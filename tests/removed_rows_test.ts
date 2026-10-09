/**
 * `removed_at` (schema v4) is in public.db, so Claude can write it. Until the app records the
 * user's removals in the vault, it must not hide anything from the user or open any CLI gate.
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { normaliseArgv, run, STRING_FLAGS } from "../src/cli/commands.ts";
import { PublicStore } from "../src/core/publicdb.ts";
import { publishedCase } from "./fixtures/case.ts";
import { MESSAGES, MESSAGES_TITLE } from "./fixtures/synthetic.ts";
import { importAndPublish, withCase } from "./helpers/app.ts";

async function cli(dir: string, argv: string[]) {
  const args = parseArgs(normaliseArgv(argv), {
    boolean: ["json", "help"],
    collect: ["source"],
    string: STRING_FLAGS,
  });
  return await run(args, { cwd: dir, env: {}, readStdin: () => Promise.resolve("") });
}

/** Claude's raw SQL, as from a shell. */
function rawSql(dir: string, sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(join(dir, "public.db"), { enableForeignKeyConstraints: false });
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

Deno.test("CLI issue rm is still refused when Claude marks the user's evidence as removed", async () => {
  const { s, dir, docId } = await publishedCase();
  const issue = s.store.addIssue({ title: "Changeover arrangements" }, "claude");
  const userEv = s.store.addEvidence(
    issue,
    { doc_id: docId, line_start: 2, line_end: 2, note: "My own note" },
    "user",
  );
  s.close();
  rawSql(dir, "UPDATE evidence SET removed_at = 't', removed_by = 'user' WHERE id = ?", userEv);
  const r = await cli(dir, ["issue", "rm", String(issue)]);
  assertEquals(r.code, 1, r.err);
  assertStringIncludes(r.err, `#${userEv}`);
  const store = PublicStore.open(join(dir, "public.db"));
  assertEquals(store.getEvidence(userEv).note, "My own note");
  store.close();
});

Deno.test("Claude marking verified and user items as removed does not hide them in the app", async () => {
  const { state, user } = await withCase();
  try {
    const doc = await importAndPublish(user, { title: MESSAGES_TITLE, text: MESSAGES });
    const ch = await user.post("/api/chronology", {
      event_date: "2025-03-14",
      description: "Late collection from school",
      sources: [`${doc.id}:1-2`],
    });
    assertEquals(ch.status, 200, ch.text);
    const iss = await user.post("/api/issues", { title: "Changeovers" });
    assertEquals(iss.status, 200, iss.text);
    const ev = await user.post(`/api/issues/${iss.json.id}/evidence`, {
      source: `${doc.id}:2`,
      note: "Late again",
    });
    assertEquals(ev.status, 200, ev.text);
    const chrono = (await user.get("/api/chronology")).json[0];
    assertEquals(
      (await user.post(`/api/chronology/${chrono.id}/verify`, {
        version: chrono.version,
        quoteAccurate: true,
        fairReading: true,
      }))
        .status,
      200,
    );

    // Claude, with SQL, marks them all removed.
    const db = state.session!.store.db;
    for (const t of ["chronology", "issues", "evidence"]) {
      db.prepare(`UPDATE ${t} SET removed_at = 't', removed_by = 'user'`).run();
    }

    const chronoAfter = (await user.get("/api/chronology")).json;
    assertEquals(chronoAfter.length, 1);
    assert(chronoAfter[0].verified, "still verified");
    assertEquals(chronoAfter[0].created_by, "user");
    const issues = (await user.get("/api/issues")).json;
    assertEquals(issues.length, 1);
    assertEquals(issues[0].created_by, "user");
    assertEquals(issues[0].evidence.length, 1);
    assertEquals(issues[0].evidence[0].created_by, "user");
  } finally {
    state.lock();
  }
});

Deno.test("removable item types are checked before they reach SQL", () => {
  const store = PublicStore.open(":memory:", { create: true });
  for (const bad of ["documents", "constructor", "toString"]) {
    // deno-lint-ignore no-explicit-any
    const t = bad as any;
    let threw = false;
    try {
      store.listRemoved(t);
    } catch (e) {
      threw = e instanceof Error && e.message.startsWith("Bad item type");
    }
    assert(threw, bad);
  }
  store.close();
});
