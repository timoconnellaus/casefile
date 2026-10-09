import { ENTITY_KINDS, type EntityKind } from "../kinds.ts";
import { chunkTextOverlapping } from "./chunk.ts";
import type { Detector, Span } from "./types.ts";

/**
 * LLM pass over an OpenAI-compatible chat-completions endpoint chosen by the user (ADR 12).
 *
 * The endpoint receives UN-REDACTED document text. It is used only if it is on this machine and
 * does not forward requests elsewhere, or if the user has explicitly allowed a remote endpoint.
 */

/** Structurally identical to `LlmSettings` in session.ts. */
export interface LlmEndpointSettings {
  /** e.g. `http://127.0.0.1:11434/v1` */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** User has explicitly accepted sending un-redacted text to a non-local endpoint. */
  allowRemote?: boolean;
  /**
   * User has confirmed that a local server casefile cannot inspect (not Ollama) runs the model on
   * this computer. Without this, unconfirmed local endpoints are refused (fail closed).
   */
  trustLocalServer?: boolean;
  /**
   * The `reasoning_effort` sent with every request (default `"none"`: no thinking, which thinking
   * models in LM Studio need to answer within the time limit). `"default"` sends none, leaving it
   * to the server. A server that rejects the field is asked again without it.
   */
  reasoningEffort?: ReasoningEffort;
}

/** Values of the `reasoningEffort` setting; `"default"` means the field is not sent. */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "default"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EndpointClass {
  /** True if requests stay on this machine as far as casefile can tell. */
  local: boolean;
  /** False when the address is local but casefile cannot tell whether the server forwards. */
  confirmed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------------------------
// Endpoint locality

/** True for localhost, *.localhost, 127.0.0.0/8 and ::1 (including IPv4-mapped loopback). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // ::ffff:127.x.y.z, which URL normalises to ::ffff:7fxx:xxxx
  if (/^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(h)) return true;
  return false;
}

interface OllamaModel {
  name?: string;
  model?: string;
  remote_host?: string;
  remote_model?: string;
}

const CLOUD_SUFFIX = /[:-]cloud$/i;

function ollamaNames(m: string): string[] {
  return m.includes(":") ? [m] : [m, `${m}:latest`];
}

/**
 * Decide whether an endpoint keeps text on this machine. A loopback address is not enough: Ollama
 * serves `:cloud` models from localhost and forwards the request to ollama.com. For loopback
 * addresses we therefore ask Ollama (`GET /api/tags`) about the configured model. Other local
 * servers (LM Studio, llama.cpp, vLLM…) cannot be asked, so they are local but unconfirmed.
 */
export async function classifyEndpoint(
  settings: Pick<LlmEndpointSettings, "baseUrl" | "model">,
  fetchFn: FetchFn = fetch,
  probeTimeoutMs = 5000,
): Promise<EndpointClass> {
  let url: URL;
  try {
    url = new URL(settings.baseUrl);
  } catch {
    return { local: false, confirmed: true, reason: `"${settings.baseUrl}" is not a valid URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { local: false, confirmed: true, reason: `unsupported protocol ${url.protocol}` };
  }
  if (!isLoopbackHost(url.hostname)) {
    return {
      local: false,
      confirmed: true,
      reason: `${url.hostname} is not this machine; document text would be sent over the network`,
    };
  }
  const proxy = proxyFor(url);
  if (proxy) {
    return {
      local: true,
      confirmed: false,
      reason:
        `a proxy (${proxy}) is configured in the environment and may carry requests off this machine`,
    };
  }
  const models = await probeOllama(url.origin, fetchFn, probeTimeoutMs);
  const wanted = new Set(ollamaNames(settings.model));
  const m = models?.find((m) => (m.name && wanted.has(m.name)) || (m.model && wanted.has(m.model)));
  if (
    CLOUD_SUFFIX.test(settings.model) || m?.remote_host || CLOUD_SUFFIX.test(m?.name ?? "") ||
    CLOUD_SUFFIX.test(m?.model ?? "")
  ) {
    const host = m?.remote_host ? hostOf(m.remote_host) : "ollama.com";
    return {
      local: false,
      confirmed: true,
      reason:
        `model "${settings.model}" is an Ollama cloud model; requests are forwarded to ${host}`,
    };
  }
  if (!models) {
    return {
      local: true,
      confirmed: false,
      reason: `${url.host} is on this machine, but it is not Ollama, so casefile cannot confirm ` +
        `that the server does not forward requests to another computer`,
    };
  }
  if (!m) {
    return {
      local: true,
      confirmed: false,
      reason: `Ollama at ${url.host} does not list model "${settings.model}", so casefile cannot ` +
        `confirm it runs on this machine`,
    };
  }
  return {
    local: true,
    confirmed: true,
    reason: `Ollama at ${url.host} runs "${settings.model}" on this machine`,
  };
}

/** The proxy environment variable that would apply to this URL, if any (Deno's fetch honours them). */
export function proxyFor(
  url: URL,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): string | undefined {
  const get = (k: string) => env(k) ?? env(k.toLowerCase());
  const proxy = url.protocol === "https:"
    ? get("HTTPS_PROXY") ?? get("ALL_PROXY")
    : get("HTTP_PROXY") ?? get("ALL_PROXY");
  if (!proxy) return undefined;
  const noProxy = (get("NO_PROXY") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(
    Boolean,
  );
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const bypass = noProxy.some((n) =>
    n === "*" || host === n.replace(/^\./, "") || host.endsWith(n.startsWith(".") ? n : `.${n}`)
  );
  return bypass
    ? undefined
    : (get("HTTPS_PROXY") ? "HTTPS_PROXY" : get("HTTP_PROXY") ? "HTTP_PROXY" : "ALL_PROXY");
}

function hostOf(s: string): string {
  try {
    return new URL(s).host || s;
  } catch {
    return s;
  }
}

async function probeOllama(
  origin: string,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<OllamaModel[] | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${origin}/api/tags`, { signal: ac.signal, redirect: "error" });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = await res.json().catch(() => null) as { models?: unknown } | null;
    if (!body || !Array.isArray(body.models)) return null;
    return body.models.filter((m): m is OllamaModel => typeof m === "object" && m !== null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Prompt and parsing

export const SYSTEM_PROMPT = `You find identifying information in Australian family-law documents
so it can be replaced with placeholders. Reply with JSON only, in exactly this shape:
{"entities":[{"text":"...","kind":"...","role":"..."}]}

"text": copied EXACTLY from the document (same spelling, capitals and spacing), one entry per
distinct value. Include every way a person is referred to: full name, first name, surname,
nickname, "Mr Surname", and kinship terms that include a name ("Aunty Jo", "Nanna Pat").
"kind": one of person, place, organisation, school, address, phone, email, identifier,
date_of_birth, other.
"role": a short snake_case description of the entity's relationship to the case, e.g. mother,
father, child_1, child_2, maternal_grandmother, fathers_partner, school, childcare,
mothers_employer, fathers_business, family_doctor, home_suburb. The role must describe the
relationship only and must NEVER contain any part of the person's or organisation's name.

Flag direct identifiers (names, addresses, phone numbers, emails, identification numbers) and
indirect ones that could identify the family: schools, childcare centres, employers,
businesses, sports clubs, churches, doctors and clinics, small towns and suburbs, nicknames.
Do NOT flag ordinary dates, times, amounts, courts, judges' titles, legislation, or generic
words like "the mother" or "the school". Only flag a date if it is someone's date of birth.
If there is nothing to flag, reply {"entities":[]}.`;

interface RawEntity {
  text?: unknown;
  kind?: unknown;
  role?: unknown;
}

/** Pull the first JSON object out of a model reply (tolerates <think> blocks and ``` fences). */
export function extractJson(reply: string): unknown {
  let s = reply.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Some servers drop the opening tag: keep only what follows the last closing one.
  const close = s.toLowerCase().lastIndexOf("</think>");
  if (close !== -1) s = s.slice(close + "</think>".length);
  s = s.replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start === -1) throw new Error("LLM reply contained no JSON object");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        throw new Error("LLM reply contained malformed JSON");
      }
    }
  }
  throw new Error("LLM reply contained an incomplete JSON object");
}

function toKind(k: unknown): EntityKind {
  const s = typeof k === "string" ? k.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (s === "organization") return "organisation";
  return (ENTITY_KINDS as readonly string[]).includes(s) ? s as EntityKind : "other";
}

/** Words that may appear in both an entity and its role without leaking anything. */
const GENERIC_ALWAYS = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "mx",
  "dr",
  "the",
  "and",
  "of",
  "mum",
  "mother",
  "dad",
  "father",
  "nan",
  "nana",
  "nanna",
  "grandma",
  "grandmother",
  "pop",
  "poppy",
  "grandpa",
  "grandfather",
  "aunt",
  "aunty",
  "auntie",
  "uncle",
  "cousin",
  "brother",
  "sister",
  "step",
]);
const GENERIC_PLACES = new Set([
  "school",
  "public",
  "primary",
  "high",
  "college",
  "childcare",
  "child",
  "care",
  "centre",
  "center",
  "early",
  "learning",
  "kindergarten",
  "preschool",
  "academy",
  "club",
  "church",
  "hospital",
  "clinic",
  "medical",
  "practice",
  "pty",
  "ltd",
  "limited",
  "group",
  "services",
  "street",
  "road",
  "nsw",
  "vic",
  "qld",
  "wa",
  "sa",
  "tas",
  "act",
  "nt",
]);

function nameWords(text: string, kind: EntityKind): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) =>
    w.length >= 2 && !GENERIC_ALWAYS.has(w) && (kind === "person" || !GENERIC_PLACES.has(w))
  );
}

/**
 * Clean a suggested role to `[a-z][a-z0-9_]*`. Roles are public (Claude sees them), so a role that
 * contains any word of a flagged value (e.g. `mia_okafor`, `okafor_joinery`) is rejected.
 */
export function sanitiseRole(
  role: unknown,
  entities: { text: string; kind: EntityKind }[],
): string | undefined {
  if (typeof role !== "string") return undefined;
  const r = role.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 40)
    .replace(/_+$/, "");
  if (!r) return undefined;
  const parts = r.split("_");
  for (const e of entities) {
    for (const w of nameWords(e.text, e.kind)) {
      const ascii = w.normalize("NFKD").replace(/\p{M}/gu, "");
      if (parts.includes(ascii) || (ascii.length >= 3 && r.includes(ascii))) return undefined;
    }
  }
  return r;
}

const WORD = /[\p{L}\p{N}]/u;

function boundaryOk(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  const first = text[start];
  const last = text[end - 1];
  return !(WORD.test(first) && before && WORD.test(before)) &&
    !(WORD.test(last) && after && WORD.test(after));
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every occurrence of `needle` in `hay`: exact, else case-insensitive, else whitespace-flexible. */
export function locate(hay: string, needle: string): { start: number; end: number }[] {
  const n = needle.trim();
  if (!n) return [];
  const tries: RegExp[] = [
    new RegExp(escapeRe(n), "g"),
    new RegExp(escapeRe(n), "gi"),
    new RegExp(n.split(/\s+/).map(escapeRe).join("\\s+"), "gi"),
  ];
  for (const re of tries) {
    const hits: { start: number; end: number }[] = [];
    for (const m of hay.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (boundaryOk(hay, start, end)) hits.push({ start, end });
    }
    if (hits.length) return hits;
  }
  return [];
}

/** Convert a parsed reply into spans over `chunk`. */
export function spansFromReply(chunk: string, parsed: unknown): Span[] {
  const list = (parsed as { entities?: unknown })?.entities;
  if (!Array.isArray(list)) throw new Error('LLM reply had no "entities" array');
  const items = (list as RawEntity[])
    .filter((e) => e && typeof e.text === "string" && e.text.trim())
    .map((e) => ({ text: (e.text as string).trim(), kind: toKind(e.kind), role: e.role }));
  const spans: Span[] = [];
  for (const it of items) {
    // Check against this entity and every other one in the reply: a role like "mia_friend" leaks.
    const roleHint = sanitiseRole(it.role, items);
    for (const { start, end } of locate(chunk, it.text)) {
      spans.push({
        start,
        end,
        text: chunk.slice(start, end),
        kind: it.kind,
        source: "llm",
        confidence: 0.8,
        label: "llm",
        roleHint,
      });
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Detector

export interface LlmOptions {
  fetch?: FetchFn;
  /** Per-request timeout. Default 120 s. */
  timeoutMs?: number;
  /** Characters per request. Default 3000. */
  chunkChars?: number;
  /**
   * Characters each chunk repeats from the end of the one before (about; it starts at a word).
   * Default 200, so a name cut by a chunk boundary is whole in the next chunk.
   */
  overlapChars?: number;
}

/**
 * One OpenAI-compatible chat-completions endpoint (ADR 12), shared by the LLM name pass and the
 * extra checks' language model (ADR 14). Asks for JSON (`response_format`) and, by default, no
 * thinking (`"reasoning_effort": "none"`, the `reasoningEffort` setting): a thinking model such as
 * Qwen 3.6 in LM Studio does not finish a chunk within 120 s with thinking on, and takes about
 * 20 s without. A server that rejects either field (400) is asked again without it, and the
 * working combination is remembered.
 */
export class ChatCompletions {
  private jsonMode = true;
  /** Whether `reasoning_effort` is sent: off for the "default" setting or once rejected. */
  private sendEffort: boolean;
  private fetchFn: FetchFn;

  constructor(
    readonly settings: LlmEndpointSettings,
    private opts: { fetch?: FetchFn; timeoutMs?: number } = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sendEffort = this.effort !== "default";
  }

  private get effort(): ReasoningEffort {
    return isReasoningEffort(this.settings.reasoningEffort)
      ? this.settings.reasoningEffort
      : "none";
  }

  async complete(messages: { role: "system" | "user"; content: string }[]): Promise<string> {
    let res = await this.post(messages, this.jsonMode, this.sendEffort);
    if (res.status === 400) {
      // Some servers reject response_format, others reasoning_effort: drop one, then the other,
      // then both, and remember the first that is accepted.
      const tries: [boolean, boolean][] = [];
      if (this.jsonMode) tries.push([false, this.sendEffort]);
      if (this.sendEffort) tries.push([this.jsonMode, false]);
      if (this.jsonMode && this.sendEffort) tries.push([false, false]);
      for (const [json, sendEffort] of tries) {
        await res.body?.cancel();
        res = await this.post(messages, json, sendEffort);
        if (res.status !== 400) {
          this.jsonMode = json;
          this.sendEffort = sendEffort;
          break;
        }
      }
    }
    if (!res.ok) {
      // Don't echo the server's reply: it may quote the document text back.
      await res.body?.cancel();
      throw new Error(`LLM endpoint answered ${res.status} ${res.statusText}`.trim());
    }
    const body = await res.json().catch(() => null) as
      | { choices?: { message?: { content?: unknown } }[] }
      | null;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("LLM endpoint reply had no message content");
    return content;
  }

  private async post(
    messages: { role: string; content: string }[],
    jsonMode: boolean,
    sendEffort: boolean,
  ): Promise<Response> {
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.settings.apiKey) headers.Authorization = `Bearer ${this.settings.apiKey}`;
    const body: Record<string, unknown> = {
      model: this.settings.model,
      temperature: 0,
      stream: false,
      messages,
    };
    if (jsonMode) body.response_format = { type: "json_object" };
    if (sendEffort) body.reasoning_effort = this.effort;
    const url = `${this.settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
        // Never follow redirects: a 307/308 would re-send the document text to wherever it points.
        redirect: "error",
      });
      // Read the body inside the timeout window, so a server that stalls mid-reply also times out.
      const buf = await res.arrayBuffer();
      return new Response(buf.byteLength ? buf : null, {
        status: res.status,
        statusText: res.statusText,
      });
    } catch (e) {
      if (ac.signal.aborted) {
        throw new Error(`LLM endpoint did not answer within ${Math.round(timeoutMs / 1000)} s`);
      }
      throw new Error(`LLM endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class LlmDetector implements Detector {
  readonly name = "llm";
  readonly findsNames = true;
  private fetchFn: FetchFn;
  private chat: ChatCompletions;

  constructor(readonly settings: LlmEndpointSettings, private opts: LlmOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.chat = new ChatCompletions(settings, { fetch: this.fetchFn, timeoutMs: opts.timeoutMs });
  }

  /**
   * Where the endpoint sends text. Checked before every document, not cached: the user can change
   * which model a local server runs (e.g. switch Ollama to a `:cloud` model) at any time.
   */
  endpoint(): Promise<EndpointClass> {
    return classifyEndpoint(this.settings, this.fetchFn);
  }

  /** Refuse unless the text will stay on this machine, or the user explicitly allowed otherwise. */
  static permitted(
    where: EndpointClass,
    settings: LlmEndpointSettings,
  ): { ok: boolean; why?: string } {
    if (where.local && where.confirmed) return { ok: true };
    if (where.local && !where.confirmed) {
      return settings.trustLocalServer || settings.allowRemote ? { ok: true } : {
        ok: false,
        why:
          `${where.reason}. Turn on "this local server runs the model on this computer" in the case ` +
          `settings only if you are sure.`,
      };
    }
    return settings.allowRemote ? { ok: true } : {
      ok: false,
      why:
        `${where.reason}. Un-redacted document text is only sent to a remote endpoint if you turn on ` +
        `"allow remote endpoint" in the case settings.`,
    };
  }

  async detect(text: string): Promise<Span[]> {
    const where = await this.endpoint();
    const p = LlmDetector.permitted(where, this.settings);
    if (!p.ok) throw new Error(`LLM pass refused: ${p.why}`);
    const out: Span[] = [];
    // Chunks overlap, so a value in the overlap can be found twice: keep the first finding at
    // each absolute position.
    const seen = new Set<string>();
    const size = this.opts.chunkChars ?? 3000;
    // At most a quarter of a chunk, so small test chunks still move on.
    const overlap = Math.min(this.opts.overlapChars ?? 200, Math.floor(size / 4));
    const chunks = chunkTextOverlapping(text, size, overlap);
    for (const chunk of chunks) {
      if (!chunk.text.trim()) continue;
      const reply = await this.chat.complete([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Document extract:\n\n${chunk.text}` },
      ]);
      for (const s of spansFromReply(chunk.text, extractJson(reply))) {
        const start = s.start + chunk.offset;
        const end = s.end + chunk.offset;
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...s, start, end });
      }
    }
    return out;
  }
}
