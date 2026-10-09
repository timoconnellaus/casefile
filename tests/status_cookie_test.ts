/**
 * The session cookie is per instance (its name carries the port), so several casefile instances on
 * 127.0.0.1 don't sign each other out; `/api/status` says when a locked case will lock again and
 * suggests the next free case folder. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { createHandler } from "../src/app/server.ts";
import { AppState } from "../src/app/state.ts";
import { cookieName, readCookie, sessionCookie } from "../src/app/security.ts";
import { PASS, setup, withCase } from "./helpers/app.ts";

/** A caller on a given port that keeps every cookie it is given, like one browser profile. */
class Browser {
  jar = new Map<string, string>();
  async req(
    handler: (r: Request) => Promise<Response>,
    port: number,
    method: string,
    path: string,
    body?: unknown,
  ) {
    const origin = `http://127.0.0.1:${port}`;
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, origin };
    if (this.jar.size) {
      headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handler(
      new Request(origin + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const sc = res.headers.get("set-cookie");
    if (sc) {
      const [pair] = sc.split(";");
      const [k, ...v] = pair.split("=");
      this.jar.set(k.trim(), v.join("="));
    }
    return { status: res.status, setCookie: sc, json: JSON.parse(await res.text() || "null") };
  }
}

Deno.test("cookie names carry the port", () => {
  assertEquals(cookieName("http://127.0.0.1:8217/api/status"), "casefile_session_8217");
  assertEquals(cookieName(new URL("http://localhost:9000/")), "casefile_session_9000");
  assertEquals(cookieName("http://127.0.0.1/"), "casefile_session_80");
  const req = new Request("http://127.0.0.1:8300/api/docs", {
    headers: { cookie: "casefile_session_8217=aaa; casefile_session_8300=bbb" },
  });
  assertEquals(readCookie(req), "bbb");
  // The flags that keep it from scripts and from cross-site requests.
  assertEquals(
    sessionCookie("t0k", "casefile_session_8300"),
    "casefile_session_8300=t0k; HttpOnly; SameSite=Strict; Path=/",
  );
});

Deno.test("two instances on different ports don't sign each other out", async () => {
  const a = await setup();
  const b = await setup();
  const browser = new Browser();
  const mk = async (t: typeof a, port: number) => {
    const r = await browser.req(t.handler, port, "POST", "/api/case/create", {
      dir: t.caseDir,
      passphrase: PASS,
      label: `Matter ${port}`,
    });
    assertEquals(r.status, 200);
    assertExists(r.setCookie);
    assertMatch(
      r.setCookie!,
      new RegExp(`^casefile_session_${port}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/$`),
    );
  };
  try {
    await mk(a, 8217);
    await mk(b, 8218);
    // One browser now holds both cookies; each instance still accepts its own.
    assertEquals(browser.jar.size, 2);
    assertEquals(
      (await browser.req(a.handler, 8217, "GET", "/api/settings")).json.label,
      "Matter 8217",
    );
    assertEquals(
      (await browser.req(b.handler, 8218, "GET", "/api/settings")).json.label,
      "Matter 8218",
    );
    assertEquals((await browser.req(a.handler, 8217, "GET", "/api/status")).json.signedIn, true);
    // Instance B's cookie, sent to A under A's name, is refused: names don't share tokens.
    const bToken = browser.jar.get("casefile_session_8218")!;
    const spoof = new Browser();
    spoof.jar.set("casefile_session_8217", bToken);
    assertEquals((await spoof.req(a.handler, 8217, "GET", "/api/settings")).status, 401);
    // And a request to A that names B's port looks for B's cookie, which A's token doesn't match.
    const odd = await a.handler(
      new Request("http://127.0.0.1:8218/api/settings", {
        headers: { host: "127.0.0.1:8218", cookie: `casefile_session_8218=${bToken}` },
      }),
    );
    assertEquals(odd.status, 401);
    await odd.body?.cancel();
  } finally {
    a.state.lock();
    b.state.lock();
  }
});

Deno.test("status while locked: the last case's idle lock, from the app config", async () => {
  const t = await withCase({ idleLockMs: undefined });
  await t.user.put("/api/settings", { idleLockMinutes: 60 });
  await t.user.post("/api/lock");
  const locked = await t.other.get("/api/status");
  assertEquals(locked.json.unlocked, false);
  assertEquals(locked.json.idleLockMinutes, 60);
  // A fresh start of the app (same config folder) still knows it, without opening the vault.
  const again = new AppState({ ...t.state.opts });
  await again.load();
  const st = await createHandler(again)(
    new Request("http://127.0.0.1:8217/api/status", { headers: { host: "127.0.0.1:8217" } }),
  );
  const body = await st.json();
  assertEquals(body.idleLockMinutes, 60);
  assertEquals(body.caseDir, null, "nothing else about the case");
  const config = await Deno.readTextFile(join(t.state.opts.configDir, "config.json"));
  assertEquals(Object.keys(JSON.parse(config)).sort(), ["idleLockMinutes", "lastCase"]);
});

Deno.test("status suggests the next free case folder", async () => {
  const t = await setup();
  assertEquals(
    (await t.other.get("/api/status")).json.defaultCaseDir,
    "~/Documents/casefile/case-1",
  );
  await Deno.mkdir(join(t.root, "Documents", "casefile", "case-1"), { recursive: true });
  await Deno.mkdir(join(t.root, "Documents", "casefile", "case-2"));
  assertEquals(
    (await t.other.get("/api/status")).json.defaultCaseDir,
    "~/Documents/casefile/case-3",
  );
  // Creating a case there works with the ~ form.
  const r = await t.user.post("/api/case/create", {
    dir: "~/Documents/casefile/case-3",
    passphrase: PASS,
    label: "Third",
  });
  assertEquals(r.status, 200, r.text);
  assert((await Deno.stat(join(t.root, "Documents", "casefile", "case-3", "case.json"))).isFile);
  assertEquals(
    (await t.user.get("/api/status")).json.defaultCaseDir,
    "~/Documents/casefile/case-4",
  );
  t.state.lock();
});

Deno.test("the favicon is served from the app (SVG and ICO), under the CSP", async () => {
  const t = await setup();
  for (
    const [path, type] of [["/favicon.svg", "image/svg+xml"], ["/favicon.ico", "image/x-icon"]]
  ) {
    const r = await t.handler(
      new Request(`http://127.0.0.1:8217${path}`, { headers: { host: "127.0.0.1:8217" } }),
    );
    assertEquals(r.status, 200, path);
    assertEquals(r.headers.get("content-type"), type);
    assert(r.headers.get("content-security-policy")?.includes("default-src 'self'"));
    const body = new Uint8Array(await r.arrayBuffer());
    assert(body.length > 100, path);
  }
  const svg = await Deno.readTextFile(new URL("../src/app/ui/favicon.svg", import.meta.url));
  assert(!/<script|on[a-z]+=|href=/i.test(svg), "a plain drawing");
  const html = await Deno.readTextFile(new URL("../src/app/ui/index.html", import.meta.url));
  assert(html.includes('<link rel="icon" href="/favicon.svg"'));
});
