/**
 * Helpers for API tests: an app with a case, a client that keeps the session cookie, and
 * importing and publishing a document the way the UI does. Taken from app_test.ts (wave 0).
 * SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { AppState, type AppStateOptions } from "../../src/app/state.ts";
import { createHandler } from "../../src/app/server.ts";
import { buildRoutes } from "../../src/app/api.ts";
import { cookieName } from "../../src/app/security.ts";
import type { ProposedSpan } from "../../src/core/detect/pipeline.ts";
import {
  FAKE_NER_NAMES,
  FakeNameDetector,
  PEOPLE,
  SECRETS,
  tempDir,
} from "../fixtures/synthetic.ts";

export const PASS = "a long test passphrase";
export const ORIGIN = "http://127.0.0.1:8217";
export const HOST = "127.0.0.1:8217";
/** The session cookie this instance sets (its name carries the port). */
export const COOKIE = cookieName(ORIGIN);
/** Synthetic name the fake NER knows but no document contains. */
export const NEW_NAME = "Sarah Jones";
export const NAMES = [...FAKE_NER_NAMES, { text: NEW_NAME, kind: "person" as const }];

export type Handler = (req: Request) => Promise<Response>;

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  // deno-lint-ignore no-explicit-any
  json: any;
}

/** A caller of the API. Remembers the session cookie the server sets. */
export class Client {
  cookie: string | undefined;
  constructor(readonly handler: Handler) {}

  async req(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res> {
    const h: Record<string, string> = { host: HOST };
    if (this.cookie) h.cookie = `${COOKIE}=${this.cookie}`;
    if (body !== undefined) h["content-type"] = "application/json";
    Object.assign(h, headers);
    const res = await this.handler(
      new Request(ORIGIN + path, {
        method,
        headers: h,
        body: body === undefined
          ? undefined
          : typeof body === "string"
          ? body
          : JSON.stringify(body),
      }),
    );
    const sc = res.headers.get("set-cookie");
    if (sc) {
      const m = new RegExp(`${COOKIE}=([^;]*)`).exec(sc);
      if (m) this.cookie = m[1] || undefined;
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  }
  get(path: string, headers?: Record<string, string>) {
    return this.req("GET", path, undefined, headers);
  }
  post(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.req("POST", path, body, headers);
  }
  put(path: string, body: unknown = {}) {
    return this.req("PUT", path, body);
  }
}

export async function setup(opts: Partial<AppStateOptions> = {}) {
  const root = await tempDir("casefile-app-test-");
  const state = new AppState({
    configDir: join(root, "config"),
    kdfIterations: 1_000,
    idleLockMs: 0,
    home: root,
    detectorFactory: () => [new FakeNameDetector(NAMES)],
    ...opts,
  });
  await state.load();
  const handler = createHandler(state);
  return {
    root,
    state,
    handler,
    caseDir: join(root, "case"),
    user: new Client(handler),
    other: new Client(handler),
  };
}

/** A fresh app with a case created (and unlocked) by `user`. */
export async function withCase(opts: Partial<AppStateOptions> = {}) {
  const t = await setup(opts);
  const r = await t.user.post("/api/case/create", {
    dir: t.caseDir,
    passphrase: PASS,
    label: "Test matter",
  });
  assertEquals(r.status, 200, r.text);
  assertExists(t.user.cookie, "creating a case issues a session cookie");
  return t;
}

/** Build a publish request from the review data the way the UI does. */
// deno-lint-ignore no-explicit-any
export function publishRequestFrom(review: any) {
  const fatherKey = review.newEntities.find((n: { full: string }) => n.full === PEOPLE.father)
    ?.key;
  const used = new Set<string>();
  const replacements: { start: number; end: number; ref: string; form: string }[] = [];
  for (const sp of review.proposals as ProposedSpan[]) {
    const p = sp.proposal;
    if (p.type === "existing") {
      replacements.push({ start: sp.start, end: sp.end, ref: p.role, form: p.form });
    } else if (p.type === "new") {
      used.add(p.key);
      replacements.push({ start: sp.start, end: sp.end, ref: p.key, form: p.form });
    } else {
      // Every bare "Okafor" / "Mr Okafor" in the fixtures is the father.
      const opt = p.options.find((o) => o.ref === fatherKey || o.ref === "father");
      assertExists(opt, `no father option for ambiguous "${sp.text}"`);
      used.add(opt.ref);
      replacements.push({ start: sp.start, end: sp.end, ref: opt.ref, form: opt.form });
    }
  }
  const newEntities = review.newEntities
    .filter((n: { key: string }) => used.has(n.key))
    // deno-lint-ignore no-explicit-any
    .map((n: any) => ({
      ref: n.key,
      kind: n.kind,
      full: n.full,
      role: n.roleHint,
      first: n.first,
      surname: n.surname,
    }));
  return { newEntities, replacements };
}

export async function importAndPublish(
  user: Client,
  doc: { title: string; text: string; origin?: string },
) {
  // New imports are "not asked yet" (withheld); these helpers mean the user's own document.
  const imp = await user.post(
    "/api/docs/import",
    doc.origin ? doc : { ...doc, origin: "mine" },
  );
  assertEquals(imp.status, 200, imp.text);
  const id: string = imp.json.id;
  const review = await user.get(`/api/docs/${id}/review`);
  assertEquals(review.status, 200, review.text);
  const pub = await user.post(`/api/docs/${id}/publish`, publishRequestFrom(review.json));
  assertEquals(pub.status, 200, pub.text);
  return { id, review: review.json, publish: pub.json };
}

/** Every API route as a concrete path (params filled with "1"). */
export function allRoutes(state: AppState) {
  return buildRoutes(state).map((r) => ({
    method: r.method,
    open: Boolean(r.open),
    path: r.pattern.source.slice(1, -1).replaceAll("\\/", "/").replaceAll("([^/]+)", "1"),
  }));
}

export function assertSecurityHeaders(res: Res, what: string) {
  assert(
    res.headers.get("content-security-policy")?.includes("default-src 'self'"),
    `${what}: CSP`,
  );
  assertEquals(res.headers.get("x-content-type-options"), "nosniff", `${what}: nosniff`);
  assertEquals(res.headers.get("cache-control"), "no-store", `${what}: no-store`);
}

export function assertNoSecrets(text: string, what: string) {
  for (const s of SECRETS) assert(!text.includes(s), `${what} contains "${s}"`);
}
