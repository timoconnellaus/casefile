/**
 * Origins and the Claude plan (ADR 7, as amended for v2). SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { originHints, withheldReason } from "../src/core/origin.ts";
import { type Origin, ORIGINS } from "../src/core/publicdb.ts";
import { CaseSession, PlanConditionsError } from "../src/core/session.ts";
import { findRuleSpans } from "../src/core/detect/rules.ts";
import { IDS, tempDir } from "./fixtures/synthetic.ts";

const COMMERCIAL = { closedEnvironment: true, noTraining: true, thisCaseOnly: true };

async function newCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, "a long test passphrase", "T", { kdfIterations: 1_000 });
  s.detectors = [];
  return { dir, s };
}

Deno.test("withheldReason: who may see what, on each plan", () => {
  const table: [Origin | null, string, boolean, string | null][] = [
    [null, "consumer", false, "not_asked"],
    [null, "commercial", true, "not_asked"],
    ["mine", "consumer", false, null],
    ["other_side", "consumer", true, "origin"],
    ["court_or_subpoena", "consumer", true, "origin"],
    ["other_side", "commercial", false, "origin"],
    ["other_side", "commercial", true, null],
    ["court_or_subpoena", "commercial", true, null],
    ["under_order", "commercial", true, "origin"],
    ["not_sure", "commercial", true, "origin"],
  ];
  for (const [o, setup, released, want] of table) {
    assertEquals(
      withheldReason(o, setup as "consumer", released),
      want,
      `${o} ${setup} ${released}`,
    );
  }
  // An unknown or missing value (a damaged vault file) is withheld, whatever the plan.
  for (const bad of ["public", "", undefined]) {
    assert(withheldReason(bad as Origin, "commercial", true) !== null, String(bad));
  }
});

Deno.test("originHints suggests an origin from a stamp near the top, with no document text", () => {
  assertEquals(originHints("PRODUCED UNDER SUBPOENA\nSchool records 2024"), {
    origin: "court_or_subpoena",
    reason: 'It says "produced under subpoena".',
    line: 1,
  });
  assertEquals(originHints("Letter\n\nRe: disclosure of documents")?.origin, "other_side");
  assertEquals(originHints("Report\nSubject to a non-publication order")?.origin, "under_order");
  assertEquals(originHints("Text messages between us"), null);
  // Only the first lines count.
  assertEquals(originHints(`${"line\n".repeat(20)}subpoena`), null);
});

Deno.test("identifier rules suggest medicare_1, tfn_1, abn_1 and file_number roles", async () => {
  const hints = (t: string) => findRuleSpans(t).map((s) => s.roleHint);
  assertEquals(hints(`Medicare ${IDS.medicare}`), ["medicare_1"]);
  assertEquals(hints(`TFN ${IDS.tfn}`), ["tfn_1"]);
  assertEquals(hints(`ABN ${IDS.abn}`), ["abn_1"]);
  assertEquals(hints(`File ${IDS.fileNo}`), ["file_number"]);
  const { s } = await newCase();
  const d = await s.importText({
    title: "Numbers",
    text: `Medicare ${IDS.medicare}. TFN ${IDS.tfn}. ABN ${IDS.abn}. File ${IDS.fileNo}.`,
    origin: "mine",
  });
  await s.publishWithDefaults(d.id);
  assertEquals(
    s.registry.list().map((e) => e.role).sort(),
    ["abn_1", "file_number", "medicare_1", "tfn_1"],
  );
  // A second Medicare number gets medicare_2, not medicare_1_2.
  const d2 = await s.importText({ title: "More", text: "Medicare 2123 45670 1.", origin: "mine" });
  await s.publishWithDefaults(d2.id);
  assert(s.registry.get("medicare_2"), JSON.stringify(s.registry.list().map((e) => e.role)));
  s.close();
});

Deno.test("a commercial plan needs three conditions, is attested, and is logged", async () => {
  const { s } = await newCase();
  for (
    const c of [
      undefined,
      null,
      {},
      { ...COMMERCIAL, noTraining: false },
      { ...COMMERCIAL, thisCaseOnly: "yes" },
    ]
  ) {
    // deno-lint-ignore no-explicit-any
    await assertRejects(() => s.setClaudeSetup("commercial", c as any), PlanConditionsError);
  }
  assertEquals(s.effectiveSetup, "consumer");
  await s.setClaudeSetup("commercial", COMMERCIAL);
  assertEquals(s.effectiveSetup, "commercial");
  assertEquals(s.settings.plan?.conditions, COMMERCIAL);
  assert(
    await s.isAttested("plan", "current", { setup: "commercial", conditions: COMMERCIAL }),
  );
  const row = s.store.listLog(10).find((r) => r.action === "claude_setup_changed")!;
  assertEquals(JSON.parse(row.detail).conditions, COMMERCIAL);
  s.close();
});

Deno.test("released is honoured only on a commercial plan with its conditions recorded", async () => {
  const { dir, s } = await newCase();
  const d = await s.importText({
    title: "Their letter",
    text: "Plain words.",
    origin: "other_side",
  });
  // Sharing one at a time is refused on a consumer plan, by both paths.
  await assertRejects(() => s.publishWithDefaults(d.id, { release: true }));
  assertEquals(s.store.hasDocument(d.id), false, "a refused publish writes nothing");
  await s.publishWithDefaults(d.id);
  await assertRejects(() => s.release(d.id));
  assertEquals(s.store.getDocument(d.id).body, null);
  await s.setClaudeSetup("commercial", COMMERCIAL);
  await s.release(d.id);
  assertEquals(s.store.getDocument(d.id).body, "Plain words.");
  // A vault that says "commercial" without the recorded conditions counts as consumer: on the next
  // open the shared document is withdrawn.
  s.settings.plan = { setup: "commercial", at: new Date().toISOString() };
  await s.saveSettings();
  s.close();
  const again = await CaseSession.open(dir, "a long test passphrase");
  assertEquals(again.effectiveSetup, "consumer");
  assertEquals(again.store.getDocument(d.id).body, null);
  again.close();
});

Deno.test("every origin is withheld or shared the same way by publish, setOrigin and reopen", async () => {
  const { dir, s } = await newCase();
  await s.setClaudeSetup("commercial", COMMERCIAL);
  for (const origin of [...ORIGINS, null]) {
    const d = await s.importText({ title: "Note", text: "Plain words.", origin });
    await s.publishWithDefaults(d.id);
    const want = origin === "mine";
    assertEquals(s.store.getDocument(d.id).withheld === 0, want, `publish ${origin}`);
    await s.setOrigin(d.id, origin);
    assertEquals(s.store.getDocument(d.id).withheld === 0, want, `setOrigin ${origin}`);
    await s.reopen(d.id);
    assertEquals(s.store.hasDocument(d.id), false, `reopen ${origin}`);
    await s.publishWithDefaults(d.id);
    assertEquals(s.store.getDocument(d.id).withheld === 0, want, `republish ${origin}`);
  }
  s.close();
  // reconcilePublic agrees with all of them.
  const again = await CaseSession.open(dir, "a long test passphrase");
  assertEquals(
    again.store.listDocuments().filter((d) => d.withheld === 0).length,
    1,
  );
  again.close();
});
