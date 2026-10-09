/**
 * Recovery key through the API (ADR 4 and ADR 13, amended): made at creation or later with the
 * passphrase, shown once, never stored or logged in plain text, opens the case with a new
 * passphrase, and wrong keys share the passphrase lockout. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { formatRecoveryKey, parseRecoveryKey } from "../src/core/vault.ts";
import { assertSecurityHeaders, type Client, PASS, setup, withCase } from "./helpers/app.ts";

const NEW_PASS = "a fresh replacement passphrase";
const KEY_RE = /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/;
const randomKey = () => formatRecoveryKey(crypto.getRandomValues(new Uint8Array(20)));

async function createWithKey() {
  const t = await setup();
  const r = await t.user.post("/api/case/create", {
    dir: t.caseDir,
    passphrase: PASS,
    label: "Test matter",
    recoveryKey: true,
  });
  assertEquals(r.status, 200, r.text);
  assertSecurityHeaders(r, "create");
  assertMatch(r.json.recoveryKey, KEY_RE);
  return { ...t, key: r.json.recoveryKey as string };
}

const recover = (c: Client, dir: string, recoveryKey: string, newPassphrase = NEW_PASS) =>
  c.post("/api/case/open", { dir, recoveryKey, newPassphrase });

/** Every file under `dir`, recursively, as latin1 text. */
async function allFiles(dir: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) out.push(...await allFiles(p));
    else if (e.isFile) {
      try {
        out.push([p, new TextDecoder("latin1").decode(await Deno.readFile(p))]);
      } catch (err) {
        // SQLite's -wal/-shm files can go away as the store closes.
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    }
  }
  return out;
}

async function assertKeyNowhere(root: string, key: string) {
  const raw = parseRecoveryKey(key)!;
  const forms = [
    key,
    key.replaceAll("-", ""),
    key.toLowerCase(),
    encodeBase64(raw),
    [...raw].map((b) => b.toString(16).padStart(2, "0")).join(""),
  ];
  for (const [path, text] of await allFiles(root)) {
    for (const f of forms) assert(!text.includes(f), `${path} holds the recovery key`);
  }
}

Deno.test("creating without a recovery key returns none", async () => {
  const t = await withCase();
  assertEquals((await t.user.get("/api/case/recovery-key")).json, { set: false, createdAt: null });
  assertEquals((await t.user.get("/api/settings")).json.recoveryKey.set, false);
  t.state.lock();
});

Deno.test("a recovery key made at creation is shown once and stored nowhere in plain text", async () => {
  const t = await createWithKey();
  const info = (await t.user.get("/api/case/recovery-key")).json;
  assertEquals(info.set, true);
  assert(!JSON.stringify(info).includes(t.key.slice(0, 9)));
  const settings = await t.user.get("/api/settings");
  assert(!settings.text.includes(t.key));
  assertEquals(t.state.session!.settings.recoveryKey, true);
  const log = t.state.session!.store.listLog(500);
  assert(log.some((r) => r.action === "recovery_key_created"));
  t.state.lock();
  await t.state.session?.settled();
  // The case folder (vault, public.db with the log, CLAUDE.md…) and the app config.
  await assertKeyNowhere(t.root, t.key);
});

Deno.test("the recovery key opens the case with a new passphrase", async () => {
  const t = await createWithKey();
  await t.user.post("/api/lock");
  // Without a new passphrase, or with a short one, nothing happens.
  assertEquals(
    (await t.other.post("/api/case/open", { dir: t.caseDir, recoveryKey: t.key }))
      .status,
    400,
  );
  assertEquals((await recover(t.other, t.caseDir, t.key, "short")).status, 400);
  const r = await recover(t.other, t.caseDir, t.key.toLowerCase().replaceAll("-", " "));
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json, { ok: true, recovered: true });
  assert(t.other.cookie, "recovery signs the caller in");
  assertEquals((await t.other.get("/api/status")).json.signedIn, true);
  const log = t.state.session!.store.listLog(500);
  assert(log.some((x) => x.action === "passphrase_reset_with_recovery_key"));
  assert(!JSON.stringify(log).includes(t.key));
  await t.other.post("/api/lock");
  // The old passphrase no longer works; the new one does; the key still works.
  assertEquals(
    (await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS })).status,
    401,
  );
  assertEquals(
    (await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: NEW_PASS })).status,
    200,
  );
  await t.user.post("/api/lock");
  assertEquals((await recover(t.user, t.caseDir, t.key, "yet another passphrase!")).status, 200);
  t.state.lock();
});

Deno.test("wrong recovery keys count toward the passphrase lockout", async () => {
  const t = await createWithKey();
  await t.user.post("/api/lock");
  for (let i = 0; i < 3; i++) {
    const r = await recover(t.other, t.caseDir, randomKey());
    assertEquals(r.status, 401, r.text);
    assertEquals(r.json.error, "Wrong recovery key");
  }
  // Locked out now: even the right passphrase, or the right key, has to wait.
  const p = await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS });
  assertEquals(p.status, 429, p.text);
  assert(p.json.retryAfterSeconds > 0);
  assertEquals((await recover(t.user, t.caseDir, t.key)).status, 429);
  assert((await t.other.get("/api/status")).json.retryAfterSeconds > 0);
  assertEquals(t.state.session, null);
});

Deno.test("wrong passphrases and wrong recovery keys add up in one count", async () => {
  const t = await createWithKey();
  await t.user.post("/api/lock");
  for (let i = 0; i < 2; i++) {
    assertEquals(
      (await t.other.post("/api/case/open", { dir: t.caseDir, passphrase: "wrong guess " + i }))
        .status,
      401,
    );
  }
  assertEquals((await recover(t.other, t.caseDir, randomKey())).status, 401);
  assertEquals((await recover(t.user, t.caseDir, t.key)).status, 429);
});

Deno.test("text that is not a recovery key is refused without a key derivation", async () => {
  const t = await createWithKey();
  await t.user.post("/api/lock");
  const r = await recover(t.other, t.caseDir, "definitely-not-a-key");
  assertEquals(r.status, 400, r.text);
  assertEquals((await t.user.get("/api/status")).json.retryAfterSeconds, 0);
});

Deno.test("a case without a recovery key refuses any key, and it counts", async () => {
  const t = await withCase();
  await t.user.post("/api/lock");
  for (let i = 0; i < 3; i++) {
    assertEquals((await recover(t.other, t.caseDir, randomKey())).status, 401);
  }
  assertEquals(
    (await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS })).status,
    429,
  );
});

Deno.test("making or replacing a recovery key needs the passphrase", async () => {
  const t = await withCase();
  assertEquals((await t.user.post("/api/case/recovery-key", {})).status, 400);
  assertEquals(
    (await t.user.post("/api/case/recovery-key", { passphrase: "not the passphrase" })).status,
    401,
  );
  const first = await t.user.post("/api/case/recovery-key", { passphrase: PASS });
  assertEquals(first.status, 200, first.text);
  assertSecurityHeaders(first, "recovery-key");
  assertMatch(first.json.recoveryKey, KEY_RE);
  assertEquals(first.json.replaced, false);
  const second = await t.user.post("/api/case/recovery-key", { passphrase: PASS });
  assertEquals(second.json.replaced, true);
  const log = t.state.session!.store.listLog(500).map((r) => r.action);
  assert(log.includes("recovery_key_created") && log.includes("recovery_key_replaced"));
  // Only the newest key works.
  await t.user.post("/api/lock");
  assertEquals((await recover(t.other, t.caseDir, first.json.recoveryKey)).status, 401);
  assertEquals((await recover(t.other, t.caseDir, second.json.recoveryKey)).status, 200);
  t.state.lock();
  await assertKeyNowhere(t.root, first.json.recoveryKey);
  await assertKeyNowhere(t.root, second.json.recoveryKey);
});

Deno.test("wrong passphrases when replacing the key count toward the lockout", async () => {
  const t = await withCase();
  for (let i = 0; i < 3; i++) {
    assertEquals(
      (await t.user.post("/api/case/recovery-key", { passphrase: "guess " + i })).status,
      401,
    );
  }
  assertEquals((await t.user.post("/api/case/recovery-key", { passphrase: PASS })).status, 429);
  t.state.lock();
});

Deno.test("removing the recovery key needs the passphrase", async () => {
  const t = await createWithKey();
  assertEquals(
    (await t.user.post("/api/case/recovery-key/remove", { passphrase: "nope nope nope" })).status,
    401,
  );
  assertEquals(
    (await t.user.post("/api/case/recovery-key/remove", { passphrase: PASS })).status,
    200,
  );
  assertEquals((await t.user.get("/api/case/recovery-key")).json.set, false);
  await t.user.post("/api/lock");
  assertEquals((await recover(t.other, t.caseDir, t.key)).status, 401);
});

Deno.test("recovery-key routes need the session", async () => {
  const t = await createWithKey();
  assertEquals((await t.other.get("/api/case/recovery-key")).status, 401);
  assertEquals((await t.other.post("/api/case/recovery-key", { passphrase: PASS })).status, 401);
  t.state.lock();
});
