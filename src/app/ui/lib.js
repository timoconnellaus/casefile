// Small helpers shared by every view. No framework; all text goes through textContent,
// never innerHTML, because documents contain arbitrary text. h() refuses a `style` attribute
// (CSP style-src 'self'; ADR 0020) — see dom.js.
import { append, clear, cls, h, svg, uniqueId } from "./dom.js";
import { showToast } from "./components/feedback.js";

export { append, clear, cls, h, svg, uniqueId };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `Request failed (${status})`);
    this.status = status;
    this.body = body ?? {};
  }
}

/** The words to show for a failed action: the API's error, or the exception's message. */
export function errorText(e) {
  return e instanceof ApiError ? e.body?.error ?? e.message : e?.message ?? String(e);
}

/** JSON API call. A 401/423 sends the user back to the unlock screen. */
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if ((res.status === 401 || res.status === 423) && !path.startsWith("/api/case/")) {
      location.hash = "#/";
      window.dispatchEvent(new Event("casefile:locked"));
    }
    throw new ApiError(res.status, isJson ? data : { error: data });
  }
  return data;
}

/** Run an async action from a button, showing errors as a toast. */
export function action(fn) {
  return async (ev) => {
    const btn = ev?.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null;
    if (btn) btn.disabled = true;
    try {
      await fn(ev);
    } catch (e) {
      showToast(e.message ?? String(e), { tone: "danger" });
      console.error(e);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

/** Every who's who entry (`GET /api/people` rows: role, kind, forms, aliases, colour, …). */
export async function listPeople() {
  return (await api("GET", "/api/people")).entities;
}

export function download(filename, content, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
