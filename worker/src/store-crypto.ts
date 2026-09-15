/**
 * Encryption at rest for the one secret a hosted server legitimately holds: the
 * SESSION key.
 *
 * The owner key never reaches the server (the custody boundary), so the only
 * key material at rest is the capped, revocable session key — which the wall
 * makes value-churn, not theft, if leaked. That is not licence to store it in
 * the clear: a breached box should yield ciphertext, not a set of keys an
 * attacker can churn every tenant's book with. So session keys are sealed with
 * AES-256-GCM under a data-encryption key that lives ONLY in the environment
 * (a sealed Railway secret / KMS), never in the database beside the ciphertext.
 *
 * GCM, not CBC, deliberately: the auth tag means a flipped byte in the store is
 * a decrypt FAILURE, not a silently mangled key that signs a garbage UserOp.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The data-encryption key, 32 bytes, from MERRYMEN_STORE_DEK (base64), or null.
 *
 * Null when unset — the file backend in a single-tenant/self-hosted context has
 * no DEK and stores plaintext on the user's own disk, exactly as today. Hosted
 * mode REQUIRES it (see requireDek); a hosted server with no DEK would store
 * session keys in the clear, so that path refuses rather than degrade.
 */
export function storeDek(): Buffer | null {
  const raw = process.env.MERRYMEN_STORE_DEK;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

export function requireDek(): Buffer {
  const dek = storeDek();
  if (!dek) {
    throw new Error("MERRYMEN_STORE_DEK is not a 32-byte base64 key — hosted mode cannot store secrets in the clear");
  }
  return dek;
}

/** Seal a secret: iv.tag.ciphertext, all base64url, in one dot-joined string. */
export function sealSecret(plaintext: string, dek: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

/** Open a sealed secret. Throws on a tampered tag or a wrong key — never returns a mangled value. */
export function openSecret(sealed: string, dek: Buffer): string {
  const parts = sealed.split(".");
  if (parts.length !== 3) throw new Error("malformed sealed secret");
  const [ivB, tagB, ctB] = parts as [string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
}
