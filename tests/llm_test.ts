import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { chunkText, chunkTextOverlapping } from "../src/core/detect/chunk.ts";
import { createDetectors } from "../src/core/detect/factory.ts";
import {
  classifyEndpoint,
  extractJson,
  type FetchFn,
  isLoopbackHost,
  LlmDetector,
  proxyFor,
  sanitiseRole,
  spansFromReply,
} from "../src/core/detect/llm.ts";
import { NerDetector } from "../src/core/detect/ner.ts";
import { detect } from "../src/core/detect/pipeline.ts";
import { EntityRegistry } from "../src/core/entities.ts";
import type { CaseSettings } from "../src/core/session.ts";
import { AFFIDAVIT, PEOPLE } from "./fixtures/synthetic.ts";

// ---------------------------------------------------------------------------------------------
// Fake servers

interface Seen {
  path: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

type Reply = (body: Record<string, unknown>, userText: string) => Response | Promise<Response>;

interface FakeServer {
  baseUrl: string;
  origin: string;
  seen: Seen[];
  close(): Promise<void>;
}

function completion(content: string): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content } }] });
}

function entities(list: { text: string; kind: string; role?: string }[]): string {
  return JSON.stringify({ entities: list });
}

/**
 * An OpenAI-compatible server on 127.0.0.1. `tags` makes it look like Ollama (`/api/tags`);
 * without it, `/api/tags` is a 404 as on LM Studio.
 */
function fakeServer(reply: Reply, tags?: unknown[]): FakeServer {
  const seen: Seen[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json() : null;
    seen.push({ path, headers: req.headers, body });
    if (path === "/api/tags") {
      return tags ? Response.json({ models: tags }) : new Response("not found", { status: 404 });
    }
    if (path === "/v1/chat/completions" && body) {
      const msgs = body.messages as { role: string; content: string }[];
      return await reply(body, msgs.find((m) => m.role === "user")?.content ?? "");
    }
    return new Response("not found", { status: 404 });
  });
  const origin = `http://127.0.0.1:${server.addr.port}`;
  return { baseUrl: `${origin}/v1`, origin, seen, close: () => server.shutdown() };
}

const chat = (s: FakeServer) => s.seen.filter((x) => x.path === "/v1/chat/completions");

const AFFIDAVIT_ENTITIES = [
  { text: PEOPLE.mother, kind: "person", role: "mother" },
  { text: PEOPLE.father, kind: "person", role: "father" },
  { text: PEOPLE.child1, kind: "person", role: "child_1" },
  { text: PEOPLE.child2, kind: "person", role: "Child 2" },
  { text: PEOPLE.school, kind: "school", role: "school" },
  { text: PEOPLE.childcare, kind: "school", role: "childcare" },
  { text: "Okafor Joinery", kind: "organisation", role: "okafor_business" },
  { text: "3 March 2017", kind: "date_of_birth", role: "child_1_dob" },
];

// ---------------------------------------------------------------------------------------------
// Endpoint locality

Deno.test("isLoopbackHost", () => {
  for (
    const h of ["localhost", "LOCALHOST", "ollama.localhost", "127.0.0.1", "127.8.9.10", "[::1]"]
  ) {
    assert(isLoopbackHost(h), h);
  }
  assert(isLoopbackHost(new URL("http://[::ffff:127.0.0.1]:1/").hostname));
  for (
    const h of ["0.0.0.0", "192.168.1.5", "10.0.0.1", "localhost.example.com", "api.openai.com"]
  ) {
    assert(!isLoopbackHost(h), h);
  }
});

Deno.test("a remote hostname is classified remote without any network access", async () => {
  const calls: string[] = [];
  const f: FetchFn = (u) => {
    calls.push(String(u));
    return Promise.reject(new Error("no network in tests"));
  };
  const c = await classifyEndpoint({ baseUrl: "https://api.example.com/v1", model: "m" }, f);
  assertEquals([c.local, c.confirmed], [false, true]);
  assertMatch(c.reason, /api\.example\.com/);
  assertEquals(calls, []);
  const bad = await classifyEndpoint({ baseUrl: "not a url", model: "m" }, f);
  assertEquals(bad.local, false);
});

Deno.test("a remote endpoint is refused without allowRemote and used with it", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: FetchFn = (u, init) => {
    calls.push({ url: String(u), init });
    return Promise.resolve(
      completion(entities([{ text: "Anna", kind: "person", role: "mother" }])),
    );
  };
  const settings = { baseUrl: "https://api.example.com/v1/", model: "m", apiKey: "sk-test" };
  const refused = new LlmDetector(settings, { fetch: f });
  await assertRejects(() => refused.detect("Anna said."), Error, "api.example.com");
  assertEquals(calls, []);
  // Through the pipeline, the refusal is reported as a detector error.
  const r = await detect("Anna said.", { registry: new EntityRegistry(), detectors: [refused] });
  assertEquals(r.errors.map((e) => e.detector), ["llm"]);
  assertMatch(r.errors[0].message, /refused.*allow remote/s);

  const allowed = new LlmDetector({ ...settings, allowRemote: true }, { fetch: f });
  const spans = await allowed.detect("Anna said.");
  assertEquals(spans.map((s) => s.text), ["Anna"]);
  assertEquals(calls.map((c) => c.url), ["https://api.example.com/v1/chat/completions"]);
});

Deno.test("Ollama model with remote_host is refused", async () => {
  const srv = fakeServer(() => completion(entities([])), [
    { name: "llama3.2:latest", model: "llama3.2:latest" },
    {
      name: "deepseek-v4.1-flash",
      model: "deepseek-v4.1-flash",
      remote_model: "deepseek-v4.1-flash",
      remote_host: "https://ollama.com:443",
    },
  ]);
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "deepseek-v4.1-flash" });
    const c = await det.endpoint();
    assertEquals([c.local, c.confirmed], [false, true]);
    assertMatch(c.reason, /ollama\.com/);
    await assertRejects(() => det.detect("Anna"), Error, "ollama.com");
    assertEquals(chat(srv), []);
    // Not cached: the model could be switched to a cloud one at any time, so every check probes.
    assertEquals(srv.seen.filter((s) => s.path === "/api/tags").length, 2);
  } finally {
    await srv.close();
  }
});

Deno.test("Ollama :cloud and -cloud models are refused", async () => {
  const srv = fakeServer(() => completion(entities([])), [
    { name: "deepseek-v4.1-flash:cloud", model: "deepseek-v4.1-flash:cloud" },
    { name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud" },
  ]);
  try {
    for (const model of ["deepseek-v4.1-flash:cloud", "gpt-oss:120b-cloud", "anything:cloud"]) {
      const det = new LlmDetector({ baseUrl: srv.baseUrl, model });
      const c = await det.endpoint();
      assertEquals(c.local, false, model);
      assertMatch(c.reason, /ollama\.com/);
      await assertRejects(() => det.detect("Anna"));
    }
    assertEquals(chat(srv), []);
    // allowRemote is the user's explicit opt-in, and then the cloud model is used.
    const ok = new LlmDetector({
      baseUrl: srv.baseUrl,
      model: "gpt-oss:120b-cloud",
      allowRemote: true,
    });
    await ok.detect("Anna");
    assertEquals(chat(srv).length, 1);
  } finally {
    await srv.close();
  }
});

Deno.test("a local Ollama model is allowed and confirmed", async () => {
  const srv = fakeServer(
    () => completion(entities([{ text: "Anna", kind: "person", role: "mother" }])),
    [{ name: "qwen3:8b", model: "qwen3:8b" }, {
      name: "llama3.2:latest",
      model: "llama3.2:latest",
    }],
  );
  try {
    for (const model of ["qwen3:8b", "llama3.2"]) {
      const det = new LlmDetector({ baseUrl: srv.baseUrl, model });
      const c = await det.endpoint();
      assertEquals([c.local, c.confirmed], [true, true], model);
      assertEquals((await det.detect("Anna said.")).map((s) => s.roleHint), ["mother"]);
    }
    // A model Ollama does not list cannot be confirmed (but is still a local address).
    const c = await classifyEndpoint({ baseUrl: srv.baseUrl, model: "missing" });
    assertEquals([c.local, c.confirmed], [true, false]);
  } finally {
    await srv.close();
  }
});

Deno.test("a local server that is not Ollama is refused until the user vouches for it (fail closed)", async () => {
  const srv = fakeServer(() => completion(entities([])));
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "lmstudio-model" });
    const c = await det.endpoint();
    assertEquals([c.local, c.confirmed], [true, false]);
    assertMatch(c.reason, /cannot confirm/);
    await assertRejects(() => det.detect("nothing here"), Error, "only if you are sure");
    assertEquals(chat(srv).length, 0);
    const trusted = new LlmDetector({
      baseUrl: srv.baseUrl,
      model: "lmstudio-model",
      trustLocalServer: true,
    });
    assertEquals(await trusted.detect("nothing here"), []);
    assertEquals(chat(srv).length, 1);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Requests and replies

Deno.test("redirects are never followed, so text cannot be bounced elsewhere", async () => {
  let posted = 0;
  const target = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => {
    posted++;
    return new Response("{}");
  });
  const srv = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/api/tags") return new Response("not ollama", { status: 404 });
    return new Response(null, {
      status: 307,
      headers: { location: `http://127.0.0.1:${target.addr.port}/v1/chat/completions` },
    });
  });
  try {
    const det = new LlmDetector({
      baseUrl: `http://127.0.0.1:${srv.addr.port}/v1`,
      model: "m",
      trustLocalServer: true,
    });
    await assertRejects(() => det.detect("Anna Thornbury"));
    assertEquals(posted, 0);
  } finally {
    await srv.shutdown();
    await target.shutdown();
  }
});

Deno.test("a proxy in the environment makes a local endpoint unconfirmed", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  const u = new URL("http://127.0.0.1:11434/v1");
  assertEquals(proxyFor(u, env({ HTTP_PROXY: "http://proxy:3128" })), "HTTP_PROXY");
  assertEquals(
    proxyFor(u, env({ HTTP_PROXY: "http://proxy:3128", NO_PROXY: "localhost,127.0.0.1" })),
    undefined,
  );
  assertEquals(proxyFor(u, env({ all_proxy: "socks5://x" })), "ALL_PROXY");
  assertEquals(proxyFor(u, env({})), undefined);
});

Deno.test("an error reply is not echoed back (it may quote the document)", async () => {
  const srv = fakeServer(() =>
    new Response("Anna Thornbury could not be processed", { status: 500 })
  );
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true });
    const err = await assertRejects(() => det.detect("Anna Thornbury"));
    assert(!(err as Error).message.includes("Anna"));
  } finally {
    await srv.close();
  }
});

Deno.test("request shape: model, messages, temperature, JSON mode and auth header", async () => {
  const srv = fakeServer(() => completion(entities([])));
  try {
    await new LlmDetector({
      baseUrl: srv.baseUrl + "/",
      model: "m1",
      trustLocalServer: true,
      apiKey: "sk-local",
    })
      .detect("Some text.");
    await new LlmDetector({ baseUrl: srv.baseUrl, model: "m2", trustLocalServer: true }).detect(
      "Other text.",
    );
    const [a, b] = chat(srv);
    assertEquals(a.headers.get("authorization"), "Bearer sk-local");
    assertEquals(b.headers.get("authorization"), null);
    assertEquals(a.headers.get("content-type"), "application/json");
    assertEquals(a.body!.model, "m1");
    assertEquals(b.body!.model, "m2");
    assertEquals(a.body!.temperature, 0);
    assertEquals(a.body!.response_format, { type: "json_object" });
    const msgs = a.body!.messages as { role: string; content: string }[];
    assertEquals(msgs.map((m) => m.role), ["system", "user"]);
    assertMatch(msgs[0].content, /date_of_birth/);
    assertMatch(msgs[0].content, /NEVER contain/);
    assert(msgs[1].content.endsWith("Some text."));
  } finally {
    await srv.close();
  }
});

Deno.test("replies wrapped in <think> blocks and ``` fences are parsed", async () => {
  const content = "<think>The mother is {probably} Anna.</think>\nHere you go:\n```json\n" +
    entities([{ text: "Anna", kind: "person", role: "mother" }]) + "\n```\nDone.";
  const srv = fakeServer(() => completion(content));
  try {
    const spans = await new LlmDetector({
      baseUrl: srv.baseUrl,
      model: "m",
      trustLocalServer: true,
    }).detect("Anna.");
    assertEquals(spans.map((s) => [s.text, s.kind, s.source, s.roleHint]), [
      ["Anna", "person", "llm", "mother"],
    ]);
  } finally {
    await srv.close();
  }
  assertEquals(extractJson('reasoning…</think>{"entities":[{"text":"a}b"}]}'), {
    entities: [{ text: "a}b" }],
  });
  for (const bad of ["no json", '{"entities": [', "{not: json}"]) {
    let threw = false;
    try {
      extractJson(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

Deno.test("a 400 is retried without response_format, and the server's choice is remembered", async () => {
  const srv = fakeServer((body) =>
    body.response_format
      ? new Response('{"error":"response_format not supported"}', { status: 400 })
      : completion(entities([{ text: "Anna", kind: "person", role: "mother" }]))
  );
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true }, {
      chunkChars: 20,
    });
    const text = "Anna went home.\nAnna came back.\n";
    const spans = await det.detect(text);
    assertEquals(spans.map((s) => text.slice(s.start, s.end)), ["Anna", "Anna"]);
    // First chunk: with, then without; second chunk: straight to without.
    assertEquals(chat(srv).map((s) => "response_format" in s.body!), [true, false, false]);
  } finally {
    await srv.close();
  }
});

Deno.test('thinking is turned off with "reasoning_effort": "none"', async () => {
  const srv = fakeServer(() => completion(entities([])));
  try {
    await new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true })
      .detect("Some text.");
    assertEquals(chat(srv)[0].body!.reasoning_effort, "none");
  } finally {
    await srv.close();
  }
});

Deno.test("a server that rejects reasoning_effort is asked again without it, and that is remembered", async () => {
  // Rejects reasoning_effort but takes JSON mode: JSON mode must survive the fallback.
  const srv = fakeServer((body) =>
    "reasoning_effort" in body
      ? new Response('{"error":"unknown field reasoning_effort"}', { status: 400 })
      : completion(entities([{ text: "Rebecca", kind: "person", role: "mother" }]))
  );
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true }, {
      chunkChars: 20,
    });
    const text = "Rebecca went home.\nRebecca came back.\n";
    const spans = await det.detect(text);
    assertEquals(spans.map((s) => text.slice(s.start, s.end)), ["Rebecca", "Rebecca"]);
    const sent = chat(srv).map((s) => [
      "reasoning_effort" in s.body!,
      "response_format" in s.body!,
    ]);
    // First chunk: both (400), without JSON mode (400), without reasoning_effort (ok); second
    // chunk: straight to the combination that worked.
    assertEquals(sent, [[true, true], [true, false], [false, true], [false, true]]);
  } finally {
    await srv.close();
  }
});

Deno.test("a server that rejects both fields gets neither, from then on", async () => {
  const srv = fakeServer((body) =>
    "reasoning_effort" in body || "response_format" in body
      ? new Response("{}", { status: 400 })
      : completion(entities([]))
  );
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true }, {
      chunkChars: 20,
    });
    await det.detect("Rebecca went home.\nRebecca came back.\n");
    const last = chat(srv).at(-1)!.body!;
    assert(!("reasoning_effort" in last) && !("response_format" in last));
    assertEquals(chat(srv).length, 5); // 4 tries for the first chunk, 1 for the second
  } finally {
    await srv.close();
  }
});

Deno.test("spans are located exactly, then case-insensitively, on whole words only", () => {
  const chunk = "Mia moved to Miami. MIA and mia\nboth.  Kiama   Downs school";
  const spans = spansFromReply(chunk, {
    entities: [
      { text: "Mia", kind: "person", role: "child_1" },
      { text: "kiama downs", kind: "place", role: "home_suburb" },
      { text: "not present", kind: "person" },
      { text: "", kind: "person" },
      { kind: "person" },
    ],
  });
  for (const s of spans) assertEquals(chunk.slice(s.start, s.end), s.text);
  // Exact match exists, so only the exact "Mia" is used; "Miami" is never matched.
  assertEquals(spans.filter((s) => s.roleHint === "child_1").map((s) => s.text), ["Mia"]);
  // Case-insensitive with flexible whitespace.
  assertEquals(spans.find((s) => s.kind === "place")?.text, "Kiama   Downs");
  const ci = spansFromReply("MIA and mia", { entities: [{ text: "Mia", kind: "person" }] });
  assertEquals(ci.map((s) => s.text), ["MIA", "mia"]);
});

Deno.test("unknown kinds become other; a missing entities array is an error", () => {
  const spans = spansFromReply("Gumnuts Club", {
    entities: [{ text: "Gumnuts Club", kind: "sports club" }, {
      text: "Club",
      kind: "Organization",
    }],
  });
  assertEquals(spans.map((s) => s.kind), ["other", "organisation"]);
  let threw = false;
  try {
    spansFromReply("x", { people: [] });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("role hints are sanitised and never contain a name", () => {
  const e = (text: string, kind: "person" | "school" | "organisation" = "person") => [{
    text,
    kind,
  }];
  assertEquals(sanitiseRole("Child 1", e("Mia Okafor")), "child_1");
  assertEquals(sanitiseRole("  Maternal-Grandmother ", e("Nanna Pat")), "maternal_grandmother");
  assertEquals(sanitiseRole("1st_child", e("Mia")), "st_child");
  assertEquals(sanitiseRole("mia_okafor", e("Mia Okafor")), undefined);
  assertEquals(sanitiseRole("child_mia", e("Mia Okafor")), undefined);
  assertEquals(sanitiseRole("okafors_child", e("Mia Okafor")), undefined);
  assertEquals(sanitiseRole("anna", e("ANNA")), undefined);
  assertEquals(sanitiseRole("okafor_joinery", e("Okafor Joinery", "organisation")), undefined);
  assertEquals(sanitiseRole("school", e("Kiama Downs Public School", "school")), "school");
  assertEquals(sanitiseRole("mother", e("Mrs Thornbury")), "mother");
  assertEquals(sanitiseRole("aunt", e("Aunty Jo")), "aunt");
  assertEquals(sanitiseRole("zoe_aunt", e("Aunty Zoë")), undefined);
  assertEquals(sanitiseRole("___", e("x")), undefined);
  assertEquals(sanitiseRole(42, e("x")), undefined);

  // Through a reply: also checked against the other entities in the same reply.
  const spans = spansFromReply("Mia and Sarah", {
    entities: [
      { text: "Mia", kind: "person", role: "Mia" },
      { text: "Sarah", kind: "person", role: "mia_friend" },
    ],
  });
  assertEquals(spans.map((s) => s.roleHint), [undefined, undefined]);
});

Deno.test("a server error surfaces through the pipeline as a detector error", async () => {
  const srv = fakeServer(() => new Response("model crashed", { status: 500 }));
  try {
    const r = await detect(AFFIDAVIT, {
      registry: new EntityRegistry(),
      detectors: [new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true })],
    });
    assertEquals(r.errors.length, 1);
    assertEquals(r.errors[0].detector, "llm");
    assertMatch(r.errors[0].message, /answered 500/);
    // Rules still ran.
    assert(r.spans.some((s) => s.label === "medicare"));
  } finally {
    await srv.close();
  }
});

Deno.test("a slow endpoint times out", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const srv = fakeServer(async () => {
    await gate;
    return completion(entities([]));
  });
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true }, {
      timeoutMs: 100,
    });
    await assertRejects(() => det.detect("Anna"), Error, "did not answer within");
  } finally {
    release();
    await srv.close();
  }
});

Deno.test("an unreachable endpoint is reported", async () => {
  const srv = fakeServer(() => completion(entities([])));
  const baseUrl = srv.baseUrl;
  await srv.close();
  await assertRejects(
    () => new LlmDetector({ baseUrl, model: "m", trustLocalServer: true }).detect("Anna"),
    Error,
    "unreachable",
  );
});

// ---------------------------------------------------------------------------------------------
// End to end

Deno.test("pipeline + LLM on the synthetic affidavit proposes new entities with roles", async () => {
  const srv = fakeServer((_body, user) =>
    completion(
      entities(AFFIDAVIT_ENTITIES.filter((e) => user.includes(e.text))),
    )
  );
  try {
    const r = await detect(AFFIDAVIT, {
      registry: new EntityRegistry(),
      detectors: [
        new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true }, {
          chunkChars: 400,
        }),
      ],
    });
    assertEquals(r.errors, []);
    assert(chat(srv).length > 1, "expected the affidavit to be sent in several chunks");
    for (const s of r.spans) assertEquals(AFFIDAVIT.slice(s.start, s.end), s.text);
    const roles = Object.fromEntries(r.newEntities.map((n) => [n.full, n.roleHint]));
    assertEquals(roles[PEOPLE.mother], "mother");
    assertEquals(roles[PEOPLE.father], "father");
    assertEquals(roles[PEOPLE.child1], "child_1");
    assertEquals(roles[PEOPLE.child2], "child_2");
    assertEquals(roles[PEOPLE.school], "school");
    assertEquals(roles[PEOPLE.childcare], "childcare");
    // The role "okafor_business" leaked a surname and was dropped.
    assert("Okafor Joinery" in roles);
    assertEquals(roles["Okafor Joinery"], undefined);
    const kinds = Object.fromEntries(r.newEntities.map((n) => [n.full, n.kind]));
    assertEquals(kinds[PEOPLE.school], "school");
    // First names are propagated by the pipeline.
    const texts = r.spans.map((s) => s.text);
    assert(texts.includes("Daniel") && texts.includes("Mia"));
    // Ordinary dates are kept.
    assert(!texts.includes("14 March 2025"));
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Factory

Deno.test("createDetectors builds NER then LLM from case settings", () => {
  const base: CaseSettings = {
    label: "t",
    claudeSetup: "consumer",
    llm: null,
    nerEnabled: false,
    nextDocNumber: 1,
  };
  const load = () => Promise.reject(new Error("not in unit tests"));
  assertEquals(createDetectors(base, { loadClassifier: load }), []);
  const both = createDetectors(
    { ...base, nerEnabled: true, llm: { baseUrl: "http://127.0.0.1:11434/v1", model: "m" } },
    { loadClassifier: load },
  );
  assertEquals(both.map((d) => d.name), ["ner", "llm"]);
  assert(both[0] instanceof NerDetector);
  assert(both[1] instanceof LlmDetector);
  assertEquals(
    createDetectors({ llm: { baseUrl: " ", model: "m" }, nerEnabled: false }).length,
    0,
  );
});

// ---------------------------------------------------------------------------------------------
// Chunk overlap

Deno.test("chunkTextOverlapping: chunks repeat about `overlap` characters, start at a word, and cover the text", () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
  const text = words.join(" ");
  const chunks = chunkTextOverlapping(text, 300, 40);
  assert(chunks.length > 1);
  assertEquals(chunks[0].offset, 0);
  for (const [i, c] of chunks.entries()) {
    assertEquals(text.slice(c.offset, c.offset + c.text.length), c.text);
    assert(c.text.length <= 300);
    if (i === 0) continue;
    const prev = chunks[i - 1];
    const prevEnd = prev.offset + prev.text.length;
    // Starts inside the previous chunk, no more than `overlap` back, at the start of a word.
    assert(c.offset < prevEnd && c.offset >= prevEnd - 40, `chunk ${i} overlaps`);
    assertMatch(text[c.offset - 1], /\s/);
    assert(c.offset + c.text.length > prevEnd, `chunk ${i} moves on`);
  }
  const last = chunks.at(-1)!;
  assertEquals(last.offset + last.text.length, text.length);
  // No overlap asked for: the plain chunks.
  assertEquals(chunkTextOverlapping(text, 300, 0), chunkText(text, 300));
  // One word longer than a chunk: no whitespace to start at, so no overlap, but still covered.
  const long = "x".repeat(700);
  assertEquals(chunkTextOverlapping(long, 300, 40).map((c) => c.text).join(""), long);
});

Deno.test("LLM pass: a name straddling a chunk boundary is found once, at its offset in the whole text", async () => {
  const name = PEOPLE.child1; // "Mia Okafor"
  // The first chunk (3000 characters) breaks at the space inside the name: "… Mia " | "Okafor …".
  const text = `${"word ".repeat(599)}${name} attended the appointment. ${
    "Nothing else happened. ".repeat(20)
  }`;
  const at = text.indexOf(name);
  assert(at < 3000 && at + name.length > 3000, "the name straddles the boundary");
  // Without overlap the name is cut in two, and neither chunk holds it whole.
  const plain = chunkText(text, 3000);
  assert(plain.length === 2 && !plain.some((c) => c.text.includes(name)));
  // A model that reports the name only when its chunk holds all of it.
  const srv = fakeServer((_body, user) =>
    completion(
      entities(user.includes(name) ? [{ text: name, kind: "person", role: "child_1" }] : []),
    )
  );
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true });
    const spans = await det.detect(text);
    assertEquals(spans.map((s) => [s.start, s.end, s.text]), [[at, at + name.length, name]]);
  } finally {
    await srv.close();
  }
});

Deno.test("LLM pass: a name inside the overlap, reported by both chunks, is kept once", async () => {
  const name = PEOPLE.mother;
  const filler = "Some ordinary words here. ".repeat(10); // 260 characters
  // Chunks of 200 with 50 overlapping: the name sits where two chunks meet.
  const text = `${filler.slice(0, 160)} ${name} ${filler}`;
  const srv = fakeServer((_body, user) =>
    completion(
      entities(user.includes(name) ? [{ text: name, kind: "person", role: "mother" }] : []),
    )
  );
  try {
    const det = new LlmDetector({ baseUrl: srv.baseUrl, model: "m", trustLocalServer: true }, {
      chunkChars: 200,
      overlapChars: 50,
    });
    const spans = await det.detect(text);
    const hits = chat(srv).filter((s) => JSON.stringify(s.body!.messages).includes(name)).length;
    assert(hits >= 2, "both chunks saw the name");
    const at = text.indexOf(name);
    assertEquals(spans.map((s) => [s.start, s.end]), [[at, at + name.length]]);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Real model (manual)

const REAL_URL = Deno.env.get("CASEFILE_TEST_LLM_URL");
const REAL_MODEL = Deno.env.get("CASEFILE_TEST_LLM_MODEL");

Deno.test({
  name: "real LLM finds the synthetic family (CASEFILE_TEST_LLM_URL + _MODEL)",
  ignore: !REAL_URL || !REAL_MODEL,
  async fn() {
    const det = new LlmDetector({
      baseUrl: REAL_URL!,
      model: REAL_MODEL!,
      apiKey: Deno.env.get("CASEFILE_TEST_LLM_KEY"),
    });
    console.log("endpoint:", await det.endpoint());
    const r = await detect(AFFIDAVIT, { registry: new EntityRegistry(), detectors: [det] });
    assertEquals(r.errors, []);
    console.log(r.newEntities.map((n) => `${n.kind}\t${n.roleHint ?? "-"}\t${n.full}`).join("\n"));
    const found = r.newEntities.map((n) => n.full);
    for (const n of [PEOPLE.mother, PEOPLE.father]) assert(found.includes(n), `missed ${n}`);
  },
});
