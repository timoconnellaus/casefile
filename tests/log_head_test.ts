/**
 * The vault's record of the AI-use log's last entry (`log-head`, ADR 8): how it is written, what
 * happens when it is lost or damaged, and why a seeded case once would not open (a session left
 * open on a case folder that was then replaced wrote its head into the new case's vault).
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { AppState } from "../src/app/state.ts";
import { CaseSession } from "../src/core/session.ts";
import { PublicStore, StoreReplacedError } from "../src/core/publicdb.ts";
import { Vault, VaultReplacedError } from "../src/core/vault.ts";
import { tempDir } from "./fixtures/synthetic.ts";

const PASS = "a long test passphrase";
const OPTS = { kdfIterations: 1_000 };
const HEAD = "log-head";

async function newCase(dir: string) {
  return await CaseSession.create(dir, PASS, "Test matter", OPTS);
}

async function readHead(dir: string) {
  const v = await Vault.open(join(dir, "vault"), PASS);
  return await v.readJson<{ id: number; chain: string }>(HEAD);
}

function lastLogId(s: CaseSession): number {
  return s.store.listLog(1)[0].id;
}

Deno.test("a session left open on a case folder that is then replaced cannot write into the new case", async () => {
  const dir = join(await tempDir(), "case");
  const stale = await newCase(dir);
  // The folder is replaced (as `seed --force` does) while the first session is still open.
  await Deno.remove(dir, { recursive: true });
  const fresh = await newCase(dir);
  await fresh.closeSettled();

  // The stale session tries to log (as locking does): its store refuses (ADR 4, amended), so no
  // head write can land in the new vault either.
  assertThrows(() => stale.log("user", "case_locked"), StoreReplacedError);
  await stale.settled();
  await assertRejects(() => stale.vault.writeJson("lapsed-checks", {}), VaultReplacedError);
  await assertRejects(() => stale.vault.delete("lapsed-checks"), VaultReplacedError);
  stale.close();

  const s = await CaseSession.open(dir, PASS);
  const check = await s.verifyLog();
  assertEquals(check.intact, true, check.problem);
  await s.closeSettled();
});

Deno.test("an app that still has a case open does not break it when the case is made again", async () => {
  const root = await tempDir();
  const dir = join(root, "case");
  (await newCase(dir)).close();
  const app = new AppState({
    configDir: join(root, "config"),
    detectorFactory: () => [],
    idleLockMs: 0,
    ...OPTS,
  });
  await app.load();
  await app.openCase(dir, PASS);
  await Deno.remove(dir, { recursive: true });
  await (await newCase(dir)).closeSettled();
  await app.lock(); // idle lock or window close in the old app

  const s = await CaseSession.open(dir, PASS);
  assertEquals((await s.verifyLog()).intact, true);
  await s.closeSettled();
});

Deno.test("locking waits for the log head: the vault records the last entry once lock resolves", async () => {
  const root = await tempDir();
  const dir = join(root, "case");
  (await newCase(dir)).close();
  for (let round = 0; round < 5; round++) {
    const app = new AppState({
      configDir: join(root, "config"),
      detectorFactory: () => [],
      idleLockMs: 0,
      ...OPTS,
    });
    await app.load();
    await app.openCase(dir, PASS);
    const s = app.session!;
    // Interleave app writes, CLI writes and queued vault writes with the lock.
    const cli = PublicStore.open(join(dir, "public.db"));
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      s.log("user", "stress", { round, i });
      if (i % 3 === 0) cli.log("claude", "cli:info", { i });
      if (i % 5 === 0) work.push(s.writeVaultJson("lapsed-checks", { round, i }));
      if (i % 7 === 0) work.push(s.updateSettings({ idleLockMinutes: 15 }));
    }
    const last = lastLogId(s) + 1; // the lock's own entry
    await app.lock();
    await Promise.all(work);
    cli.close();
    const head = await readHead(dir);
    assertEquals(head?.id, last, `round ${round}: the vault's head is behind the log`);
  }
  const s = await CaseSession.open(dir, PASS);
  const check = await s.verifyLog();
  assertEquals([check.intact, check.pending], [true, 0], check.problem);
  await s.closeSettled();
});

Deno.test("a process that exits as soon as the lock resolves keeps its last log head", async () => {
  const root = await tempDir();
  const dir = join(root, "case");
  (await newCase(dir)).close();
  const state = new URL("../src/app/state.ts", import.meta.url).href;
  // The desktop window's close handler: lock, then exit at once.
  const code = `
    import { AppState } from ${JSON.stringify(state)};
    const app = new AppState({ configDir: ${JSON.stringify(join(root, "config"))},
      detectorFactory: () => [], idleLockMs: 0, kdfIterations: 1000 });
    await app.load();
    await app.openCase(${JSON.stringify(dir)}, ${JSON.stringify(PASS)});
    for (let i = 0; i < 20; i++) app.session.log("user", "burst", { i });
    await app.lock();
    Deno.exit(0);
  `;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", code],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  const store = PublicStore.open(join(dir, "public.db"));
  const last = store.listLog(1)[0];
  store.close();
  assertEquals(last.action, "case_locked");
  assertEquals((await readHead(dir))?.id, last.id);
});

Deno.test("a log entry in a transaction that is rolled back does not become the head", async () => {
  const dir = join(await tempDir(), "case");
  const s = await newCase(dir);
  s.log("user", "kept");
  try {
    s.store.tx(() => {
      s.log("user", "rolled back");
      throw new Error("abandoned");
    });
  } catch { /* expected */ }
  const check = await s.verifyLog();
  assertEquals(check.intact, true, check.problem);
  await s.closeSettled();
});

Deno.test("a damaged log head does not stop the case opening, and the log check keeps reporting it", async () => {
  const dir = join(await tempDir(), "case");
  const first = await newCase(dir);
  first.log("user", "something");
  await first.closeSettled();
  const file = join(dir, "vault", `${HEAD}.enc`);
  const damaged = new Uint8Array(await Deno.readFile(file));
  damaged[damaged.length - 1] ^= 0xff;
  await Deno.writeFile(file, damaged);

  const s = await CaseSession.open(dir, PASS);
  const check = await s.verifyLog();
  assertEquals(check.intact, false);
  assertEquals(check.headLost?.reason, "damaged");
  assert(check.problem?.includes("could not be read"), check.problem);
  // The damaged copy is kept beside the vault, and a new head is recorded.
  const kept = check.recorded?.[0].kept;
  assert(kept && (await Deno.stat(join(dir, "vault", kept))).isFile);
  assert(s.store.listLog(100).some((l) => l.action === "log_head_lost"));
  await s.closeSettled();
  assertEquals((await readHead(dir))?.id !== undefined, true);

  // Reopening does not make the gap disappear.
  const again = await CaseSession.open(dir, PASS);
  assertEquals((await again.verifyLog()).headLost?.reason, "damaged");
  await again.closeSettled();
});

Deno.test("a log head from another case is reported, not trusted", async () => {
  const root = await tempDir();
  const a = await newCase(join(root, "a"));
  const b = await newCase(join(root, "b"));
  await a.closeSettled();
  await b.closeSettled();
  await Deno.copyFile(
    join(root, "b", "vault", `${HEAD}.enc`),
    join(root, "a", "vault", `${HEAD}.enc`),
  );
  const s = await CaseSession.open(join(root, "a"), PASS);
  assertEquals((await s.verifyLog()).intact, false);
  await s.closeSettled();
});

Deno.test("a deleted log head with entries cut from the end stays reported after reopening", async () => {
  const dir = join(await tempDir(), "case");
  const first = await newCase(dir);
  for (let i = 0; i < 5; i++) first.log("user", "entry", { i });
  const last = lastLogId(first);
  first.store.db.prepare("DELETE FROM ai_log WHERE id >= ?").run(last - 2);
  await first.closeSettled();
  await Deno.remove(join(dir, "vault", `${HEAD}.enc`));

  const s = await CaseSession.open(dir, PASS);
  assertEquals((await s.verifyLog()).headLost?.reason, "missing");
  await s.closeSettled();
  const again = await CaseSession.open(dir, PASS);
  const check = await again.verifyLog();
  assertEquals(check.intact, false);
  assertEquals(check.headLost?.reason, "missing");
  await again.closeSettled();
});

Deno.test("vault writes leave no temporary files behind", async () => {
  const dir = join(await tempDir(), "vault");
  const v = await Vault.create(dir, PASS, 1_000);
  await Promise.all(Array.from({ length: 20 }, (_, i) => v.writeJson("lapsed-checks", { i })));
  for await (const e of Deno.readDir(dir)) assert(!e.name.endsWith(".tmp"), e.name);
  assertEquals(typeof (await v.readJson<{ i: number }>("lapsed-checks"))?.i, "number");
});
