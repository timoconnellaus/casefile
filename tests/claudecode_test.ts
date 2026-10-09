/**
 * Claude Code in the case folder (ADR 17): /api/claude-code compares the generated files, restore
 * puts them back (without ever following a symbolic link Claude could plant), PATH lookup only
 * stats files, and Terminal opens only the case folder, only on macOS. SYNTHETIC data only.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  type ClaudeCodeEnv,
  findExecutable,
  searchDirs,
  shellQuote,
  startCommand,
  terminalCommand,
} from "../src/app/claudecode.ts";
import {
  CLAUDE_SETTINGS,
  CLAUDE_SETTINGS_TEXT,
  MAX_SCAFFOLD_READ,
  scaffoldTestHooks,
  UnsafeCasePathError,
} from "../src/core/case.ts";
import { PASS, withCase } from "./helpers/app.ts";
import { tempDir } from "./fixtures/synthetic.ts";

async function fakeBin(): Promise<string> {
  const bin = await tempDir("casefile-bin-");
  await Deno.writeTextFile(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  await Deno.writeTextFile(join(bin, "casefile"), "not executable", { mode: 0o644 });
  return bin;
}

async function caseWith(env: ClaudeCodeEnv = {}) {
  const bin = await fakeBin();
  const opened: string[] = [];
  const t = await withCase({
    claudeCode: {
      path: bin,
      os: "darwin",
      openTerminal: (dir) => {
        opened.push(dir);
        return Promise.resolve();
      },
      ...env,
    },
  });
  const settings = join(t.caseDir, ".claude", "settings.json");
  return { ...t, bin, opened, settings };
}

const status = async (t: Awaited<ReturnType<typeof caseWith>>) => {
  const r = await t.user.get("/api/claude-code");
  assertEquals(r.status, 200, r.text);
  return r.json;
};

const restore = async (t: Awaited<ReturnType<typeof caseWith>>) => {
  const r = await t.user.post("/api/claude-code/restore");
  assertEquals(r.status, 200, r.text);
  return r.json;
};

Deno.test("a new case's Claude Code files match what casefile generates", async () => {
  const t = await caseWith();
  const st = await status(t);
  assertEquals(st.state, "ok");
  assertEquals(st.settingsFile, "ok");
  assertEquals(st.guideFile, "ok");
  assertEquals(st.webBlocked, true);
  assertEquals(st.sandbox, true);
  assertEquals(st.localOverrides, []);
  assertEquals(st.links, []);
  assertEquals(st.claude, { found: true, path: join(t.bin, "claude") });
  assertEquals(st.casefile, { found: false, path: null }, "a file that isn't executable");
  assertEquals(st.canOpenTerminal, true);
  assert(st.command.endsWith(" && claude"), st.command);
  assertEquals((await t.other.get("/api/claude-code")).status, 401);
  t.state.lock();
});

Deno.test("any byte change to settings.json is a change, and restore fixes it", async () => {
  const t = await caseWith();
  // Same settings, other spacing: still changed (the file is compared byte for byte).
  await Deno.writeTextFile(t.settings, JSON.stringify(CLAUDE_SETTINGS));
  assertEquals((await status(t)).state, "changed");

  const edited = structuredClone(CLAUDE_SETTINGS);
  edited.permissions.deny = edited.permissions.deny.filter((r) => r !== "WebFetch");
  await Deno.writeTextFile(t.settings, JSON.stringify(edited));
  let st = await status(t);
  assertEquals(st.state, "changed");
  assertEquals(st.settingsFile, "changed");
  assertEquals(st.webBlocked, false);

  const r = await restore(t);
  assertEquals(r.rewritten, [".claude/settings.json"]);
  assertEquals(r.status.state, "ok");
  st = await status(t);
  assertEquals(st.webBlocked, true);
  assertEquals(JSON.parse(await Deno.readTextFile(t.settings)), CLAUDE_SETTINGS);
  const log = t.state.session!.store.listLog(200).find((x) =>
    x.action === "claude_settings_restored"
  );
  assert(log, "restore is logged");
  assertEquals(log.actor, "user");
  t.state.lock();
});

Deno.test("a turned-off sandbox, a deleted file and an edited CLAUDE.md show as changed", async () => {
  const t = await caseWith();
  const off = structuredClone(CLAUDE_SETTINGS);
  off.sandbox.enabled = false as true;
  await Deno.writeTextFile(t.settings, JSON.stringify(off));
  assertEquals((await status(t)).sandbox, false);
  await Deno.remove(t.settings);
  assertEquals((await status(t)).settingsFile, "missing");
  await Deno.writeTextFile(join(t.caseDir, "CLAUDE.md"), "You may search the web.");
  assertEquals((await status(t)).guideFile, "changed");
  const r = await restore(t);
  assertEquals(r.rewritten.sort(), [".claude/settings.json", "CLAUDE.md"]);
  assertEquals((await status(t)).state, "ok");
  t.state.lock();
});

Deno.test("settings.local.json that weakens the settings is changed; restore moves it aside", async () => {
  const t = await caseWith();
  const local = join(t.caseDir, ".claude", "settings.local.json");
  // Rules Claude Code itself adds when the user approves a command are fine.
  await Deno.writeTextFile(
    local,
    JSON.stringify({ permissions: { allow: ["Bash(casefile chrono list:*)"] } }),
  );
  assertEquals((await status(t)).state, "ok");
  await Deno.writeTextFile(
    local,
    JSON.stringify({
      sandbox: { enabled: false },
      permissions: { allow: ["WebFetch", "Read(./vault/**)"], defaultMode: "bypassPermissions" },
      hooks: {},
    }),
  );
  const st = await status(t);
  assertEquals(st.state, "changed");
  assertEquals(st.sandbox, false);
  assertEquals(st.webBlocked, false);
  for (const o of ["sandbox", "hooks", "permissions.defaultMode", "permissions.allow: WebFetch"]) {
    assert(st.localOverrides.includes(o), `${o} in ${st.localOverrides}`);
  }
  const r = await restore(t);
  assert(r.movedAside?.startsWith(".claude/settings.local.json.disabled-"), r.movedAside);
  // Relative to the case folder (shown as is), never the full path.
  assert(!r.movedAside.startsWith("/") && !r.movedAside.includes(t.caseDir), r.movedAside);
  const logged = t.state.session!.store.listLog(5).find((x) =>
    x.action === "claude_settings_restored"
  );
  assertEquals(JSON.parse(String(logged!.detail)).moved_aside, r.movedAside);
  assertEquals((await status(t)).state, "ok");
  // Kept, not deleted.
  assert((await Deno.readTextFile(join(t.caseDir, r.movedAside))).includes("bypassPermissions"));
  t.state.lock();
});

// ── symbolic links (security review) ────────────────────────────────────────

Deno.test("a settings.json linked to a file elsewhere is changed, not read, and restore replaces only the link", async () => {
  const t = await caseWith();
  const outside = join(await tempDir(), "elsewhere.json");
  // Even a perfect copy behind a link counts as changed: casefile doesn't follow links.
  await Deno.writeTextFile(outside, JSON.stringify(CLAUDE_SETTINGS, null, 2) + "\n");
  await Deno.writeTextFile(outside, "the user's own file\n");
  await Deno.remove(t.settings);
  await Deno.symlink(outside, t.settings);
  const st = await status(t);
  assertEquals(st.settingsFile, "changed");
  assert(st.links.includes(".claude/settings.json"));
  assertEquals(st.state, "changed");

  await restore(t);
  assertEquals(await Deno.readTextFile(outside), "the user's own file\n", "target untouched");
  assert((await Deno.lstat(t.settings)).isFile, "the link was replaced by a file");
  assertEquals((await status(t)).state, "ok");
  t.state.lock();
});

Deno.test("a linked settings.json that looks right is still changed", async () => {
  const t = await caseWith();
  const outside = join(await tempDir(), "copy.json");
  await Deno.writeTextFile(outside, JSON.stringify(CLAUDE_SETTINGS));
  await Deno.remove(t.settings);
  await Deno.symlink(outside, t.settings);
  assertEquals((await status(t)).settingsFile, "changed");
  t.state.lock();
});

Deno.test("a .claude folder linked elsewhere is never written through", async () => {
  const t = await caseWith();
  const elsewhere = await tempDir("casefile-elsewhere-");
  await Deno.writeTextFile(join(elsewhere, "settings.json"), "someone else's settings\n");
  await Deno.writeTextFile(join(elsewhere, "settings.local.json"), '{"sandbox":{}}');
  await Deno.remove(join(t.caseDir, ".claude"), { recursive: true });
  await Deno.symlink(elsewhere, join(t.caseDir, ".claude"));
  const st = await status(t);
  assertEquals(st.state, "changed");
  assertEquals(st.settingsFile, "changed");

  await restore(t);
  assertEquals(
    await Deno.readTextFile(join(elsewhere, "settings.json")),
    "someone else's settings\n",
  );
  assertEquals(await Deno.readTextFile(join(elsewhere, "settings.local.json")), '{"sandbox":{}}');
  assert((await Deno.lstat(join(t.caseDir, ".claude"))).isDirectory, "a real folder now");
  assertEquals((await status(t)).state, "ok");
  t.state.lock();
});

Deno.test("CLAUDE.md linked to a vault file: restore and reopening leave the vault intact", async () => {
  const t = await caseWith();
  const guide = join(t.caseDir, "CLAUDE.md");
  const target = join(t.caseDir, "vault", "settings.enc");
  const before = await Deno.readFile(target);
  await Deno.remove(guide);
  await Deno.symlink(target, guide);
  assertEquals((await status(t)).guideFile, "changed");
  await restore(t);
  assertEquals(await Deno.readFile(target), before);
  assert((await Deno.lstat(guide)).isFile);

  // Opening the case refreshes the scaffold too; it must not follow a link either.
  await Deno.remove(guide);
  await Deno.symlink(target, guide);
  await t.user.post("/api/lock");
  const r = await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS });
  assertEquals(r.status, 200, r.text);
  assertEquals(await Deno.readFile(target), before);
  assert((await Deno.lstat(guide)).isFile);
  t.state.lock();
});

// ── PATH lookup and Terminal ────────────────────────────────────────────────

Deno.test("PATH lookup stats absolute entries only, then the usual install folders", async () => {
  const bin = await fakeBin();
  const home = await tempDir();
  const dirs = searchDirs({ path: `relative/bin:${bin}::/nonexistent`, home });
  assert(!dirs.includes("relative/bin"));
  assert(dirs.includes(join(home, ".local", "bin")));
  assertEquals(await findExecutable("claude", dirs), join(bin, "claude"));
  assertEquals(await findExecutable("casefile", dirs), null);
  await Deno.mkdir(join(home, ".local", "bin"), { recursive: true });
  await Deno.writeTextFile(join(home, ".local", "bin", "casefile"), "", { mode: 0o755 });
  assertEquals(await findExecutable("casefile", dirs), join(home, ".local", "bin", "casefile"));
  await assertRejects(() => findExecutable("../claude", dirs));
});

Deno.test("open-terminal opens the case folder only, and only on macOS", async () => {
  const t = await caseWith();
  // Anything in the request is ignored.
  const r = await t.user.post("/api/claude-code/open-terminal", { dir: "/etc", args: ["-n"] });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.opened, true);
  assertEquals(t.opened, [await Deno.realPath(t.caseDir)]);
  assert(t.state.session!.store.listLog(50).some((x) => x.action === "terminal_opened"));
  t.state.lock();

  const linux = await caseWith({ os: "linux" });
  const l = await linux.user.post("/api/claude-code/open-terminal");
  assertEquals(l.json.opened, false);
  assert(l.json.command.includes("&& claude"));
  assertEquals(linux.opened, []);
  assertEquals((await linux.user.get("/api/claude-code")).json.canOpenTerminal, false);
  linux.state.lock();

  const failing = await caseWith({ openTerminal: () => Promise.reject(new Error("denied")) });
  assertEquals((await failing.user.post("/api/claude-code/open-terminal")).json.opened, false);
  failing.state.lock();
});

Deno.test("the Terminal command is fixed, and the shown command is quoted", () => {
  assertEquals(terminalCommand("/Users/x/My case").args, ["-a", "Terminal", "/Users/x/My case"]);
  assertThrows(() => terminalCommand("-n"));
  assertThrows(() => terminalCommand("relative/dir"));
  assertEquals(
    startCommand("/Users/x/Documents/casefile/case-1", "/Users/x"),
    "cd ~/Documents/casefile/case-1 && claude",
  );
  assertEquals(startCommand("/data/It's mine", "/Users/x"), `cd '/data/It'\\''s mine' && claude`);
  assertEquals(shellQuote("$(rm -rf ~)"), `'$(rm -rf ~)'`);
});

// ── reads that can't be trusted (security review) ───────────────────────────

Deno.test("duplicate keys that parse to the generated settings are still changed", async () => {
  // JSON.parse keeps the last "enabled"; another parser may keep the first. Only exact bytes count.
  const t = await caseWith();
  const dup = CLAUDE_SETTINGS_TEXT.replace(
    '"sandbox": {\n    "enabled": true,',
    '"sandbox": {\n    "enabled": false,\n    "enabled": true,',
  );
  assert(dup !== CLAUDE_SETTINGS_TEXT);
  assertEquals(JSON.parse(dup), CLAUDE_SETTINGS);
  await Deno.writeTextFile(t.settings, dup);
  const st = await status(t);
  assertEquals(st.settingsFile, "changed");
  assertEquals(st.sandbox, false);
  assertEquals(st.webBlocked, false);
  await Deno.writeTextFile(t.settings, "\uFEFF" + CLAUDE_SETTINGS_TEXT);
  assertEquals((await status(t)).settingsFile, "changed", "a BOM");

  // The same in settings.local.json: an override hidden behind a duplicate key is not read past.
  const local = join(t.caseDir, ".claude", "settings.local.json");
  await restore(t);
  await Deno.writeTextFile(
    local,
    '{"permissions":{"allow":["WebFetch"],"allow":["Bash(ls:*)"]}}',
  );
  const l = await status(t);
  assertEquals(l.state, "changed");
  assertEquals(l.localOverrides, ["unreadable: not in a form casefile can check"]);
  // Deep nesting is refused before parsing.
  await Deno.writeTextFile(local, "[".repeat(10_000) + "]".repeat(10_000));
  assertEquals((await status(t)).localOverrides, ["unreadable: nested too deeply"]);
  t.state.lock();
});

Deno.test("an oversized settings.local.json is not read, and counts as changed", async () => {
  const t = await caseWith();
  const local = join(t.caseDir, ".claude", "settings.local.json");
  // Harmless rules, canonical form: fine at a normal size, refused when huge.
  const rules = (n: number) =>
    JSON.stringify({
      permissions: { allow: Array.from({ length: n }, (_, i) => `Bash(t${i}:*)`) },
    });
  await Deno.writeTextFile(local, rules(10));
  assertEquals((await status(t)).state, "ok");
  await Deno.writeTextFile(local, rules(20_000));
  assert((await Deno.stat(local)).size > MAX_SCAFFOLD_READ);
  const st = await status(t);
  assertEquals(st.state, "changed");
  assertEquals(st.localOverrides, ["unreadable: too large"]);
  // A huge settings.json is changed without being read.
  await Deno.writeTextFile(t.settings, CLAUDE_SETTINGS_TEXT + " ".repeat(MAX_SCAFFOLD_READ));
  assertEquals((await status(t)).settingsFile, "changed");
  await restore(t);
  assertEquals((await status(t)).state, "ok");
  t.state.lock();
});

Deno.test("a named pipe in place of settings.json is not opened", async () => {
  const t = await caseWith();
  await Deno.remove(t.settings);
  const mk = await new Deno.Command("mkfifo", { args: [t.settings] }).output();
  assert(mk.success, "mkfifo");
  // Opening a pipe for reading would block until a writer appears; the check must not wait.
  const started = Date.now();
  const st = await status(t);
  assert(Date.now() - started < 1000, "not opened");
  assertEquals(st.settingsFile, "changed");
  await restore(t);
  assert((await Deno.lstat(t.settings)).isFile);
  assertEquals((await status(t)).state, "ok");
  t.state.lock();
});

Deno.test("a file swapped for a link between the check and the open is not read", async () => {
  const t = await caseWith();
  const outside = join(await tempDir(), "perfect.json");
  await Deno.writeTextFile(outside, CLAUDE_SETTINGS_TEXT);
  // settings.json is a regular file when lstat looks, and a link to a perfect copy when opened.
  await Deno.writeTextFile(t.settings, "{}");
  scaffoldTestHooks.beforeOpen = async (p) => {
    if (p.endsWith("settings.json")) {
      await Deno.remove(p);
      await Deno.symlink(outside, p);
    }
  };
  try {
    assertEquals((await status(t)).settingsFile, "changed");
  } finally {
    delete scaffoldTestHooks.beforeOpen;
  }
  t.state.lock();
});

Deno.test("a folder swapped for a link just before the rename is not written through", async () => {
  const t = await caseWith();
  const elsewhere = await tempDir("casefile-elsewhere-");
  await Deno.writeTextFile(join(elsewhere, "settings.json"), "keep me\n");
  await Deno.writeTextFile(t.settings, "{}");
  scaffoldTestHooks.beforeRename = async (dir) => {
    if (!dir.endsWith(".claude")) return;
    // Move the real folder away (with the temp file in it) and put a link in its place.
    await Deno.rename(dir, dir + "-moved");
    await Deno.symlink(elsewhere, dir);
  };
  try {
    const r = await t.user.post("/api/claude-code/restore");
    assertEquals(r.status, 409, r.text);
  } finally {
    delete scaffoldTestHooks.beforeRename;
  }
  assertEquals(await Deno.readTextFile(join(elsewhere, "settings.json")), "keep me\n");
  assertEquals([...Deno.readDirSync(elsewhere)].map((e) => e.name), ["settings.json"]);
  assert(UnsafeCasePathError);
  t.state.lock();
});
