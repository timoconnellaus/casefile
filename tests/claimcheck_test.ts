/**
 * casefile's own checks of a claim against the lines it cites (claimcheck.ts). Pure functions over
 * tokenised text; the CANON lines below are D001/D002 as casefile tokenises them.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals } from "@std/assert";
import {
  cantCheck,
  checkClaim,
  type CitedLines,
  missingCitation,
  splitSentences,
} from "../src/core/claimcheck.ts";
import type { EntityKind } from "../src/core/kinds.ts";
import type { CheckRow } from "../src/core/states.ts";

const KINDS = new Map<string, EntityKind>([
  ["mother", "person"],
  ["father", "person"],
  ["child_1", "person"],
  ["child_2", "person"],
  ["school", "school"],
  ["childcare", "organisation"],
  ["place_1", "place"],
]);

const D001 = [
  "14/03/2025 3:05pm {{mother.first}}: Where are you? {{child_1.first}} has been waiting at school since 3.",
  "14/03/2025 4:31pm {{father.first}}: Traffic. Got them now.",
  "15/03/2025 9:12am {{mother.first}}: {{father.title}}, this is the third time this term.",
  "15/03/2025 9:40am {{father.first}}: {{child_1.first}} said she was fine. Stop making a big deal {{mother.first}}.",
  "22/03/2025 6:02pm {{mother.first}}: Swimming is moved to Saturday 8am at {{place_1}} pool.",
  "22/03/2025 6:30pm {{father.first}}: Fine.",
  "29/03/2025 8:41am {{mother.first}}: {{child_2.first}} has a temperature, keeping him home.",
];
const D002_9 =
  "4. On 14 March 2025 {{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.";

function d001(from: number, to = from): CitedLines {
  return {
    ref: { doc_id: "D001", line_start: from, line_end: to },
    lines: D001.slice(from - 1, to).map((text, i) => ({ line: from + i, text })),
  };
}
const D002 = {
  ref: { doc_id: "D002", line_start: 9, line_end: 9 },
  lines: [{ line: 9, text: D002_9 }],
};

function row(rows: CheckRow[], text: string): CheckRow {
  const r = rows.find((x) => x.text === text);
  assert(r, `no row for ${text}: ${JSON.stringify(rows.map((x) => x.text))}`);
  return r;
}

Deno.test("CANON 14 March: date, Daniel, 90 minutes and school check out; Lachlan is flagged", () => {
  const claim =
    "2025-03-14 {{father.first}} collected {{child_1.first}} and {{child_2.first}} 90 minutes late from {{school}}.";
  const rows = checkClaim(claim, [D002, d001(1, 2)], KINDS);

  const date = row(rows, "14 March 2025");
  assertEquals([date.kind, date.ok, date.level], ["date", true, "ok"]);
  assertEquals(date.message, "14 March 2025 appears in D002:9 and D001:1–2.");

  const daniel = row(rows, "{{father.first}}");
  assertEquals([daniel.ok, daniel.level], [true, "ok"]);
  const mins = row(rows, "90 minutes");
  assertEquals([mins.kind, mins.ok, mins.level, mins.where], ["number", true, "ok", "D002:9"]);
  const school = row(rows, "{{school}}");
  assertEquals([school.ok, school.level, school.where], [true, "ok", "D002:9"]);

  const lachlan = row(rows, "{{child_2.first}}");
  assertEquals([lachlan.kind, lachlan.ok, lachlan.level], ["entity", true, "danger"]);
  assertEquals(lachlan.message, "{{child_2.first}} is not in D001:1–2, only in D002:9.");
  assertEquals(lachlan.where, "D001:1-2");

  assertEquals(cantCheck(rows), false, "found in D002:9, so it can still be checked");
  // Deterministic: the same input gives the same rows.
  assertEquals(checkClaim(claim, [D002, d001(1, 2)], KINDS), rows);
});

Deno.test("CANON 29 March: Mia where D001:7 names Lachlan is a possible mix-up and can't be checked", () => {
  const rows = checkClaim("2025-03-29 {{child_1.first}} has a temperature.", [d001(7)], KINDS);
  const mia = row(rows, "{{child_1.first}}");
  assertEquals([mia.ok, mia.level], [false, "danger"]);
  assertEquals(
    mia.message,
    "May have mixed up {{child_1.first}} and {{child_2.first}}: D001:7 names {{child_2.first}}, not {{child_1.first}}.",
  );
  assertEquals(row(rows, "29 March 2025").ok, true);
  assert(cantCheck(rows));
});

Deno.test("a name in none of the cited lines, with nobody else of its kind there, is not found", () => {
  const rows = checkClaim("{{school}} called.", [d001(2)], KINDS);
  const r = row(rows, "{{school}}");
  assertEquals([r.ok, r.message], [false, "{{school}} is not in D001:2."]);
  assert(cantCheck(rows));
});

Deno.test("unknown labels and unquotable citations can't be checked", () => {
  const unknown = checkClaim("{{ghost}} was there.", [d001(1)], KINDS);
  assertEquals([row(unknown, "{{ghost}}").ok, row(unknown, "{{ghost}}").level], [null, "danger"]);
  assert(cantCheck(unknown));

  const gone = checkClaim("{{father.first}} was late.", [
    { ref: { doc_id: "D009", line_start: 3, line_end: 4 }, lines: [] },
  ], KINDS);
  const c = row(gone, "D009:3–4");
  assertEquals([c.kind, c.ok, c.where], ["citation", false, "D009:3-4"]);
  assert(cantCheck(gone));

  assert(cantCheck([missingCitation()]));
  assertEquals(checkClaim("No labels here.", [], KINDS), []);
});

Deno.test("dates are recognised in every common form and compared by value", () => {
  for (
    const claim of [
      "14 March 2025",
      "March 14, 2025",
      "14/03/2025",
      "2025-03-14",
      "14th of Mar 2025",
    ]
  ) {
    const rows = checkClaim(`It was ${claim}.`, [D002], KINDS);
    const d = rows.find((r) => r.kind === "date");
    assert(d, claim);
    assertEquals([d.text, d.ok], ["14 March 2025", true], claim);
  }
  const wrong = checkClaim("On 15 March 2025 it happened.", [d001(1)], KINDS);
  assertEquals(row(wrong, "15 March 2025").ok, false);
  assertEquals(
    row(wrong, "15 March 2025").message,
    "15 March 2025 is not in the cited lines; they have 14 March 2025.",
  );
  // A month matches any day in it; a day without a year matches that day.
  assertEquals(row(checkClaim("In March 2025.", [d001(5)], KINDS), "March 2025").ok, true);
  assertEquals(row(checkClaim("On 22 March.", [d001(5)], KINDS), "22 March").ok, true);
});

Deno.test("numbers: units, durations, times and money; digits in dates and times are not numbers", () => {
  assertEquals(row(checkClaim("He was 1.5 hours late.", [D002], KINDS), "1.5 hours").ok, true);
  assertEquals(row(checkClaim("Ninety minutes late.", [D002], KINDS), "Ninety minutes").ok, true);
  assertEquals(row(checkClaim("He was 60 minutes late.", [D002], KINDS), "60 minutes").ok, false);
  assertEquals(row(checkClaim("Swimming at 8am.", [d001(5)], KINDS), "8am").ok, true);
  assertEquals(row(checkClaim("Swimming at 9am.", [d001(5)], KINDS), "9am").ok, false);
  assertEquals(row(checkClaim("Waiting since 3.", [d001(1)], KINDS), "3").ok, true);
  // "14/03/2025 3:05pm" yields a date and a time, never 14, 03, 2025 or 05.
  const rows = checkClaim("He paid $500.", [d001(1)], KINDS);
  assertEquals(rows.map((r) => [r.kind, r.text, r.ok]), [["number", "$500", false]]);
});

Deno.test("feelings are pointed out, placeholders are flagged, tokens are never read as words", () => {
  const rows = checkClaim(
    "{{child_1.first}} was upset and scared. [In your own words: how you felt]",
    [d001(4)],
    KINDS,
  );
  assertEquals(row(rows, "upset").kind, "feeling");
  assertEquals([row(rows, "upset").ok, row(rows, "upset").level], [null, "attention"]);
  assertEquals(row(rows, "[In your own words: how you felt]").kind, "placeholder");
  assertEquals(row(rows, "{{child_1.first}}").ok, true);
  assertEquals(cantCheck(rows), false);
  // A role named like a feeling word is a label, not a feeling.
  const k = new Map(KINDS).set("upset", "person");
  assertEquals(checkClaim("{{upset}} came.", [d001(1)], k).filter((r) => r.kind === "feeling"), []);
});

Deno.test("splitSentences keeps citations with their sentence and never splits a token", () => {
  assertEquals(
    splitSentences(
      "{{father.title}} was late (D001:1-2). He said traffic. (D001:2) Mr. Smith agreed [D002:9; D001:3–4]!\n\nNew para",
    ),
    [
      {
        text: "{{father.title}} was late.",
        cites: [{ doc_id: "D001", line_start: 1, line_end: 2 }],
      },
      { text: "He said traffic.", cites: [{ doc_id: "D001", line_start: 2, line_end: 2 }] },
      {
        text: "Mr. Smith agreed!",
        cites: [
          { doc_id: "D002", line_start: 9, line_end: 9 },
          { doc_id: "D001", line_start: 3, line_end: 4 },
        ],
      },
      { text: "New para", cites: [] },
    ],
  );
  assertEquals(splitSentences("It cost 2.5 hours. Then"), [
    { text: "It cost 2.5 hours.", cites: [] },
    { text: "Then", cites: [] },
  ]);
  assertEquals(splitSentences("  "), []);
});
