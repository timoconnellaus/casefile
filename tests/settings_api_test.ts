/**
 * Settings from wave 1 (ADR 13 amendment, ADR 17): idle lock, shortcuts, the user's role, PD-AI
 * 5.4 confirmations, and the Getting started checklist. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { CLAUDE_SETTINGS } from "../src/core/case.ts";
import { AFFIDAVIT, AFFIDAVIT_TITLE, tempDir } from "./fixtures/synthetic.ts";
import { allRoutes, importAndPublish, setup, withCase } from "./helpers/app.ts";

Deno.test("open routes are still exactly status, case/open, case/create and case/restore", async () => {
  // Deliberately restated here: wave 1 adds recovery to case/open, not a new open route. ADR 29
  // adds restoring a backup, which has to work before any case is open.
  const { state } = await setup();
  const open = allRoutes(state).filter((r) => r.open).map((r) => `${r.method} ${r.path}`).sort();
  assertEquals(open, [
    "GET /api/status",
    "POST /api/case/create",
    "POST /api/case/open",
    "POST /api/case/restore",
  ]);
  for (
    const p of [
      "GET /api/claude-code",
      "POST /api/claude-code/restore",
      "POST /api/claude-code/open-terminal",
      "GET /api/start",
      "POST /api/start/claude-opened",
      "POST /api/settings/confirmations",
      "GET /api/case/recovery-key",
      "POST /api/case/recovery-key",
      "POST /api/case/recovery-key/remove",
    ]
  ) {
    assert(allRoutes(state).some((r) => `${r.method} ${r.path}` === p && !r.open), p);
  }
});

Deno.test("idle lock: 30 minutes by default, 15/30/60 from settings, in status even while locked", async () => {
  const t = await withCase({ idleLockMs: undefined });
  assertEquals((await t.user.get("/api/status")).json.idleLockMinutes, 30);
  // Anyone else sees the app-level copy of the last-opened case's setting (not sensitive).
  assertEquals((await t.other.get("/api/status")).json.idleLockMinutes, 30);
  assertEquals(t.state.idleLockMs(), 30 * 60_000);
  for (const bad of [45, "15", 0, null]) {
    assertEquals(
      (await t.user.put("/api/settings", { idleLockMinutes: bad })).status,
      400,
      `${bad}`,
    );
  }
  assertEquals((await t.user.put("/api/settings", { idleLockMinutes: 15 })).status, 200);
  assertEquals((await t.user.get("/api/status")).json.idleLockMinutes, 15);
  assertEquals((await t.user.get("/api/settings")).json.idleLockMinutes, 15);
  assertEquals(t.state.idleLockMs(), 15 * 60_000);
  const log = t.state.session!.store.listLog(20).find((r) => r.action === "settings_changed");
  assertEquals(JSON.parse(String(log!.detail)).idle_lock_minutes, 15);
  assertEquals((await t.other.get("/api/status")).json.idleLockMinutes, 15);
  // It is kept in the vault, so it survives locking; while locked, status shows the copy.
  await t.user.post("/api/lock");
  assertEquals((await t.user.get("/api/status")).json.idleLockMinutes, 15);
  assertEquals((await t.other.get("/api/status")).json.idleLockMinutes, 15);
  await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: "a long test passphrase" });
  assertEquals(t.state.idleLockMinutes(), 15);
  t.state.lock();
});

Deno.test("the idle-lock timer uses the setting", async () => {
  const t = await withCase({ idleLockMs: undefined });
  await t.user.put("/api/settings", { idleLockMinutes: 60 });
  assertEquals(t.state.idleLockMs(), 60 * 60_000);
  t.state.lock();
  // Tests may still override it.
  const u = await withCase({ idleLockMs: 5 });
  assertEquals(u.state.idleLockMs(), 5);
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(u.state.session, null, "locked after the idle time");
});

Deno.test("shortcuts and the user's role", async () => {
  const t = await withCase();
  assertEquals((await t.user.get("/api/settings")).json.shortcuts, true);
  assertEquals((await t.user.put("/api/settings", { shortcuts: "no" })).status, 400);
  assertEquals((await t.user.put("/api/settings", { shortcuts: false })).status, 200);
  assertEquals((await t.user.get("/api/settings")).json.shortcuts, false);

  // A name is not a role; only someone in Who's who can be chosen.
  assertEquals((await t.user.put("/api/settings", { userRole: "Anna Thornbury" })).status, 400);
  await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const role = t.state.session!.registry.list()[0].role;
  assertEquals((await t.user.put("/api/settings", { userRole: role })).status, 200);
  assertEquals((await t.user.get("/api/settings")).json.userRole, role);
  assertEquals((await t.user.put("/api/settings", { userRole: null })).status, 200);
  assertEquals((await t.user.get("/api/settings")).json.userRole, null);
  t.state.lock();
});

Deno.test('language model thinking: reasoning_effort "none" by default, a setting, logged', async () => {
  const t = await withCase();
  const llm = { baseUrl: "http://127.0.0.1:9/v1", model: "m" };
  assertEquals((await t.user.put("/api/settings", { llm })).status, 200);
  assertEquals((await t.user.get("/api/settings")).json.llm.reasoningEffort, "none");
  assertEquals(
    t.state.session!.settings.llm!.reasoningEffort,
    undefined,
    "the default is not stored",
  );
  const log = () =>
    JSON.parse(String(
      t.state.session!.store.listLog(20).find((r) => r.action === "settings_changed")!.detail,
    ));
  assertEquals(log().reasoning_effort, "none");
  assertEquals(
    (await t.user.put("/api/settings", { llm: { ...llm, reasoningEffort: "medium" } })).status,
    200,
  );
  assertEquals((await t.user.get("/api/settings")).json.llm.reasoningEffort, "medium");
  assertEquals(log().reasoning_effort, "medium");
  // Saving the address again without it keeps the choice.
  await t.user.put("/api/settings", { llm });
  assertEquals((await t.user.get("/api/settings")).json.llm.reasoningEffort, "medium");
  for (const bad of ["max", 3, true]) {
    assertEquals(
      (await t.user.put("/api/settings", { llm: { ...llm, reasoningEffort: bad } })).status,
      400,
      String(bad),
    );
  }
  await t.user.put("/api/settings", { llm: { ...llm, reasoningEffort: "default" } });
  assertEquals((await t.user.get("/api/settings")).json.llm.reasoningEffort, "default");
  await t.user.put("/api/settings", { llm: { ...llm, reasoningEffort: "none" } });
  assertEquals(t.state.session!.settings.llm!.reasoningEffort, undefined);
  t.state.lock();
});

Deno.test("PD-AI 5.4 confirmations are dated, kept in the vault and logged", async () => {
  const t = await withCase();
  let s = (await t.user.get("/api/settings")).json;
  assertEquals(s.confirmations, { helpImproveOff: null, chatHistory: null });
  assertEquals((await t.user.post("/api/settings/confirmations", {})).status, 400);
  assertEquals(
    (await t.user.post("/api/settings/confirmations", { helpImproveOff: "yes" })).status,
    400,
  );
  const r = await t.user.post("/api/settings/confirmations", {
    helpImproveOff: true,
    chatHistory: true,
  });
  assertEquals(r.status, 200, r.text);
  assert(!isNaN(Date.parse(r.json.helpImproveOff)));
  assert(!isNaN(Date.parse(r.json.chatHistory)));
  s = (await t.user.get("/api/settings")).json;
  assertEquals(s.confirmations, r.json);
  const row = t.state.session!.store.listLog(20).find((x) => x.action === "pd_ai_confirmed");
  assertEquals(row?.actor, "user");
  assertEquals(JSON.parse(String(row!.detail)).items, ["help_improve_off", "chat_history"]);
  // Withdrawn.
  await t.user.post("/api/settings/confirmations", { chatHistory: false });
  assertEquals((await t.user.get("/api/settings")).json.confirmations.chatHistory, null);
  assert(
    t.state.session!.store.listLog(20).some((x) => x.action === "pd_ai_confirmation_withdrawn"),
  );
  // Not in public.db's documents or anywhere Claude reads except the log action.
  assertEquals(
    (await t.other.post("/api/settings/confirmations", { chatHistory: true })).status,
    401,
  );
  t.state.lock();
});

Deno.test("Getting started: steps come from records", async () => {
  const bin = await tempDir("casefile-bin-");
  const t = await withCase({ claudeCode: { path: bin, os: "darwin" } });
  // deno-lint-ignore no-explicit-any
  const steps = async () => (await t.user.get("/api/start")).json as any;
  let st = await steps();
  assertEquals(st.steps.map((x: { id: string }) => x.id), [
    "plan",
    "claude_code",
    "import",
    "share",
    "open_claude",
    "backup",
  ]);
  assertEquals(st.done, 0);
  assertEquals(st.total, 6);

  // Step 1 needs the plan recorded, both confirmations and the web block in the folder.
  await t.state.session!.updateSettings({
    plan: { setup: "consumer", at: new Date().toISOString() },
  });
  await t.user.post("/api/settings/confirmations", { helpImproveOff: true, chatHistory: true });
  st = await steps();
  assertEquals(st.steps[0].done, true);
  assertEquals(st.steps[0].webBlocked, true);
  const edited = structuredClone(CLAUDE_SETTINGS);
  edited.permissions.deny = edited.permissions.deny.filter((r) => r !== "WebSearch");
  await Deno.writeTextFile(join(t.caseDir, ".claude", "settings.json"), JSON.stringify(edited));
  assertEquals((await steps()).steps[0].done, false, "web search no longer blocked");
  await t.user.post("/api/claude-code/restore");

  // Step 2: Claude Code found on the PATH.
  await Deno.writeTextFile(join(bin, "claude"), "", { mode: 0o755 });
  assertEquals((await steps()).steps[1], {
    id: "claude_code",
    done: true,
    path: join(bin, "claude"),
  });

  // Steps 3 and 4.
  await t.user.post("/api/docs/import", { title: "Notes", text: "Nothing identifying here." });
  st = await steps();
  assertEquals(st.steps[2], { id: "import", done: true, imported: 1 });
  assertEquals(st.steps[3].done, false);
  assertEquals(st.steps[3].needsReview, 1);
  await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  st = await steps();
  assertEquals(st.steps[3].done, true);
  assertEquals(st.steps[3].shared + st.steps[3].withheld, 1);
  assertEquals(st.steps[3].needsReview, 1);

  // Step 5 only the user can mark; it is kept in the vault, not public.db.
  assertEquals((await t.user.post("/api/start/claude-opened", { done: "yes" })).status, 400);
  const m = await t.user.post("/api/start/claude-opened", { done: true });
  assertEquals(m.json.done, true);
  st = await steps();
  assertEquals(st.steps[4].done, true);
  assert(st.steps[4].command.endsWith("&& claude"));
  assertEquals(st.steps[4].canOpenTerminal, true);
  assert((await t.state.session!.vault.list()).includes("start"));

  // Step 6: no backup yet (ADR 29); it is done once one is made.
  assertEquals(st.steps[5], { id: "backup", done: false, lastAt: null });
  assertEquals(st.done, 5);
  await Deno.mkdir(join(bin, "usb"));
  const b = await t.user.post("/api/backup", { folder: join(bin, "usb") });
  assertEquals(b.status, 200, b.text);
  st = await steps();
  assertEquals(st.steps[5], { id: "backup", done: true, lastAt: b.json.lastAt });
  assertEquals(st.done, 6);
  await t.user.post("/api/start/claude-opened", { done: false });
  assertEquals((await steps()).steps[4].done, false);
  t.state.lock();
});
