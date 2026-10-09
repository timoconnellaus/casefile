/**
 * Settings shows the language-model check in plain words (DESIGN-SPEC §6): one summary and a
 * detail that doesn't repeat it, with no developer words. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals } from "@std/assert";
import { classifyEndpoint, type FetchFn, LlmDetector } from "../src/core/detect/llm.ts";
import { llmCheckKind, llmWords } from "../src/app/llmwords.ts";
import { withCase } from "./helpers/app.ts";

const DEV_WORDS = /ollama|endpoint|proxy|localhost|127\.0|loopback|api\/|model id|sandbox|url\b/i;

/** A fake local server that lists `models` at /api/tags (or isn't that kind of server). */
const tags = (models: unknown[] | null): FetchFn => (u) =>
  models === null
    ? Promise.reject(new Error("connection refused"))
    : String(u).endsWith("/api/tags")
    ? Promise.resolve(new Response(JSON.stringify({ models })))
    : Promise.reject(new Error("unexpected"));

Deno.test("every check result reads as plain words, without repeating itself", async () => {
  const local = "http://127.0.0.1:11434/v1";
  const cases: [string, { baseUrl: string; model: string }, FetchFn, string][] = [
    ["remote", { baseUrl: "https://api.example.com/v1", model: "m" }, tags([]), "other_computer"],
    ["bad", { baseUrl: "not an address", model: "m" }, tags([]), "bad_address"],
    ["cloud", { baseUrl: local, model: "big:cloud" }, tags([]), "online_model"],
    ["unknown server", { baseUrl: local, model: "m" }, tags(null), "cannot_confirm"],
    [
      "not listed",
      { baseUrl: local, model: "m" },
      tags([{ name: "other:latest" }]),
      "model_not_found",
    ],
    ["here", { baseUrl: local, model: "m" }, tags([{ name: "m:latest" }]), "runs_here"],
  ];
  for (const [what, settings, f, kind] of cases) {
    const c = await classifyEndpoint(settings, f);
    const p = LlmDetector.permitted(c, settings);
    const w = llmWords({ ...c, permitted: p.ok, why: p.why });
    assertEquals(w.kind, kind, what);
    assertEquals(llmCheckKind(c), kind, what);
    assertEquals(w.used, kind === "runs_here", what);
    for (const t of [w.summary, w.detail]) {
      assert(!DEV_WORDS.test(t), `${what}: developer words in "${t}"`);
      assert(!t.includes(settings.baseUrl), `${what}: the address is not repeated`);
    }
    assert(!w.detail.includes(w.summary), `${what}: detail repeats the summary`);
    // Every sentence appears once.
    const sentences = `${w.summary} ${w.detail}`.split(/(?<=\.)\s+/).filter(Boolean);
    assertEquals(sentences.length, new Set(sentences).size, `${what}: a sentence twice`);
    // A riskier option turns "not used" into "used because you chose to".
    if (kind !== "runs_here" && kind !== "bad_address") {
      const risky = { ...settings, trustLocalServer: true, allowRemote: true };
      const q = LlmDetector.permitted(c, risky);
      const r = llmWords({ ...c, permitted: q.ok, why: q.why });
      assertEquals([r.kind, r.used], ["riskier_option", true], what);
      assert(!DEV_WORDS.test(`${r.summary} ${r.detail}`), what);
    }
  }
  assertEquals(llmWords(null).kind, "unavailable");
});

Deno.test("POST /api/settings/check-llm adds the plain words", async () => {
  const t = await withCase({
    llmChecker: () =>
      Promise.resolve({
        local: true,
        confirmed: false,
        reason: "x is on this machine, but it is not Ollama, so casefile cannot confirm",
      }),
  });
  try {
    // No model set: nothing to check (the server answers {ok: true}).
    assertEquals((await t.user.post("/api/settings/check-llm")).json.summary, undefined);
    await t.user.put("/api/settings", {
      llm: { baseUrl: "http://127.0.0.1:9/v1", model: "m" },
    });
    const r = await t.user.post("/api/settings/check-llm");
    assertEquals(r.status, 200, r.text);
    assertEquals(r.json.kind, "cannot_confirm");
    assertEquals(r.json.used, false);
    assert(r.json.summary && !DEV_WORDS.test(r.json.summary + r.json.detail));
    assertEquals(typeof r.json.reason, "string", "the technical reason is still there");
  } finally {
    t.state.lock();
  }
});
