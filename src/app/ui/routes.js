// Route table: hash → view module. Pure (views load lazily), so tests can import it under Deno.
//
// Each view is views/<name>.js exporting `default async (main, params, ctx)`, with styles in
// views/<name>.css (linked from index.html).

/** The AppHeader's sections, in order (spec §5). Paste lives under To check; search is ⌘K. */
export const NAV = [
  { id: "docs", href: "#/docs", label: "Documents" },
  { id: "to-check", href: "#/to-check", label: "To check", count: true },
  { id: "people", href: "#/people", label: "People" },
  { id: "chronology", href: "#/chronology", label: "Chronology" },
  { id: "issues", href: "#/issues", label: "Issues" },
  { id: "drafts", href: "#/drafts", label: "Drafts" },
  { id: "log", href: "#/log", label: "Log" },
  { id: "settings", href: "#/settings", label: "Settings" },
];

/**
 * @typedef {{name: string, path: string, nav: string|null, title: string,
 *   load: () => Promise<{default: Function}>,
 *   parse?: (params: Record<string, string>) => Record<string, string>|null}} Route
 */

/** @type {Route[]} */
export const ROUTES = [
  {
    name: "review",
    path: "#/review/:id",
    nav: "docs",
    title: "Review",
    load: () => import("./views/review.js"),
  },
  {
    name: "documents",
    path: "#/docs",
    nav: "docs",
    title: "Documents",
    load: () => import("./views/documents.js"),
  },
  {
    name: "document",
    path: "#/doc/:ref",
    nav: "docs",
    title: "Document",
    load: () => import("./views/document.js"),
    // "D001" or "D001:12" (a line to scroll to)
    parse: ({ ref }) => {
      const m = /^([A-Z]\d+)(?::(\d+))?$/.exec(ref);
      return m ? { id: m[1], ...(m[2] ? { line: m[2] } : {}) } : null;
    },
  },
  {
    name: "people",
    path: "#/people/:role?",
    nav: "people",
    title: "People",
    load: () => import("./views/people.js"),
  },
  {
    name: "chronology",
    path: "#/chronology",
    nav: "chronology",
    title: "Chronology",
    load: () => import("./views/chronology.js"),
  },
  {
    name: "issues",
    path: "#/issues/:id?",
    nav: "issues",
    title: "Issues",
    load: () => import("./views/issues.js"),
  },
  {
    name: "drafts",
    path: "#/drafts",
    nav: "drafts",
    title: "Drafts",
    load: () => import("./views/drafts.js"),
  },
  {
    name: "draft",
    path: "#/draft/:id",
    nav: "drafts",
    title: "Draft",
    load: () => import("./views/draft.js"),
    parse: ({ id }) => (/^\d+$/.test(id) ? { id } : null),
  },
  {
    name: "tocheck",
    path: "#/to-check",
    nav: "to-check",
    title: "To check",
    load: () => import("./views/tocheck.js"),
  },
  { name: "log", path: "#/log", nav: "log", title: "Log", load: () => import("./views/log.js") },
  {
    name: "paste",
    path: "#/paste",
    nav: "to-check",
    title: "Paste",
    load: () => import("./views/paste.js"),
  },
  {
    name: "settings",
    path: "#/settings",
    nav: "settings",
    title: "Settings",
    load: () => import("./views/settings.js"),
  },
  {
    name: "start",
    path: "#/start",
    nav: null,
    title: "Getting started",
    load: () => import("./views/start.js"),
  },
];

/** Shown whenever the case is locked; not reachable by hash. */
export const UNLOCK = {
  name: "unlock",
  path: "",
  nav: null,
  title: "Unlock",
  load: () => import("./views/unlock.js"),
};

/** Empty hashes go to Documents. */
export const ALIASES = {
  "#/": "#/docs",
  "#": "#/docs",
  "": "#/docs",
};

export const DEFAULT_HASH = "#/docs";

function compile(path) {
  const keys = [];
  const src = path.split("/").map((part, i) => {
    if (i === 0) return part.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");
    const m = /^:(\w+)(\?)?$/.exec(part);
    if (!m) return `/${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    keys.push(m[1]);
    return m[2] ? "(?:/([^/]+))?" : "/([^/]+)";
  }).join("");
  return { re: new RegExp(`^${src}/?$`), keys };
}

const COMPILED = ROUTES.map((r) => ({ route: r, ...compile(r.path) }));

/** Where an old or empty hash should go, or null if it is already canonical. */
export function redirectFor(hash) {
  return Object.hasOwn(ALIASES, hash) ? ALIASES[hash] : null;
}

/**
 * Match a location hash. Returns {route, params} or null.
 * @param {string} hash e.g. "#/doc/D001:12"
 */
export function matchRoute(hash) {
  const clean = hash.split("?")[0];
  for (const { route, re, keys } of COMPILED) {
    const m = re.exec(clean);
    if (!m) continue;
    /** @type {Record<string, string>} */
    let params = {};
    try {
      keys.forEach((k, i) => {
        if (m[i + 1] !== undefined) params[k] = decodeURIComponent(m[i + 1]);
      });
    } catch {
      return null;
    }
    if (route.parse) {
      const p = route.parse(params);
      if (!p) return null;
      params = p;
    }
    return { route, params };
  }
  return null;
}
