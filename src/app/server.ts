import { extname, fromFileUrl, join, normalize } from "@std/path";
import { buildRoutes, errorResponse, type Route } from "./api.ts";
import {
  cookieName,
  hostAllowed,
  originAllowed,
  SECURITY_HEADERS,
  sessionCookie,
} from "./security.ts";
import { type AppState, CASE_REPLACED_MESSAGE } from "./state.ts";
import { isCaseReplacedError } from "../core/session.ts";

const UI_DIR = fromFileUrl(new URL("./ui/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2", // bundled IBM Plex (ADR 0020)
  ".txt": "text/plain; charset=utf-8", // the fonts' OFL licence
};

const MAX_BODY = 20 * 1024 * 1024;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

async function serveStatic(path: string): Promise<Response> {
  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const full = normalize(join(UI_DIR, rel));
  if (!full.startsWith(UI_DIR)) return new Response("Not found", { status: 404 });
  try {
    const data = await Deno.readFile(full);
    return new Response(data, {
      headers: {
        "content-type": MIME[extname(full)] ?? "application/octet-stream",
        ...SECURITY_HEADERS,
      },
    });
  } catch {
    // Unknown paths fall back to the app shell (client-side routing uses the hash, but be lenient).
    if (!extname(rel)) return serveStatic("/");
    return new Response("Not found", { status: 404 });
  }
}

export function createHandler(state: AppState): (req: Request) => Promise<Response> {
  const routes: Route[] = buildRoutes(state);
  return async (req: Request) => {
    if (!hostAllowed(req)) return new Response("Forbidden host", { status: 403 });
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      return await serveStatic(url.pathname);
    }
    if (!originAllowed(req)) return json(403, { error: "Cross-origin request refused" });

    let matched: { route: Route; params: Record<string, string> } | undefined;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params: Record<string, string> = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      } catch {
        return json(400, { error: "Bad request path" });
      }
      matched = { route: r, params };
      break;
    }
    if (!matched) {
      return json(pathMatched ? 405 : 404, {
        error: pathMatched ? "Method not allowed" : "Not found",
      });
    }

    // A case whose folder was replaced while open is locked before anything reads it.
    await state.checkReplaced();
    if (!matched.route.open) {
      if (!state.session || !state.token) {
        return json(423, {
          error: state.lockNotice ?? "The case is locked",
          ...(state.lockNotice ? { replaced: true } : {}),
        });
      }
      if (!state.isSignedIn(req)) return json(401, { error: "Not signed in to this case" });
      state.touch();
    }

    const body = async () => {
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > MAX_BODY) throw new SyntaxError("too large");
      const text = await req.text();
      if (text.length > MAX_BODY) throw new SyntaxError("too large");
      return text ? JSON.parse(text) : {};
    };
    try {
      const before = state.token;
      const result = await matched.route.handler({ req, params: matched.params, url, body });
      if (result instanceof Response) {
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) result.headers.set(k, v);
        return result;
      }
      // Opening or creating a case issues a fresh session cookie.
      const extra: Record<string, string> = {};
      // Its name carries this instance's port, so instances on other ports keep theirs.
      if (state.token && state.token !== before) {
        extra["set-cookie"] = sessionCookie(state.token, cookieName(req));
      }
      return json(200, result ?? { ok: true }, extra);
    } catch (e) {
      if (isCaseReplacedError(e)) {
        // Replaced mid-request (after the check above).
        await state.checkReplaced();
        return json(423, { error: CASE_REPLACED_MESSAGE, replaced: true });
      }
      const { status, body } = errorResponse(e);
      // Only the error type is printed; messages and stacks can contain case content.
      if (status === 500) {
        console.error(`casefile: internal error (${e instanceof Error ? e.name : typeof e})`);
        if (Deno.env.get("CASEFILE_DEBUG") === "1") console.error(e);
      }
      return json(status, body);
    }
  };
}
