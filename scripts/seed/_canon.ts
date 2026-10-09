/**
 * The CANON example case as data: the invented "Parenting matter 2025" family from the design
 * review (CANON.md). SYNTHETIC — every name, number and address is made up (ADR 11).
 *
 * Files in scripts/seed/ starting with "_" are data, not seed steps; the loader skips them.
 * The parts tests also use (who's who, D001, D002) come from tests/fixtures/canon.ts, so tests and
 * the seed can't drift.
 */
import type { EntityKind } from "../../src/core/kinds.ts";
import type { Origin } from "../../src/core/publicdb.ts";
import {
  CANON_CASE_LABEL,
  CANON_ENTITIES,
  type CanonEntity,
  D001_LINES,
  D002_LINES,
} from "../../tests/fixtures/canon.ts";

export type { Origin };

export const LABEL = CANON_CASE_LABEL;

/**
 * Identifiers casefile names itself: they are not registered up front, so importing D002 proposes
 * them with the detector's role hint (medicare_1, tfn_1, abn_1, file_number) and sharing D002
 * creates them under those roles.
 */
export const HINTED_ROLES = new Set(["medicare_1", "tfn_1", "abn_1", "file_number"]);

/** The nickname the user adds after D006 was shared — this is what makes D006 "Exposed". */
export const LATE_ALIAS = { role: "mother", alias: "Annie" };

/**
 * Who's who as registered before import: CANON's entities without the hinted identifiers, the late
 * nickname, colour slots or the safety flag (the user sets those afterwards, through the app).
 */
export const ENTITIES: {
  role: string;
  kind: EntityKind;
  full: string;
  first?: string;
  surname?: string;
  title?: string;
  aliases: string[];
}[] = CANON_ENTITIES
  .filter((e) => !HINTED_ROLES.has(e.role))
  .map((e) => ({
    role: e.role,
    kind: e.kind,
    full: e.full,
    first: e.first,
    surname: e.surname,
    title: e.title,
    aliases: (e.aliases ?? []).filter((a) => a !== LATE_ALIAS.alias),
  }));

/** Colour slots and the safety flag, as CANON has them (set through PATCH /api/entities). */
export const STYLE: Pick<CanonEntity, "role" | "colour" | "safety">[] = CANON_ENTITIES
  .filter((e) => e.colour !== undefined || e.safety)
  .map((e) => ({ role: e.role, colour: e.colour, safety: e.safety }));

/**
 * The rest of CANON's who's who (41: People 18, Places & organisations 14, Numbers & dates 9).
 * No document mentions them; they fill the lists. All invented.
 */
export const EXTRA_ENTITIES: { role: string; kind: EntityKind; full: string; title?: string }[] = [
  { role: "maternal_aunt", kind: "person", full: "Joanne Pritchard" },
  { role: "fathers_partner", kind: "person", full: "Kylie Brennan" },
  { role: "family_doctor", kind: "person", full: "Anika Sharma", title: "Dr Sharma" },
  { role: "school_principal", kind: "person", full: "Graham Whitfield" },
  { role: "childcare_educator", kind: "person", full: "Tessa Morrow" },
  { role: "swim_coach", kind: "person", full: "Ryan Delaney" },
  { role: "family_consultant", kind: "person", full: "Helen Varga" },
  { role: "mothers_lawyer", kind: "person", full: "Simon Achterberg" },
  { role: "fathers_lawyer", kind: "person", full: "Fiona Castellano" },
  { role: "neighbour", kind: "person", full: "Bruce Halloran" },
  { role: "mothers_friend", kind: "person", full: "Leanne Fitzgerald" },
  { role: "independent_childrens_lawyer", kind: "person", full: "Marcus Oyelaran" },
  { role: "place_2", kind: "place", full: "Albion Park" },
  { role: "place_3", kind: "place", full: "Oak Flats" },
  { role: "place_4", kind: "place", full: "Unanderra" },
  { role: "mothers_employer", kind: "organisation", full: "Illawarra Shoalhaven Health" },
  { role: "contact_centre", kind: "organisation", full: "Coastal Family Contact Centre" },
  { role: "fathers_legal_firm", kind: "organisation", full: "Harbour Street Lawyers" },
  { role: "mothers_legal_firm", kind: "organisation", full: "Seaview Family Law" },
  { role: "after_school_care", kind: "organisation", full: "Seabird OSHC" },
  { role: "netball_club", kind: "organisation", full: "Minnamurra Netball Club" },
  { role: "medical_centre", kind: "organisation", full: "Werri Beach Medical Centre" },
];

/**
 * The user's relationship descriptions (ADR 15). Claude reads them, so no names or numbers: other
 * people are named by token.
 */
export const DESCRIPTIONS: Record<string, string> = {
  mother: "The applicant. The children's mother.",
  father: "The respondent. The children's father.",
  child_1: "The parties' older child.",
  child_2: "The parties' younger child.",
  maternal_grandmother: "The children's maternal grandmother. Helps with pick-ups.",
  class_teacher: "{{child_1}}'s class teacher.",
  school: "{{child_1}}'s primary school.",
  childcare: "{{child_2}}'s childcare centre.",
  fathers_business: "The father's business.",
  mothers_home: "Where the mother and the children live.",
  place_1: "Where the swimming lessons are.",
};

export interface SeedDoc {
  id: string;
  title: string;
  text: string;
  origin: Origin | null; // null = not asked yet
  /** Unshared documents stay "Needs review". */
  share: boolean;
}

const lines = (...l: string[]) => l.join("\n");

export const DOCS: SeedDoc[] = [
  {
    id: "D001",
    title: "Text messages, March 2025",
    origin: "mine",
    share: true,
    text: D001_LINES.join("\n"),
  },
  {
    id: "D002",
    title: "Affidavit of Anna Thornbury",
    origin: "mine",
    share: true,
    text: D002_LINES.join("\n"),
  },
  {
    id: "D003",
    title: "Email about school pick-up times",
    origin: "mine",
    share: true,
    text: lines(
      "From: Priya Raman, Kiama Downs Public School",
      "Sent: 11 February 2025",
      "Mia was collected at 4.15pm on Monday and Thursday this week. School finishes at 3pm.",
      "Please let me know if the pick-up arrangements have changed.",
    ),
  },
  {
    id: "D004",
    title: "School records, 2024",
    origin: "court_or_subpoena",
    share: true,
    text: lines("Attendance summary for Mia Okafor, 2024.", "Days absent: 6."),
  },
  {
    id: "D005",
    title: "Subpoenaed medical records",
    origin: "court_or_subpoena",
    share: true,
    text: lines("Patient: Lachlan Okafor", "Consultation notes, 2025."),
  },
  {
    id: "D006",
    title: "Letter from the other side's lawyer",
    origin: "mine",
    share: true,
    // 14 lines: Claude reads lines 1-12 (with "Annie" on line 4) before the nickname is known.
    text: lines(
      "Harbour Street Lawyers",
      "26 September 2025",
      "Dear Ms Thornbury,",
      "We act for Daniel Okafor. Our client says Annie has refused two requests to change the weekend arrangements.",
      "Our client proposes that changeovers happen at Kiama Downs Public School.",
      "He would collect the children from school on Friday afternoons.",
      "He would return them to school on Monday mornings.",
      "During school holidays changeovers would happen at 5pm on Sundays.",
      "Our client is willing to attend mediation.",
      "Please let us know within 14 days whether this is acceptable.",
      "If we do not hear from you, our client may file an application.",
      "This letter is written without prejudice save as to costs.",
      "Yours faithfully,",
      "Harbour Street Lawyers",
    ),
  },
  {
    id: "D007",
    title: "Notice of subpoena",
    origin: "court_or_subpoena",
    share: true,
    text: lines("Subpoena to produce documents, file PAC1234/2024."),
  },
  {
    id: "D008",
    title: "Daniel's affidavit, May 2025",
    origin: "other_side",
    share: true,
    text: lines("I, Daniel Okafor, affirm:", "1. I am the father of Mia and Lachlan."),
  },
  {
    id: "D009",
    title: "Family report",
    origin: "under_order",
    share: true,
    text: lines("Family report prepared for the Court.", "The children were interviewed."),
  },
  {
    id: "D010",
    title: "Handover notebook, 2024",
    origin: "not_sure",
    share: true,
    text: lines("Handover at Dapto, 5pm. Mia tired."),
  },
  {
    id: "D011",
    title: "Medical certificate, Lachlan, March 2025",
    origin: "mine",
    share: true,
    text: lines(
      "Dapto Family Medical Practice",
      "30 March 2025",
      "Lachlan Okafor was seen today with a fever and should rest at home for two days.",
    ),
  },
  {
    id: "D012",
    title: "Text messages, April 2025",
    origin: "mine",
    share: true,
    text: lines(
      "05/04/2025 5:10pm Daniel: Running late, be there at 6.",
      "05/04/2025 6:45pm Anna: The children waited until 6.40.",
      "12/04/2025 4:58pm Daniel: Can we swap this weekend?",
      "12/04/2025 5:20pm Anna: No, Mia has a birthday party on Saturday.",
    ),
  },
  {
    id: "D013",
    title: "Swimming club enrolment, 2025",
    origin: "mine",
    share: true,
    text: lines(
      "Dapto Swim Club — enrolment confirmation",
      "Swimmer: Mia Okafor",
      "Lessons: Saturdays 8am from 22 March 2025",
    ),
  },
  {
    id: "D014",
    title: "Text messages with Margaret, March 2025",
    origin: "mine",
    share: true,
    text: lines(
      "18/03/2025 7:02pm Margaret: I picked up Lachlan from Little Gumnuts Childcare today.",
      "18/03/2025 7:05pm Anna: Thanks Mum.",
    ),
  },
  {
    id: "D015",
    title: "Email from childcare centre",
    origin: null,
    share: false,
    text: lines(
      "From: Little Gumnuts Childcare",
      "Hi Annie, Lachlan had a good week. Please bring a hat on Friday.",
    ),
  },
  {
    id: "D016",
    title: "School reports term 2",
    origin: null,
    share: false,
    text: lines(
      "Kiama Downs Public School — Term 2 report",
      "Student: Mia Okafor",
      "Mia reads confidently. Parent contact: Annie, 0412 345 678.",
    ),
  },
];

/** Filler messages so the case has CANON's 312 documents (D017–D312, all shared). */
/**
 * A filler document's date: 2024, or 2025 up to September, so nothing is dated after CANON's
 * "today" (7 October 2025).
 */
export function fillerDate(n: number): { year: number; month: string; day: string } {
  const year = 2024 + (n % 2);
  return {
    year,
    month: String(((n * 5) % (year === 2025 ? 9 : 12)) + 1).padStart(2, "0"),
    day: String((n % 28) + 1).padStart(2, "0"),
  };
}

export function fillerDoc(n: number): SeedDoc {
  const id = `D${String(n).padStart(3, "0")}`;
  const { year, month, day } = fillerDate(n);
  const who = n % 2 ? "Anna" : "Daniel";
  const child = n % 3 ? "Mia" : "Lachlan";
  return {
    id,
    title: n % 4 ? `Text messages, batch ${n}` : `Email about arrangements ${n}`,
    origin: "mine",
    share: true,
    text: lines(
      `${day}/${month}/${year} 5:${
        String(n % 60).padStart(2, "0")
      }pm ${who}: ${child} has swimming on Saturday.`,
      `${day}/${month}/${year} 6:0${n % 10}pm ${who === "Anna" ? "Daniel" : "Anna"}: OK.`,
    ),
  };
}

/**
 * Claude's chronology (tokenised, as Claude writes it through the CLI). `whileShared`: Claude
 * wrote it on 2 October from D006 while D006 was shared, and the user checked it on 3 October,
 * before "Annie" withdrew D006; sharing D006 again lists it under "these go back to To check".
 */
export const CHRONOLOGY: {
  date: string;
  text: string;
  sources: string[];
  check: "checked" | "to_check" | "cant_check";
  whileShared?: true;
}[] = [
  {
    date: "2025-02-11",
    text:
      "{{class_teacher}} emailed that {{child_1.first}} was collected at 4.15pm twice that week.",
    sources: ["D003:1-3"],
    check: "checked",
  },
  {
    date: "2025-03-14",
    text:
      "{{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.",
    sources: ["D002:9", "D001:1-2"],
    check: "to_check",
  },
  {
    date: "2025-03-15",
    text: "{{mother.first}} told {{father.title}} it was the third late collection this term.",
    sources: ["D001:3"],
    check: "to_check",
  },
  {
    date: "2025-03-15",
    text: "{{father.first}} said {{child_1.first}} was fine.",
    sources: ["D001:4"],
    check: "checked",
  },
  {
    date: "2025-03-22",
    text: "Swimming moved to Saturday 8am at {{place_1}} pool.",
    sources: ["D001:5-6"],
    check: "to_check",
  },
  {
    date: "2025-03-22",
    text: "{{child_1.first}} started Saturday swimming lessons.",
    sources: ["D013:2-3"],
    check: "checked",
  },
  {
    // Can't check: Claude names {{child_1}} (Mia) but D001:7 names Lachlan.
    date: "2025-03-29",
    text: "{{child_1.first}} had a temperature and was kept home.",
    sources: ["D001:7"],
    check: "cant_check",
  },
  {
    date: "2025-03-30",
    text: "{{child_2.first}} was seen by a doctor with a fever.",
    sources: ["D011:2-3"],
    check: "checked",
  },
  {
    date: "2025-04-05",
    text: "{{father.first}} said he would be late; the children waited until 6.40pm.",
    sources: ["D012:1-2"],
    check: "checked",
  },
  {
    date: "2025-04-12",
    text:
      "{{father.first}} asked to swap weekends; {{mother.first}} said no because of a birthday party.",
    sources: ["D012:3-4"],
    check: "checked",
  },
  {
    date: "2023-06-01",
    text: "{{mother.first}} and {{father.first}} separated.",
    sources: ["D002:4", "D002:7"],
    check: "checked",
  },
  {
    date: "2017-03-03",
    text: "{{child_1.first}} was born.",
    sources: ["D002:6"],
    check: "checked",
  },
  {
    date: "2019-09-21",
    text: "{{child_2.first}} was born.",
    sources: ["D002:6"],
    check: "checked",
  },
  {
    date: "2025-03-18",
    text: "{{maternal_grandmother}} collected {{child_2.first}} from {{childcare}}.",
    sources: ["D014:1"],
    check: "checked",
  },
  {
    date: "2025-04-02",
    text: "{{mother.first}} affirmed her affidavit.",
    sources: ["D002:1-4"],
    check: "checked",
  },
  {
    date: "2025-09-26",
    text: "{{father.first}}'s lawyers proposed that changeovers happen at {{school}}.",
    sources: ["D006:2-5"],
    check: "checked",
    whileShared: true,
  },
  {
    date: "2025-03-14",
    text: "{{mother.first}} messaged that {{child_1.first}} had been waiting at school since 3pm.",
    sources: ["D001:1"],
    check: "to_check",
  },
];

/** Claude's issues; `checked` = the user checked Claude's description. */
export const ISSUES: { title: string; desc: string; checked: boolean }[] = [
  {
    title: "Reliability of changeovers",
    desc: "Whether {{father.first}} collects the children on time and as agreed.",
    checked: true,
  },
  {
    title: "Children's schooling and attendance",
    desc:
      "How the arrangements affect {{child_1.first}}'s and {{child_2.first}}'s school and care.",
    checked: true,
  },
  {
    title: "Communication between parents",
    desc: "How the parents talk to each other about changes.",
    checked: true,
  },
  {
    title: "Medical care",
    desc: "Who looks after the children when they are unwell.",
    checked: false,
  },
];

/**
 * Evidence links (issue index into ISSUES). 11 links, 9 checked (CANON). `whileShared`: from
 * D006, as for CHRONOLOGY.
 */
export const EVIDENCE: {
  issue: number;
  source: string;
  stance: "supports" | "undermines" | "context";
  note: string;
  checked: boolean;
  whileShared?: true;
}[] = [
  {
    issue: 0,
    source: "D001:1-2",
    stance: "supports",
    note: "Late collection on 14 March.",
    checked: true,
  },
  {
    issue: 0,
    source: "D002:9",
    stance: "supports",
    note: "Your affidavit, para 4.",
    checked: true,
  },
  {
    issue: 0,
    source: "D012:1-2",
    stance: "supports",
    note: "Late again on 5 April.",
    checked: true,
  },
  { issue: 0, source: "D001:3", stance: "supports", note: "Third time this term.", checked: false },
  {
    issue: 0,
    source: "D001:6",
    stance: "undermines",
    note: "Agreed to the swimming change.",
    checked: false,
  },
  { issue: 1, source: "D003:1-3", stance: "supports", note: "Teacher's email.", checked: true },
  { issue: 1, source: "D013:2-3", stance: "context", note: "Swimming lessons.", checked: true },
  {
    issue: 2,
    source: "D006:4",
    stance: "undermines",
    note: "Their lawyer says two requests to change weekends were refused.",
    checked: true,
    whileShared: true,
  },
  {
    issue: 2,
    source: "D001:4",
    stance: "undermines",
    note: "Tone of the exchange.",
    checked: true,
  },
  {
    issue: 3,
    source: "D011:2-3",
    stance: "supports",
    note: "Doctor's certificate.",
    checked: true,
  },
  {
    issue: 3,
    source: "D001:7",
    stance: "context",
    note: "Kept home with a temperature.",
    checked: true,
  },
];

/** The affidavit draft, in order. */
export const DRAFT = {
  title: "Affidavit of Anna Thornbury",
  paragraphs: [
    {
      by: "user",
      text:
        "I am the applicant mother. I make this affidavit in support of my application about where the children live.",
    },
    {
      by: "user",
      text: "Mia was born on 3 March 2017 and Lachlan was born on 21/09/2019. They live with me.",
    },
    {
      by: "claude",
      then: "adopt",
      text:
        "On 14 March 2025 {{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.",
    },
    {
      by: "claude",
      then: "rewrite",
      text:
        "On 15 March 2025 I told {{father.title}} by text message that this was the third late collection that term.",
      // The user's rewrite: "Drafted by Claude — rewritten by you, adopt to confirm" (ADR 9).
      rewrite:
        "On 15 March 2025 I told Mr Okafor by text that this was the third late collection that term.",
    },
    // ¶5 and ¶6: two passages of Claude's text the user added from Paste (ADR 0019).
    {
      by: "paste",
      text:
        "On 22 March 2025 I told {{father.first}} that swimming had moved to Saturday 8am at {{place_1}} pool, and he agreed.",
    },
    {
      by: "paste",
      text: "[In your own words: how the late collections affected the children.]",
    },
    { by: "user", text: "I ask the Court to make the orders set out in my application." },
  ] as {
    by: "user" | "claude" | "paste";
    text: string;
    then?: "adopt" | "rewrite";
    rewrite?: string;
  }[],
};

/** The other two Paste uses: the user reads Claude's text with real names (CANON: 3 uses). */
export const PASTE_VIEWS = [
  "{{child_1.first}} has swimming on Saturday. Ask {{father.first}} if he can take her.",
  "{{school}} finishes at 3pm (D003:3).",
];

export const CLAUDE_NOTE = {
  on: "issue:4",
  text: "D001:7 and D011 both mention a temperature. Check which child each one is about.",
};
