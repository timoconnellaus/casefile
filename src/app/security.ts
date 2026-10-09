/**
 * Local API protection (ADR 13).
 *
 * The app serves on 127.0.0.1, so any process on the machine can reach it — including Claude Code.
 * Once a case is unlocked the API returns re-identified text, so every request that touches case
 * data needs a session cookie that is only issued in exchange for the passphrase. Host and Origin
 * checks stop web pages in an ordinary browser from reaching the API (DNS rebinding, CSRF).
 */

/** Session cookies are called `casefile_session_<port>` (see `cookieName`). */
export const COOKIE_PREFIX = "casefile_session";

/**
 * The session cookie's name for the instance a request reached: `casefile_session_<port>`.
 * Browsers keep cookies per host, not per port, so with one shared name two casefile instances on
 * 127.0.0.1 (two cases, or the app and a test copy) would overwrite each other's cookie and sign
 * each other out. The port comes from the request URL (its Host header); a request that names
 * another port only makes the server look for that port's cookie, which still has to hold this
 * instance's token.
 */
export function cookieName(req: Request | URL | string): string {
  let port = "";
  try {
    const u = req instanceof URL ? req : new URL(typeof req === "string" ? req : req.url);
    port = u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    port = "0";
  }
  return `${COOKIE_PREFIX}_${/^\d{1,5}$/.test(port) ? port : "0"}`;
}

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The named cookie (default: this instance's session cookie for `req`). */
export function readCookie(req: Request, name = cookieName(req)): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** HttpOnly (no script can read it), SameSite=Strict (no cross-site request carries it). */
export function sessionCookie(token: string, name: string): string {
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function clearCookie(name: string): string {
  return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The Host header must name a loopback address (blocks DNS-rebinding attacks). */
export function hostAllowed(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTS.has(name.toLowerCase());
}

/** For state-changing requests, a present Origin header must be this same local origin. */
export function originAllowed(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.get("origin");
  if (origin === null) return true; // same-origin fetches from some webviews omit it; cookie still required
  try {
    const o = new URL(origin);
    return LOCAL_HOSTS.has(o.hostname === "::1" ? "[::1]" : o.hostname) &&
      o.host === req.headers.get("host");
  } catch {
    return false;
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
