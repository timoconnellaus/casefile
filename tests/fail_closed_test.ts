/**
 * Failed detectors fail closed (security review, finding 3): text a detector could not check is not
 * published or stored (ADR 6).
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { InvalidInputError } from "../src/core/publicdb.ts";
import { CaseSession, LeakError } from "../src/core/session.ts";
import { FailingDetector, FakeNameDetector, tempDir } from "./fixtures/synthetic.ts";
import { PASS } from "./fixtures/case.ts";

async function emptyCase() {
  const dir = join(await tempDir(), "case");
  return await CaseSession.create(dir, PASS, "Test matter", { kdfIterations: 1_000 });
}

Deno.test("publishing refuses when a detector failed on the title", async () => {
  const s = await emptyCase();
  s.detectors = [new FailingDetector()];
  const doc = await s.importText({
    origin: "mine",
    title: "Notes",
    text: "Nothing identifying here.\n",
  });
  const err = await assertRejects(() => s.publishWithDefaults(doc.id), LeakError);
  assertEquals(err.leaks.length, 1);
  assertEquals(err.leaks[0].field, "title");
  assert(err.leaks[0].reason.includes("broken"), err.leaks[0].reason);
  assertEquals(s.store.hasDocument(doc.id), false);
  s.close();
});

Deno.test("user text is refused when a detector failed, naming the detector", async () => {
  const s = await emptyCase();
  s.detectors = [new FailingDetector()];
  const err = await assertRejects(
    () => s.tokeniseUserText("A note about the handover."),
    InvalidInputError,
  );
  assert(err.message.includes("broken"), err.message);
  s.close();
});

Deno.test("the session says whether any name detector is active", async () => {
  const s = await emptyCase();
  assertEquals(s.nameDetection, false);
  s.detectors = [new FailingDetector()];
  assertEquals(s.nameDetection, false, "a detector that does not look for names does not count");
  s.detectors = [new FakeNameDetector([])];
  assertEquals(s.nameDetection, true);
  s.close();
});
