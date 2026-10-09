/** Test helper: a case with the synthetic affidavit published. SYNTHETIC data only (ADR 11). */
import { join } from "@std/path";
import type { ProposedSpan } from "../../src/core/detect/pipeline.ts";
import { CaseSession, type PublishRequest } from "../../src/core/session.ts";
import {
  AFFIDAVIT,
  AFFIDAVIT_TITLE,
  FAKE_NER_NAMES,
  FakeNameDetector,
  PEOPLE,
  tempDir,
} from "./synthetic.ts";

export const PASS = "a long test passphrase";

/** "Mr Okafor" and other ambiguous spans are resolved to the father. */
export async function publishedCase() {
  const dir = join(await tempDir(), "case");
  const s = await CaseSession.create(dir, PASS, "Test matter", { kdfIterations: 1_000 });
  s.detectors = [new FakeNameDetector(FAKE_NER_NAMES)];
  const doc = await s.importText({ origin: "mine", title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const { request, unresolved } = s.defaultPublishRequest(doc);
  const fatherKey = doc.newEntities.find((n) => n.full === PEOPLE.father)?.key;
  const resolved = unresolved.map((sp: ProposedSpan) => {
    if (sp.proposal.type !== "ambiguous") throw new Error("not ambiguous");
    const opt = sp.proposal.options.find((o) => o.ref === fatherKey || o.ref === "father")!;
    return { start: sp.start, end: sp.end, ref: opt.ref, form: opt.form };
  });
  const req: PublishRequest = { ...request, replacements: [...request.replacements, ...resolved] };
  await s.publish(doc.id, req);
  return { dir, s, docId: doc.id };
}

/** Every row of every table in public.db, for "nothing Claude can see changed" assertions. */
export function dumpPublic(store: { db: { prepare(sql: string): { all(): unknown[] } } }): string {
  const tables = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all() as { name: string }[];
  return JSON.stringify(
    tables.map((t) => [t.name, store.db.prepare(`SELECT * FROM "${t.name}"`).all()]),
  );
}
