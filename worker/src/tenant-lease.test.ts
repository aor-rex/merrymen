/**
 * The per-tenant advisory lease — the parts a unit test can pin without a live
 * Postgres. The key derivation must be deterministic, tenant-separating, and in
 * Postgres bigint range; the no-database path must always grant a healthy hold
 * so self-hosted and single-service testnet behave exactly as before.
 *
 * The Postgres path itself (pg_try_advisory_lock round-trip, contention between
 * two connections, loss-on-disconnect) is gated behind a live-Postgres
 * integration test before any funded deploy — same gate as the grant store.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acquireTenantLease, leaseKey } from "./tenant-lease";

const A = "0xABCdef0000000000000000000000000000000001" as const;
const B = "0x0000000000000000000000000000000000000002" as const;

describe("leaseKey", () => {
  it("is deterministic and case-insensitive on the tenant address", () => {
    assert.equal(leaseKey(A), leaseKey(A.toLowerCase()));
    assert.equal(leaseKey(A), leaseKey(A.toUpperCase()));
    // Two replicas computing the same key is the whole point — they must contend
    // over ONE lock, so the function cannot depend on anything but the address.
    assert.equal(leaseKey(A), leaseKey(A));
  });

  it("separates distinct tenants", () => {
    assert.notEqual(leaseKey(A), leaseKey(B));
  });

  it("stays inside signed 64-bit range (a valid Postgres bigint)", () => {
    const MIN = -(2n ** 63n);
    const MAX = 2n ** 63n - 1n;
    for (const t of [A, B, `0x${"ff".repeat(20)}`, `0x${"00".repeat(20)}`, "0xabc"]) {
      const k = leaseKey(t);
      assert.ok(typeof k === "bigint", `${t} → not a bigint`);
      assert.ok(k >= MIN && k <= MAX, `${t} → ${k} out of signed bigint range`);
    }
  });
});

describe("acquireTenantLease without a shared database", () => {
  it("grants an always-healthy no-op hold (single process by construction)", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL; // force the no-DB path; never touches pg
    try {
      const lease = await acquireTenantLease(A);
      assert.ok(lease, "the no-database acquire must always succeed");
      assert.equal(lease.backend, "none");
      assert.equal(lease.healthy(), true);
      assert.equal(lease.tenant, A);
      // release() is idempotent — the orchestrator may call it more than once
      // (kill switch, then shutdown) and it must never throw.
      await lease.release();
      await lease.release();
      assert.equal(lease.healthy(), true, "the no-op hold has nothing to lose");
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});
