/**
 * The name finder question (ADR 26): asked the first time a case is opened, "On" chosen in the UI;
 * turning it on gets the model ready there and then (a download the first time), and a decline or
 * a failed download leaves the case working with rules only. Never downloaded unasked. SYNTHETIC
 * data only (ADR 11).
 */
import { assert, assertEquals } from "@std/assert";
import { createDetectors } from "../src/core/detect/factory.ts";
import { ModelPinError } from "../src/core/detect/ner.ts";
import type { CaseSettings } from "../src/core/session.ts";
import { AFFIDAVIT, AFFIDAVIT_TITLE, FakeNameDetector } from "./fixtures/synthetic.ts";
import { NAMES, PASS, withCase } from "./helpers/app.ts";

/** An app whose name finder is the fake one, only while it is on, with a loader that counts. */
async function app(load: () => Promise<void> = () => Promise.resolve()) {
  let loads = 0;
  const t = await withCase({
    detectorFactory: (st: CaseSettings) => st.nerEnabled ? [new FakeNameDetector(NAMES)] : [],
    nameFinderLoader: async () => {
      loads++;
      await load();
    },
  });
  return { ...t, loads: () => loads };
}

function lastChoice(t: Awaited<ReturnType<typeof app>>) {
  const row = t.state.session!.store.listLog(50).find((r) => r.action === "name_finder_chosen");
  return row ? JSON.parse(String(row.detail)) : null;
}

Deno.test("a new case asks about the name finder, and nothing is downloaded until the user answers", async () => {
  const t = await app();
  const st = (await t.user.get("/api/settings")).json;
  assertEquals(st.nameFinderAsk, true);
  assertEquals(st.nerEnabled, false);
  assertEquals(st.nameDetection, false);
  assertEquals(t.loads(), 0, "creating and opening a case downloads nothing");
  // The default settings build no name finder at all.
  assertEquals(createDetectors(t.state.session!.settings).length, 0);
  // Unanswered, it is asked again next time the case is opened.
  await t.user.post("/api/lock");
  await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS });
  assertEquals((await t.user.get("/api/settings")).json.nameFinderAsk, true);
  assertEquals(t.loads(), 0);
  t.state.lock();
});

Deno.test("On: the name finder is got ready there and then, turned on, and not asked about again", async () => {
  const t = await app();
  const r = await t.user.post("/api/settings/name-finder", { on: true });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json, { on: true, nameDetection: true, error: null });
  assertEquals(t.loads(), 1);
  const st = (await t.user.get("/api/settings")).json;
  assertEquals([st.nerEnabled, st.nameDetection, st.nameFinderAsk], [true, true, false]);
  assert(t.state.session!.settings.nameFinderAsked);
  assertEquals(lastChoice(t), { asked_on: true, on: true });
  // Kept in the vault: the next open doesn't ask.
  await t.user.post("/api/lock");
  await t.user.post("/api/case/open", { dir: t.caseDir, passphrase: PASS });
  assertEquals((await t.user.get("/api/settings")).json.nameFinderAsk, false);
  t.state.lock();
});

Deno.test("Off: the case works with rules only, says so, and isn't asked again", async () => {
  const t = await app();
  const r = await t.user.post("/api/settings/name-finder", { on: false });
  assertEquals(r.json, { on: false, nameDetection: false, error: null });
  assertEquals(t.loads(), 0, "declining downloads nothing");
  assertEquals((await t.user.get("/api/settings")).json.nameFinderAsk, false);
  assertEquals(lastChoice(t), { asked_on: false, on: false });
  // Documents still import and review, with the warning's flag set.
  const imp = await t.user.post("/api/docs/import", { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  assertEquals(imp.status, 200, imp.text);
  const review = await t.user.get(`/api/docs/${imp.json.id}/review`);
  assertEquals(review.json.nameDetection, false);
  t.state.lock();
});

Deno.test("a failed download (offline, or files that don't match) leaves it off, with a plain reason", async () => {
  for (
    const [fail, words] of [
      [() => Promise.reject(new TypeError("error sending request: dns error")), /downloaded/],
      [() => Promise.reject(new ModelPinError(["onnx/model_quantized.onnx"])), /expected/],
    ] as const
  ) {
    const t = await app(fail);
    const r = await t.user.post("/api/settings/name-finder", { on: true });
    assertEquals(r.status, 200, r.text);
    assertEquals([r.json.on, r.json.nameDetection], [false, false]);
    assert(words.test(r.json.error), r.json.error);
    assert(!/dns|onnx/.test(r.json.error), "no technical detail from the failure");
    const st = (await t.user.get("/api/settings")).json;
    assertEquals([st.nerEnabled, st.nameFinderAsk], [false, false]);
    assertEquals(lastChoice(t), { asked_on: true, on: false });
    // The case still works.
    const imp = await t.user.post("/api/docs/import", { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
    assertEquals(imp.status, 200, imp.text);
    t.state.lock();
  }
});

Deno.test("the name finder answer: bad input is refused; choosing in Settings counts as the answer", async () => {
  const t = await app();
  for (const bad of [undefined, "yes", 1]) {
    assertEquals((await t.user.post("/api/settings/name-finder", { on: bad })).status, 400);
  }
  assertEquals((await t.other.post("/api/settings/name-finder", { on: true })).status, 401);
  assertEquals(t.loads(), 0);
  await t.user.put("/api/settings", { nerEnabled: false });
  assertEquals((await t.user.get("/api/settings")).json.nameFinderAsk, false);
  t.state.lock();
});
