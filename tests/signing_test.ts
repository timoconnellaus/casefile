import { assertEquals } from "@std/assert";
import { canonicalJson, Signer } from "../src/core/signing.ts";

async function key() {
  return await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

Deno.test("canonical JSON does not depend on key order", () => {
  assertEquals(
    canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }),
    canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
  );
  assertEquals(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

Deno.test("a signature verifies only for the same kind, content and key", async () => {
  const s = new Signer(await key());
  const content = {
    id: 1,
    description: "{{father}} was late",
    sources: [{ doc_id: "D001", line_start: 4, line_end: 4 }],
  };
  const sig = await s.sign("chronology", content);
  assertEquals(await s.verify("chronology", content, sig), true);
  assertEquals(
    await s.verify("chronology", { ...content, description: "{{mother}} was late" }, sig),
    false,
  );
  assertEquals(await s.verify("evidence", content, sig), false);
  assertEquals(await new Signer(await key()).verify("chronology", content, sig), false);
  assertEquals(await s.verify("chronology", content, null), false);
  assertEquals(await s.verify("chronology", content, "not-hex"), false);
});
