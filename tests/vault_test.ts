import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import {
  formatRecoveryKey,
  MalformedRecoveryKeyError,
  parseRecoveryKey,
  Vault,
  VaultCorruptError,
  WrongPassphraseError,
  WrongRecoveryKeyError,
} from "../src/core/vault.ts";
import { tempDir } from "./fixtures/synthetic.ts";

const ITER = 1_000; // fast KDF for tests; production uses 600k

async function fresh() {
  const dir = join(await tempDir(), "vault");
  return { dir, vault: await Vault.create(dir, "correct horse battery", ITER) };
}

Deno.test("write then read back after reopening with the passphrase", async () => {
  const { dir, vault } = await fresh();
  await vault.writeJson("doc-d001", { original: "Anna Thornbury lives at 14 Banksia Crescent" });
  const again = await Vault.open(dir, "correct horse battery");
  assertEquals(await again.readJson("doc-d001"), {
    original: "Anna Thornbury lives at 14 Banksia Crescent",
  });
  assertEquals(await again.readJson("missing"), undefined);
});

Deno.test("a wrong passphrase is rejected", async () => {
  const { dir } = await fresh();
  await assertRejects(() => Vault.open(dir, "wrong passphrase"), WrongPassphraseError);
});

Deno.test("nothing is stored in plain text", async () => {
  const { dir, vault } = await fresh();
  await vault.writeJson("doc-d001", { original: "Anna Thornbury 0412 345 678" });
  for await (const e of Deno.readDir(dir)) {
    const bytes = new TextDecoder("latin1").decode(await Deno.readFile(join(dir, e.name)));
    for (const secret of ["Anna", "Thornbury", "0412", "correct horse"]) {
      assert(!bytes.includes(secret), `${secret} found in ${e.name}`);
    }
  }
});

Deno.test("files are private to the user", async () => {
  const { dir, vault } = await fresh();
  await vault.write("x", new Uint8Array([1, 2, 3]));
  assertEquals((await Deno.stat(join(dir, "x.enc"))).mode! & 0o077, 0);
  assertEquals((await Deno.stat(join(dir, "keyfile.json"))).mode! & 0o077, 0);
});

Deno.test("tampering with a file is detected", async () => {
  const { dir, vault } = await fresh();
  await vault.writeJson("a", { v: 1 });
  const p = join(dir, "a.enc");
  const buf = await Deno.readFile(p);
  buf[buf.length - 1] ^= 0xff;
  await Deno.writeFile(p, buf);
  await assertRejects(() => vault.read("a"), VaultCorruptError);
});

Deno.test("swapping two files is detected (file name is bound to the ciphertext)", async () => {
  const { dir, vault } = await fresh();
  await vault.writeJson("a", { v: "a" });
  await vault.writeJson("b", { v: "b" });
  await Deno.copyFile(join(dir, "b.enc"), join(dir, "a.enc"));
  await assertRejects(() => vault.read("a"), VaultCorruptError);
});

Deno.test("changing the passphrase keeps the data", async () => {
  const { dir, vault } = await fresh();
  await vault.writeJson("a", { v: 42 });
  await vault.changePassphrase("a brand new passphrase", ITER);
  await assertRejects(() => Vault.open(dir, "correct horse battery"), WrongPassphraseError);
  const v2 = await Vault.open(dir, "a brand new passphrase");
  assertEquals(await v2.readJson("a"), { v: 42 });
});

Deno.test("unsafe names and short passphrases are refused", async () => {
  const { vault } = await fresh();
  for (const bad of ["../x", "a/b", "keyfile", "", "UPPER"]) {
    await assertRejects(() => vault.write(bad, new Uint8Array()), Error);
  }
  const d = await tempDir();
  await assertRejects(() => Vault.create(join(d, "v"), "short"), Error);
});

Deno.test("creating over an existing vault is refused", async () => {
  const { dir } = await fresh();
  await assertRejects(() => Vault.create(dir, "another passphrase", ITER), Error);
});

Deno.test("list and delete", async () => {
  const { vault } = await fresh();
  await vault.writeJson("doc-d001", 1);
  await vault.writeJson("doc-d002", 2);
  await vault.writeJson("settings", 3);
  assertEquals(await vault.list("doc-"), ["doc-d001", "doc-d002"]);
  await vault.delete("doc-d001");
  assertEquals(await vault.list("doc-"), ["doc-d002"]);
});

// ── keyfile v2 and recovery keys (ADR 4, amended) ───────────────────────────

const keyfile = async (dir: string) =>
  JSON.parse(await Deno.readTextFile(join(dir, "keyfile.json")));

Deno.test("recovery keys: 32 Crockford characters in 8 groups, read back leniently", () => {
  const raw = crypto.getRandomValues(new Uint8Array(20));
  const key = formatRecoveryKey(raw);
  assert(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/.test(key), key);
  assertEquals(parseRecoveryKey(key), raw);
  assertEquals(parseRecoveryKey(key.toLowerCase().replaceAll("-", " ")), raw);
  const zeros = formatRecoveryKey(new Uint8Array(20));
  assertEquals(zeros, "0000-0000-0000-0000-0000-0000-0000-0000");
  assertEquals(parseRecoveryKey(zeros.replaceAll("0", "O")), new Uint8Array(20));
  assertEquals(
    formatRecoveryKey(new Uint8Array(20).fill(255)),
    "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ",
  );
  for (const bad of ["", "ABCD", zeros + "0", zeros.slice(0, -1) + "U"]) {
    assertEquals(parseRecoveryKey(bad), null, bad);
  }
});

Deno.test("a version 1 keyfile written by an earlier build still opens", async () => {
  // Built here with WebCrypto, independently of vault.ts, exactly as v1 wrote it.
  const dir = join(await tempDir(), "vault");
  await Deno.mkdir(dir);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("an old passphrase"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const kek = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("casefile-data-key") },
      kek,
      raw,
    ),
  );
  await Deno.writeTextFile(
    join(dir, "keyfile.json"),
    JSON.stringify({
      format: "casefile-vault",
      version: 1,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITER, salt: encodeBase64(salt) },
      wrapped: { iv: encodeBase64(iv), data: encodeBase64(wrapped) },
    }),
  );
  const v = await Vault.open(dir, "an old passphrase");
  await v.writeJson("a", { v: 1 });
  assertEquals(await v.recoveryInfo(), { set: false, createdAt: null });
  // Adding a recovery key upgrades the keyfile to v2 and keeps the passphrase working.
  const key = await v.setRecoveryKey(ITER);
  assertEquals((await keyfile(dir)).version, 2);
  assertEquals(await (await Vault.open(dir, "an old passphrase")).readJson("a"), { v: 1 });
  assertEquals(await (await Vault.openWithRecovery(dir, key)).readJson("a"), { v: 1 });
});

Deno.test("a vault without a recovery key keeps writing keyfile version 1", async () => {
  const { dir, vault } = await fresh();
  assertEquals((await keyfile(dir)).version, 1);
  await vault.changePassphrase("another long passphrase", ITER);
  assertEquals((await keyfile(dir)).version, 1);
  assertEquals((await keyfile(dir)).recovery, undefined);
});

Deno.test("the recovery key opens the vault; a wrong one counts as a wrong passphrase", async () => {
  const { dir, vault } = await fresh();
  await vault.writeJson("a", { v: 7 });
  const key = await vault.setRecoveryKey(ITER);
  assertEquals((await vault.recoveryInfo()).set, true);
  assertEquals(await (await Vault.openWithRecovery(dir, key)).readJson("a"), { v: 7 });
  const other = formatRecoveryKey(crypto.getRandomValues(new Uint8Array(20)));
  const e = await assertRejects(() => Vault.openWithRecovery(dir, other), WrongRecoveryKeyError);
  assert(e instanceof WrongPassphraseError, "shares the passphrase lockout");
  await assertRejects(() => Vault.openWithRecovery(dir, "not a key"), MalformedRecoveryKeyError);
  // The recovery key is not a passphrase, and the passphrase is not a recovery key.
  await assertRejects(() => Vault.open(dir, key), WrongPassphraseError);
});

Deno.test("changing the passphrase keeps the recovery key; rotating replaces it", async () => {
  const { dir, vault } = await fresh();
  await vault.writeJson("a", { v: 1 });
  const first = await vault.setRecoveryKey(ITER);
  await vault.changePassphrase("a brand new passphrase", ITER);
  await Vault.openWithRecovery(dir, first);
  const second = await vault.setRecoveryKey(ITER);
  assert(first !== second);
  await assertRejects(() => Vault.openWithRecovery(dir, first), WrongRecoveryKeyError);
  await Vault.openWithRecovery(dir, second);
  await Vault.open(dir, "a brand new passphrase");
  await vault.removeRecoveryKey();
  assertEquals((await keyfile(dir)).version, 1);
  await assertRejects(() => Vault.openWithRecovery(dir, second), WrongRecoveryKeyError);
  await Vault.open(dir, "a brand new passphrase");
});

Deno.test("the recovery key is not stored, in any form", async () => {
  const { dir, vault } = await fresh();
  await vault.writeJson("a", { v: 1 });
  const key = await vault.setRecoveryKey(ITER);
  const raw = parseRecoveryKey(key)!;
  const forms = [
    key,
    key.replaceAll("-", ""),
    encodeBase64(raw),
    [...raw].map((b) => b.toString(16).padStart(2, "0")).join(""),
  ];
  for await (const e of Deno.readDir(dir)) {
    const text = new TextDecoder("latin1").decode(await Deno.readFile(join(dir, e.name)));
    for (const f of forms) assert(!text.includes(f), `${e.name} holds the key`);
  }
});

Deno.test("a swapped-in recovery wrap of another key is refused and changes nothing", async () => {
  // Something that can write keyfile.json (but doesn't know the data key) wraps a key of its own
  // with a recovery key it knows. Recovery must not accept that key: re-wrapping it under a new
  // passphrase would lose the real data key.
  const { dir, vault } = await fresh();
  await vault.writeJson("a", { v: 1 });
  const attacker = await fresh();
  await attacker.vault.writeJson("a", { v: "theirs" });
  const theirKey = await attacker.vault.setRecoveryKey(ITER);
  const kf = await keyfile(dir);
  kf.recovery = (await keyfile(attacker.dir)).recovery;
  kf.version = 2;
  await Deno.writeTextFile(join(dir, "keyfile.json"), JSON.stringify(kf));
  const before = await Deno.readTextFile(join(dir, "keyfile.json"));
  await assertRejects(() => Vault.openWithRecovery(dir, theirKey), VaultCorruptError);
  assertEquals(await Deno.readTextFile(join(dir, "keyfile.json")), before);
  assertEquals(await (await Vault.open(dir, "correct horse battery")).readJson("a"), { v: 1 });
});

Deno.test("a recovery wrap can't be passed off as the passphrase wrap", async () => {
  const { dir, vault } = await fresh();
  const key = await vault.setRecoveryKey(ITER);
  const kf = await keyfile(dir);
  // Put the recovery wrap where the passphrase wrap goes; the key text as a "passphrase" must
  // not open it (different associated data, and the KDF input differs).
  kf.kdf = kf.recovery.kdf;
  kf.wrapped = kf.recovery.wrapped;
  await Deno.writeTextFile(join(dir, "keyfile.json"), JSON.stringify(kf));
  await assertRejects(() => Vault.open(dir, key), WrongPassphraseError);
  assert(decodeBase64(kf.wrapped.data).length > 0);
});
