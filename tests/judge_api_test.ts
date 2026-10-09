/**
 * casefile's extra checks through the API (ADR 14): what is sent, the gates on sending, and that
 * a judgement only ever flags. The language model and Jev are reached through a stubbed fetch that
 * records every request, so these tests see exactly what would leave casefile.
 * SYNTHETIC data only (ADR 11): the CANON case.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import type { FetchFn } from "../src/core/detect/llm.ts";
import { JEV_ENDPOINT, JEV_MODEL } from "../src/core/judge/jev.ts";
import type { NliModel } from "../src/core/judge/local.ts";
import type { CaseSession } from "../src/core/session.ts";
import { CANON_ENTITIES, seedCanon } from "./fixtures/canon.ts";
import { type Client, withCase } from "./helpers/app.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const JEV_KEY = "ts-test-KEY-7f3a9c1e5b2d8046";
const WITHHELD_MARK = "Quokka harbour agreement";
const EXPOSED_MARK = "Wombat changeover log";

interface Sent {
  url: string;
  body: string;
  headers: Headers;
}

/**
 * A fetch that answers like Ollama (not running), an OpenAI-compatible server and Jev, and records
 * every request. Every judgement it gives raises a flag.
 */
function recordingFetch(): { fetch: FetchFn; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn: FetchFn = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    sent.push({ url, body, headers: new Headers(init?.headers) });
    if (url.endsWith("/api/tags")) {
      return Promise.resolve(new Response("not ollama", { status: 404 }));
    }
    const flagAll = (qs: Record<string, Any>) =>
      Object.fromEntries(
        Object.keys(qs).map((id) => [
          id,
          id === "origin_hint"
            ? {
              type: "choice",
              choice: "under_order",
              confidence: 0.9,
              probabilities: {
                mine: 0.05,
                other_side: 0.02,
                court_or_subpoena: 0.02,
                under_order: 0.9,
                unclear: 0.01,
              },
            }
            : { type: "noul", noul: id === "fair_reading" ? 0.01 : 0.99 },
        ]),
      );
    if (url === JEV_ENDPOINT) {
      const req = JSON.parse(body);
      return Promise.resolve(
        Response.json({ model: JEV_MODEL, answers: flagAll(req.questions), usage: {} }),
      );
    }
    if (url.endsWith("/chat/completions")) {
      const req = JSON.parse(body);
      const { questions } = JSON.parse(req.messages[1].content);
      const answers = Object.fromEntries(
        Object.keys(questions).map((id) => [
          id,
          id === "origin_hint"
            ? {
              probabilities: {
                mine: 0.05,
                other_side: 0.02,
                court_or_subpoena: 0.02,
                under_order: 0.9,
                unclear: 0.01,
              },
            }
            : { p: id === "fair_reading" ? 0.01 : 0.99 },
        ]),
      );
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: JSON.stringify({ answers }) } }] }),
      );
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  };
  return { fetch: fetchFn, sent };
}

/** A local classifier that flags everything too (so local checks run without the real model). */
const flaggingNli: NliModel = {
  logits: (_premise, hypothesis) =>
    Promise.resolve(
      /official|emotion/.test(hypothesis)
        ? { entailment: 8, neutral: 0, contradiction: -8 }
        : { entailment: -8, neutral: 8, contradiction: 0 },
    ),
};

/** Every real value in CANON's who's who, in every form: none may ever be sent. */
const IDENTIFYING = [
  ...new Set(
    CANON_ENTITIES.flatMap((e) =>
      [e.full, e.first, e.surname, e.title, ...(e.aliases ?? [])].filter((v): v is string => !!v)
    ),
  ),
];

function assertNothingIdentifying(sent: Sent[]) {
  for (const r of sent) {
    const all = `${r.url}\n${r.body}`;
    for (const v of IDENTIFYING) {
      const re = new RegExp(
        `(^|[^\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
        "iu",
      );
      assert(!re.test(all), `a real value (${v}) was sent to ${r.url}`);
    }
    assert(!all.includes(WITHHELD_MARK), `withheld document text was sent to ${r.url}`);
    assert(!all.includes(EXPOSED_MARK), `exposed document text was sent to ${r.url}`);
  }
}

/**
 * CANON (D001, D002 shared), plus D003 withheld (from the other side), D004 exposed (shared, then
 * a nickname it shows was added), Claude's chronology entries and evidence citing each, and an
 * affidavit paragraph with cited sentences.
 */
async function canonCase(fetchFn: FetchFn) {
  const t = await withCase({
    detectorFactory: () => [],
    judgeDeps: { fetch: fetchFn, loadNli: () => Promise.resolve(flaggingNli) },
  });
  const s = t.state.session!;
  await seedCanon(s, { omitAliases: ["Annie"] });
  const d3 = await s.importText({
    title: "Father's affidavit",
    text: `I, Daniel Okafor, say on affirmation:\n1. The ${WITHHELD_MARK} was signed by Anna.`,
    origin: "other_side",
  });
  await s.publishWithDefaults(d3.id);
  const d4 = await s.importText({
    title: "Handover notes",
    text: `${EXPOSED_MARK}\nAnnie dropped Mia at school at 8:30am on 3 April 2025.`,
    origin: "mine",
  });
  await s.publishWithDefaults(d4.id);
  assertEquals(s.docState(await s.getDoc("D004")), "shared");

  const cite = (doc_id: string, a: number, b = a) => ({ doc_id, line_start: a, line_end: b });
  /** Claude's entry citing `refs` (written straight to public.db when the store would refuse). */
  const entry = (description: string, refs: ReturnType<typeof cite>[]) => {
    const id = s.store.addChronology({
      event_date: "2025-03-14",
      description,
      sources: [cite("D001", 1)],
    }, "claude");
    s.store.db.prepare("DELETE FROM chronology_sources WHERE entry_id = ?").run(id);
    for (const r of refs) {
      s.store.db.prepare(
        "INSERT INTO chronology_sources(entry_id, doc_id, line_start, line_end) VALUES (?, ?, ?, ?)",
      ).run(id, r.doc_id, r.line_start, r.line_end);
    }
    return id;
  };
  const chrono = {
    shared: entry("{{father.first}} collected {{child_1.first}} late from {{school}}.", [
      cite("D001", 1, 2),
      cite("D002", 9),
    ]),
    withheld: entry("An agreement was signed.", [cite("D003", 2)]),
    // Cited while D004 was shared; the nickname added below then exposes it.
    exposed: entry("{{child_1.first}} was dropped at school.", [cite("D004", 2)]),
    mixed: entry("Pick-up was late.", [cite("D001", 2), cite("D003", 2)]),
  };
  const mother = s.registry.get("mother")!;
  await s.updateEntity("mother", { aliases: [...mother.aliases, "Annie"] });
  assertEquals(s.docState(await s.getDoc("D003")), "withheld");
  assertEquals(s.docState(await s.getDoc("D004")), "exposed");

  const issue = s.store.addIssue({ title: "Pick-ups", description: "Lateness." }, "claude");
  const evidence = s.store.addEvidence(issue, {
    ...cite("D001", 7),
    note: "{{child_2.first}} was kept home with a temperature.",
  }, "claude");
  const draft = (await t.user.post("/api/drafts", { kind: "affidavit", title: "Affidavit" })).json
    .id;
  const para = s.store.addParagraph(
    draft,
    "I was frightened when {{father.first}} was late (D001:2). {{child_1.first}} waited at " +
      "{{school}} (D001:1). The agreement was signed (D003:2).",
    "claude",
  );
  return { ...t, s, chrono, evidence, para, draft };
}

async function useJev(user: Client) {
  const r = await user.put("/api/judge", {
    jevKey: JEV_KEY,
    backend: "jev",
    confirm: "send to Jev",
  });
  assertEquals(r.status, 200, r.text);
}

async function useLlm(user: Client, s: CaseSession, extra: Record<string, unknown> = {}) {
  const r = await user.put("/api/settings", {
    llm: {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "test-model",
      trustLocalServer: true,
      ...extra,
    },
  });
  assertEquals(r.status, 200, r.text);
  assertEquals((await user.put("/api/judge", { backend: "llm" })).status, 200);
  assert(s.settings.llm);
}

/** Ask the extra check about every item and document in the case. */
async function checkEverything(t: Awaited<ReturnType<typeof canonCase>>) {
  const out: Any[] = [];
  const ask = async (type: string, id: string | number) => {
    const r = await t.user.post("/api/judge/check", { type, id });
    assertEquals(r.status, 200, `${type} ${id}: ${r.text}`);
    out.push(r.json);
    return r.json;
  };
  for (const id of Object.values(t.chrono)) await ask("chronology", id);
  await ask("evidence", t.evidence);
  await ask("paragraph", t.para);
  for (const id of ["D001", "D002", "D003", "D004"]) await ask("document", id);
  return out;
}

// ── 1. nothing identifying is sent ─────────────────────────────────────────

for (const backend of ["jev", "llm"] as const) {
  Deno.test(`${backend}: only text with names replaced is sent, and never a withheld or exposed document`, async () => {
    const rec = recordingFetch();
    const t = await canonCase(rec.fetch);
    try {
      if (backend === "jev") await useJev(t.user);
      else await useLlm(t.user, t.s);
      const results = await checkEverything(t);
      const calls = rec.sent.filter((r) =>
        r.url === JEV_ENDPOINT || r.url.endsWith("/chat/completions")
      );
      // Not vacuous: shared text and Claude's notes were sent, with labels for the names.
      assert(calls.length >= 5, `only ${calls.length} requests`);
      const bodies = calls.map((c) => c.body).join("\n");
      assertStringIncludes(bodies, "Where are you?"); // D001:1, shared
      assertStringIncludes(bodies, "{{child_1.first}}");
      assertStringIncludes(bodies, "I was frightened when {{father.first}} was late");
      assertNothingIdentifying(rec.sent);
      // The items citing withheld or exposed documents were not sent, and say why.
      const byItem = results.map((r) => r.notChecked.join(" "));
      assertStringIncludes(byItem[1], "Claude can't see"); // chronology citing D003
      assertStringIncludes(byItem[2], "Claude can't see"); // citing exposed D004
      assertStringIncludes(byItem[3], "Claude can't see"); // one shared, one withheld citation
      assertStringIncludes(results.at(-2).notChecked.join(" "), "Claude can't see"); // D003
      assertStringIncludes(results.at(-1).notChecked.join(" "), "Claude can't see"); // D004
      if (backend === "jev") {
        for (const c of calls) {
          assertEquals(c.headers.get("authorization"), `Bearer ${JEV_KEY}`);
          const req = JSON.parse(c.body);
          assertEquals(req.model, JEV_MODEL);
          for (const q of Object.values(req.questions) as Any[]) assert(!("nli" in q));
        }
      }
    } finally {
      await t.state.shutdown();
    }
  });
}

Deno.test("text a new nickname would reveal is not sent, even in Claude's own note", async () => {
  const rec = recordingFetch();
  const t = await canonCase(rec.fetch);
  try {
    await useJev(t.user);
    // Claude wrote the nickname into a note before casefile knew it.
    const id = t.s.store.addChronology({
      event_date: "2025-03-14",
      description: "Annie waited at {{school}}.",
      sources: [{ doc_id: "D001", line_start: 1, line_end: 1 }],
    }, "claude");
    const r = await t.user.post("/api/judge/check", { type: "chronology", id });
    assertEquals(r.status, 200, r.text);
    assertEquals(r.json.judgements, 0);
    assertStringIncludes(r.json.notChecked[0], "name or number casefile knows");
    assertEquals(rec.sent.filter((x) => x.url === JEV_ENDPOINT).length, 0);
  } finally {
    await t.state.shutdown();
  }
});

// ── 2. configuration gates ─────────────────────────────────────────────────

Deno.test("Jev is off by default and turns on only with a key and the typed phrase", async () => {
  const rec = recordingFetch();
  const t = await canonCase(rec.fetch);
  try {
    const st = await t.user.get("/api/judge");
    assertEquals(st.json.backend, "local");
    assertEquals(st.json.jev.hasKey, false);
    assertEquals(st.json.jev.termsChecked, "2026-10-07");
    assertEquals(
      (await t.user.put("/api/judge", { backend: "jev", confirm: "send to Jev" })).status,
      400,
    );
    assertEquals((await t.user.put("/api/judge", { jevKey: JEV_KEY, backend: "jev" })).status, 400);
    assertEquals((await t.user.get("/api/judge")).json.backend, "local");
    assertEquals(
      (await t.user.get("/api/judge")).json.jev.hasKey,
      false,
      "a refused change saves nothing",
    );
    // Nothing went to Jev while it was off.
    await t.user.post("/api/judge/check", { type: "chronology", id: t.chrono.shared });
    assertEquals(rec.sent.filter((x) => x.url === JEV_ENDPOINT).length, 0);
    await useJev(t.user);
    const on = await t.user.get("/api/judge");
    assertEquals(on.json.backend, "jev");
    assert(on.json.jev.onSince);
    const actions = t.s.store.listLog(1000).map((r) => r.action);
    assert(actions.includes("jev_turned_on") && actions.includes("jev_key_saved"));
    // Turning it off is recorded too, and the Court summary names Jev as a second AI tool.
    await t.user.post("/api/judge/check", { type: "chronology", id: t.chrono.shared });
    assertEquals((await t.user.put("/api/judge", { backend: "local" })).status, 200);
    assert(t.s.store.listLog(1000).some((r) => r.action === "jev_turned_off"));
    const summary = await t.user.get("/api/court-summary");
    const tools = summary.json.sections.find((x: Any) => x.id === "tools").lines.join("\n");
    assertStringIncludes(tools, "Jev by TypeSafe AI, a second AI tool");
    assertStringIncludes(tools, "It answered 1 question about text with names replaced");
  } finally {
    await t.state.shutdown();
  }
});

Deno.test("Jev's key never appears in an API response, a log row, public.db or any plain file", async () => {
  const rec = recordingFetch();
  const t = await canonCase(rec.fetch);
  try {
    const texts: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await t.user.req(method, path, body);
      texts.push(r.text);
      return r;
    };
    await call("PUT", "/api/judge", { jevKey: JEV_KEY, backend: "jev", confirm: "send to Jev" });
    await call("POST", "/api/judge/test");
    await call("POST", "/api/judge/check", { type: "chronology", id: t.chrono.shared });
    // A key Jev refuses: the error must not quote it either.
    for (
      const path of [
        "/api/judge",
        "/api/settings",
        "/api/status",
        "/api/log",
        "/api/security-log",
        "/api/court-summary",
        "/api/to-check",
        "/api/chronology",
        "/api/issues",
        "/api/docs",
        "/api/people",
        `/api/drafts/${t.draft}`,
      ]
    ) await call("GET", path);
    for (const [i, text] of texts.entries()) {
      assert(!text.includes(JEV_KEY), `response ${i} has the key`);
      assert(!text.includes(JEV_KEY.slice(-12)), `response ${i} has part of the key`);
    }
    const log = JSON.stringify(t.s.store.db.prepare("SELECT * FROM ai_log").all());
    assert(!log.includes(JEV_KEY.slice(-12)), "the log has the key");
    await t.state.shutdown();
    // Every file in the case folder (public.db and its WAL, the encrypted vault, Claude's files).
    for await (const f of walk(t.caseDir, { includeDirs: false })) {
      const bytes = new TextDecoder("latin1").decode(await Deno.readFile(f.path));
      assert(!bytes.includes(JEV_KEY.slice(-12)), `${f.path} holds the key in plain text`);
    }
    // And the app's own config folder.
    for await (const f of walk(join(t.root, "config"), { includeDirs: false })) {
      assert(!(await Deno.readTextFile(f.path)).includes(JEV_KEY.slice(-12)));
    }
  } finally {
    await t.state.shutdown();
  }
});

Deno.test("a remote language model is refused for extra checks unless remote is allowed", async () => {
  const rec = recordingFetch();
  const t = await canonCase(rec.fetch);
  try {
    const r = await t.user.put("/api/settings", {
      llm: { baseUrl: "https://llm.example.com/v1", model: "big-model" },
    });
    assertEquals(r.status, 200, r.text);
    await t.user.put("/api/judge", { backend: "llm" });
    const refused = await t.user.post("/api/judge/check", {
      type: "chronology",
      id: t.chrono.shared,
    });
    assertEquals(refused.status, 409, refused.text);
    assertStringIncludes(refused.json.error, "isn't on this computer");
    assertEquals(rec.sent.length, 0, "nothing was sent, not even a probe");
    // An unconfirmed local server is refused too, until the user vouches for it.
    await t.user.put("/api/settings", { llm: { baseUrl: "http://127.0.0.1:1234/v1", model: "m" } });
    const local = await t.user.post("/api/judge/check", {
      type: "chronology",
      id: t.chrono.shared,
    });
    assertEquals(local.status, 409, local.text);
    assertEquals(rec.sent.filter((x) => x.url.endsWith("/chat/completions")).length, 0);
    // With remote allowed it is used.
    await t.user.put("/api/settings", {
      llm: { baseUrl: "https://llm.example.com/v1", model: "big-model", allowRemote: true },
    });
    const ok = await t.user.post("/api/judge/check", { type: "chronology", id: t.chrono.shared });
    assertEquals(ok.status, 200, ok.text);
    assertEquals(rec.sent.filter((x) => x.url.endsWith("/chat/completions")).length, 1);
    assertNothingIdentifying(rec.sent);
  } finally {
    await t.state.shutdown();
  }
});

// ── 3. flags only ──────────────────────────────────────────────────────────

/** Everything in public.db except the log, as one string. */
function publicExceptLog(s: CaseSession): string {
  const tables = (s.store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'ai_log%' AND name NOT LIKE '%fts%' ORDER BY name",
  ).all() as { name: string }[]).map((r) => r.name);
  return JSON.stringify(
    tables.map((n) => [n, s.store.db.prepare(`SELECT * FROM "${n}"`).all()]),
  );
}

Deno.test("a judgement only flags: nothing is marked, changed or shared, and checking ignores it", async () => {
  const rec = recordingFetch();
  const t = await canonCase(rec.fetch);
  try {
    await useJev(t.user);
    const before = {
      db: publicExceptLog(t.s),
      chrono: (await t.user.get("/api/chronology")).json,
      draft: (await t.user.get(`/api/drafts/${t.draft}`)).json,
      docs: (await t.user.get("/api/docs")).json,
      toCheck: (await t.user.get("/api/to-check")).json,
    };
    const results = await checkEverything(t);
    // It did flag: one per kind of question.
    const questions = new Set(results.flatMap((r) => r.flags.map((f: Any) => f.question)));
    assertEquals([...questions].sort(), ["fair_reading", "feeling_or_opinion", "origin_hint"]);
    for (const f of results.flatMap((r) => r.flags)) {
      assertEquals(f.kind, "judgement");
      assertEquals(f.level, "attention");
      assert(f.message.startsWith("casefile's extra check thinks"), f.message);
    }
    // Nothing else changed: public.db (but the log), every state, the queue.
    assertEquals(publicExceptLog(t.s), before.db);
    assertEquals((await t.user.get("/api/chronology")).json, before.chrono);
    assertEquals((await t.user.get(`/api/drafts/${t.draft}`)).json, before.draft);
    assertEquals((await t.user.get("/api/docs")).json, before.docs);
    assertEquals((await t.user.get("/api/to-check")).json, before.toCheck);
    // The log has counts only: no text, ids, questions or answers.
    const rows = t.s.store.listLog(1000).filter((r) => r.action === "judge_ran");
    // One row per item that asked anything (the 4 citing documents Claude can't see asked nothing).
    assertEquals(rows.length, 5);
    for (const r of rows) {
      assertEquals(Object.keys(JSON.parse(r.detail)).sort(), ["backend", "flags", "judgements"]);
    }
    // Checking and adopting go on as if the extra check had said nothing.
    const shown = (await t.user.get("/api/chronology")).json.find((e: Any) =>
      e.id === t.chrono.shared
    );
    const verify = await t.user.post(`/api/chronology/${t.chrono.shared}/verify`, {
      version: shown.version,
      quoteAccurate: true,
      fairReading: true,
    });
    assertEquals(verify.status, 200, verify.text);
    const entry = (await t.user.get("/api/chronology")).json.find((e: Any) =>
      e.id === t.chrono.shared
    );
    assertEquals(entry.state, "checked");
    assert(
      !JSON.stringify(entry.checks).includes("judgement"),
      "no judgement in casefile's checks",
    );
  } finally {
    await t.state.shutdown();
  }
});

Deno.test("the checking, adopting and sharing code never reads a judgement", async () => {
  // Structural: only the judge's own route and the app's wiring import it.
  const allowed = new Set(["src/app/routes/judge.ts", "src/app/state.ts"]);
  const root = new URL("../", import.meta.url);
  for await (const f of walk(new URL("../src/", import.meta.url), { exts: [".ts", ".js"] })) {
    const rel = f.path.slice(decodeURIComponent(root.pathname).length);
    if (rel.startsWith("src/core/judge/") || allowed.has(rel)) continue;
    const text = await Deno.readTextFile(f.path);
    assert(!/from\s+["'][^"']*\/judge\//.test(text), `${rel} imports the judge`);
  }
});
