/**
 * Desktop updates (ADR 24): the signed manifest, the update bar's restart, the backup before a new
 * version first opens a case, and the CLI the app carries. SYNTHETIC data only (ADR 11).
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  generateKeys,
  publicKeyOf,
  sha256Hex,
  signManifest,
  verifyEnvelope,
} from "../scripts/release/signing.ts";
import {
  appBundle,
  relaunchIfStale,
  runtimeDylib,
  runtimeVersion,
  Updates,
} from "../src/app/updates.ts";
import { installBundledCli } from "../src/app/cli_install.ts";
import { CASE_LOCK_FILE } from "../src/core/caselock.ts";
import { tempDir } from "./fixtures/synthetic.ts";
import { denoAutoUpdate, PASS, releaseServer, setup } from "./helpers/app.ts";

const MANIFEST = {
  version: "0.3.0",
  patches: { "0.2.0": { name: "patch-0.2.0-to-0.3.0.bin", sha256: "ab".repeat(32) } },
};

Deno.test("latest.json verifies only with its own key and only unaltered", async () => {
  const keys = await generateKeys();
  assertEquals(await publicKeyOf(keys.privateKey), keys.publicKey);
  const env = await signManifest(MANIFEST, keys.privateKey);
  assertEquals(await verifyEnvelope(env, keys.publicKey), MANIFEST);
  // The signature is over the exact `signed` text.
  const altered = { ...env, signed: env.signed.replace("0.3.0", "0.3.1") };
  assertEquals(await verifyEnvelope(altered, keys.publicKey), null);
  const other = await generateKeys();
  assertEquals(await verifyEnvelope(env, other.publicKey), null);
  // The formats Deno.autoUpdate reads: a raw 32-byte public key and a 64-byte signature.
  assertEquals(atob(keys.publicKey).length, 32);
  assertEquals(atob(env.signature).length, 64);
  assertEquals(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("updates are off until configured and in a desktop build", () => {
  const u = new Updates();
  u.start(null);
  assertEquals(u.status, {
    enabled: false,
    ready: null,
    rolledBack: false,
    checking: false,
    lastCheck: null,
    lastError: null,
  });
  u.start("0.2.0"); // no repository or key configured yet, and no Deno.autoUpdate under deno test
  assertFalse(u.status.enabled);
});

Deno.test("the app bundle is found from its executable", () => {
  assertEquals(
    appBundle("/Users/x/Applications/casefile.app/Contents/MacOS/laufey_webview"),
    "/Users/x/Applications/casefile.app",
  );
  assertEquals(appBundle("/usr/local/bin/deno"), null);
});

Deno.test("Restart to update closes the case, then starts the new version", async () => {
  const updates = new Updates();
  let relaunched = 0;
  const t = await setup({ updates, relaunch: () => Promise.resolve(void relaunched++) });
  const r = await t.user.post("/api/case/create", {
    dir: t.caseDir,
    passphrase: PASS,
    label: "Test matter",
  });
  assertEquals(r.status, 200, r.text);
  assertEquals((await t.other.post("/api/update/restart")).status, 401, "signed in only");
  assertEquals((await t.user.post("/api/update/restart")).status, 409, "nothing waiting");
  updates.markReady("0.3.0");
  assertEquals((await t.user.get("/api/status")).json.update.ready, "0.3.0");
  const restart = await t.user.post("/api/update/restart");
  assertEquals(restart.status, 200, restart.text);
  for (let i = 0; i < 50 && !relaunched; i++) await new Promise((r) => setTimeout(r, 20));
  assertEquals(relaunched, 1);
  assertFalse((await t.user.get("/api/status")).json.unlocked, "the case was closed first");
  await assertRejects(() => Deno.lstat(join(t.caseDir, CASE_LOCK_FILE)), Deno.errors.NotFound);
});

async function backups(root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const c of Deno.readDir(join(root, "config", "backups", "case"))) out.push(c.name);
  } catch { /* none yet */ }
  return out.sort();
}

Deno.test("a new version backs the case up before it first opens it, and only then", async () => {
  const v2 = await setup({ build: { version: "0.2.0", dev: false } });
  const created = await v2.user.post("/api/case/create", {
    dir: v2.caseDir,
    passphrase: PASS,
    label: "Test matter",
  });
  assertEquals(created.status, 200, created.text);
  await v2.state.shutdown();
  assertEquals(await backups(v2.root), [], "a new case needs no backup");

  // The same config folder, as the next version of the app.
  const v3 = await setup({
    build: { version: "0.3.0", dev: false },
    configDir: join(v2.root, "config"),
  });
  const wrong = await v3.user.post("/api/case/open", {
    dir: v2.caseDir,
    passphrase: "wrong passphrase",
  });
  assertEquals(wrong.status, 401, wrong.text);
  assertEquals(await backups(v2.root), [], "only the right passphrase makes a backup");

  const opened = await v3.user.post("/api/case/open", { dir: v2.caseDir, passphrase: PASS });
  assertEquals(opened.status, 200, opened.text);
  const made = await backups(v2.root);
  assertEquals(made.length, 1);
  assert(made[0].endsWith("-before-0.3.0"), made[0]);
  const manifest = JSON.parse(
    await Deno.readTextFile(join(v2.root, "config", "backups", "case", made[0], "backup.json")),
  );
  assertEquals(manifest.previousRelease, "0.2.0");

  await v3.state.lock();
  const again = await v3.user.post("/api/case/open", { dir: v2.caseDir, passphrase: PASS });
  assertEquals(again.status, 200, again.text);
  assertEquals((await backups(v2.root)).length, 1, "once per version");
  await v3.state.shutdown();
});

Deno.test("the app installs the CLI it carries once per version", async () => {
  const root = await tempDir();
  const source = join(root, "casefile-cli");
  await Deno.writeTextFile(source, "#!/bin/sh\necho v2\n");
  const opts = {
    home: join(root, "home"),
    configDir: join(root, "config"),
    source: new URL(`file://${source}`),
  };
  const first = await installBundledCli("0.2.0", opts);
  assert(first.installed);
  assertEquals(first.path, join(root, "home", ".local", "bin", "casefile"));
  assertEquals((await Deno.stat(first.path)).mode! & 0o777, 0o755);
  assertFalse((await installBundledCli("0.2.0", opts)).installed);
  await Deno.writeTextFile(source, "#!/bin/sh\necho v3\n");
  assert((await installBundledCli("0.3.0", opts)).installed);
  assertEquals(await Deno.readTextFile(first.path), "#!/bin/sh\necho v3\n");
  const none = await installBundledCli("0.4.0", {
    ...opts,
    source: new URL(`file://${root}/missing`),
  });
  assertFalse(none.installed);
});

Deno.test("the runtime's version is read from its metadata, across read chunks", async () => {
  const root = await tempDir();
  const dylib = join(root, "libruntime.dylib");
  const mark = new TextEncoder().encode('…,"app_name":"casefile","app_version":"0.3.1"}');
  // The mark straddles the 8 MB read boundary.
  const bytes = new Uint8Array(8 * 1024 * 1024 + 4096);
  bytes.set(mark, 8 * 1024 * 1024 - 20);
  await Deno.writeFile(dylib, bytes);
  assertEquals(await runtimeVersion(dylib), "0.3.1");
  await Deno.writeFile(dylib, new Uint8Array(1024));
  assertEquals(await runtimeVersion(dylib), null);
});

Deno.test("right after an update is swapped in, the old code starts the new version once", async () => {
  const root = await tempDir();
  const bundle = join(root, "casefile.app");
  const dylib = runtimeDylib(bundle);
  await Deno.mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  await Deno.writeTextFile(dylib, 'x"app_name":"casefile","app_version":"0.3.0"}');
  const launched: string[] = [];
  const launch = (b: string) => Promise.resolve(void launched.push(b));
  const config = join(root, "config");

  // No swap just happened: nothing to do.
  assertFalse(await relaunchIfStale(bundle, "0.2.0", config, launch));
  await Deno.writeTextFile(`${dylib}.backup`, "old");
  // The runtime on disk is this version: nothing to do.
  assertFalse(await relaunchIfStale(bundle, "0.3.0", config, launch));
  // Newer on disk than running: start again, once.
  assert(await relaunchIfStale(bundle, "0.2.0", config, launch));
  assertEquals(launched, [bundle]);
  assertFalse(await relaunchIfStale(bundle, "0.2.0", config, launch), "not in a loop");
  assertEquals(launched.length, 1);
});

// ── checking through GitHub's redirects (issue #5) ───────────────────────────

const PATCH = new TextEncoder().encode("a synthetic patch, not a real runtime diff");

/** A release like GitHub's: signed latest.json and a patch from 0.2.0, behind two redirects. */
async function release(opts: { patch?: Uint8Array; sha256?: string; from?: string } = {}) {
  const keys = await generateKeys();
  const patch = opts.patch ?? PATCH;
  const env = await signManifest({
    version: "0.3.0",
    patches: {
      [opts.from ?? "0.2.0"]: {
        name: "patch-0.2.0-to-0.3.0.bin",
        sha256: opts.sha256 ?? await sha256Hex(new Uint8Array(PATCH)),
      },
    },
  }, keys.privateKey);
  const srv = releaseServer({
    "latest.json": JSON.stringify(env),
    "patch-0.2.0-to-0.3.0.bin": patch,
  });
  return { keys, ...srv };
}

/** An app at 0.2.0 checking `base`, with Deno 2.9.7's autoUpdate standing in for the runtime's. */
function app(base: string, publicKey: string, stageTimeoutMs?: number) {
  const deno = denoAutoUpdate("0.2.0");
  const updates = new Updates({
    url: base,
    publicKey,
    autoUpdate: deno.autoUpdate,
    stageTimeoutMs,
  });
  updates.start("0.2.0", { timers: false });
  return { updates, deno };
}

Deno.test("Deno.autoUpdate alone can't download through GitHub's redirects (issue #5)", async () => {
  const r = await release();
  try {
    const deno = denoAutoUpdate("0.2.0");
    deno.autoUpdate({ url: r.base, publicKey: r.keys.publicKey });
    for (let i = 0; i < 100 && !deno.errors.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(deno.staged, []);
    assertStringIncludes(deno.errors[0], "redirect");
  } finally {
    await r.server.shutdown();
  }
});

Deno.test("an update is found and staged through two redirects to another host", async () => {
  const r = await release();
  const fetchBefore = globalThis.fetch;
  try {
    const { updates, deno } = app(r.base, r.keys.publicKey);
    assertEquals(deno.calls, [{ url: "" }], "start only asks about a rollback");
    const st = await updates.check();
    assertEquals(st.ready, "0.3.0");
    assertEquals(st.lastError, null);
    assertFalse(st.checking);
    assert(st.lastCheck && Date.now() - Date.parse(st.lastCheck) < 60_000, st.lastCheck ?? "");
    assertEquals(deno.staged, ["0.3.0"]);
    assertEquals(deno.errors, []);
    assertEquals(deno.calls[1], { url: r.base }, "the runtime is given the same base URL");
    assert(globalThis.fetch === fetchBefore, "fetch is put back");
    const port = (r.server.addr as Deno.NetAddr).port;
    // Both files went github.com-style → tagged release → asset host, once each.
    assertEquals(r.hits, [
      `127.0.0.1:${port}/releases/latest/download/latest.json`,
      `127.0.0.1:${port}/releases/download/v0.3.0/latest.json`,
      `localhost:${port}/asset/latest.json`,
      `127.0.0.1:${port}/releases/latest/download/patch-0.2.0-to-0.3.0.bin`,
      `127.0.0.1:${port}/releases/download/v0.3.0/patch-0.2.0-to-0.3.0.bin`,
      `localhost:${port}/asset/patch-0.2.0-to-0.3.0.bin`,
    ]);
    // Already staged: a second check doesn't download the patch again.
    const again = await updates.check();
    assertEquals(again.ready, "0.3.0");
    assertEquals(r.hits.length, 9);
  } finally {
    await r.server.shutdown();
  }
});

Deno.test("a check that finds this version is up to date, with no error", async () => {
  const r = await release();
  try {
    const deno = denoAutoUpdate("0.3.0");
    const updates = new Updates({
      url: r.base,
      publicKey: r.keys.publicKey,
      autoUpdate: deno.autoUpdate,
    });
    updates.start("0.3.0", { timers: false });
    const st = await updates.check();
    assertEquals([st.ready, st.lastError], [null, null]);
    assert(st.lastCheck);
    assertEquals(deno.calls.length, 1, "nothing to stage");
  } finally {
    await r.server.shutdown();
  }
});

Deno.test("update checks fail visibly, and as strictly as Deno's own checks", async (t) => {
  await t.step("signed with another key", async () => {
    const r = await release();
    try {
      const other = await generateKeys();
      const { updates, deno } = app(r.base, other.publicKey);
      const st = await updates.check();
      assertEquals(st.ready, null);
      assertStringIncludes(st.lastError ?? "", "isn't signed with casefile's key");
      assertEquals(deno.calls.length, 1, "the runtime is never handed it");
      assertFalse(r.hits.some((h) => h.includes(".bin")), "the patch isn't downloaded");
    } finally {
      await r.server.shutdown();
    }
  });
  await t.step("a patch that doesn't match its hash", async () => {
    const r = await release({ patch: new TextEncoder().encode("tampered") });
    try {
      const { updates, deno } = app(r.base, r.keys.publicKey);
      const st = await updates.check();
      assertEquals(st.ready, null);
      assertStringIncludes(st.lastError ?? "", "didn't match its checksum");
      assertEquals(deno.calls.length, 1);
    } finally {
      await r.server.shutdown();
    }
  });
  await t.step("no patch from this version", async () => {
    const r = await release({ from: "0.1.0" });
    try {
      const { updates } = app(r.base, r.keys.publicKey);
      const st = await updates.check();
      assertMatch(st.lastError ?? "", /0\.3\.0 is out, but there is no update from 0\.2\.0/);
    } finally {
      await r.server.shutdown();
    }
  });
  await t.step("a missing release", async () => {
    const r = await release();
    try {
      const { updates } = app(r.base.replace("/latest/", "/nothing/"), r.keys.publicKey);
      const st = await updates.check();
      assertMatch(st.lastError ?? "", /answered 404 for the update information/);
    } finally {
      await r.server.shutdown();
    }
  });
  await t.step("no server, and signed URLs stay out of the message", async () => {
    const r = await release();
    const port = (r.server.addr as Deno.NetAddr).port;
    await r.server.shutdown();
    const { updates } = app(`http://127.0.0.1:${port}/x?token=SECRET`, "AAAA");
    const st = await updates.check();
    assertStringIncludes(st.lastError ?? "", "couldn't reach 127.0.0.1");
    assertFalse((st.lastError ?? "").includes("SECRET"), st.lastError ?? "");
    assert(st.lastCheck);
  });
  await t.step("the runtime doesn't stage it", async () => {
    const r = await release();
    try {
      const updates = new Updates({
        url: r.base,
        publicKey: r.keys.publicKey,
        autoUpdate: () => {},
        stageTimeoutMs: 100,
      });
      updates.start("0.2.0", { timers: false });
      const st = await updates.check();
      assertEquals(st.ready, null);
      assertStringIncludes(st.lastError ?? "", "couldn't be set up to install");
    } finally {
      await r.server.shutdown();
    }
  });
});

Deno.test("a rolled-back update is reported from the start", () => {
  const updates = new Updates({
    url: "https://example.invalid/x",
    publicKey: "AAAA",
    autoUpdate: (o) => o.onRollback?.("Update failed to start, rolled back."),
  });
  updates.start("0.3.0", { timers: false });
  assert(updates.status.rolledBack);
});

Deno.test("Check for updates is signed in only and answers with the result", async () => {
  const r = await release();
  try {
    const { updates } = app(r.base, r.keys.publicKey);
    const t = await setup({ updates });
    const created = await t.user.post("/api/case/create", {
      dir: t.caseDir,
      passphrase: PASS,
      label: "Test matter",
    });
    assertEquals(created.status, 200, created.text);
    assertEquals((await t.other.post("/api/update/check")).status, 401, "signed in only");
    const before = (await t.other.get("/api/status")).json.update;
    assertEquals([before.lastCheck, before.lastError, before.checking], [null, null, false]);
    const res = await t.user.post("/api/update/check");
    assertEquals(res.status, 200, res.text);
    assertEquals(res.json.update.ready, "0.3.0");
    assertEquals(res.json.update.lastError, null);
    const after = (await t.other.get("/api/status")).json.update;
    assertEquals(after.ready, "0.3.0");
    assert(after.lastCheck);
    await t.state.shutdown();

    // A copy that doesn't update itself says so.
    const plain = await setup({ updates: new Updates() });
    await plain.user.post("/api/case/create", {
      dir: plain.caseDir,
      passphrase: PASS,
      label: "Test matter",
    });
    assertEquals((await plain.user.post("/api/update/check")).status, 409);
    await plain.state.shutdown();
  } finally {
    await r.server.shutdown();
  }
});
