/**
 * The desktop app's HTTP server and JSON API (ADR 13). Requests go straight to the handler from
 * `createHandler`; no socket is opened.
 *
 * Threat model: any local process (including Claude Code with a shell) can send requests to the
 * API. Only the user in the app holds the session cookie, which is issued only for the passphrase.
 */
import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import type { AppState } from "../src/app/state.ts";
import type { ProposedSpan } from "../src/core/detect/pipeline.ts";
import {
  AFFIDAVIT,
  AFFIDAVIT_TITLE,
  FakeNameDetector,
  IDS,
  MESSAGES,
  MESSAGES_TITLE,
  PEOPLE,
} from "./fixtures/synthetic.ts";
import { dumpPublic } from "./fixtures/case.ts";
import {
  allRoutes,
  assertNoSecrets,
  assertSecurityHeaders,
  Client,
  importAndPublish,
  NAMES,
  NEW_NAME,
  ORIGIN,
  PASS,
  publishRequestFrom,
  setup,
  withCase,
} from "./helpers/app.ts";

const CLAUDE_TEXT =
  "On 14 March 2025 {{father.first}} collected the children 90 minutes late from {{school}}.";

// ── Host and Origin ─────────────────────────────────────────────────────────

Deno.test("a non-loopback Host header is refused (DNS rebinding)", async () => {
  const { state, user, other } = await withCase();
  try {
    for (const host of ["evil.example:8217", "evil.example", "127.0.0.1.evil.example:8217"]) {
      for (const path of ["/api/status", "/api/settings", "/", "/app.js"]) {
        const r = await user.get(path, { host });
        assertEquals(r.status, 403, `${host} ${path}`);
        assertNoSecrets(r.text, path);
      }
    }
    // Missing Host header too.
    const r = await other.handler(new Request(`${ORIGIN}/api/status`));
    assertEquals(r.status, 403);
    // Loopback names are fine.
    for (const host of ["localhost:8217", "[::1]:8217", "127.0.0.1"]) {
      assertEquals((await user.get("/api/status", { host })).status, 200, host);
    }
  } finally {
    state.lock();
  }
});

Deno.test("cross-origin POSTs are refused; same-origin and no-origin POSTs are allowed", async () => {
  const { state, user } = await withCase();
  try {
    const body = { text: "{{father}}" };
    for (
      const origin of [
        "http://evil.example",
        "null",
        "http://localhost:8217",
        "http://127.0.0.1:9999",
      ]
    ) {
      const r = await user.post("/api/paste/view", body, { origin });
      assertEquals(r.status, 403, origin);
      assertSecurityHeaders(r, "403");
    }
    // A cross-origin lock attempt with the cookie does nothing.
    assertEquals((await user.post("/api/lock", {}, { origin: "http://evil.example" })).status, 403);
    assert(state.session !== null, "still unlocked");

    const same = await user.post("/api/paste/view", body, { origin: ORIGIN });
    assertEquals(same.status, 200, same.text);
    assertEquals(same.json.unknown, ["{{father}}"]); // no entities yet
    const none = await user.post("/api/paste/view", body);
    assertEquals(none.status, 200);
    // GETs carry no Origin check (read-only; the cookie still applies).
    assertEquals((await user.get("/api/settings", { origin: "http://evil.example" })).status, 200);
  } finally {
    state.lock();
  }
});

// ── locked / signed-out ─────────────────────────────────────────────────────

Deno.test("only status, case/open, case/create and case/restore are open routes", async () => {
  const { state } = await setup();
  const open = allRoutes(state).filter((r) => r.open).map((r) => `${r.method} ${r.path}`).sort();
  assertEquals(open, [
    "GET /api/status",
    "POST /api/case/create",
    "POST /api/case/open",
    // ADR 29: restoring a backup works before any case is open.
    "POST /api/case/restore",
  ]);
});

Deno.test("every non-open route is 423 when locked and 401 without the cookie when unlocked", async () => {
  const t = await setup();
  const routes = allRoutes(t.state).filter((r) => !r.open);
  assert(routes.length > 40, `found ${routes.length} routes`);
  for (const r of routes) {
    const res = await t.other.req(r.method, r.path, r.method === "GET" ? undefined : {});
    assertEquals(res.status, 423, `${r.method} ${r.path} while locked`);
    assertSecurityHeaders(res, r.path);
  }

  // Unlock as the user; set up a little data so a successful bypass would be visible.
  const c = await t.user.post("/api/case/create", {
    dir: t.caseDir,
    passphrase: PASS,
    label: "Test matter",
  });
  assertEquals(c.status, 200);
  await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });

  const wrong = new Client(t.handler);
  wrong.cookie = "0".repeat(64);
  const sameLength = new Client(t.handler);
  sameLength.cookie = t.user.cookie!.slice(0, -1) + (t.user.cookie!.endsWith("a") ? "b" : "a");
  for (const caller of [t.other, wrong, sameLength]) {
    for (const r of routes) {
      const res = await caller.req(r.method, r.path, r.method === "GET" ? undefined : {});
      assertEquals(res.status, 401, `${r.method} ${r.path} with cookie ${caller.cookie}`);
      assertNoSecrets(res.text, r.path);
    }
  }
  // None of that disturbed the user's session.
  assert(t.state.session !== null);
  assertEquals((await t.user.get("/api/docs/D001")).status, 200);
  assertEquals((await t.user.get("/api/docs")).json.length, 1);
  t.state.lock();
});

Deno.test("status reveals the label and case folder only to the signed-in user", async () => {
  const { state, user, other, caseDir } = await withCase();
  try {
    const anon = await other.get("/api/status");
    assertEquals(anon.status, 200);
    assertEquals(anon.json.unlocked, true);
    assertEquals(anon.json.signedIn, false);
    assertEquals(anon.json.label, null);
    assertEquals(anon.json.caseDir, null);
    assertEquals(anon.json.lastCaseDir, null);
    assert(!anon.text.includes("Test matter"));
    assert(!anon.text.includes(caseDir));
    assertSecurityHeaders(anon, "status");

    const me = await user.get("/api/status");
    assertEquals(me.json.signedIn, true);
    assertEquals(me.json.label, "Test matter");
    assertEquals(me.json.caseDir, caseDir);
    assertEquals(me.json.lastCaseDir, null);

    // Once nothing is open, the Unlock screen can be filled in with the last case (QA U1).
    state.lock();
    const locked = await other.get("/api/status");
    assertEquals(locked.json.lastCaseDir, caseDir);
    assertEquals(locked.json.label, null);
  } finally {
    state.lock();
  }
});

// ── opening and creating while another session is unlocked ──────────────────

Deno.test("another caller cannot create a case over the user's session", async () => {
  const { state, user, other, root } = await withCase();
  try {
    const token = state.token;
    const r = await other.post("/api/case/create", {
      dir: join(root, "case-2"),
      passphrase: "another long passphrase",
      label: "Mine now",
    });
    assertEquals(r.status, 409);
    assertEquals(other.cookie, undefined);
    assertEquals(state.token, token);
    await assertRejectsNotFound(join(root, "case-2"));
    assertEquals((await user.get("/api/settings")).json.label, "Test matter");
  } finally {
    state.lock();
  }
});

Deno.test("case/open with the right passphrase replaces the session; a wrong one does not", async () => {
  const { state, user, other, caseDir } = await withCase();
  try {
    // Wrong passphrase from a caller without the cookie: refused, user keeps working.
    const bad = await other.post("/api/case/open", {
      dir: caseDir,
      passphrase: "not the passphrase",
    });
    assert(bad.status === 401 || bad.status === 409, `wrong passphrase gave ${bad.status}`);
    assertEquals(other.cookie, undefined);
    assertEquals((await user.get("/api/settings")).status, 200);

    // The right passphrase proves it is the user (e.g. the webview lost its cookie).
    const oldCookie = user.cookie;
    const ok = await other.post("/api/case/open", { dir: caseDir, passphrase: PASS });
    assertEquals(ok.status, 200, ok.text);
    assertExists(other.cookie);
    assertNotEquals(other.cookie, oldCookie);
    assertEquals((await other.get("/api/settings")).status, 200);
    // The old cookie no longer works.
    assertEquals((await user.get("/api/settings")).status, 401);
  } finally {
    state.lock();
  }
});

async function assertRejectsNotFound(path: string) {
  try {
    await Deno.stat(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return;
    throw e;
  }
  throw new Error(`${path} should not exist`);
}

Deno.test("creating a case in a non-empty folder is refused and writes nothing there", async () => {
  const { state, user, root } = await setup();
  const dir = join(root, "My documents");
  await Deno.mkdir(dir);
  await Deno.writeTextFile(join(dir, "notes.txt"), "personal notes");
  const r = await user.post("/api/case/create", { dir, passphrase: PASS, label: "x" });
  assertEquals(r.status, 409, r.text);
  const names = [];
  for await (const e of Deno.readDir(dir)) names.push(e.name);
  assertEquals(names, ["notes.txt"]);
  assertEquals(state.session, null);
  assertEquals(user.cookie, undefined);

  // An existing empty folder is fine.
  const empty = join(root, "empty");
  await Deno.mkdir(empty);
  assertEquals(
    (await user.post("/api/case/create", { dir: empty, passphrase: PASS, label: "x" })).status,
    200,
  );
  state.lock();
});

Deno.test("a passphrase shorter than 12 characters is rejected before anything is written", async () => {
  const { state, user, caseDir } = await setup();
  const r = await user.post("/api/case/create", {
    dir: caseDir,
    passphrase: "short pass",
    label: "x",
  });
  assertEquals(r.status, 400);
  await assertRejectsNotFound(caseDir);
  assertEquals(state.session, null);
  // Missing fields are 400 too.
  assertEquals((await user.post("/api/case/create", { dir: caseDir, label: "x" })).status, 400);
  assertEquals((await user.post("/api/case/create", "{not json")).status, 400);
});

Deno.test("passphrase attempts are rate limited, even for the right passphrase", async () => {
  const { state, user, caseDir } = await withCase();
  await user.post("/api/lock");
  assertEquals(state.session, null);
  const attacker = new Client(user.handler);
  for (let i = 0; i < 3; i++) {
    const r = await attacker.post("/api/case/open", {
      dir: caseDir,
      passphrase: `wrong guess ${i}xx`,
    });
    assertEquals(r.status, 401, `attempt ${i + 1}`);
    assertEquals(r.json.error, "Wrong passphrase");
  }
  const blocked = await user.post("/api/case/open", { dir: caseDir, passphrase: PASS });
  assertEquals(blocked.status, 429);
  assert(typeof blocked.json.retryAfterSeconds === "number" && blocked.json.retryAfterSeconds > 0);
  assert(blocked.json.retryAfterSeconds <= 2);
  assertEquals(state.session, null, "a blocked attempt does not open the case");
  const st = await user.get("/api/status");
  assert(st.json.retryAfterSeconds > 0);

  // After the wait the right passphrase works again (first wait is 2 s).
  await new Promise((r) => setTimeout(r, blocked.json.retryAfterSeconds * 1000 + 50));
  const ok = await user.post("/api/case/open", { dir: caseDir, passphrase: PASS });
  assertEquals(ok.status, 200, ok.text);
  assertEquals((await user.get("/api/status")).json.retryAfterSeconds, 0);

  // A wrong current passphrase on a passphrase change counts as a failure too.
  const ch = await user.post("/api/case/passphrase", {
    current: "not it at all",
    next: "another long passphrase",
  });
  assertEquals(ch.status, 401);
  assertEquals((await user.get("/api/settings")).status, 200);
  state.lock();
});

Deno.test("parallel guesses cannot race past the limit", async () => {
  const { state, user, caseDir } = await withCase();
  await user.post("/api/lock");
  const attacker = new Client(user.handler);
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      (_, i) => attacker.post("/api/case/open", { dir: caseDir, passphrase: `guess number ${i}` }),
    ),
  );
  const statuses = results.map((r) => r.status);
  // Attempts run one at a time: only the first 3 are checked, the rest are refused unchecked.
  assertEquals(statuses.filter((s) => s === 401).length, 3);
  assertEquals(statuses.filter((s) => s === 429).length, 5);
  state.lock();
});

Deno.test("unlocking another case does not reset the limit on this one", async () => {
  const { state, user, caseDir, root } = await withCase();
  await user.post("/api/lock");
  const attacker = new Client(user.handler);
  for (let i = 0; i < 3; i++) {
    await attacker.post("/api/case/open", { dir: caseDir, passphrase: `wrong guess ${i}xx` });
  }
  // The attacker makes their own case with a known passphrase and opens it successfully...
  const own = join(root, "attacker-case");
  assertEquals(
    (await attacker.post("/api/case/create", {
      dir: own,
      passphrase: "attacker passphrase",
      label: "x",
    })).status,
    200,
  );
  await attacker.post("/api/lock");
  assertEquals(
    (await attacker.post("/api/case/open", { dir: own, passphrase: "attacker passphrase" })).status,
    200,
  );
  await attacker.post("/api/lock");
  // ...but the user's case is still rate limited.
  assertEquals(
    (await attacker.post("/api/case/open", { dir: caseDir, passphrase: "yet another guess" }))
      .status,
    429,
  );
  state.lock();
});

Deno.test("a symlinked path shares the limit of the case it points to", async () => {
  const { state, user, caseDir, root } = await withCase();
  await user.post("/api/lock");
  const link = join(root, "alias-to-case");
  await Deno.symlink(caseDir, link);
  const attacker = new Client(user.handler);
  for (let i = 0; i < 3; i++) {
    await attacker.post("/api/case/open", { dir: link, passphrase: `wrong guess ${i}xx` });
  }
  assertEquals(
    (await attacker.post("/api/case/open", { dir: caseDir, passphrase: "another guess" })).status,
    429,
  );
  state.lock();
});

// ── headers, static files, errors ───────────────────────────────────────────

Deno.test("API and static responses carry the security headers", async () => {
  const { state, user, other } = await withCase();
  try {
    for (
      const [c, path] of [
        [user, "/api/status"],
        [user, "/api/settings"],
        [other, "/api/settings"],
        [user, "/"],
        [user, "/app.js"],
        [user, "/style.css"],
      ] as const
    ) {
      const r = await c.get(path);
      assertSecurityHeaders(r, path);
    }
    const index = await user.get("/");
    assertEquals(index.status, 200);
    assert(index.headers.get("content-type")?.startsWith("text/html"));
    assertEquals((await user.get("/api/nope")).status, 404);
    assertEquals((await user.req("DELETE", "/api/status")).status, 405);
    assertEquals((await user.req("POST", "/")).status, 405);
  } finally {
    state.lock();
  }
});

Deno.test("static paths cannot escape the UI folder", async () => {
  const { user } = await setup();
  const deno = await Deno.readTextFile(new URL("../deno.json", import.meta.url));
  for (
    const path of [
      "/../deno.json",
      "/%2e%2e/deno.json",
      "/..%2fdeno.json",
      "/%2e%2e%2fdeno.json",
      "/..%2f..%2f..%2fdeno.json",
      "/%2e%2e%2f%2e%2e%2f%2e%2e%2fdeno.json",
      "/ui/../../deno.json",
      "/../../../src/app/state.ts",
      "/..%5cdeno.json",
      "//etc/passwd",
      "/%2e%2e%2f%2e%2e%2f%2e%2e%2fCLAUDE",
    ]
  ) {
    const r = await user.get(path);
    assert(r.status === 404 || r.status === 200, `${path}: ${r.status}`);
    assert(!r.text.includes('"@casefile/casefile"'), `${path} served deno.json`);
    assert(!r.text.includes(deno.slice(0, 40)), `${path} served deno.json`);
    assert(!r.text.includes("class AppState"), `${path} served source`);
    assert(!r.text.includes("root:"), `${path} served /etc/passwd`);
  }
});

Deno.test("an unexpected internal error returns a generic 500 with no case text", async () => {
  let boom = false;
  const { state, user } = await withCase({
    detectorFactory: () => {
      if (boom) throw new Error(`Could not load model for ${PEOPLE.mother} at ${IDS.address}`);
      return [new FakeNameDetector(NAMES)];
    },
  });
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logged.push(a.map(String).join(" "));
  try {
    boom = true;
    const r = await user.put("/api/settings", { nerEnabled: true });
    assertEquals(r.status, 500);
    assertEquals(typeof r.json.error, "string");
    assertNoSecrets(r.text, "500 body");
    assertSecurityHeaders(r, "500");
    assertNoSecrets(logged.join("\n"), "console output");
    assert(logged.length > 0, "the error type is logged");
    boom = false;
    assertEquals((await user.get("/api/settings")).status, 200);
  } finally {
    console.error = orig;
    state.lock();
  }
});

Deno.test("a detector failure while creating a case does not leave it unlocked without a cookie", async () => {
  const { state, user, other, caseDir } = await setup({
    detectorFactory: () => {
      throw new Error(`Could not load model for ${PEOPLE.mother}`);
    },
  });
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await user.post("/api/case/create", { dir: caseDir, passphrase: PASS, label: "x" });
    assertEquals(r.status, 500);
    assertNoSecrets(r.text, "500 body");
    // No cookie was issued, so the case must not stay unlocked: nobody could use or lock it, and
    // case/create from the user would then be refused with 409.
    assertEquals(user.cookie, undefined);
    const st = await other.get("/api/status");
    assertEquals(st.json.unlocked, false, "case left unlocked with no cookie holder");
    assertEquals(state.session, null);
  } finally {
    console.error = orig;
    state.lock();
  }
});

Deno.test("a malformed percent-escape in a route parameter is a client error", async () => {
  const { state, user } = await withCase();
  try {
    const r = await user.get("/api/docs/%E0%A4%A");
    assert(r.status >= 400 && r.status < 500, `got ${r.status}`);
  } finally {
    state.lock();
  }
});

// ── the main flow ───────────────────────────────────────────────────────────

Deno.test("flow: import, review, publish, read, search, chronology, drafts, settings, lock", async () => {
  const { state, user, other } = await withCase();
  const s = () => state.session!;

  // status
  assertEquals((await user.get("/api/status")).json.label, "Test matter");

  // import + review + publish
  const imp = await user.post("/api/docs/import", {
    title: AFFIDAVIT_TITLE,
    text: AFFIDAVIT,
    source: "affidavit.txt",
    origin: "mine",
  });
  assertEquals(imp.status, 200, imp.text);
  assertEquals(imp.json.id, "D001");
  assert(imp.json.detections > 0);
  const review = await user.get("/api/docs/D001/review");
  assertEquals(review.status, 200);
  assertEquals(review.json.original, AFFIDAVIT);
  assert(review.json.proposals.length > 0);
  assert(
    review.json.proposals.some((p: ProposedSpan) =>
      p.text === "Mr Okafor" && p.proposal.type === "ambiguous"
    ),
  );
  const req = publishRequestFrom(review.json);
  const pub = await user.post("/api/docs/D001/publish", req);
  assertEquals(pub.status, 200, pub.text);
  assertEquals(pub.json.withheld, false);
  assertNoSecrets(s().store.getDocument("D001").body!, "public.db body");
  assertEquals(s().store.getDocument("D001").title, "Affidavit of {{mother}}");

  // re-identified view equals the original
  const view = await user.get("/api/docs/D001");
  assertEquals(view.status, 200);
  assertEquals(view.json.title, AFFIDAVIT_TITLE);
  assertEquals(view.json.lines.map((l: { text: string }) => l.text), AFFIDAVIT.split("\n"));

  // Claude's view: tokenised text, cookie required
  assertEquals((await other.get("/api/docs/D001/claude-view")).status, 401);
  const cv = await user.get("/api/docs/D001/claude-view");
  assertEquals(cv.status, 200, cv.text);
  assertEquals(cv.json.title, "Affidavit of {{mother}}");
  assertEquals(
    cv.json.lines.map((l: { text: string }) => l.text),
    s().store.getDocument("D001").body!.split("\n"),
  );
  assertEquals(cv.json.lines[0].line, 1);
  assertNoSecrets(JSON.stringify(cv.json), "claude-view");

  // a publish that misses a replacement is blocked with the leaks listed
  const imp2 = await user.post("/api/docs/import", {
    title: "Copy",
    text: AFFIDAVIT,
    origin: "mine",
  });
  const id2 = imp2.json.id;
  const rev2 = (await user.get(`/api/docs/${id2}/review`)).json;
  const full2 = publishRequestFrom(rev2);
  const mobileAt = AFFIDAVIT.indexOf(IDS.mobile);
  const partial = {
    ...full2,
    replacements: full2.replacements.filter((r) => !(r.start <= mobileAt && mobileAt < r.end)),
  };
  assertEquals(partial.replacements.length, full2.replacements.length - 1);
  const leak = await user.post(`/api/docs/${id2}/publish`, partial);
  assertEquals(leak.status, 409, leak.text);
  assert(Array.isArray(leak.json.leaks) && leak.json.leaks.length > 0);
  assert(leak.json.leaks.some((l: { text: string }) => l.text.includes(IDS.mobile)));
  assertEquals(s().store.hasDocument(id2), false, "nothing was published");
  assertEquals((await user.post(`/api/docs/${id2}/publish`, { newEntities: "x" })).status, 400);
  assertEquals((await user.req("DELETE", `/api/docs/${id2}`)).status, 200);

  // search with a real name
  const hits = await user.get("/api/search/all?q=Daniel");
  assertEquals(hits.status, 200);
  assert(hits.json.lines.length >= 2, JSON.stringify(hits.json));
  for (const h of hits.json.lines) {
    assertEquals(h.doc_id, "D001");
    assert(h.text.text.includes("Daniel"), h.text.text);
  }
  // The old line-only search (an array) is gone (W3-4).
  assertEquals((await user.get("/api/search?q=Daniel")).status, 404);

  // Paste reports unknown tokens (the old POST /api/reidentify is gone, W3-4)
  const re = await user.post("/api/paste/view", { text: "{{father}} and {{stranger}}" });
  assertEquals(re.status, 200);
  assertEquals(re.json.rich.text.startsWith(`${PEOPLE.father} and `), true);
  assertEquals(re.json.unknown, ["{{stranger}}"]);
  assertEquals((await user.post("/api/reidentify", { text: "{{father}}" })).status, 404);

  // chronology: real names in, tokens stored, real names out
  const ch = await user.post("/api/chronology", {
    event_date: "2025-03-14",
    description: "Daniel Okafor collected the children late from Kiama Downs Public School",
    sources: ["D001:9"],
  });
  assertEquals(ch.status, 200, ch.text);
  const row = s().store.listChronology().find((r) => r.id === ch.json.id)!;
  assertNoSecrets(row.description, "stored chronology");
  assert(row.description.includes("{{father}}"), row.description);
  let chrono = (await user.get("/api/chronology")).json;
  assertEquals(
    chrono[0].description.text,
    "Daniel Okafor collected the children late from Kiama Downs Public School",
  );
  assertEquals(chrono[0].verified, false);
  assert(chrono[0].sources[0].quote[0].text.includes("Daniel collected"));

  // Verifying needs the version the user was shown (ADR 8).
  assertEquals((await user.post(`/api/chronology/${ch.json.id}/verify`)).status, 400);
  assertEquals(
    (await user.post(`/api/chronology/${ch.json.id}/verify`, {
      version: chrono[0].version,
      quoteAccurate: true,
      fairReading: true,
    }))
      .status,
    200,
  );
  chrono = (await user.get("/api/chronology")).json;
  assertEquals(chrono[0].verified, true);
  assertEquals((await user.post(`/api/chronology/${ch.json.id}/unverify`)).status, 200);
  chrono = (await user.get("/api/chronology")).json;
  assertEquals(chrono[0].verified, false);

  // user text with a new unknown name or identifier is refused, and nothing is stored
  const before = s().store.listChronology().length;
  for (const description of [`${NEW_NAME} phoned the school`, "Call 0498 765 432 about pickup"]) {
    const r = await user.post("/api/chronology", { event_date: "2025-03-15", description });
    assertEquals(r.status, 400, `${description}: ${r.text}`);
  }
  assertEquals((await user.post("/api/notes", { text: `${NEW_NAME} is a witness` })).status, 400);
  assertEquals(s().store.listChronology().length, before);

  // drafts: Claude paragraph blocks export until adopted
  const d = await user.post("/api/drafts", {
    kind: "affidavit",
    title: `Affidavit of ${PEOPLE.mother}`,
  });
  assertEquals(d.status, 200, d.text);
  const draftId: number = d.json.id;
  assertEquals(s().store.getDraft(draftId).title, "Affidavit of {{mother}}");
  assertEquals((await user.post("/api/drafts", { kind: "novel", title: "x" })).status, 400);
  const mine = await user.post(`/api/drafts/${draftId}/paragraphs`, {
    text: `I am the mother of ${PEOPLE.child1}.`,
  });
  assertEquals(mine.status, 200, mine.text);
  const para = s().store.addParagraph(draftId, CLAUDE_TEXT, "claude");

  const blocked = await user.get(`/api/drafts/${draftId}/export`);
  assertEquals(blocked.status, 409);
  assertEquals(blocked.json.needsReview, [para]);

  const draftView = (await user.get(`/api/drafts/${draftId}`)).json;
  assertEquals(draftView.title, `Affidavit of ${PEOPLE.mother}`);
  assertEquals(draftView.paragraphs.map((p: { state: string }) => p.state), [
    "user",
    "claude_needs_you",
  ]);

  for (
    const att of [{}, { ownKnowledge: true }, { ownWords: true }, {
      ownKnowledge: "yes",
      ownWords: true,
    }]
  ) {
    const r = await user.post(`/api/paragraphs/${para}/adopt`, att);
    assertEquals(r.status, 400, JSON.stringify(att));
  }
  assertEquals((await user.get(`/api/drafts/${draftId}/export`)).status, 409);
  const shownPara = draftView.paragraphs.find((p: { id: number }) => p.id === para);
  assertEquals(
    (await user.post(`/api/paragraphs/${para}/adopt`, {
      ownKnowledge: true,
      ownWords: true,
      version: shownPara.version,
    })).status,
    200,
  );

  const exp = await user.get(`/api/drafts/${draftId}/export`);
  assertEquals(exp.status, 200, exp.text);
  assertSecurityHeaders(exp, "export");
  assert(exp.text.includes(`# Affidavit of ${PEOPLE.mother}`));
  assert(exp.text.includes("1. I am the mother of Mia Okafor."));
  assert(exp.text.includes("2. On 14 March 2025 Daniel collected the children"));
  assert(exp.text.includes(PEOPLE.school));
  const cd = exp.headers.get("content-disposition")!;
  assert(/^attachment; filename="affidavit-\d+-\d{4}-\d{2}-\d{2}\.md"$/.test(cd), cd);
  assertNoSecrets(cd, "filename");
  const txt = await user.get(`/api/drafts/${draftId}/export?format=text`);
  assertEquals(txt.status, 200);
  assert(txt.headers.get("content-disposition")!.endsWith('.txt"'));

  // settings: API key masked, masked value keeps the key, log holds only the host
  const llmUrl = "http://user:pass@127.0.0.1:1234/v1";
  const put = await user.put("/api/settings", {
    llm: { baseUrl: llmUrl, model: "local-model", apiKey: "sk-test-key-123" },
  });
  assertEquals(put.status, 200, put.text);
  let settings = (await user.get("/api/settings")).json;
  assertEquals(settings.llm.apiKey, "••••••");
  assert(!JSON.stringify(settings).includes("sk-test-key-123"));
  const put2 = await user.put("/api/settings", {
    llm: { baseUrl: llmUrl, model: "other-model", apiKey: "••••••" },
  });
  assertEquals(put2.status, 200);
  assertEquals(s().settings.llm?.apiKey, "sk-test-key-123");
  assertEquals(s().settings.llm?.model, "other-model");
  // An empty key clears it.
  await user.put("/api/settings", { llm: { baseUrl: llmUrl, model: "other-model", apiKey: "" } });
  assertEquals(s().settings.llm?.apiKey, undefined);
  settings = (await user.get("/api/settings")).json;
  assertEquals(settings.llm.apiKey, "");
  assertEquals((await user.put("/api/settings", { llm: { baseUrl: llmUrl } })).status, 400);

  const changes = s().store.listLog(1000).filter((l) => l.action === "settings_changed");
  assert(changes.length >= 3);
  for (const c of changes) {
    assertEquals(JSON.parse(c.detail).llm_host, "127.0.0.1:1234");
  }
  const wholeLog = JSON.stringify(s().store.listLog(1000));
  assert(!wholeLog.includes("pass@"), "credentials in log");
  assert(!wholeLog.includes("user:pass"), "credentials in log");
  assert(!wholeLog.includes("sk-test-key"), "API key in log");
  assertNoSecrets(wholeLog, "AI-use log");
  const apiLog = await user.get("/api/log");
  assertEquals(apiLog.status, 200);
  assert(!apiLog.text.includes("user:pass"));
  assertEquals((await user.put("/api/settings", { llm: null })).status, 200);
  assertEquals(s().settings.llm, null);

  // The plan: commercial needs the three conditions and shares nothing by itself
  const sub = await importAndPublish(user, {
    title: MESSAGES_TITLE,
    text: MESSAGES,
    origin: "court_or_subpoena",
  });
  assertEquals(sub.publish.withheld, true);
  assertEquals(s().store.getDocument(sub.id).body, null);
  assertEquals(s().store.search("third time").length, 0);
  assertEquals((await user.post("/api/plan", { setup: "enterprise" })).status, 400);
  assertEquals(
    (await user.post("/api/settings/claude-setup", { setup: "commercial" })).status,
    404,
    "the old route without conditions is gone (W3-4)",
  );
  assertEquals((await user.post("/api/plan", { setup: "commercial" })).status, 400);
  const plan = await user.post("/api/plan", {
    setup: "commercial",
    conditions: { closedEnvironment: true, noTraining: true, thisCaseOnly: true },
  });
  assertEquals(plan.status, 200, plan.text);
  assertEquals(s().store.getDocument(sub.id).body, null, "switching shares nothing");
  const share = await user.post(`/api/docs/${sub.id}/share`);
  assertEquals(share.status, 200, share.text);
  const subRow = s().store.getDocument(sub.id);
  assertEquals(subRow.withheld, 0);
  assert(subRow.body?.includes("{{father.title}}, this is the third time"), subRow.body ?? "null");
  assertNoSecrets(subRow.body!, "republished body");
  assertEquals((await user.get("/api/settings")).json.claudeSetup, "commercial");

  // lock: everything is 423 again, including for the former cookie holder
  assertEquals((await user.post("/api/lock")).status, 200);
  assertEquals(state.session, null);
  for (const r of allRoutes(state).filter((r) => !r.open)) {
    const res = await user.req(r.method, r.path, r.method === "GET" ? undefined : {});
    assertEquals(res.status, 423, `${r.method} ${r.path} after lock`);
  }
  const st = (await user.get("/api/status")).json;
  assertEquals(st.unlocked, false);
  assertEquals(st.signedIn, false);
  assertEquals(st.label, null);
});

// ── security review: hardening ──────────────────────────────────────────────

Deno.test("doc meta: only changed fields are saved, so Claude's guesses are not re-tokenised", async () => {
  const t = await withCase();
  const { id } = await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const store = t.state.session!.store;
  // Claude guesses a name in author_role.
  store.setDocumentMeta(id, { author_role: "Anna", doc_type: "affidavit" }, "claude");

  // The form sends every field; the user only changed the type.
  const shown = (await t.user.get(`/api/docs/${id}`)).json.meta;
  assertEquals(shown.author_role, "Anna");
  let r = await t.user.put(`/api/docs/${id}/meta`, {
    doc_type: "statement",
    doc_date: "",
    author_role: shown.author_role,
  });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.updated, ["doc_type"]);
  assertEquals(store.getDocument(id).author_role, "Anna", "not turned into {{mother.first}}");

  // Editing the guessed field while keeping the name is refused, and public.db is untouched.
  const before = dumpPublic(store);
  r = await t.user.put(`/api/docs/${id}/meta`, { author_role: "Anna (mother)" });
  assertEquals(r.status, 400, r.text);
  assertEquals(dumpPublic(store), before);
  assertEquals((await t.user.get("/api/security-log")).json.length, 1);

  // An explicit `changed` list limits what is considered.
  r = await t.user.put(`/api/docs/${id}/meta`, {
    doc_type: "letter",
    author_role: "the mother",
    changed: ["doc_type"],
  });
  assertEquals(r.json.updated, ["doc_type"]);
  assertEquals(store.getDocument(id).author_role, "Anna");
});

Deno.test("settings, status and review say whether names are detected automatically", async () => {
  for (const [factory, expected] of [[() => [], false], [undefined, true]] as const) {
    const t = await withCase(factory ? { detectorFactory: factory } : {});
    assertEquals((await t.user.get("/api/settings")).json.nameDetection, expected);
    assertEquals((await t.user.get("/api/status")).json.nameDetection, expected);
    assertEquals((await t.other.get("/api/status")).json.nameDetection, null);
    const imp = await t.user.post("/api/docs/import", { title: "Notes", text: "Hello there." });
    const review = await t.user.get(`/api/docs/${imp.json.id}/review`);
    assertEquals(review.json.nameDetection, expected);
  }
});

Deno.test("API quotes come from the vault, and created_by shows 'user' only for recorded items", async () => {
  const t = await withCase();
  const { id } = await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
  const store = t.state.session!.store;
  const db = store.db;
  const ev = await t.user.post("/api/chronology", {
    event_date: "2025-03-14",
    description: "Late pickup",
    sources: [`${id}:8`],
  });
  // Claude's own entry, with a forged created_by.
  const forged = store.addChronology(
    {
      event_date: "2025-03-15",
      description: "x",
      sources: [{ doc_id: id, line_start: 8, line_end: 8 }],
    },
    "claude",
  );
  db.prepare("UPDATE chronology SET created_by = 'user' WHERE id = ?").run(forged);
  // Claude rewrites the cited line in public.db.
  db.prepare("UPDATE lines SET text = 'Invented quote.' WHERE doc_id = ? AND line_no = 8").run(id);

  const rows = (await t.user.get("/api/chronology")).json;
  const mine = rows.find((r: { id: number }) => r.id === ev.json.id);
  const theirs = rows.find((r: { id: number }) => r.id === forged);
  assertEquals(mine.created_by, "user");
  assertEquals(theirs.created_by, "claude");
  assert(mine.sources[0].quote[0].text.includes(PEOPLE.school), "real text quoted");
  assert(!JSON.stringify(rows).includes("Invented"));
  const search = (await t.user.get("/api/search/all?q=Invented")).json;
  assertEquals(search.totals.lines, 0);
  assertEquals(search.lines, []);
  const claudeView = (await t.user.get(`/api/docs/${id}/claude-view`)).json;
  assert(!JSON.stringify(claudeView).includes("Invented"));
});

/** What Claude can observe: public.db's rows (incl. ai_log) and the vault's file names and sizes. */
async function observable(t: { state: AppState; caseDir: string }) {
  // Vault writes queued by the last request may still be in flight; observe the settled state.
  await t.state.session!.settled();
  const sizes: string[] = [];
  for await (const e of Deno.readDir(join(t.caseDir, "vault"))) {
    sizes.push(`${e.name}:${(await Deno.stat(join(t.caseDir, "vault", e.name))).size}`);
  }
  return { db: dumpPublic(t.state.session!.store), vault: sizes.sort() };
}

Deno.test("a refused probe looks the same to Claude as an ordinary refusal or a no-op save", async () => {
  // Three identical cases; in each the user saves Claude's guessed author_role differently.
  const runs: Record<string, { before: unknown; after: unknown; status: number }> = {};
  for (const kind of ["probe", "refused", "noop"] as const) {
    const t = await withCase();
    const { id } = await importAndPublish(t.user, { title: AFFIDAVIT_TITLE, text: AFFIDAVIT });
    t.state.session!.store.setDocumentMeta(id, { author_role: "Anna" }, "claude");
    const before = await observable(t);
    const body = kind === "probe"
      ? { author_role: "Anna W" } // keeps the real name Claude guessed
      : kind === "refused"
      ? { author_role: "call 0412 999 888" } // refused for an ordinary reason (a phone number)
      : { author_role: "Anna" }; // unchanged
    const r = await t.user.put(`/api/docs/${id}/meta`, body);
    runs[kind] = { before, after: await observable(t), status: r.status };
  }
  assertEquals(runs.probe.status, 400);
  assertEquals(runs.refused.status, 400);
  assertEquals(runs.noop.status, 200);
  // What Claude can observe is how things CHANGE in response to the save: whether public.db
  // changed, which vault files appeared or disappeared, and by how many bytes each one grew.
  // (Comparing absolute sizes across three separate cases made the test depend on incidental
  // differences between the cases rather than on the save.)
  const delta = (k: string) => {
    // deno-lint-ignore no-explicit-any
    const { before, after } = runs[k] as any;
    const size = (list: string[]) =>
      Object.fromEntries(list.map((x) => {
        const i = x.lastIndexOf(":");
        return [x.slice(0, i), Number(x.slice(i + 1))];
      }));
    const b = size(before.vault), a = size(after.vault);
    const names = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    return {
      dbChanged: before.db !== after.db,
      vault: names.map((n) =>
        `${n}:${n in b ? "" : "+"}${n in a ? "" : "-"}${(a[n] ?? 0) - (b[n] ?? 0)}`
      ),
    };
  };
  assertEquals(delta("probe").dbChanged, false);
  assertEquals(delta("probe"), delta("refused"));
  assertEquals(delta("probe"), delta("noop"));
});
