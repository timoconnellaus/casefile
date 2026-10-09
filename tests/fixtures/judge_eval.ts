/**
 * The labelled evaluation set for casefile's extra checks (ADR 14): CANON-style sentences with
 * names already replaced, each labelled with whether the check should raise a flag. Used to choose
 * each backend's threshold (`scripts/judge-eval.ts`) and to check the recorded figures
 * (`tests/judge_calibration_test.ts`). SYNTHETIC data only (ADR 11): every event is invented.
 */
import type { Origin } from "../../src/core/publicdb.ts";
import type { Example } from "../../src/core/judge/evaluate.ts";
import type { QuestionId } from "../../src/core/judge/questions.ts";

/** A sentence from a draft affidavit: does it state the witness's feelings or opinions? */
export interface FeelingCase {
  sentence: string;
  /** True: it gives the witness's feelings, beliefs or opinions (only they can say it). */
  feeling: boolean;
}

export const FEELING_CASES: FeelingCase[] = [
  // Feelings and opinions.
  {
    sentence: "I was frightened when {{father.first}} shouted at me in the car park.",
    feeling: true,
  },
  {
    sentence: "I believe {{father.title}} does not take the children's routines seriously.",
    feeling: true,
  },
  { sentence: "I felt humiliated in front of the other parents at {{school}}.", feeling: true },
  {
    sentence: "In my opinion the current arrangements are not in the children's best interests.",
    feeling: true,
  },
  {
    sentence: "I am worried that {{child_2.first}} is not sleeping well after weekends away.",
    feeling: true,
  },
  {
    sentence: "I think {{father.first}} is trying to turn {{child_1.first}} against me.",
    feeling: true,
  },
  { sentence: "It upset me deeply that nobody told me about the change of school.", feeling: true },
  { sentence: "I am anxious every Friday afternoon waiting for the handover.", feeling: true },
  { sentence: "I do not trust {{father.title}} to collect the children on time.", feeling: true },
  {
    sentence: "I was relieved when {{maternal_grandmother}} offered to help with pick-ups.",
    feeling: true,
  },
  { sentence: "I feel that my concerns have been ignored for months.", feeling: true },
  {
    sentence: "I am convinced that {{child_1.first}} is happier when she has a settled routine.",
    feeling: true,
  },
  { sentence: "It was obvious to me that he had been drinking.", feeling: true },
  { sentence: "I was devastated when I read the message.", feeling: true },
  {
    sentence: "I consider that the children need more stability than they have now.",
    feeling: true,
  },
  { sentence: "I am scared of what will happen if the children travel overseas.", feeling: true },
  { sentence: "I suspect {{father.first}} reads the children's messages to me.", feeling: true },
  { sentence: "I was furious that the swimming lesson was missed again.", feeling: true },
  // Facts and events.
  {
    sentence: "On 14 March 2025 {{father.first}} collected the children at 4:31pm.",
    feeling: false,
  },
  {
    sentence: "{{child_1.first}} attends {{school}} and {{child_2.first}} attends {{childcare}}.",
    feeling: false,
  },
  { sentence: "{{father.title}} and I separated in June 2023.", feeling: false },
  {
    sentence: "Swimming lessons moved to Saturday mornings at {{place_1}} pool in March 2025.",
    feeling: false,
  },
  {
    sentence: "On 29 March 2025 {{child_2.first}} had a temperature and stayed home with me.",
    feeling: false,
  },
  {
    sentence: "I sent {{father.first}} a text message at 3:05pm asking where he was.",
    feeling: false,
  },
  {
    sentence: "The children live with me from Sunday evening to Friday afternoon.",
    feeling: false,
  },
  {
    sentence: "{{class_teacher.title}} telephoned me on 15 March 2025 about the late pick-up.",
    feeling: false,
  },
  {
    sentence: "I drove {{child_1.first}} to her swimming lesson on 22 March 2025.",
    feeling: false,
  },
  { sentence: "{{father.first}} replied to my message about forty minutes later.", feeling: false },
  { sentence: "The handover takes place outside {{school}} at 3pm.", feeling: false },
  {
    sentence: "{{maternal_grandmother}} collected the children twice in April 2025.",
    feeling: false,
  },
  { sentence: "I have worked part time at a pharmacy since 2021.", feeling: false },
  { sentence: "The interim orders were made on 3 February 2025.", feeling: false },
  { sentence: "{{child_2.first}} was seen by a doctor on 31 March 2025.", feeling: false },
  { sentence: "The school term ended on 11 April 2025.", feeling: false },
  { sentence: "{{father.first}} wrote that the children were fine.", feeling: false },
  { sentence: "I attended the parent-teacher interview on 2 May 2025.", feeling: false },
];

/** Claude's note and the lines it cites: is the note a fair reading of them? */
export interface FairCase {
  claim: string;
  cited: string[];
  /** True: the note fairly reflects the cited lines. */
  fair: boolean;
}

const D001_1 =
  "14/03/2025 3:05pm {{mother.first}}: Where are you? {{child_1.first}} has been waiting at {{school}} since 3.";
const D001_2 = "14/03/2025 4:31pm {{father.first}}: Traffic. Got them now.";
const D001_3 =
  "15/03/2025 9:12am {{mother.first}}: {{father.title}}, this is the third time this term.";
const D001_4 =
  "15/03/2025 9:40am {{father.first}}: {{child_1.first}} said she was fine. Stop making a big deal {{mother.first}}.";
const D001_5 =
  "22/03/2025 6:02pm {{mother.first}}: Swimming is moved to Saturday 8am at {{place_1}} pool.";
const D001_6 = "22/03/2025 6:30pm {{father.first}}: Fine.";
const D001_7 =
  "29/03/2025 8:41am {{mother.first}}: {{child_2.first}} has a temperature, keeping him home.";
const D002_7 =
  "2. The father of the children is {{father}}. {{father.title}} and I separated in June 2023.";
const D002_8 = "3. {{child_1.first}} attends {{school}}. {{child_2.first}} attends {{childcare}}.";
const D002_9 =
  "4. On 14 March 2025 {{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.";

export const FAIR_CASES: FairCase[] = [
  // Fair readings.
  {
    claim: "{{child_1.first}} waited at {{school}} from 3pm on 14 March 2025.",
    cited: [D001_1],
    fair: true,
  },
  {
    claim: "{{father.first}} collected the children at about 4:31pm, blaming traffic.",
    cited: [D001_2],
    fair: true,
  },
  {
    claim: "{{mother.first}} told {{father.first}} it was the third late pick-up this term.",
    cited: [D001_3],
    fair: true,
  },
  { claim: "Swimming moved to Saturday at 8am at {{place_1}} pool.", cited: [D001_5], fair: true },
  {
    claim: "{{father.first}} agreed to the new swimming time.",
    cited: [D001_5, D001_6],
    fair: true,
  },
  {
    claim: "{{child_2.first}} had a temperature and was kept home on 29 March 2025.",
    cited: [D001_7],
    fair: true,
  },
  { claim: "The parents separated in June 2023.", cited: [D002_7], fair: true },
  {
    claim: "{{child_1.first}} goes to {{school}} and {{child_2.first}} goes to {{childcare}}.",
    cited: [D002_8],
    fair: true,
  },
  {
    claim:
      "{{father.first}} was 90 minutes late collecting both children from {{school}} on 14 March 2025.",
    cited: [D002_9],
    fair: true,
  },
  {
    claim: "{{father.first}} said {{child_1.first}} told him she was fine.",
    cited: [D001_4],
    fair: true,
  },
  {
    claim: "{{mother.first}} asked {{father.first}} where he was while {{child_1.first}} waited.",
    cited: [D001_1],
    fair: true,
  },
  {
    claim: "{{father.first}} told {{mother.first}} to stop making a big deal of it.",
    cited: [D001_4],
    fair: true,
  },
  {
    claim: "{{mother.first}} kept {{child_2.first}} home because he had a temperature.",
    cited: [D001_7],
    fair: true,
  },
  { claim: "{{child_2.first}} attends {{childcare}}.", cited: [D002_8], fair: true },
  // Not fair: a different fact, an overstatement, an added motive or an invented detail.
  {
    claim: "{{father.first}} collected the children on time on 14 March 2025.",
    cited: [D001_2, D002_9],
    fair: false,
  },
  {
    claim: "{{father.first}} refused to collect the children from {{school}}.",
    cited: [D001_2],
    fair: false,
  },
  {
    claim: "{{father.first}} admitted he had forgotten the children.",
    cited: [D001_2],
    fair: false,
  },
  { claim: "{{child_1.first}} was waiting at {{school}} until 6pm.", cited: [D001_1], fair: false },
  {
    claim: "{{father.first}} objected to swimming moving to Saturday.",
    cited: [D001_5, D001_6],
    fair: false,
  },
  { claim: "{{child_1.first}} had a temperature and was kept home.", cited: [D001_7], fair: false },
  {
    claim: "The parents separated in 2019 after {{father.first}} moved interstate.",
    cited: [D002_7],
    fair: false,
  },
  { claim: "{{child_2.first}} attends {{school}} with his sister.", cited: [D002_8], fair: false },
  {
    claim: "{{father.first}} apologised for being late and promised it would not happen again.",
    cited: [D001_2],
    fair: false,
  },
  {
    claim: "{{mother.first}} said this was the first time {{father.first}} had been late.",
    cited: [D001_3],
    fair: false,
  },
  {
    claim: "{{child_1.first}} told {{mother.first}} she was frightened.",
    cited: [D001_4],
    fair: false,
  },
  {
    claim: "{{mother.first}} took {{child_2.first}} to hospital on 29 March 2025.",
    cited: [D001_7],
    fair: false,
  },
  {
    claim: "{{father.first}} collected the children 30 minutes late.",
    cited: [D002_9],
    fair: false,
  },
  { claim: "Swimming was cancelled for the rest of the term.", cited: [D001_5], fair: false },
];

/** The opening lines of a document: where does it look like it came from? */
export interface OriginCase {
  opening: string[];
  /** Where it came from; `mine` for the user's own writing and records. */
  origin: Origin;
}

export const ORIGIN_CASES: OriginCase[] = [
  {
    opening: [
      "Notes for my lawyer",
      "Things I remember about the March pick-ups",
      "1. 14 March: waited at {{school}} with {{child_1.first}}.",
    ],
    origin: "mine",
  },
  {
    opening: ["Text messages, March 2025", "14/03/2025 3:05pm {{mother.first}}: Where are you?"],
    origin: "mine",
  },
  {
    opening: [
      "AFFIDAVIT",
      "I, {{mother}}, of {{mothers_home}}, say on oath:",
      "1. I am the mother of {{child_1}}.",
    ],
    origin: "mine",
  },
  {
    opening: [
      "My diary, April 2025",
      "Monday: {{child_2.first}} coughing again, called {{childcare}}.",
    ],
    origin: "mine",
  },
  {
    opening: [
      "Email from me to {{class_teacher.title}}",
      "Subject: {{child_1.first}}'s reading",
      "Hi, just checking how she is going this term.",
    ],
    origin: "mine",
  },
  {
    opening: [
      "Budget for the children's expenses I prepared",
      "School fees: $1,200",
      "Swimming: $180 a term",
    ],
    origin: "mine",
  },
  {
    opening: [
      "AFFIDAVIT",
      "I, {{father}}, of an address known to the Court, say on affirmation:",
      "1. I am the father of the children.",
    ],
    origin: "other_side",
  },
  {
    opening: [
      "Respondent's outline of case",
      "Filed on behalf of the father",
      "1. The father seeks equal time.",
    ],
    origin: "other_side",
  },
  {
    opening: [
      "Letter from the father's lawyers",
      "Dear {{mother.title}},",
      "We act for {{father}} in relation to the children.",
    ],
    origin: "other_side",
  },
  {
    opening: [
      "Case Outline Document — Respondent father",
      "Served on the applicant on 3 March 2025",
    ],
    origin: "other_side",
  },
  {
    opening: [
      "PRODUCED UNDER SUBPOENA",
      "Subpoena number 4 of 2025 — documents of {{school}}",
      "Attendance records, Term 1",
    ],
    origin: "court_or_subpoena",
  },
  {
    opening: [
      "Records produced in answer to a subpoena to produce",
      "Clinic notes for {{child_2}}",
    ],
    origin: "court_or_subpoena",
  },
  {
    opening: [
      "Notice to Produce — documents produced by the Department",
      "Child protection records",
    ],
    origin: "court_or_subpoena",
  },
  {
    opening: [
      "Copy from the Court file",
      "Subpoenaed material — inspection only",
      "Police records",
    ],
    origin: "court_or_subpoena",
  },
  {
    opening: [
      "Family Report",
      "Prepared by a family consultant under section 62G of the Family Law Act 1975",
      "Not to be published",
    ],
    origin: "under_order",
  },
  {
    opening: [
      "CONFIDENTIAL — subject to the orders of 3 February 2025",
      "Report of the independent children's lawyer",
    ],
    origin: "under_order",
  },
  {
    opening: [
      "Expert report ordered by the Court on 3 February 2025",
      "Psychological assessment of the family",
      "Not to be copied or disclosed",
    ],
    origin: "under_order",
  },
  {
    opening: ["Section 11F report", "Prepared pursuant to orders made on 10 April 2025"],
    origin: "under_order",
  },
];

/** Each question's examples, as state fields and whether casefile should flag them. */
export const EVAL_SETS: Record<QuestionId, Example[]> = {
  feeling_or_opinion: FEELING_CASES.map((c) => ({
    fields: { sentence: c.sentence },
    flag: c.feeling,
  })),
  fair_reading: FAIR_CASES.map((c) => ({
    fields: { claim: c.claim, cited_lines: c.cited.join("\n") },
    flag: !c.fair,
  })),
  // Every example is read as if the user had said it was theirs: the flag says otherwise.
  origin_hint: ORIGIN_CASES.map((c) => ({
    fields: { opening_lines: c.opening.join("\n") },
    flag: c.origin !== "mine",
  })),
};
