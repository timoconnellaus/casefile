// The app shell: AppHeader + <main>, routing, the To-check count, ⌘K, lock and focus handling.
import { clear, h } from "../dom.js";
import { api } from "../lib.js";
import { toCheckCount, updateReadyNote, updateRolledBackNote, windowTitle } from "../model.js";
import { DEFAULT_HASH, matchRoute, redirectFor, UNLOCK } from "../routes.js";
import {
  announce,
  clearLive,
  confirmDialog,
  EmptyState,
  liveRegion,
  showToast,
} from "../components/index.js";
import { AppHeader } from "./header.js";
import { openPalette } from "./palette.js";

async function fetchToCheck() {
  try {
    return toCheckCount(await api("GET", "/api/to-check"));
  } catch {
    return null; // the count is a convenience; never block the screen on it
  }
}

/**
 * Start the app in `root`.
 * @param {HTMLElement} root
 */
/**
 * A newer casefile is downloaded and waiting (ADR 23): offer to restart into it. Restarting closes
 * the case, so it asks first; the new version asks for the passphrase. Also says once if the last
 * update failed to start and casefile went back.
 */
function watchForUpdate() {
  let bar = null;
  let rollbackShown = false;
  const check = (st) => {
    const u = st?.update;
    if (!u) return;
    if (u.rolledBack && !rollbackShown) {
      rollbackShown = true;
      showToast(updateRolledBackNote(), { tone: "danger" });
    }
    if (!u.ready || bar) return;
    const restart = async () => {
      const ok = await confirmDialog(
        `Restart to update to casefile ${u.ready}?`,
        "casefile closes the case, saving everything, and opens the new version. You'll need " +
          "your passphrase to open the case again.",
        "Restart now",
      );
      if (!ok) return;
      try {
        await api("POST", "/api/update/restart");
        bar.replaceChildren(h("span", {}, "Restarting casefile…"));
      } catch (e) {
        showToast(String(e?.message ?? e), { tone: "danger" });
      }
    };
    bar = h(
      "div",
      { class: "update-note", role: "status" },
      h("span", {}, updateReadyNote(u.ready)),
      h("button", { type: "button", class: "btn", onclick: restart }, "Restart to update"),
    );
    document.body.prepend(bar);
    announce(updateReadyNote(u.ready));
  };
  const poll = async () => {
    try {
      check(await api("GET", "/api/status"));
    } catch { /* not answering: try again later */ }
  };
  setInterval(poll, 5 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
  });
  return check;
}

export function startApp(root) {
  let status = null;
  let first = true;
  let wasLocked = false; // the last render was the Unlock screen
  let header = null;
  let rendering = Promise.resolve();

  const ctx = {
    get status() {
      return status;
    },
    settings: {},
    shortcuts: true,
    announce,
    toast: showToast,
    navigate: (hash) => (location.hash = hash),
    rerender: () => schedule(),
    /** Re-read the To-check count after an action that changes it. */
    refreshCounts: async () => header?.setCount(await fetchToCheck()),
    /** Update the header's "Locks after N min idle" (Settings). */
    setIdleMinutes: (m) => header?.setIdleMinutes(m),
    /** Update the case name in the header (Settings). */
    setCaseName: (label) => header?.setLabel(label),
  };

  const lock = async () => {
    await api("POST", "/api/lock");
    location.hash = "#/";
    announce("Case locked");
    await schedule();
  };

  async function renderLocked() {
    header = null;
    wasLocked = true;
    root.className = "app app--locked";
    const main = h("main", { id: "main", class: "page", tabindex: "-1" });
    clear(root, main);
    const mod = await UNLOCK.load();
    document.title = windowTitle(null, status?.build);
    await mod.default(main, {}, ctx);
  }

  async function render() {
    // The current screen stays up while the next one loads.
    status = await api("GET", "/api/status");
    checkUpdate(status);
    if (!status.signedIn) return await renderLocked();
    // Only once signed in: a locked case answers 423, which asks the shell to render again.
    const settingsP = api("GET", "/api/settings").catch(() => ({}));

    // Old and empty hashes are rewritten in place (no extra history entry, no hashchange).
    const to = redirectFor(location.hash);
    if (to) history.replaceState(null, "", to);
    const found = matchRoute(location.hash);
    const modP = found ? found.route.load() : null;
    modP?.catch(() => {}); // reported below, where it's awaited

    ctx.settings = await settingsP;
    ctx.shortcuts = ctx.settings.shortcuts !== false;

    // The header is built once per opened case and kept: only the current section changes.
    const keepHeader = header && root.contains(header);
    if (!keepHeader) {
      root.className = "app";
      header = AppHeader({
        label: status.label ?? "",
        current: found?.route.nav ?? null,
        idleMinutes: status.idleLockMinutes ?? ctx.settings.idleLockMinutes ?? 30,
        dev: status.build?.dev === true,
        onSearch: (q) => openPalette({ initial: q }),
        onLock: lock,
      });
      clear(
        root,
        h("a", {
          class: "skip-link",
          href: "#main",
          onclick: (e) => (e.preventDefault(), document.getElementById("main")?.focus()),
        }, "Skip to content"),
        header,
      );
      liveRegion();
    } else header.setCurrent(found?.route.nav ?? null);
    fetchToCheck().then((n) => header?.setCount(n));

    // The new screen is built in a hidden <main> next to the old one, then swapped in, so the
    // page never goes blank while it loads. The old one is inert and loses its ids meanwhile, so
    // nothing (getElementById, labels, the skip link) finds it instead of the new screen.
    const old = root.querySelector(":scope > main");
    if (old) {
      old.inert = true;
      old.removeAttribute("id");
      for (const el of old.querySelectorAll("[id]")) el.removeAttribute("id");
    }
    const main = h("main", { id: "main", class: "page", tabindex: "-1", hidden: !!old });
    root.append(main);
    const show = () => {
      old?.remove();
      main.hidden = false;
    };

    if (!found) {
      document.title = windowTitle("Not found", status?.build);
      main.append(
        h("div", { class: "page-head" }, h("h1", {}, "Not found")),
        h(
          "div",
          { class: "page-body" },
          EmptyState({
            message: "There is no page at this address.",
            action: h("a", { class: "btn", href: DEFAULT_HASH }, "Go to Documents"),
          }),
        ),
      );
      show();
      return;
    }

    const { route, params } = found;
    document.title = windowTitle(route.title, status?.build);
    try {
      const mod = await modP;
      await mod.default(main, params, ctx);
    } catch (e) {
      console.error(e);
      clear(
        main,
        h("div", { class: "page-head" }, h("h1", {}, route.title)),
        h(
          "div",
          { class: "page-body" },
          EmptyState({
            tone: "danger",
            message: e?.message ?? String(e),
            action: h(
              "button",
              { type: "button", class: "btn", onclick: () => schedule() },
              "Try again",
            ),
          }),
        ),
      );
    }
    show();
    // Just opened: mention details that look like a safety-sensitive person's but aren't linked
    // to anyone (security review). Linking is the user's choice, in People.
    if (wasLocked) suggestLinks();
    // Move focus to the new screen (not on first load, so the browser's own start applies; but
    // after unlocking, as after any navigation).
    if (!first || wasLocked) {
      const h1 = main.querySelector("h1");
      if (h1 && !h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
      (h1 ?? main).focus();
    }
    first = false;
    wasLocked = false;
  }

  async function suggestLinks() {
    try {
      const r = await api("GET", "/api/people/link-suggestions");
      const safe = (r?.suggestions ?? []).filter((x) => x.safety);
      if (!safe.length) return;
      const n = safe.length;
      showToast(
        h(
          "span",
          {},
          `${n === 1 ? "A detail" : `${n} details`} in who’s who ${
            n === 1 ? "looks" : "look"
          } like a safety-sensitive person’s but ${
            n === 1 ? "isn’t" : "aren’t"
          } linked to anyone. `,
          h("a", { href: "#/people" }, "Check in People"),
        ),
        { timeout: 15000 },
      );
    } catch {
      // a convenience only
    }
  }

  function schedule() {
    rendering = rendering.then(render, render).catch((e) => {
      console.error(e);
      clear(
        root,
        h(
          "main",
          { class: "page" },
          EmptyState({ tone: "danger", message: e?.message ?? String(e) }),
        ),
      );
    });
    return rendering;
  }

  const checkUpdate = watchForUpdate();
  window.addEventListener("hashchange", () => {
    clearLive(); // an old result ("Opening case.") shouldn't linger on the next screen
    schedule();
  });
  window.addEventListener("casefile:locked", () => setTimeout(() => schedule(), 0));
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k" && status?.signedIn) {
      e.preventDefault();
      openPalette();
    }
  });
  return schedule();
}
