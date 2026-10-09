/**
 * The UI design system's pure parts (ADR 0020): state vocabulary, entity colour classes, segment
 * plans, citations, routes, token contrast, and static checks that keep the UI CSP-safe
 * (no inline styles, no innerHTML) with its fonts bundled.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { extname, fromFileUrl, join } from "@std/path";
import { walk } from "@std/fs";
import {
  actorFor,
  badgeFor,
  checkRow,
  colourClass,
  contrast,
  CONTRAST_PAIRS,
  describeMark,
  ENTITY_ID,
  ENTITY_INK,
  ENTITY_SLOTS,
  formatDay,
  formatRef,
  formatRefs,
  idleNote,
  lineRange,
  parseRef,
  planSegments,
  plural,
  searchGroups,
  segmentsFromText,
  shapeClass,
  sourceWindow,
  STATES,
  toCheckCount,
  tokenText,
  updateCheckNote,
} from "../src/app/ui/model.js";
import { matchRoute, NAV, redirectFor, ROUTES } from "../src/app/ui/routes.js";
import { EXTERNAL_LINKS } from "../src/app/links.ts";

const UI = fromFileUrl(new URL("../src/app/ui/", import.meta.url));
/** The only addresses the UI may name: the vetted help links (src/app/links.ts). */
const ALLOWED_LINKS = new Set<string>(Object.values(EXTERNAL_LINKS).map((l) => l.url));

// ── vocabulary ──────────────────────────────────────────────────────────────

Deno.test("badges use the spec's words, glyphs and only two status hues", () => {
  assertEquals(badgeFor("doc", "exposed").label, "Exposed — re-check");
  assertEquals(badgeFor("doc", "exposed").tone, "danger");
  assertEquals(badgeFor("doc", "withheld").glyph, "lock");
  assertEquals(badgeFor("work", "cant_check").label, "Can’t check");
  assertEquals(badgeFor("work", "changed").tone, "attention");
  assertEquals(badgeFor("para", "claude_adopted").glyph, "pen");
  assertEquals(badgeFor("para", "claude_adopted").className, "badge badge--neutral");
  for (const states of Object.values(STATES)) {
    for (const s of Object.values(states)) {
      assert(["neutral", "attention", "danger"].includes(s.tone));
      assert(s.glyph, "status is never colour alone");
      // Words the spec forbids on screen.
      assert(!/\b(verified|unverified|publish|tokenis|entity|leak|de-identified)/i.test(s.label));
    }
  }
});

Deno.test("old API values are no longer states; anything outside the vocabulary throws", () => {
  assertThrows(() => badgeFor("doc", "pending"));
  assertThrows(() => badgeFor("doc", "published"));
  assertThrows(() => badgeFor("para", "claude_needs_review"));
  assertThrows(() => badgeFor("doc", "verified"));
  assertThrows(() => badgeFor("doc", "toString"));
  assertThrows(() => badgeFor("nope" as "doc", "shared"));
});

Deno.test("actors are words, never colours", () => {
  assertEquals(actorFor("claude").label, "Claude");
  assertEquals(actorFor("you").label, "You");
  assertEquals(actorFor("casefile").label, "casefile checked");
  assertThrows(() => actorFor("someone"));
});

// ── entity colour ───────────────────────────────────────────────────────────

Deno.test("parties and children get the six slots; everyone else is neutral ink", () => {
  assertEquals(colourClass({ role: "mother", kind: "person" }), "ent-c0");
  assertEquals(colourClass({ role: "child_2", kind: "person" }), "ent-c3");
  assertEquals(colourClass({ role: "maternal_grandmother", kind: "person" }), "ent-ink");
  assertEquals(colourClass({ role: "class_teacher", kind: "person", colour: 4 }), "ent-c4");
  assertEquals(colourClass({ role: "mother", kind: "person", colour: null }), "ent-ink");
  assertEquals(colourClass({ role: "school", kind: "school" }), "ent-ink");
  assertEquals(colourClass({ role: "phone_1", kind: "phone", colour: 2 }), "ent-id");
  assertEquals(colourClass({ role: "x", kind: "person", colour: 9 }), "ent-ink");
  assertEquals(shapeClass("person"), "ent-solid");
  assertEquals(shapeClass("organisation"), "ent-dashed");
  assertEquals(shapeClass("date_of_birth"), "ent-dotted");
  assertEquals(shapeClass("address"), "ent-dotted");
});

Deno.test("segments plan marks, chips and unknown labels", () => {
  const segs = [
    { t: "On 14 March 2025 " },
    { t: "Daniel", role: "father", form: "first", kind: "person", name: "Daniel Okafor" },
    " collected ",
    { t: "{{child_3}}", unknown: true, raw: "{{child_3}}" },
  ];
  const real = planSegments(segs);
  assertEquals(real.map((p) => p.type), ["text", "mark", "text", "unknown"]);
  assertEquals(real[1].className, "ent ent-c1 ent-solid");
  assertEquals(real[1].text, "Daniel");
  assertEquals(real[1].describe, "Daniel Okafor — Claude sees {{father.first}}");
  assertEquals(real[3].className, "token token--unknown");
  const tok = planSegments(segs, { mode: "token" });
  assertEquals(tok[1].type, "chip");
  assertEquals(tok[1].text, "{{father.first}}");
  assertEquals(tok[1].className, "token ent-c1");
  assertEquals(tokenText("mother"), "{{mother}}");
  assertEquals(tokenText("mother", "full"), "{{mother}}");
  assertEquals(
    describeMark("Anna Thornbury", "mother", "first"),
    "Anna Thornbury — Claude sees {{mother.first}}",
  );
});

Deno.test("segmentsFromText finds known, unknown and broken labels", () => {
  const segs = segmentsFromText("Hi {{mother.first}}, {{child_9}} and {{ oops }}", {
    mother: { name: "Anna Thornbury", kind: "person", colour: 0 },
  });
  assertEquals(segs[1].role, "mother");
  assertEquals(segs[1].form, "first");
  assertEquals(segs[3].unknown, true);
  assertEquals(segs[5].malformed, true);
  assertEquals(segmentsFromText("plain"), [{ t: "plain" }]);
});

// ── citations and checks ────────────────────────────────────────────────────

Deno.test("citations use en dashes and round-trip", () => {
  assertEquals(formatRef({ doc: "D001", start: 1, end: 2 }), "D001:1–2");
  assertEquals(formatRef({ doc_id: "D002", line_start: 9, line_end: 9 }), "D002:9");
  assertEquals(parseRef("D001:1-2"), { doc: "D001", start: 1, end: 2 });
  assertEquals(parseRef("D001:1–2"), { doc: "D001", start: 1, end: 2 });
  assertEquals(parseRef("D002:9"), { doc: "D002", start: 9, end: 9 });
  assertEquals(parseRef("D002:9-3"), null);
  assertEquals(parseRef("nope"), null);
  assertEquals(
    formatRefs([{ doc: "D002", start: 9 }, { doc: "D001", start: 1, end: 2 }]),
    "D002:9 and D001:1–2",
  );
  assertEquals(lineRange(3), "line 3");
  assertEquals(lineRange(1, 7), "lines 1–7");
});

Deno.test("SourcePanel window shows ±2 lines of context, clipped to the document", () => {
  type L = { line: number; cited: boolean };
  const doc = ["a", "b", "c", "d", "e", "f", "g"];
  const win = (s: number, e?: number, c?: number): L[] => sourceWindow(doc, s, e, c);
  const w = win(1, 2);
  assertEquals(w.map((l) => l.line), [1, 2, 3, 4]);
  assertEquals(w.map((l) => l.cited), [true, true, false, false]);
  assertEquals(win(7).map((l) => l.line), [5, 6, 7]);
  assertEquals(win(4, 4, 1).map((l) => l.line), [3, 4, 5]);
});

Deno.test("check rows map levels to glyphs and screen-reader words", () => {
  assertEquals(checkRow({ level: "ok", message: "x" }).glyph, "check");
  assertEquals(checkRow({ level: "danger", message: "x" }).glyph, "triangle");
  assertEquals(checkRow({ ok: false, message: "x" }).level, "danger");
  assertEquals(checkRow({ level: "attention", message: "x" }).sr, "Look at this:");
});

// ── API degradation ─────────────────────────────────────────────────────────

Deno.test("To-check count and search results accept today's and tomorrow's shapes", () => {
  assertEquals(toCheckCount({ total: 14 }), 14);
  assertEquals(toCheckCount({ items: [1, 2] }), 2);
  assertEquals(toCheckCount({ groups: [{ count: 1 }, { items: [1, 2] }] }), 3);
  assertEquals(toCheckCount(null), null);
  assertEquals(searchGroups(null), []);
  const all = searchGroups({
    groups: [{ kind: "people", label: "People", total: 3, items: [{ href: "#/people/mother" }] }, {
      kind: "issues",
      items: [],
    }],
  });
  assertEquals(all.length, 1);
  assertEquals(all[0].total, 3);
});

Deno.test("search results: the real /api/search/all shape becomes palette groups (QA G1)", () => {
  // Shape returned by GET /api/search/all (src/app/routes/search.ts); a regression here made
  // ⌘K show "No matches" for every query.
  const body = {
    q: "Mia",
    total: 223,
    totals: { lines: 219, people: 1, chronology: 2, issues: 1 },
    offset: 0,
    limit: 50,
    lines: [{
      doc_id: "D001",
      line: 1,
      text: { text: "Mia ok", segs: [{ t: "Mia", role: "child_1" }, { t: " ok" }] },
      docTitle: "Text messages",
      docState: "shared",
    }],
    people: [{ role: "child_1", kind: "person", group: "people", name: "Mia Okafor", colour: 2 }],
    chronology: [{ id: 7, event_date: "2025-03-14", description: { text: "Mia late", segs: [] } }],
    issues: [{ id: 3, title: { text: "Mia's schooling", segs: [] } }],
  };
  const g = searchGroups(body);
  assertEquals(g.map((x: { kind: string }) => x.kind), ["lines", "people", "chronology", "issues"]);
  assertEquals(g.map((x: { total: number }) => x.total), [219, 1, 2, 1]);
  assertEquals(g[0].items[0].href, "#/doc/D001:1");
  assertEquals(g[0].items[0].segs?.[0].role, "child_1");
  assertEquals(g[1].items[0], { href: "#/people/child_1", title: "Mia Okafor", text: "child 1" });
  assertEquals(g[2].items[0].href, "#/chronology?entry=7");
  assertEquals(g[2].items[0].title, "14 March 2025");
  assertEquals(g[3].items[0].href, "#/issues/3");
  assertEquals(g[3].items[0].text, "Mia's schooling");
  // Empty groups drop out; an empty result is no groups.
  assertEquals(searchGroups({ ...body, people: [], chronology: [], issues: [] }).length, 1);
  assertEquals(
    searchGroups({
      q: "",
      total: 0,
      totals: {},
      lines: [],
      people: [],
      chronology: [],
      issues: [],
    }),
    [],
  );
});

Deno.test("small formatters", () => {
  assertEquals(formatDay("2025-03-14"), "14 March 2025");
  assertEquals(formatDay("2025-10-07", true), "7 Oct 2025");
  assertEquals(formatDay(""), "");
  assertEquals(plural(1, "entry", "entries"), "1 entry");
  assertEquals(plural(4, "entry", "entries"), "4 entries");
  assertEquals(idleNote(30), "Locks after 30 min idle");
  assertEquals(idleNote(60), "Locks after 1 hour idle");
  assertEquals(idleNote(undefined), "Locks after 30 min idle");
});

// ── routes ──────────────────────────────────────────────────────────────────

Deno.test("routes match the planned hashes", () => {
  const m = (h: string) => {
    const r = matchRoute(h);
    return r ? [r.route.name, r.params] : null;
  };
  assertEquals(m("#/review/D015"), ["review", { id: "D015" }]);
  assertEquals(m("#/docs"), ["documents", {}]);
  assertEquals(m("#/doc/D001"), ["document", { id: "D001" }]);
  assertEquals(m("#/doc/D002:9"), ["document", { id: "D002", line: "9" }]);
  assertEquals(m("#/doc/nope"), null);
  assertEquals(m("#/people"), ["people", {}]);
  assertEquals(m("#/people/mother"), ["people", { role: "mother" }]);
  assertEquals(m("#/issues/3"), ["issues", { id: "3" }]);
  assertEquals(m("#/draft/1"), ["draft", { id: "1" }]);
  assertEquals(m("#/draft/x"), null);
  for (
    const h of [
      "#/chronology",
      "#/drafts",
      "#/to-check",
      "#/log",
      "#/paste",
      "#/settings",
      "#/start",
    ]
  ) {
    assert(matchRoute(h), h);
  }
  assertEquals(m("#/nope"), null);
  assertEquals(redirectFor("#/entities"), null);
  assertEquals(redirectFor("#/reidentify"), null);
  assertEquals(redirectFor(""), "#/docs");
  assertEquals(redirectFor("#/docs"), null);
});

Deno.test("the header has the spec's eight sections and every route's view exists", async () => {
  assertEquals(NAV.map((n) => n.label), [
    "Documents",
    "To check",
    "People",
    "Chronology",
    "Issues",
    "Drafts",
    "Log",
    "Settings",
  ]);
  const index = await Deno.readTextFile(join(UI, "index.html"));
  for (const r of ROUTES) {
    const file = /import\("\.\/views\/([a-z]+)\.js"\)/.exec(r.load.toString())?.[1];
    assert(file, `${r.name}: load() must import ./views/<name>.js`);
    await Deno.stat(join(UI, "views", `${file}.js`));
    assert(index.includes(`href="/views/${file}.css"`), `index.html links views/${file}.css`);
    await Deno.stat(join(UI, "views", `${file}.css`));
  }
  assert(!index.includes("legacy"), "index.html links no legacy stylesheet");
});

// ── tokens and contrast ─────────────────────────────────────────────────────

Deno.test("token colours meet the spec's contrast (text 4.5:1, UI 3:1)", () => {
  for (const [fg, bg] of CONTRAST_PAIRS.text) {
    assert(contrast(fg, bg) >= 4.5, `${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}`);
  }
  for (const [fg, bg] of CONTRAST_PAIRS.ui) {
    assert(contrast(fg, bg) >= 3, `${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}`);
  }
});

Deno.test("tokens.css defines the spec palette that model.js mirrors", async () => {
  const css = (await Deno.readTextFile(join(UI, "tokens.css"))).toLowerCase();
  for (const [i, hex] of ENTITY_SLOTS.entries()) {
    assert(css.includes(`--ent-c${i}: ${hex.toLowerCase()}`), `--ent-c${i}`);
  }
  assert(css.includes(`--ent-ink: ${ENTITY_INK.toLowerCase()}`));
  assert(css.includes(`--ent-id: ${ENTITY_ID.toLowerCase()}`));
  for (const v of ["--attn: #e8a33d", "--danger: #f4867a", "--focus: #ffd27a", "--bg: #121518"]) {
    assert(css.includes(v), v);
  }
  const components = await Deno.readTextFile(join(UI, "components.css"));
  for (let i = 0; i < 6; i++) assert(components.includes(`.ent-c${i} {`), `.ent-c${i}`);
  assert(components.includes(".ent-ink {") && components.includes(".ent-id {"));
});

// ── CSP safety ──────────────────────────────────────────────────────────────

Deno.test("the UI has no inline styles, inline scripts, innerHTML or external resources", async () => {
  for await (const f of walk(UI, { includeDirs: false })) {
    const ext = extname(f.path);
    if (![".js", ".html", ".css"].includes(ext)) continue;
    const text = await Deno.readTextFile(f.path);
    const rel = f.path.slice(UI.length);
    if (ext === ".html") {
      assert(!/\sstyle\s*=/.test(text), `${rel}: style attribute`);
      assert(!/<style[\s>]/.test(text), `${rel}: <style> block`);
      assert(!/<script(?![^>]*\bsrc=)[^>]*>/.test(text), `${rel}: inline script`);
      assert(!/\son[a-z]+\s*=/.test(text), `${rel}: inline event handler`);
    }
    if (ext === ".js") {
      assert(
        !/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/.test(text),
        `${rel}: HTML injection`,
      );
      assert(!/\.style\.|setAttribute\(\s*["']style/.test(text), `${rel}: inline style`);
      // h(tag, {style: …}) — dom.js itself names the key only to refuse it.
      if (!rel.endsWith("dom.js")) {
        assert(!/[{,]\s*style\s*:/.test(text), `${rel}: style attribute`);
      }
    }
    // No external resources, and no links out except the vetted help links (links.ts), which
    // may appear only in components/links.js. Comments are stripped first, but not the "//" of
    // a URL (the old pattern stripped from "https://" to the end of the line, hiding every URL).
    const code = text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/.*$/gm, "$1");
    for (const m of code.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      const url = m[0];
      if (url.startsWith("http://www.w3.org/2000/svg")) continue;
      // A local address shown as an example (the language model field's placeholder).
      if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) continue;
      assert(
        rel === "components/links.js" && ALLOWED_LINKS.has(url),
        `${rel}: external URL ${url}`,
      );
    }
  }
});

Deno.test("h() refuses a style attribute and innerHTML", async () => {
  const g = globalThis as unknown as { document?: unknown };
  const had = "document" in g;
  const before = g.document;
  g.document = {
    createElement: () => ({ setAttribute() {}, append() {}, addEventListener() {} }),
    createTextNode: (t: string) => t,
  };
  try {
    const { h } = await import("../src/app/ui/dom.js");
    assertThrows(() => h("div", { style: "color: red" }), Error, "inline styles are not allowed");
    assertThrows(() => h("div", { innerHTML: "<b>x</b>" }), Error, "innerHTML is not allowed");
  } finally {
    if (had) g.document = before;
    else delete g.document;
  }
});

Deno.test("IBM Plex is bundled as real woff2 files with the OFL", async () => {
  for (
    const f of [
      "IBMPlexSans-Regular",
      "IBMPlexSans-Medium",
      "IBMPlexSans-SemiBold",
      "IBMPlexMono-Regular",
      "IBMPlexMono-Medium",
    ]
  ) {
    const bytes = await Deno.readFile(join(UI, "fonts", `${f}.woff2`));
    assertEquals(new TextDecoder().decode(bytes.slice(0, 4)), "wOF2", f);
    const css = await Deno.readTextFile(join(UI, "tokens.css"));
    assert(css.includes(`/fonts/${f}.woff2`), `${f} has an @font-face`);
  }
  const ofl = await Deno.readTextFile(join(UI, "fonts", "OFL.txt"));
  assert(ofl.includes("SIL OPEN FONT LICENSE Version 1.1"));
});

Deno.test("Settings says what the last update check found", () => {
  const u = { enabled: true, ready: null, checking: false, lastCheck: null, lastError: null };
  const at = "2026-10-09T02:00:00.000Z";
  assertEquals(updateCheckNote({ ...u, enabled: false }), null);
  assertEquals(updateCheckNote(u), "casefile hasn't checked for updates yet.");
  assertEquals(updateCheckNote({ ...u, checking: true }), "Checking for updates…");
  assertEquals(
    updateCheckNote({ ...u, lastCheck: at }, () => "9 Oct 13:00"),
    "casefile is up to date (checked 9 Oct 13:00).",
  );
  assertEquals(
    updateCheckNote({ ...u, lastCheck: at, lastError: "github.com answered 503." }, () => "then"),
    "Last check (then) failed: github.com answered 503.",
  );
  assertEquals(
    updateCheckNote({ ...u, lastCheck: at, ready: "0.3.0" }),
    "casefile 0.3.0 is ready. Restart to update.",
  );
});
