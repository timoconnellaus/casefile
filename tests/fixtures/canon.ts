/**
 * The canonical example case (docs/rebuild/CANON.md), for tests written for the v2 rebuild.
 * SYNTHETIC data only (ADR 11): every name, address and number is invented. Identifier values
 * are the ones in `synthetic.ts`, so they are checksum-valid.
 */
import type { CaseSession } from "../../src/core/session.ts";
import type { EntityKind } from "../../src/core/kinds.ts";
import type { Origin } from "../../src/core/publicdb.ts";
import { IDS } from "./synthetic.ts";

/** "Today" in the mockups. */
export const CANON_TODAY = "2025-10-07";

export const CANON_CASE_LABEL = "Parenting matter 2025";

/** The colour slots (DESIGN-SPEC §4); the UI owns the hex values. */
export const CANON_PALETTE = ["#FFAABB", "#77AADD", "#44BB99", "#BBCC33", "#99DDFF", "#EEDD88"];

export interface CanonEntity {
  role: string;
  kind: EntityKind;
  full: string;
  first?: string;
  surname?: string;
  title?: string;
  aliases?: string[];
  /** Palette index; absent: neutral ink. */
  colour?: number;
  safety?: boolean;
}

/** Who's who (CANON.md). */
export const CANON_ENTITIES: CanonEntity[] = [
  {
    role: "mother",
    kind: "person",
    full: "Anna Thornbury",
    first: "Anna",
    surname: "Thornbury",
    title: "Ms Thornbury",
    aliases: ["Annie", "Ana"],
    colour: 0,
    safety: true,
  },
  {
    role: "father",
    kind: "person",
    full: "Daniel Okafor",
    first: "Daniel",
    surname: "Okafor",
    title: "Mr Okafor",
    colour: 1,
  },
  { role: "child_1", kind: "person", full: "Mia Okafor", first: "Mia", colour: 2 },
  { role: "child_2", kind: "person", full: "Lachlan Okafor", first: "Lachlan", colour: 3 },
  { role: "maternal_grandmother", kind: "person", full: "Margaret Thornbury" },
  { role: "class_teacher", kind: "person", full: "Priya Raman", title: "Ms Raman" },
  { role: "school", kind: "school", full: "Kiama Downs Public School" },
  { role: "childcare", kind: "organisation", full: "Little Gumnuts Childcare" },
  { role: "fathers_business", kind: "organisation", full: "Okafor Joinery" },
  { role: "mothers_home", kind: "address", full: IDS.address },
  { role: "place_1", kind: "place", full: "Dapto" },
  { role: "phone_1", kind: "phone", full: IDS.mobile },
  { role: "email_1", kind: "email", full: IDS.email },
  { role: "medicare_1", kind: "identifier", full: IDS.medicare },
  { role: "tfn_1", kind: "identifier", full: IDS.tfn },
  { role: "abn_1", kind: "identifier", full: IDS.abn },
  { role: "dob_1", kind: "date_of_birth", full: IDS.dob1 },
  { role: "dob_2", kind: "date_of_birth", full: IDS.dob2 },
  { role: "file_number", kind: "identifier", full: IDS.fileNo },
];

export interface CanonDoc {
  id: string;
  title: string;
  origin: Origin;
  text: string;
}

/** D001 Text messages, March 2025 — exactly these 7 lines. */
export const D001_LINES = [
  "14/03/2025 3:05pm Anna: Where are you? Mia has been waiting at school since 3.",
  "14/03/2025 4:31pm Daniel: Traffic. Got them now.",
  "15/03/2025 9:12am Anna: Mr Okafor, this is the third time this term.",
  "15/03/2025 9:40am Daniel: Mia said she was fine. Stop making a big deal Anna.",
  "22/03/2025 6:02pm Anna: Swimming is moved to Saturday 8am at Dapto pool.",
  "22/03/2025 6:30pm Daniel: Fine.",
  "29/03/2025 8:41am Anna: Lachlan has a temperature, keeping him home.",
];

/** D002 Affidavit of Anna Thornbury (filed 2 April 2025); line 7 and line 9 are exact. */
export const D002_LINES = [
  "AFFIDAVIT",
  `Federal Circuit and Family Court of Australia — File number ${IDS.fileNo}`,
  "",
  `I, Anna Thornbury, of ${IDS.address}, say on oath:`,
  "",
  `1. I am the mother of Mia Okafor, born ${IDS.dob1}, and Lachlan Okafor, born on ${IDS.dob2}.`,
  "2. The father of the children is Daniel Okafor. Mr Okafor and I separated in June 2023.",
  "3. Mia attends Kiama Downs Public School. Lachlan attends Little Gumnuts Childcare.",
  "4. On 14 March 2025 Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public School.",
  `5. I can be contacted on ${IDS.mobile} or ${IDS.email}.`,
  `6. My Medicare number is ${IDS.medicare} and my tax file number is ${IDS.tfn}.`,
  `7. Daniel's business, Okafor Joinery (ABN ${IDS.abn}), operates from the same address.`,
];

export const CANON_DOCS: CanonDoc[] = [
  { id: "D001", title: "Text messages, March 2025", origin: "mine", text: D001_LINES.join("\n") },
  {
    id: "D002",
    title: "Affidavit of Anna Thornbury",
    origin: "mine",
    text: D002_LINES.join("\n"),
  },
];

/**
 * Seed a new, empty case with CANON's who's who (colour slots and the safety flag included) and
 * share D001 and D002, which get those ids. Leave out aliases with `omitAliases` (e.g. "Annie", to
 * add it later in an exposure scenario).
 */
export async function seedCanon(
  session: CaseSession,
  opts: { omitAliases?: string[] } = {},
): Promise<{ docs: string[] }> {
  if (session.registry.list().length || (await session.listDocs()).length) {
    throw new Error("seedCanon needs an empty case");
  }
  const omit = new Set(opts.omitAliases ?? []);
  for (const c of CANON_ENTITIES) {
    const e = session.registry.add({
      role: c.role,
      kind: c.kind,
      full: c.full,
      first: c.first,
      surname: c.surname,
      title: c.title,
      aliases: (c.aliases ?? []).filter((a) => !omit.has(a)),
    });
    if (c.colour !== undefined) e.colour = c.colour;
    if (c.safety) e.safety = true;
  }
  await session.saveRegistry();
  const docs: string[] = [];
  for (const d of CANON_DOCS) {
    const doc = await session.importText({ title: d.title, text: d.text, origin: d.origin });
    if (doc.id !== d.id) throw new Error(`seedCanon: ${d.title} got ${doc.id}, not ${d.id}`);
    await session.publishWithDefaults(doc.id);
    docs.push(doc.id);
  }
  return { docs };
}
