import React from "react";
import { grantHasV4, grantV4Adapter, type StoredGrant } from "@merrymen/core";

type V4Grant = Pick<StoredGrant, "grantFeatures" | "v4AdapterAddress">;

/** The old unrestricted router grant and the constrained adapter are different permissions. */
export function V4PermissionLine({ grant, configuredAdapter }: { grant: V4Grant; configuredAdapter?: string }) {
  const adapter = grantV4Adapter(grant);
  const legacy = grantHasV4(grant);
  const settingsMismatch = adapter && configuredAdapter && adapter.toLowerCase() !== configuredAdapter.toLowerCase();
  return (
    <li>
      <b>Uniswap v4</b> —{" "}
      {legacy && (
        <span style={{ color: "var(--red)" }}>
          old unrestricted router permission. <b>Re-sign below</b> to remove it.
        </span>
      )}
      {legacy && adapter && " "}
      {adapter ? (
        <>
          adapter permission sealed to <code style={{ overflowWrap: "anywhere" }}>{adapter}</code>.
          The agent checks that contract is deployed on this network before using it.
          {settingsMismatch && (
            <>{" "}Settings now names a different adapter. The agent cannot use v4 until the address in Settings and this signed key match. Verify the intended deployed address, then re-sign.</>
          )}
        </>
      ) : legacy ? null : configuredAdapter ? (
        <>
          adapter address saved in Settings, but this key does not grant it. <b>Re-sign below</b> to seal it.
        </>
      ) : (
        <>
          not granted. Check that a deployed <b>V4SelfSwap adapter</b> address is saved in Settings, then re-sign below.
        </>
      )}
    </li>
  );
}
