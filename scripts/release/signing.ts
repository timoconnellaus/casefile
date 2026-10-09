/**
 * Update manifests for the desktop app (ADR 24), in the format `Deno.autoUpdate` reads:
 *
 *   latest.json = { signed: "<manifest JSON>", signature: "<base64 Ed25519 over signed>" }
 *   manifest    = { version, patches: { [fromVersion]: { name, sha256 } } }
 *
 * The signature covers the exact bytes of `signed`, so no canonical JSON is needed. The public key
 * is raw (32 bytes, base64) and built into the app (src/app/update_config.ts); the private key is
 * PKCS#8 (base64) and lives only in the GitHub `release` environment.
 */
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";

export interface PatchEntry {
  name: string;
  /** Lowercase hex SHA-256 of the patch file. */
  sha256: string;
}

export interface Manifest {
  version: string;
  patches: Record<string, PatchEntry>;
}

export interface Envelope {
  signed: string;
  signature: string;
}

const ED25519 = { name: "Ed25519" } as const;

export async function generateKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    publicKey: encodeBase64(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: encodeBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  };
}

/** The public key (raw, base64) that goes with a private key (PKCS#8, base64). */
export async function publicKeyOf(privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", decodeBase64(privateKey), ED25519, true, [
    "sign",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const x = jwk.x!.replaceAll("-", "+").replaceAll("_", "/");
  return encodeBase64(decodeBase64(x + "=".repeat((4 - x.length % 4) % 4)));
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return encodeHex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function signManifest(manifest: Manifest, privateKey: string): Promise<Envelope> {
  const key = await crypto.subtle.importKey("pkcs8", decodeBase64(privateKey), ED25519, false, [
    "sign",
  ]);
  const signed = JSON.stringify(manifest);
  const sig = await crypto.subtle.sign(ED25519, key, new TextEncoder().encode(signed));
  return { signed, signature: encodeBase64(sig) };
}

/** The manifest, if the envelope is signed by `publicKey`; otherwise null. */
export async function verifyEnvelope(env: Envelope, publicKey: string): Promise<Manifest | null> {
  const key = await crypto.subtle.importKey("raw", decodeBase64(publicKey), ED25519, false, [
    "verify",
  ]);
  const ok = await crypto.subtle.verify(
    ED25519,
    key,
    decodeBase64(env.signature),
    new TextEncoder().encode(env.signed),
  );
  return ok ? JSON.parse(env.signed) as Manifest : null;
}

/** Versions are plain `MAJOR.MINOR.PATCH`, from the release tag `vMAJOR.MINOR.PATCH`. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
