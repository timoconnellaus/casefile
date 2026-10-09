/**
 * The encrypted single-file backup (ADR 29): the format, its encryption with the case's own data
 * key, and restoring it. The restore path is the risky part, so most of this file is about what a
 * restore refuses and that a refused restore leaves nothing behind. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  BACKUP_MAGIC,
  BackupDamagedError,
  BackupTooNewError,
  FRAME_SIZE,
  NotABackupError,
  readBackupHeader,
  restoreBackup,
  RestoreTargetError,
  type Snapshot,
  verifyBackup,
  writeBackup,
  writeBackupFile,
} from "../src/core/backupfile.ts";
import { CaseSession } from "../src/core/session.ts";
import {
  backupKeyFrom,
  MalformedRecoveryKeyError,
  unwrapKeyFile,
  WrongPassphraseError,
  WrongRecoveryKeyError,
} from "../src/core/vault.ts";
import { PASS, publishedCase } from "./fixtures/case.ts";
import { SECRETS, tempDir } from "./fixtures/synthetic.ts";

const NEW_PASS = "another long passphrase";

/** The log problems a session has recorded, and any it logged (ADR 8). Both must be none. */
function logProblems(s: CaseSession) {
  const logged = s.store.db.prepare(
    "SELECT action FROM ai_log WHERE action IN ('log_problem_found', 'log_head_lost')",
  ).all();
  return [...(s.settings.logProblems ?? []), ...logged];
}

/** A published case with a recovery key, backed up into a folder of its own. */
async function backedUp(opts: { recovery?: boolean; big?: boolean } = {}) {
  const { dir, s, docId } = await publishedCase();
  const recoveryKey = opts.recovery === false ? null : await s.vault.setRecoveryKey(1_000);
  if (opts.big) {
    // More than two frames' worth, so frames can be dropped and swapped.
    const big = new Uint8Array(FRAME_SIZE * 2 + 1234);
    for (let i = 0; i < big.length; i += 65536) {
      crypto.getRandomValues(big.subarray(i, Math.min(big.length, i + 65536)));
    }
    await s.vault.write("original-big", big);
  }
  const out = await tempDir("casefile-backups-");
  const r = await writeBackup(s, out, { tmpDir: join(out, ".tmp"), app: "0.9.0" });
  return { dir, s, docId, recoveryKey, out, file: r.path, written: r };
}

/** Everything in a folder, recursively, as relative paths. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for await (const e of Deno.readDir(d)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory) await walk(join(d, e.name), r);
    }
  };
  await walk(dir, "");
  return out.sort();
}

/** Restoring must leave nothing behind in `parent` but what was there before. */
async function assertRefusedCleanly(
  parent: string,
  before: string[],
  fn: () => Promise<unknown>,
  // deno-lint-ignore no-explicit-any
  err: new (...a: any[]) => Error,
) {
  await assertRejects(fn, err);
  assertEquals(await tree(parent), before, "a refused restore leaves nothing behind");
}

Deno.test("a backup is one file: the header, then encrypted frames with no case content in the clear", async () => {
  const { s, file, written, recoveryKey } = await backedUp();
  assert(written.path.endsWith(".casefile-backup"));
  assert(/casefile-backup-\d{4}-\d\d-\d\d-\d{6}\.casefile-backup$/.test(written.path));
  const bytes = await Deno.readFile(file);
  assertEquals(new TextDecoder().decode(bytes.subarray(0, 16)), BACKUP_MAGIC);
  assertEquals(written.bytes, bytes.length);
  const text = new TextDecoder("latin1").decode(bytes);
  for (const secret of SECRETS) assert(!text.includes(secret), `"${secret}" is in the clear`);
  // Nor anything Claude can read: the tokenised text, the case's name, the file names inside.
  for (const plain of ["{{mother", "Test matter", "public.db", "settings.enc", "SQLite format"]) {
    assert(!text.includes(plain), `"${plain}" is in the clear`);
  }
  const { header } = await readBackupHeader(file);
  assertEquals(header.app, "0.9.0");
  assertEquals(header.publicDbSchema, 4);
  // The header carries the case's own keyfile: the passphrase wrap and the recovery wrap.
  assertEquals(header.keyfile, await s.vault.keyFile());
  const kf = header.keyfile as { recovery?: unknown; version: number };
  assertEquals(kf.version, 2);
  assert(kf.recovery);
  // Either secret checks the whole backup.
  assertEquals((await verifyBackup(file, { passphrase: PASS })).files, written.files);
  assertEquals((await verifyBackup(file, { recoveryKey: recoveryKey! })).files, written.files);
  // Not a temporary file left beside it.
  assertEquals((await tree(join(file, ".."))).filter((n) => n.includes("partial")), []);
  await s.closeSettled();
});

Deno.test("the backup key is derived from the data key, not the data key itself", async () => {
  const { s, file } = await backedUp();
  const { header } = await readBackupHeader(file);
  const raw = await unwrapKeyFile(header.keyfile, { passphrase: PASS });
  const backupKey = await backupKeyFrom(raw);
  // A vault file can't be opened with the backup key (it is a different key).
  const enc = await Deno.readFile(join(s.paths.vaultDir, "settings.enc"));
  await assertRejects(() =>
    crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: enc.slice(0, 12),
        additionalData: new TextEncoder().encode("settings"),
      },
      backupKey,
      enc.slice(12),
    )
  );
  await s.closeSettled();
});

Deno.test("restore with the passphrase: a separate case that opens with it, as it was", async () => {
  const { s, file, docId, written } = await backedUp();
  const docsBefore = await s.listDocInfo();
  const bodyBefore = s.store.getDocument(docId).body;
  const logBefore = s.store.db.prepare("SELECT id, action, chain FROM ai_log ORDER BY id").all();
  const original = s.paths.root;
  await s.closeSettled();
  const originalFiles = await tree(original);

  const parent = await tempDir("casefile-restore-");
  const target = join(parent, "restored");
  const r = await restoreBackup(file, target, { passphrase: PASS });
  assertEquals(r.root, target);
  assertEquals(r.files, written.files);
  assert(!(await tree(parent)).some((n) => n.includes("restoring")), "no staging folder left");
  // Only casefile's own files: no lock, no generated Claude Code files until it is opened.
  const restored = await tree(target);
  assert(restored.includes("case.json") && restored.includes("public.db"));
  assert(restored.includes("vault/keyfile.json") && restored.includes("vault/settings.enc"));
  assert(!restored.includes(".casefile-lock") && !restored.includes("CLAUDE.md"));

  const back = await CaseSession.open(target, PASS);
  try {
    assertEquals(
      (await back.listDocInfo()).map((d) => [d.id, d.state]),
      docsBefore.map((d) => [d.id, d.state]),
    );
    assertEquals(back.store.getDocument(docId).body, bodyBefore);
    // Who's who came back too: the tokens read as the names again.
    const plain = back.reidentify(bodyBefore!).text;
    assert(plain.includes("Anna Thornbury") && !bodyBefore!.includes("Anna"));
    // The log carries on from the backup: the same rows, then this opening, and no problems.
    const rows = back.store.db.prepare("SELECT id, action, chain FROM ai_log ORDER BY id").all();
    assertEquals(rows.slice(0, logBefore.length), logBefore);
    assertEquals(logProblems(back), []);
    // Opening wrote the generated files again.
    assert((await tree(target)).includes("CLAUDE.md"));
  } finally {
    await back.closeSettled();
  }
  // The original is untouched by the restore.
  assertEquals(await tree(original), originalFiles);
  const again = await CaseSession.open(original, PASS);
  assertEquals(logProblems(again), []);
  await again.closeSettled();
});

Deno.test("restore with the recovery key sets a new passphrase on the restored case only", async () => {
  const { s, file, recoveryKey } = await backedUp();
  const original = s.paths.root;
  await s.closeSettled();
  const parent = await tempDir("casefile-restore-");
  const target = join(parent, "restored");

  await assertRejects(
    () => restoreBackup(file, target, { recoveryKey: recoveryKey! }),
    Error,
    "new passphrase",
  );
  await restoreBackup(file, target, { recoveryKey: recoveryKey! }, {
    newPassphrase: NEW_PASS,
    kdfIterations: 1_000,
  });
  await assertRejects(() => CaseSession.open(target, PASS), WrongPassphraseError);
  const back = await CaseSession.open(target, NEW_PASS);
  await back.closeSettled();
  // The recovery key still opens the restored case's vault, and the original keeps its passphrase.
  const orig = await CaseSession.open(original, PASS);
  await orig.closeSettled();
});

Deno.test("a wrong passphrase or recovery key restores nothing", async () => {
  const { s, file, recoveryKey } = await backedUp();
  await s.closeSettled();
  const parent = await tempDir("casefile-restore-");
  const target = join(parent, "restored");
  const before = await tree(parent);
  await assertRefusedCleanly(
    parent,
    before,
    () => restoreBackup(file, target, { passphrase: "not the passphrase" }),
    WrongPassphraseError,
  );
  // A recovery key with one character changed.
  const wrong = recoveryKey!.replace(/^./, (c) => (c === "A" ? "B" : "A"));
  await assertRefusedCleanly(
    parent,
    before,
    () => restoreBackup(file, target, { recoveryKey: wrong }, { newPassphrase: NEW_PASS }),
    WrongRecoveryKeyError,
  );
  await assertRefusedCleanly(
    parent,
    before,
    () => restoreBackup(file, target, { recoveryKey: "not a key" }, { newPassphrase: NEW_PASS }),
    MalformedRecoveryKeyError,
  );
});

Deno.test("a backup of a case without a recovery key refuses every recovery key", async () => {
  const { s, file } = await backedUp({ recovery: false });
  const key = await s.vault.setRecoveryKey(1_000); // made after the backup: not in it
  await s.closeSettled();
  const parent = await tempDir("casefile-restore-");
  await assertRefusedCleanly(
    parent,
    [],
    () => restoreBackup(file, join(parent, "r"), { recoveryKey: key }, { newPassphrase: NEW_PASS }),
    WrongRecoveryKeyError,
  );
  // The passphrase it had then still restores it.
  await restoreBackup(file, join(parent, "r"), { passphrase: PASS });
});

Deno.test("a passphrase changed after the backup: the backup needs the one it was made with", async () => {
  const { s, file } = await backedUp();
  await s.vault.changePassphrase(NEW_PASS, 1_000);
  await s.closeSettled();
  const parent = await tempDir("casefile-restore-");
  await assertRejects(
    () => restoreBackup(file, join(parent, "r"), { passphrase: NEW_PASS }),
    WrongPassphraseError,
  );
  await restoreBackup(file, join(parent, "r"), { passphrase: PASS });
});

/** Damage the backup with `fn` and expect a clean refusal with `err`. */
async function damaged(
  name: string,
  fn: (b: Uint8Array, headerEnd: number) => Uint8Array,
  // deno-lint-ignore no-explicit-any
  err: new (...a: any[]) => Error = BackupDamagedError,
) {
  const { s, file } = await backedUp({ big: true });
  await s.closeSettled();
  const { length } = await readBackupHeader(file);
  const bytes = await Deno.readFile(file);
  const bad = join(await tempDir(), "bad.casefile-backup");
  await Deno.writeFile(bad, fn(bytes, length));
  const parent = await tempDir("casefile-restore-");
  await Deno.mkdir(join(parent, "empty"));
  const before = await tree(parent);
  for (const target of ["new", "empty"]) {
    await assertRejects(
      () => restoreBackup(bad, join(parent, target), { passphrase: PASS }),
      err,
      undefined,
      name,
    );
    assertEquals(await tree(parent), before, `${name}: nothing left behind`);
  }
}

/** Offsets of each frame (its flag byte) after the header. */
function frames(b: Uint8Array, headerEnd: number): number[] {
  const out: number[] = [];
  for (let off = headerEnd; off < b.length;) {
    out.push(off);
    off += 5 + new DataView(b.buffer, b.byteOffset + off + 1, 4).getUint32(0);
  }
  return out;
}

Deno.test("a damaged backup restores nothing: one changed byte anywhere in the frames", async () => {
  await damaged("byte in first frame", (b, h) => {
    const c = b.slice();
    c[h + 40] ^= 1;
    return c;
  });
  await damaged("byte in the middle", (b) => {
    const c = b.slice();
    c[Math.floor(c.length / 2)] ^= 0x80;
    return c;
  });
  await damaged("byte in the last tag", (b) => {
    const c = b.slice();
    c[c.length - 1] ^= 1;
    return c;
  });
  await damaged("last-frame flag cleared", (b, h) => {
    const c = b.slice();
    const f = frames(c, h);
    c[f[f.length - 1]] = 0;
    return c;
  });
});

Deno.test("a damaged backup restores nothing: the header changed", async () => {
  // The header is bound into every frame: a changed date fails the first frame.
  await damaged("createdAt changed", (b) => {
    const text = new TextDecoder("latin1").decode(b);
    const i = text.indexOf('"createdAt":"') + 13;
    const c = b.slice();
    c[i + 3] = c[i + 3] === 0x39 ? 0x38 : c[i + 3] + 1;
    return c;
  });
  await damaged("not JSON", (b) => {
    const c = b.slice();
    c[20] = 0x7b;
    c[21] = 0x7b;
    return c;
  }, NotABackupError);
  await damaged("header length too long", (b) => {
    const c = b.slice();
    new DataView(c.buffer).setUint32(16, 0x7fffffff);
    return c;
  }, NotABackupError);
});

Deno.test("a cut-short or padded backup restores nothing", async () => {
  await damaged("cut in the last frame", (b) => b.slice(0, b.length - 7));
  await damaged("cut in the middle", (b) => b.slice(0, Math.floor(b.length / 2)));
  await damaged("last frame missing", (b, h) => {
    const f = frames(b, h);
    return b.slice(0, f[f.length - 1]);
  });
  await damaged("only the header", (b, h) => b.slice(0, h));
  await damaged("header cut", (b, h) => b.slice(0, h - 5), NotABackupError);
  await damaged("more after the end", (b) => {
    const c = new Uint8Array(b.length + 3);
    c.set(b);
    return c;
  });
});

Deno.test("a backup with frames dropped, repeated or swapped restores nothing", async () => {
  const cut = (b: Uint8Array, h: number, order: (f: number[]) => number[]) => {
    const f = frames(b, h);
    const ends = [...f.slice(1), b.length];
    const parts = order(f.map((_, i) => i)).map((i) => b.slice(f[i], ends[i]));
    const out = new Uint8Array(h + parts.reduce((n, p) => n + p.length, 0));
    out.set(b.slice(0, h));
    let off = h;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  };
  await damaged("a middle frame dropped", (b, h) => cut(b, h, (f) => [f[0], ...f.slice(2)]));
  await damaged("the first frame repeated", (b, h) => cut(b, h, (f) => [f[0], ...f]));
  await damaged("two frames swapped", (b, h) => cut(b, h, (f) => [f[1], f[0], ...f.slice(2)]));
});

Deno.test("files that aren't backups are refused as such", async () => {
  const dir = await tempDir();
  const parent = await tempDir("casefile-restore-");
  for (
    const [name, data] of [
      ["empty", new Uint8Array(0)],
      ["text", new TextEncoder().encode("hello, this is not a backup at all")],
      ["sqlite", new TextEncoder().encode("SQLite format 3\0" + "x".repeat(100))],
    ] as const
  ) {
    const p = join(dir, name);
    await Deno.writeFile(p, data);
    await assertRefusedCleanly(
      parent,
      [],
      () => restoreBackup(p, join(parent, "r"), { passphrase: PASS }),
      NotABackupError,
    );
  }
  await assertRejects(
    () => restoreBackup(join(dir, "missing"), join(parent, "r"), { passphrase: PASS }),
    Deno.errors.NotFound,
  );
});

Deno.test("restore goes only into a new or empty folder, never over a case or inside one", async () => {
  const { s, file, dir } = await backedUp();
  const parent = await tempDir("casefile-restore-");

  // Not empty: refused, and what was there is untouched.
  const full = join(parent, "full");
  await Deno.mkdir(full);
  await Deno.writeTextFile(join(full, "notes.txt"), "mine");
  await assertRejects(
    () => restoreBackup(file, full, { passphrase: PASS }),
    RestoreTargetError,
    "isn't empty",
  );
  assertEquals(await Deno.readTextFile(join(full, "notes.txt")), "mine");
  // Over the case itself (open or not).
  await assertRejects(() => restoreBackup(file, dir, { passphrase: PASS }), RestoreTargetError);
  await s.closeSettled();
  const originalFiles = await tree(dir);
  await assertRejects(() => restoreBackup(file, dir, { passphrase: PASS }), RestoreTargetError);
  assertEquals(await tree(dir), originalFiles, "the case is untouched");
  // A file, not a folder.
  await Deno.writeTextFile(join(parent, "file"), "x");
  await assertRejects(
    () => restoreBackup(file, join(parent, "file"), { passphrase: PASS }),
    RestoreTargetError,
  );
  // A new folder inside a case folder: that case's Claude could read it.
  await assertRejects(
    () => restoreBackup(file, join(dir, "restored"), { passphrase: PASS }),
    RestoreTargetError,
    "inside a case",
  );
  assertEquals(await tree(dir), originalFiles);
  // A symbolic link to an empty folder is not an empty folder.
  await Deno.mkdir(join(parent, "elsewhere"));
  await Deno.symlink(join(parent, "elsewhere"), join(parent, "link"));
  await assertRejects(
    () => restoreBackup(file, join(parent, "link"), { passphrase: PASS }),
    RestoreTargetError,
  );
  // An empty folder is fine, as is a new one whose parents don't exist yet.
  await Deno.mkdir(join(parent, "empty"));
  await restoreBackup(file, join(parent, "empty"), { passphrase: PASS });
  await restoreBackup(file, join(parent, "a", "b", "c"), { passphrase: PASS });
  // Restoring the same backup twice gives two separate cases.
  const one = await CaseSession.open(join(parent, "empty"), PASS);
  const two = await CaseSession.open(join(parent, "a", "b", "c"), PASS);
  one.log("user", "only_in_one", {});
  await one.settled();
  assertNotEquals(
    two.store.db.prepare("SELECT COUNT(*) AS n FROM ai_log WHERE action = 'only_in_one'").get(),
    one.store.db.prepare("SELECT COUNT(*) AS n FROM ai_log WHERE action = 'only_in_one'").get(),
  );
  await one.closeSettled();
  await two.closeSettled();
});

/** Build a backup as an older casefile made it: public.db at schema v3 (ADR 22's frozen file). */
async function v3Backup() {
  const { dir, s } = await publishedCase();
  const docs = (await s.listDocInfo()).map((d) => [d.id, d.state]);
  await s.closeSettled();
  const files = [];
  files.push({ path: "case.json", data: await Deno.readFile(join(dir, "case.json")) });
  for await (const e of Deno.readDir(join(dir, "vault"))) {
    if (e.name.endsWith(".enc")) {
      files.push({
        path: `vault/${e.name}`,
        data: await Deno.readFile(join(dir, "vault", e.name)),
      });
    }
  }
  // A v3 public.db holding the case's log (so its chain still leads on from the vault's head),
  // and no documents: opening repairs public.db from the vault.
  const v3 = join(await tempDir(), "v3.db");
  const db = new DatabaseSync(v3);
  db.exec(
    await Deno.readTextFile(fromFileUrl(new URL("./fixtures/schemas/v3.sql", import.meta.url))),
  );
  // (Row by row: Deno turns SQLite's ATTACH off without every permission.)
  const cur = new DatabaseSync(join(dir, "public.db"), { readOnly: true });
  const ins = db.prepare(
    "INSERT INTO ai_log (id, ts, actor, action, detail, chain, chain_kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (
    const r of cur.prepare(
      "SELECT id, ts, actor, action, detail, chain, chain_kind FROM ai_log ORDER BY id",
    ).all() as Record<string, string | number | null>[]
  ) ins.run(r.id, r.ts, r.actor, r.action, r.detail, r.chain, r.chain_kind);
  for (
    const r of cur.prepare("SELECT key, value FROM case_info").all() as Record<string, string>[]
  ) {
    db.prepare("INSERT INTO case_info (key, value) VALUES (?, ?)").run(r.key, r.value);
  }
  cur.close();
  assertEquals(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    3,
  );
  db.close();
  files.push({ path: "public.db", data: await Deno.readFile(v3) });
  const keyfile = JSON.parse(await Deno.readTextFile(join(dir, "vault", "keyfile.json")));
  const snap: Snapshot = { files, keyfile, schema: 3 };
  const key = await backupKeyFrom(await unwrapKeyFile(keyfile, { passphrase: PASS }));
  const file = join(await tempDir(), "old.casefile-backup");
  await writeBackupFile(file, snap, key, { createdAt: "2026-06-01T00:00:00.000Z", app: "0.1.0" });
  return { file, docs, key, snap, keyfile };
}

Deno.test("a backup from an older schema restores and is brought up to date when opened", async () => {
  const { file, docs } = await v3Backup();
  const parent = await tempDir("casefile-restore-");
  const target = join(parent, "restored");
  const r = await restoreBackup(file, target, { passphrase: PASS });
  assertEquals(r.header.publicDbSchema, 3);
  const db = new DatabaseSync(join(target, "public.db"), { readOnly: true });
  assertEquals(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    3,
  );
  db.close();
  const back = await CaseSession.open(target, PASS);
  try {
    assertEquals(
      (back.store.db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
      4,
    );
    assertEquals((await back.listDocInfo()).map((d) => [d.id, d.state]), docs);
    // Repaired from the vault: the shared document's text is back in public.db.
    assertEquals(back.store.listDocuments().length, docs.length);
    assertEquals(logProblems(back), []);
  } finally {
    await back.closeSettled();
  }
});

Deno.test("a backup from a newer casefile is refused before anything is written", async () => {
  const { snap, key } = await v3Backup();
  const file = join(await tempDir(), "new.casefile-backup");
  // Written as a future casefile would: public.db v99.
  await assertRejects(
    () => writeBackupFile(file, { ...snap, schema: 99 }, key, { createdAt: "x", app: "9.0.0" }),
    BackupTooNewError,
  );
  // writeBackupFile checks what it wrote, so build the future file by hand from a v3 one.
  const ok = join(await tempDir(), "ok.casefile-backup");
  await writeBackupFile(ok, snap, key, { createdAt: "2026-06-01T00:00:00.000Z", app: "0.1.0" });
  const bytes = await Deno.readFile(ok);
  const text = new TextDecoder("latin1").decode(bytes);
  const i = text.indexOf('"publicDbSchema":3') + '"publicDbSchema":'.length;
  const future = bytes.slice();
  future[i] = 0x39; // "9"
  await Deno.writeFile(file, future);
  const parent = await tempDir("casefile-restore-");
  await assertRefusedCleanly(
    parent,
    [],
    () => restoreBackup(file, join(parent, "r"), { passphrase: PASS }),
    BackupTooNewError,
  );
});

Deno.test("a keyfile swapped in the header can't pass off another key", async () => {
  // Someone who can write the backup replaces its keyfile with one wrapping a key of their own,
  // under a passphrase they know. The frames were not made with that key, so nothing restores.
  const { s, file } = await backedUp();
  await s.closeSettled();
  const other = await publishedCase();
  const otherKeyfile = await other.s.vault.keyFile();
  await other.s.closeSettled();
  const bytes = await Deno.readFile(file);
  const { header, length } = await readBackupHeader(file);
  const json = new TextEncoder().encode(JSON.stringify({ ...header, keyfile: otherKeyfile }));
  const forged = new Uint8Array(20 + json.length + (bytes.length - length));
  forged.set(bytes.subarray(0, 16));
  new DataView(forged.buffer).setUint32(16, json.length);
  forged.set(json, 20);
  forged.set(bytes.subarray(length), 20 + json.length);
  const bad = join(await tempDir(), "forged.casefile-backup");
  await Deno.writeFile(bad, forged);
  const parent = await tempDir("casefile-restore-");
  await assertRefusedCleanly(
    parent,
    [],
    () => restoreBackup(bad, join(parent, "r"), { passphrase: PASS }),
    BackupDamagedError,
  );
});

Deno.test("the backup holds the case as at one moment, while the CLI writes", async () => {
  // A CLI connection writes to public.db while the backup is taken; the copy is whole.
  const { s } = await publishedCase();
  const cli = new DatabaseSync(s.paths.publicDb);
  const out = await tempDir("casefile-backups-");
  const writing = (async () => {
    for (let i = 0; i < 50; i++) {
      cli.prepare(
        "INSERT INTO ai_log (ts, actor, action, detail) VALUES ('t', 'claude', 'cli_test', '{}')",
      ).run();
      await new Promise((r) => setTimeout(r, 0));
    }
  })();
  const r = await writeBackup(s, out, { tmpDir: join(out, ".tmp"), app: null });
  await writing;
  cli.close();
  await s.closeSettled();
  const parent = await tempDir("casefile-restore-");
  await restoreBackup(r.path, join(parent, "r"), { passphrase: PASS });
  const db = new DatabaseSync(join(parent, "r", "public.db"), { readOnly: true });
  assertEquals(
    (db.prepare("PRAGMA integrity_check").get() as Record<string, string>)
      .integrity_check,
    "ok",
  );
  db.close();
  const back = await CaseSession.open(join(parent, "r"), PASS);
  assertEquals(logProblems(back), []);
  await back.closeSettled();
  // The temporary copy of public.db is gone.
  assertEquals(await tree(join(out, ".tmp")), []);
});
