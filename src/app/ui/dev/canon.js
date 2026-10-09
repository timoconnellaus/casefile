// CANON fixture for the component gallery: the invented "Parenting matter 2025" family
// (SYNTHETIC — ADR 11; see the design review's CANON.md). Shaped like the API's segments so the
// gallery exercises the same code paths the views will.

/** Who's who (role → name, kind, colour slot). */
export const ENTITIES = {
  mother: { name: "Anna Thornbury", kind: "person", colour: 0 },
  father: { name: "Daniel Okafor", kind: "person", colour: 1 },
  child_1: { name: "Mia Okafor", kind: "person", colour: 2 },
  child_2: { name: "Lachlan Okafor", kind: "person", colour: 3 },
  maternal_grandmother: { name: "Margaret Thornbury", kind: "person", colour: null },
  class_teacher: { name: "Ms Priya Raman", kind: "person", colour: null },
  school: { name: "Kiama Downs Public School", kind: "school", colour: null },
  childcare: { name: "Little Gumnuts Childcare", kind: "organisation", colour: null },
  fathers_business: { name: "Okafor Joinery", kind: "organisation", colour: null },
  mothers_home: { name: "14 Banksia Crescent, Gerringong NSW 2534", kind: "address" },
  place_1: { name: "Dapto", kind: "place", colour: null },
  phone_1: { name: "0412 345 678", kind: "phone" },
  email_1: { name: "anna.thornbury@example.com.au", kind: "email" },
  medicare_1: { name: "2950 12348 1", kind: "identifier" },
  tfn_1: { name: "123 456 707", kind: "identifier" },
  abn_1: { name: "51 824 753 556", kind: "identifier" },
  dob_1: { name: "3 March 2017", kind: "date_of_birth" },
  dob_2: { name: "21/09/2019", kind: "date_of_birth" },
  file_number: { name: "PAC1234/2024", kind: "identifier" },
};

/** A plain-text segment. */
const P = (t) => ({ t });
/** A real value Claude sees as {{role}} / {{role.form}}. */
const E = (t, role, form) => ({
  t,
  role,
  form,
  kind: ENTITIES[role].kind,
  colour: ENTITIES[role].colour,
  name: ENTITIES[role].name,
});

export const D001 = {
  id: "D001",
  title: "Text messages, March 2025",
  lines: [
    [
      P("14/03/2025 3:05pm "),
      E("Anna", "mother", "first"),
      P(": Where are you? "),
      E("Mia", "child_1", "first"),
      P(" has been waiting at school since 3."),
    ],
    [P("14/03/2025 4:31pm "), E("Daniel", "father", "first"), P(": Traffic. Got them now.")],
    [
      P("15/03/2025 9:12am "),
      E("Anna", "mother", "first"),
      P(": "),
      E("Mr Okafor", "father", "title"),
      P(", this is the third time this term."),
    ],
    [
      P("15/03/2025 9:40am "),
      E("Daniel", "father", "first"),
      P(": "),
      E("Mia", "child_1", "first"),
      P(" said she was fine. Stop making a big deal "),
      E("Anna", "mother", "first"),
      P("."),
    ],
    [
      P("22/03/2025 6:02pm "),
      E("Anna", "mother", "first"),
      P(": Swimming is moved to Saturday 8am at "),
      E("Dapto", "place_1"),
      P(" pool."),
    ],
    [P("22/03/2025 6:30pm "), E("Daniel", "father", "first"), P(": Fine.")],
    [
      P("29/03/2025 8:41am "),
      E("Anna", "mother", "first"),
      P(": "),
      E("Lachlan", "child_2", "first"),
      P(" has a temperature, keeping him home."),
    ],
  ].map((segs, i) => ({ line: i + 1, segs })),
};

export const D002 = {
  id: "D002",
  title: "Affidavit of Anna Thornbury",
  lines: [
    [P("AFFIDAVIT")],
    [
      P("Federal Circuit and Family Court of Australia — File number "),
      E("PAC1234/2024", "file_number"),
    ],
    [],
    [
      P("I, "),
      E("Anna Thornbury", "mother"),
      P(", of "),
      E("14 Banksia Crescent, Gerringong NSW 2534", "mothers_home"),
      P(", affirm:"),
    ],
    [],
    [
      P("1. I am the mother of "),
      E("Mia Okafor", "child_1"),
      P(", born "),
      E("3 March 2017", "dob_1"),
      P(", and "),
      E("Lachlan Okafor", "child_2"),
      P(", born on "),
      E("21/09/2019", "dob_2"),
      P("."),
    ],
    [
      P("2. The father of the children is "),
      E("Daniel Okafor", "father"),
      P(". "),
      E("Mr Okafor", "father", "title"),
      P(" and I separated in June 2023."),
    ],
    [
      P("3. "),
      E("Mia", "child_1", "first"),
      P(" attends "),
      E("Kiama Downs Public School", "school"),
      P(". "),
      E("Lachlan", "child_2", "first"),
      P(" attends "),
      E("Little Gumnuts Childcare", "childcare"),
      P("."),
    ],
    [
      P("4. On 14 March 2025 "),
      E("Daniel", "father", "first"),
      P(" collected "),
      E("Mia", "child_1", "first"),
      P(" and "),
      E("Lachlan", "child_2", "first"),
      P(" 90 minutes late from "),
      E("Kiama Downs Public School", "school"),
      P("."),
    ],
    [
      P("5. I can be contacted on "),
      E("0412 345 678", "phone_1"),
      P(" or "),
      E("anna.thornbury@example.com.au", "email_1"),
      P("."),
    ],
    [
      P("6. My Medicare number is "),
      E("2950 12348 1", "medicare_1"),
      P(" and my tax file number is "),
      E("123 456 707", "tfn_1"),
      P("."),
    ],
    [
      P("7. "),
      E("Daniel", "father", "first"),
      P("’s business, "),
      E("Okafor Joinery", "fathers_business"),
      P(" (ABN "),
      E("51 824 753 556", "abn_1"),
      P("), operates from the same address."),
    ],
  ].map((segs, i) => ({ line: i + 1, segs })),
};

/** The main checking example: 14 March 2025, citing D002:9 and D001:1–2. */
export const CHRONO_14_MARCH = {
  date: "2025-03-14",
  segs: [
    E("Daniel", "father", "first"),
    P(" collected "),
    E("Mia", "child_1", "first"),
    P(" and "),
    E("Lachlan", "child_2", "first"),
    P(" 90 minutes late from "),
    E("Kiama Downs Public School", "school"),
    P("."),
  ],
  sources: [{ doc: "D002", start: 9, end: 9 }, { doc: "D001", start: 1, end: 2 }],
  checks: [
    { level: "ok", message: "14 March 2025 appears in D002:9" },
    { level: "ok", message: "Daniel appears in D002:9 and D001:2" },
    { level: "ok", message: "90 minutes appears in D002:9" },
    { level: "ok", message: "Kiama Downs Public School appears in D002:9" },
    { level: "danger", message: "Lachlan is not in D001:1–2, only in D002:9" },
  ],
};

/** Claude's 29 March entry names the wrong child: {{child_1}} where D001:7 names Lachlan. */
export const CHRONO_29_MARCH_CHECKS = [
  { level: "ok", message: "29 March 2025 appears in D001:7" },
  { level: "danger", message: "Mia is not in D001:7 — the line names Lachlan" },
  { level: "attention", message: "“has a temperature” — only you can say how serious it was" },
];

const ORIGIN = {
  mine: "It's mine (I wrote or received it)",
  other_side: "From the other side",
  court_or_subpoena: "From a subpoena or the court",
  under_order: "Under an order or undertaking",
  not_sure: "Not sure",
  null: "Not asked yet",
};

/** Documents list rows (the 16 named in CANON plus invented filler up to 312). */
export function documentRows() {
  const named = [
    ["D001", "Text messages, March 2025", "2025-03-15", "Messages", "mine", "shared", 6],
    [
      "D002",
      "Affidavit of Anna Thornbury",
      "2025-04-02",
      "Affidavits & court",
      "mine",
      "shared",
      3,
    ],
    [
      "D003",
      "Email about school pick-up times",
      "2025-02-11",
      "Letters & emails",
      "mine",
      "shared",
      1,
    ],
    [
      "D004",
      "School records, 2024",
      "2024-12-06",
      "School & medical",
      "court_or_subpoena",
      "withheld",
      0,
    ],
    [
      "D005",
      "Subpoenaed medical records",
      "2025-05-20",
      "School & medical",
      "court_or_subpoena",
      "withheld",
      0,
    ],
    [
      "D006",
      "Letter from the other side's lawyer",
      "2025-09-26",
      "Letters & emails",
      "mine",
      "exposed",
      0,
    ],
    [
      "D007",
      "Notice of subpoena",
      "2025-05-02",
      "Affidavits & court",
      "court_or_subpoena",
      "withheld",
      0,
    ],
    [
      "D008",
      "Daniel's affidavit, May 2025",
      "2025-05-14",
      "Affidavits & court",
      "other_side",
      "withheld",
      0,
    ],
    ["D009", "Family report", "2025-07-30", "Affidavits & court", "under_order", "withheld", 0],
    ["D010", "Handover notebook, 2024", "", "Other", "not_sure", "withheld", 0],
    [
      "D015",
      "Email from childcare centre",
      "2025-09-30",
      "Letters & emails",
      null,
      "needs_review",
      0,
    ],
    ["D016", "School reports term 2", "2025-07-04", "School & medical", null, "needs_review", 0],
  ];
  const rows = named.map(([id, title, date, type, origin, state, cited]) => ({
    id,
    title,
    date,
    type,
    origin: ORIGIN[String(origin)],
    state,
    cited,
  }));
  for (let n = 11; n <= 312; n++) {
    if (n === 15 || n === 16) continue;
    const id = `D${String(n).padStart(3, "0")}`;
    const month = String(((n * 7) % 12) + 1).padStart(2, "0");
    const day = String(((n * 13) % 28) + 1).padStart(2, "0");
    rows.push({
      id,
      title: n % 3 ? `Text messages, batch ${n}` : `Email ${n}`,
      date: n % 41 === 0 ? "" : `${2024 + (n % 2)}-${month}-${day}`,
      type: n % 3 ? "Messages" : "Letters & emails",
      origin: ORIGIN.mine,
      state: "shared",
      cited: n % 5,
    });
  }
  return rows;
}

/** Fake ⌘K results (the shape /api/search/all will return). */
export function fakeSearch(q) {
  const s = q.toLowerCase();
  const lines = [
    ...D001.lines.map((l) => ({ doc: "D001", ...l })),
    ...D002.lines.map((l) => ({ doc: "D002", ...l })),
  ]
    .filter((l) => l.segs.map((x) => x.t).join("").toLowerCase().includes(s));
  const people = Object.entries(ENTITIES)
    .filter(([, e]) => e.name.toLowerCase().includes(s))
    .map(([role, e]) => ({ href: `#/people/${role}`, title: role, text: e.name }));
  return Promise.resolve([
    {
      kind: "lines",
      label: "Document lines",
      total: lines.length,
      items: lines.slice(0, 8).map((l) => ({
        href: `#/doc/${l.doc}:${l.line}`,
        title: `${l.doc}:${l.line}`,
        segs: l.segs,
      })),
    },
    { kind: "people", label: "People", total: people.length, items: people },
  ].filter((g) => g.items.length));
}
