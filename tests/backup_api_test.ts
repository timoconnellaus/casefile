/**
 * The encrypted single-file backup through the app (ADR 29): making one from Settings, the folder
 * remembered as the next default, and restoring one from the unlock screen into a new case.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { verifyBackup } from "../src/core/backupfile.ts";
import { importAndPublish, PASS, withCase } from "./helpers/app.ts";
import { AFFIDAVIT, AFFIDAVIT_TITLE } from "./fixtures/synthetic.ts";

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) out.push(e.name);
  return out.sort();
}

Deno.test("Back up now: one file in the folder typed, remembered for next time, logged as counts", async () => {
  const t = await withCase();
  await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  assertEquals((await t.user.get("/api/backup")).json, { lastAt: null, folder: null });

  // The folder is typed as the user would, under their home folder.
  const usb = join(t.root, "usb");
  await Deno.mkdir(usb);
  const r = await t.user.post("/api/backup", { folder: "~/usb" });
  assertEquals(r.status, 200, r.text);
  assertMatch(r.json.file, /^casefile-backup-\d{4}-\d\d-\d\d-\d{6}\.casefile-backup$/);
  assertEquals(r.json.folder, await Deno.realPath(usb));
  assertEquals(await files(usb), [r.json.file]);
  assertEquals((await verifyBackup(join(usb, r.json.file), { passphrase: PASS })).files > 3, true);

  // The last backup is recorded in the case's vault; the folder in the app's config, as typed.
  const st = (await t.user.get("/api/backup")).json;
  assertEquals(st, { lastAt: r.json.lastAt, folder: "~/usb" });
  const config = JSON.parse(await Deno.readTextFile(join(t.root, "config", "config.json")));
  assertEquals(config.lastBackupDir, "~/usb");
  assert((await t.state.session!.vault.list()).includes("backups"));

  // The log has the counts only: no folder, no file name.
  const row = t.state.session!.store.listLog(50).find((l) => l.action === "case_backed_up")!;
  assertEquals(Object.keys(JSON.parse(row.detail)).sort(), ["bytes", "files"]);
  assert(!row.detail.includes("usb") && !row.detail.includes("casefile-backup"));

  // The temporary copy of public.db, made in the app's folder, is gone.
  assertEquals(await files(join(t.root, "config", "tmp")), []);
  t.state.lock();
});

Deno.test("Back up now refuses a folder that isn't there, or is inside the case folder", async () => {
  const t = await withCase();
  const bad = async (folder: unknown, text: string) => {
    const r = await t.user.post("/api/backup", { folder });
    assertEquals(r.status, 400, r.text);
    assert(r.json.error.includes(text), r.json.error);
  };
  await bad("", "Missing folder");
  await bad("   ", "Type the folder");
  await bad(join(t.root, "nowhere"), "can't find that folder");
  await bad(t.caseDir, "outside the case folder");
  await bad(join(t.caseDir, "vault"), "outside the case folder");
  // A link from elsewhere into the case folder is still the case folder.
  await Deno.symlink(t.caseDir, join(t.root, "link"));
  await bad(join(t.root, "link"), "outside the case folder");
  // A file is not a folder.
  await Deno.writeTextFile(join(t.root, "file"), "x");
  await bad(join(t.root, "file"), "can't find that folder");
  assertEquals((await t.user.get("/api/backup")).json.lastAt, null);
  t.state.lock();
});

Deno.test("Back up now needs the signed-in user", async () => {
  const t = await withCase();
  await Deno.mkdir(join(t.root, "usb"));
  assertEquals((await t.other.post("/api/backup", { folder: join(t.root, "usb") })).status, 401);
  await t.state.lock();
  assertEquals((await t.user.post("/api/backup", { folder: join(t.root, "usb") })).status, 423);
  assertEquals(await files(join(t.root, "usb")), []);
});
