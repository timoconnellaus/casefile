/**
 * The case-in-use lock, and a session whose case folder is replaced while it is open (ADR 4,
 * amendment "one opener at a time").
 *
 * The bug: the desktop app opened the canon case while `deno task seed --force` was rebuilding it.
 * Opening a case repairs public.db against the vault (`reconcilePublic`); the app read the vault's
 * list of documents, the seed then published D130, and the app's repair withdrew D130 from
 * public.db because its earlier read of the vault did not list it. The seed then failed with
 * "Not found: document D130". A second process is played here by tests/helpers/hold_case.ts.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { CASE_LOCK_FILE, CaseInUseError, CaseLock, pidAlive } from "../src/core/caselock.ts";
import { PublicStore, StoreReplacedError } from "../src/core/publicdb.ts";
import { CaseSession } from "../src/core/session.ts";
import { VaultReplacedError } from "../src/core/vault.ts";
import { CASE_REPLACED_MESSAGE } from "../src/app/state.ts";
import { seedCase } from "../scripts/seed.ts";
import { tempDir } from "./fixtures/synthetic.ts";
import { PASS, setup, withCase } from "./helpers/app.ts";

const OPTS = { kdfIterations: 1_000 };
const HOLD = fromFileUrl(new URL("./helpers/hold_case.ts", import.meta.url));
const inUse = (pid: number) =>
  `This case is open in casefile (pid ${pid}). Lock it or quit casefile first.`;

/** Another process with the case open, like a second casefile app. */
async function holdCase(dir: string) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-sys",
      "--allow-ffi",
      HOLD,
      dir,
      PASS,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const writer = child.stdin.getWriter();
  let buf = "";
  const next = async () => {
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the holding process ended");
      buf += value;
    }
    const nl = buf.indexOf("\n");
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    return JSON.parse(line);
  };
  const first = await next();
  assertEquals(first.open, true, JSON.stringify(first));
  return {
    pid: child.pid,
    async send(cmd: string) {
      await writer.write(new TextEncoder().encode(cmd + "\n"));
      return await next();
    },
    /** Kill it without closing anything, as a crash would. */
    async crash() {
      child.kill("SIGKILL");
      await child.status;
      await writer.close().catch(() => {});
      await reader.cancel().catch(() => {});
    },
    async end() {
      await writer.close().catch(() => {});
      await reader.cancel().catch(() => {});
      await child.status;
    },
  };
}

async function newCase(dir: string, label = "Test matter") {
  return await CaseSession.create(dir, PASS, label, OPTS);
}

function readLockFile(dir: string) {
  return JSON.parse(Deno.readTextFileSync(join(dir, CASE_LOCK_FILE)));
}

function lockExists(dir: string): boolean {
  try {
    Deno.lstatSync(join(dir, CASE_LOCK_FILE));
    return true;
  } catch {
    return false;
  }
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const c = new Deno.Command(Deno.execPath(), { args: ["eval", "0"], stdout: "null" }).spawn();
  await c.status;
  return c.pid;
}

Deno.test("a case open in another process can't be opened, created over or re-seeded; a crashed holder's lock is taken over", async () => {
  const t = await setup();
  const dir = t.caseDir;
  (await newCase(dir)).close();
  assert(!lockExists(dir), "closing removes the lock");

  const other = await holdCase(dir);
  try {
    const lock = readLockFile(dir);
    assertEquals(lock.pid, other.pid);
    assertEquals(lock.host, Deno.hostname());
    assert(!Number.isNaN(Date.parse(lock.startedAt)));

    // A second opener (another casefile app): refused, with the holder's pid.
    await assertRejects(() => CaseSession.open(dir, PASS), CaseInUseError, inUse(other.pid));
    const r = await t.user.post("/api/case/open", { dir, passphrase: PASS });
    assertEquals(r.status, 409, r.text);
    assertEquals(r.json.error, inUse(other.pid));
    assertEquals(t.state.session, null);
    // Creating a case there, and seed --force, are refused the same way.
    await assertRejects(
      () => t.state.createCase(dir, PASS, "Another matter"),
      CaseInUseError,
      inUse(other.pid),
    );
    await assertRejects(
      () => seedCase({ dir, force: true, quiet: true, ...OPTS }),
      CaseInUseError,
      inUse(other.pid),
    );
    assert(Deno.statSync(join(dir, "public.db")).isFile, "the seed deleted nothing");

    // The holder crashes: its lock stays behind, but its process is gone, so it is stale.
    await other.crash();
    assertEquals(readLockFile(dir).pid, other.pid);
    assert(!pidAlive(other.pid));
    const r2 = await t.user.post("/api/case/open", { dir, passphrase: PASS });
    assertEquals(r2.status, 200, r2.text);
    assertEquals(readLockFile(dir).pid, Deno.pid);
    await t.state.lock();
    assert(!lockExists(dir), "locking removes the lock");
  } finally {
    await other.crash().catch(() => {});
    await t.state.shutdown();
  }
});

Deno.test("a case folder replaced under an open session: the new case keeps every row and its log", async () => {
  const dir = join(await tempDir(), "case");
  (await newCase(dir, "Old matter")).close();
  const stale = await holdCase(dir);
  try {
    // Something that ignores the lock (an older build, or a person in Finder) replaces the case.
    await Deno.remove(dir, { recursive: true });
    const fresh = await newCase(dir, "New matter");
    for (let i = 1; i <= 5; i++) {
      const doc = await fresh.importText({
        origin: "mine",
        title: `Note ${i}`,
        text: `A short note with nothing identifying in it, number ${i}.`,
        source: `note-${i}.txt`,
      });
      await fresh.publishWithDefaults(doc.id);
    }
    await fresh.settled();
    const docs = fresh.store.listDocuments().map((d) => d.id);
    const log = fresh.store.listLog(10_000).map((l) => l.id);
    assertEquals(docs.length, 5);
    // The new rows are still in the WAL, which a careless close of the old connection could lose.
    assert(Deno.statSync(join(dir, "public.db-wal")).size > 0);

    // The old session notices, refuses to write anywhere, and closes.
    const w = await stale.send("write");
    assertEquals(w, { replaced: true, log: "StoreReplacedError", vault: "VaultReplacedError" });
    assertEquals(await stale.send("close"), { closed: true });
    await stale.end();

    // Every row is there for a new connection, the log verifies, and the lock is still fresh's.
    const check = PublicStore.open(join(dir, "public.db"));
    assertEquals(check.listDocuments().map((d) => d.id), docs);
    assertEquals(check.listLog(10_000).map((l) => l.id), log);
    check.close();
    const v = await fresh.verifyLog();
    assertEquals(v.intact, true, v.problem);
    assertEquals(readLockFile(dir).pid, Deno.pid);
    await fresh.closeSettled();
    assert(!lockExists(dir));

    const again = await CaseSession.open(dir, PASS);
    assertEquals(again.store.listDocuments().length, 5);
    assertEquals(again.settings.label, "New matter");
    await again.closeSettled();
  } finally {
    await stale.crash().catch(() => {});
  }
});

Deno.test("a session in this process stops using a replaced folder, and closing it leaves the new case's lock", async () => {
  const dir = join(await tempDir(), "case");
  const stale = await newCase(dir, "Old matter");
  await stale.settled();
  await Deno.remove(dir, { recursive: true });
  const fresh = await newCase(dir, "New matter");
  fresh.log("user", "note_added", {});
  const rows = fresh.store.listLog(10_000).length;

  assert(stale.folderReplaced());
  assert(!fresh.folderReplaced());
  assertThrows(() => stale.log("user", "case_locked"), StoreReplacedError);
  assertThrows(() => stale.store.listDocuments(), StoreReplacedError);
  await assertRejects(() => stale.vault.writeJson("lapsed-checks", {}), VaultReplacedError);
  await stale.closeSettled();

  assert(lockExists(dir), "the old session's close left the new case's lock alone");
  assertEquals(fresh.store.listLog(10_000).length, rows);
  assertEquals((await fresh.verifyLog()).intact, true);
  await fresh.closeSettled();
});

Deno.test("the app locks a case whose folder was replaced and says why", async () => {
  const t = await setup();
  try {
    const created = await t.user.post("/api/case/create", {
      dir: t.caseDir,
      passphrase: PASS,
      label: "Old matter",
    });
    assertEquals(created.status, 200, created.text);
    assertEquals((await t.user.get("/api/docs")).status, 200);

    await Deno.remove(t.caseDir, { recursive: true });
    const fresh = await newCase(t.caseDir, "New matter");
    await fresh.closeSettled();

    const r = await t.user.get("/api/docs");
    assertEquals(r.status, 423, r.text);
    assertEquals(r.json.error, CASE_REPLACED_MESSAGE);
    assertEquals(t.state.session, null);
    const status = (await t.user.get("/api/status")).json;
    assertEquals(status.unlocked, false);
    assertEquals(status.lockNotice, CASE_REPLACED_MESSAGE);
    assert(!lockExists(t.caseDir), "the new case is closed, and the app did not leave a lock");

    // Opening it again works, and clears the notice.
    const o = await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS });
    assertEquals(o.status, 200, o.text);
    assertEquals((await t.user.get("/api/settings")).json.label, "New matter");
    assertEquals((await t.user.get("/api/status")).json.lockNotice, null);
  } finally {
    await t.state.shutdown();
  }
});

Deno.test("the lock: shared within a process, refused from another host, stale when its process is gone", async () => {
  const dir = await tempDir();
  const path = join(dir, CASE_LOCK_FILE);
  const write = (info: Record<string, unknown>) =>
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        format: "casefile-lock",
        startedAt: new Date().toISOString(),
        host: Deno.hostname(),
        by: "app",
        token: crypto.randomUUID(),
        ...info,
      }),
    );

  // Two holds in one process (the app replacing its own session) share one file.
  const a = await CaseLock.acquire(dir);
  const b = await CaseLock.acquire(dir);
  a.release();
  assert(lockExists(dir), "still held by the second");
  b.release();
  assert(!lockExists(dir));

  // A live process elsewhere on this machine (our parent) holds it.
  write({ pid: Deno.ppid });
  await assertRejects(() => CaseLock.acquire(dir), CaseInUseError, inUse(Deno.ppid));
  // Another machine's process can't be checked, so it counts as live.
  write({ pid: await deadPid(), host: "some-other-mac" });
  await assertRejects(() => CaseLock.acquire(dir), CaseInUseError, "on some-other-mac");
  // A process that has ended: stale, taken over.
  write({ pid: await deadPid() });
  const c = await CaseLock.acquire(dir);
  assertEquals(readLockFile(dir).pid, Deno.pid);
  // Our own pid but not a hold of ours (e.g. a copied folder): stale too.
  c.release();
  write({ pid: Deno.pid });
  (await CaseLock.acquire(dir)).release();
  assert(!lockExists(dir));

  // A file that can't be read: being written by another opener if new, stale if old.
  Deno.writeTextFileSync(path, "{");
  await assertRejects(() => CaseLock.acquire(dir), CaseInUseError);
  Deno.utimeSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  (await CaseLock.acquire(dir)).release();

  // Releasing never removes a lock that is no longer this hold's.
  const d = await CaseLock.acquire(dir);
  write({ pid: Deno.ppid });
  d.release();
  assertEquals(readLockFile(dir).pid, Deno.ppid);
});

/** Import a document with nothing to replace and share it, as the import and review screens do. */
async function sharePlain(s: CaseSession, title: string): Promise<string> {
  const doc = await s.importText({
    title,
    text: `${title}: nothing to replace here.\nA second line.`,
    origin: "mine",
  });
  const { request, unresolved } = s.defaultPublishRequest(doc);
  assertEquals(unresolved.length, 0);
  await s.publish(doc.id, request);
  return doc.id;
}

Deno.test("opening the open case again ends its session first, so that session's writes can't race the repair on open", async () => {
  // The lock is shared within one process (the app replacing its own session), so it does not
  // stop this: the app opened a second session on the case while the first was still in use.
  // The second one's repair (reconcilePublic) read the vault's list of documents, the first then
  // shared a document, and the repair withdrew it from public.db because its list did not have it.
  const t = await withCase();
  try {
    const first = t.state.session!;
    for (const title of ["Note one", "Note two", "Note three"]) await sharePlain(first, title);

    // The first session shares one more document right after the second listed the vault.
    const listDocs = CaseSession.prototype.listDocs;
    const late: { listed: boolean; id?: string; error?: unknown } = { listed: false };
    CaseSession.prototype.listDocs = async function (this: CaseSession) {
      const list = await listDocs.call(this);
      if (this !== first && !late.listed) {
        late.listed = true;
        try {
          late.id = await sharePlain(first, "Late note");
        } catch (e) {
          late.error = e;
        }
      }
      return list;
    };
    let r;
    try {
      r = await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS });
    } finally {
      CaseSession.prototype.listDocs = listDocs;
    }
    assertEquals(r.status, 200, r.text);
    const second = t.state.session!;
    assert(second !== first);
    assert(late.listed, "the second session listed the vault");

    // Whatever the vault says is shared is in public.db: no document went missing.
    for (const d of await second.listDocs()) {
      if (d.status === "published") assert(second.store.hasDocument(d.id), `${d.id} is missing`);
    }
    assertEquals(second.store.listDocuments().length, 3);
    // The first session had already been closed: it could not share anything meanwhile.
    assert(late.error !== undefined, `the replaced session still shared ${late.id}`);

    // A wrong passphrase never ends the open session.
    const wrong = await t.other.post("/api/case/open", { dir: t.caseDir, passphrase: "not it" });
    assertEquals(wrong.status, 401, wrong.text);
    assert(t.state.session === second, "still open");
    assertEquals(second.store.listDocuments().length, 3);
  } finally {
    await t.state.shutdown();
    await Deno.remove(t.root, { recursive: true });
  }
});
