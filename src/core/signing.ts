import { decodeHex, encodeHex } from "@std/encoding/hex";

/**
 * Verification signatures (ADR 0008). When the user verifies a chronology entry, an evidence
 * link or an issue, or adopts an affidavit paragraph, the app signs the record's content with a
 * key that only exists inside the vault. Claude can write to public.db, but cannot forge a
 * signature, and any later change to the content makes the old signature fail.
 */

const enc = new TextEncoder();

/** Deterministic JSON: object keys sorted, so the same content always signs the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${
    Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) =>
      `${JSON.stringify(k)}:${canonicalJson(obj[k])}`
    )
      .join(",")
  }}`;
}

export class Signer {
  constructor(private key: CryptoKey) {}

  async sign(kind: string, content: unknown): Promise<string> {
    const sig = await crypto.subtle.sign(
      "HMAC",
      this.key,
      enc.encode(`${kind}\n${canonicalJson(content)}`),
    );
    return encodeHex(new Uint8Array(sig));
  }

  async verify(kind: string, content: unknown, sig: string | null | undefined): Promise<boolean> {
    if (!sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
    return await crypto.subtle.verify(
      "HMAC",
      this.key,
      decodeHex(sig),
      enc.encode(`${kind}\n${canonicalJson(content)}`),
    );
  }
}
