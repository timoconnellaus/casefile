// Paste (W2-7, ADR 0019): the user pastes what Claude wrote in the chat (names replaced) and reads
// it with real names, checked sentence by sentence against the lines it cites
// (POST /api/paste/view). Copying is logged with a warning and Clear clipboard
// (POST /api/paste/copied); "Add to a draft as Claude's" stores the paragraphs as needing the user
// (POST /api/paste/add-to-draft), with Undo (DELETE /api/paragraphs/:id). The log never holds the
// text, only counts.
import { clear, h } from "../dom.js";
import { api } from "../lib.js";
import { plural } from "../model.js";
import {
  announce,
  Badge,
  Callout,
  CheckList,
  ConfirmBar,
  EmptyState,
  Field,
  FlagBadge,
  Icon,
  Key,
  linkEntities,
  Segments,
  showToast,
  UnknownToken,
} from "../components/index.js";

/** Paragraphs are separated by blank lines (as the API splits them). */
export function paragraphsOf(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim())
    .filter(Boolean);
}

const squash = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

/** The API's sentences grouped by the paragraph each came from (its `paragraph` index). */
function byParagraph(sentences) {
  const out = [];
  for (const s of sentences) (out[s.paragraph ?? 0] ??= []).push(s);
  return out.filter(Boolean);
}

/** Everyone the pasted text names: role → {name, kind, colour, forms, count}. */
function whoIn(rich) {
  const known = new Map();
  for (const s of rich?.segs ?? []) {
    if (!s.role) continue;
    const k = known.get(s.role) ??
      { name: s.t, kind: s.kind, colour: s.colour, forms: new Map(), count: 0 };
    if (s.form === "full" || !s.form) k.name = s.t;
    if (!k.forms.has(s.form ?? "full")) k.forms.set(s.form ?? "full", s.t);
    k.count += 1;
    known.set(s.role, k);
  }
  return known;
}

const SENTENCE = {
  checked: { tone: "neutral", glyph: "check", text: "casefile checked" },
  not_checked: { tone: "attention", glyph: "dot", text: "Not checked" },
  cant_check: { tone: "danger", glyph: "triangle", text: "Can’t check" },
};
const sentenceBadge = (state) => {
  const { tone, glyph, text } = SENTENCE[state] ?? SENTENCE.not_checked;
  return FlagBadge(tone, glyph, text, { small: true, className: "paste-sbadge" });
};

/** Take a sentence's closing full stop off its last segment, so citations go before it. */
function splitStop(segs) {
  const last = segs.at(-1);
  if (!last || last.role || last.unknown || last.malformed) return { segs, stop: "" };
  const m = /([.!?])\s*$/.exec(last.t ?? "");
  if (!m) return { segs, stop: "" };
  return { segs: [...segs.slice(0, -1), { t: last.t.slice(0, m.index) }], stop: m[1] };
}

const dash = (ref) => String(ref).replace("-", "–");
function citeLink(ref) {
  const m = /^([A-Z]\d+):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!m) return h("span", { class: "mono" }, ref);
  const lines = m[3] ? `lines ${m[2]}–${m[3]}` : `line ${m[2]}`;
  return h(
    "a",
    { href: `#/doc/${m[1]}:${m[2]}`, "aria-label": `Open ${m[1]} ${lines}` },
    dash(ref),
  );
}

/** A short quote of a sentence for the check list. */
function quote(sentence) {
  const t = squash(sentence.text?.text);
  return t.length > 70 ? `“${t.slice(0, 67)}…”` : `“${t}”`;
}

/** @param {HTMLElement} main @param {Record<string, string>} _params @param {any} ctx */
export default function view(main, _params, ctx) {
  const state = { text: "", result: null, editing: true };

  const logged = h("div", { class: "paste-logged", role: "status" });
  const keyArea = h("div", { class: "paste-key" });
  const left = h("section", { class: "paste-in", "aria-labelledby": "paste-in-h" });
  const right = h("section", { class: "paste-out", "aria-labelledby": "paste-out-h" });
  const work = h(
    "div",
    { class: "paste-work" },
    keyArea,
    h("div", { class: "paste-cols" }, left, right),
  );
  let linker = null;

  function setLogged(when, paras) {
    clear(
      logged,
      // Plain status text, not a Badge: "Logged" isn't a §3 state (QA Pa1).
      h("span", { class: "status-text strong" }, Icon("check"), "Logged"),
      h(
        "span",
        {},
        when
          ? `Recorded in the AI-use log at ${when}: ${
            plural(paras, "paragraph")
          }. What you pasted isn’t recorded.`
          : "Every use is recorded in the AI-use log. What you paste isn’t recorded.",
      ),
    );
  }

  async function show() {
    const text = state.text;
    if (!text.trim()) {
      showToast("Paste something Claude wrote first.");
      return;
    }
    state.result = await api("POST", "/api/paste/view", { text });
    state.editing = false;
    const now = new Date().toLocaleTimeString("en-AU", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    setLogged(now, paragraphsOf(text).length);
    render();
    const n = state.result.sentences.length;
    const cant = state.result.sentences.filter((s) => s.state === "cant_check").length;
    announce(
      `Showing Claude’s text with real names: ${plural(n, "sentence")}${
        cant ? `, ${cant} can’t be checked` : ""
      }.`,
    );
    document.getElementById("paste-out-h")?.focus();
  }

  function renderLeft() {
    const r = state.result;
    const editBtn = r
      ? h("button", {
        type: "button",
        class: "btn",
        "aria-pressed": state.editing,
        onclick: () => {
          state.editing = !state.editing;
          renderLeft();
          if (state.editing) left.querySelector("textarea")?.focus();
        },
      }, state.editing ? "Show highlighted" : "Edit text")
      : null;
    const head = h(
      "div",
      { class: "hstack between" },
      h(
        "h2",
        { id: "paste-in-h", class: "eyebrow paste-col-title" },
        "What Claude wrote (as pasted)",
      ),
      editBtn,
    );
    if (state.editing || !r) {
      const ta = h("textarea", {
        class: "paste-textarea",
        "aria-labelledby": "paste-in-h",
        "aria-describedby": "paste-in-hint",
        spellcheck: "false",
        oninput: (e) => (state.text = e.target.value),
        onkeydown: (e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            show();
          }
        },
      });
      ta.value = state.text;
      clear(
        left,
        head,
        ta,
        h(
          "p",
          { id: "paste-in-hint", class: "muted small" },
          "Paste the text from the Claude chat, with the labels like {{mother}} as Claude wrote them.",
        ),
        h(
          "div",
          {},
          h("button", {
            type: "button",
            class: "btn btn-primary btn-lg",
            onclick: () => show().catch((e) => showToast(e.message, { tone: "danger" })),
          }, "Show with real names"),
        ),
      );
      return;
    }
    clear(
      left,
      head,
      h(
        "div",
        { class: "paste-tokens", "aria-label": "What Claude wrote, with labels", role: "group" },
        paragraphsOf(state.text).length
          ? Segments(r.rich.segs, { mode: "token", interactive: false })
          : null,
      ),
    );
  }

  function renderKey() {
    const r = state.result;
    if (!r) {
      clear(keyArea);
      return;
    }
    const known = whoIn(r.rich);
    const entries = [...known].map(([role, k]) => ({
      role,
      name: k.name,
      kind: k.kind,
      colour: k.colour,
      count: k.count,
    }));
    const unknown = [...new Set([...(r.unknown ?? []), ...(r.malformed ?? [])])];
    clear(
      keyArea,
      entries.length ? Key({ entries, help: null }) : null,
      unknown.length
        ? h(
          "ul",
          { class: "paste-unknown-key", "aria-label": "Labels casefile doesn’t know" },
          unknown.map((u) =>
            h(
              "li",
              {},
              UnknownToken(u),
              h("span", { class: "muted small" }, "not anyone in this case"),
            )
          ),
        )
        : null,
    );
  }

  function renderRight() {
    const r = state.result;
    if (!r) {
      clear(
        right,
        outHead(),
        EmptyState({
          message:
            "Paste what Claude wrote on the left, then choose “Show with real names”. Each sentence is checked against the lines it cites.",
        }),
      );
      return;
    }
    const groups = byParagraph(r.sentences);
    const unknown = r.unknown ?? [];
    const malformed = r.malformed ?? [];

    const alert = unknown.length || malformed.length
      ? Callout({
        tone: "danger",
        title: "Can’t check",
        children: [
          ...unknown.map((u) =>
            h(
              "p",
              {},
              h("span", { class: "mono danger-text" }, u),
              " isn’t anyone in this case. Claude may have invented a person or mixed someone up. Don’t rely on that sentence until you’ve checked it.",
            )
          ),
          ...malformed.map((u) =>
            h(
              "p",
              {},
              h("span", { class: "mono danger-text" }, u),
              " is a broken label casefile can’t read. Don’t rely on that sentence until you’ve checked it.",
            )
          ),
        ],
      })
      : null;

    const textBox = h(
      "div",
      { class: "paste-text" },
      groups.map((sents) =>
        h(
          "p",
          {},
          sents.map((s) => {
            const { segs, stop } = s.cites?.length
              ? splitStop(s.text?.segs ?? [])
              : { segs: s.text?.segs ?? [], stop: "" };
            return [
              Segments(segs),
              s.cites?.length
                ? [" (", s.cites.flatMap((c, i) => (i ? ["; ", citeLink(c)] : [citeLink(c)])), ")"]
                : null,
              stop,
              " ",
              sentenceBadge(s.state),
              " ",
            ];
          }),
        )
      ),
    );

    const rows = [];
    for (const s of r.sentences) {
      for (const c of s.checks ?? []) {
        rows.push({ level: c.level, segs: c.segs, message: c.message });
      }
      const own = (s.text?.unknown?.length ?? 0) + (s.text?.malformed?.length ?? 0);
      if (!s.cites?.length) {
        rows.push({ level: "attention", message: `Not checked: ${quote(s)} cites nothing.` });
      } else if (s.state === "cant_check" && !(s.checks ?? []).length && !own) {
        rows.push({
          level: "danger",
          message: `Can’t check: casefile can’t quote the lines ${quote(s)} cites (${
            s.cites.map(dash).join(", ")
          }).`,
        });
      } else if (s.state === "not_checked" && !(s.checks ?? []).length) {
        rows.push({
          level: "attention",
          message: `Not checked: nothing in ${quote(s)} that casefile can compare with ${
            s.cites.map(dash).join(", ")
          }.`,
        });
      }
    }
    for (const u of [...unknown, ...malformed]) {
      rows.push({ level: "danger", message: `Can’t check: ${u} isn’t anyone in this case.` });
    }

    const status = h("div", { class: "paste-status", role: "status" });
    const addArea = h("div", {});
    const paras = paragraphsOf(state.text).length;

    clear(
      right,
      outHead(),
      alert,
      textBox,
      CheckList({
        rows,
        heading: "What casefile checked",
        caveat:
          "A check means the names, dates and numbers appear in the lines Claude cited. It doesn’t mean they’re true.",
      }),
      h(
        "p",
        {},
        "Check facts, dates and any law Claude mentions before you rely on them (the Court’s rules on AI, PD-AI 4.6–4.7). An affidavit must be in your own words, so use “Add to a draft as Claude’s” rather than copying this into one.",
      ),
      h(
        "div",
        { class: "hstack" },
        h("button", {
          type: "button",
          class: "btn btn-primary btn-lg",
          "aria-expanded": "false",
          "aria-controls": "paste-add",
          onclick: (e) => openAdd(addArea, status, paras, e.currentTarget),
        }, "Add to a draft as Claude’s…"),
        h("button", {
          type: "button",
          class: "btn btn-lg",
          "aria-expanded": (r.safety ?? []).length ? "false" : null,
          "aria-controls": (r.safety ?? []).length ? "paste-copy-warn" : null,
          onclick: (e) =>
            (r.safety ?? []).length
              ? warnBeforeCopy(status, r.safety, e.currentTarget)
              : copy(status),
        }, "Copy"),
      ),
      addArea,
      status,
    );
  }

  /**
   * The text re-identifies someone marked safety-sensitive: say who, and copy only once the user
   * confirms (ADR 0015, ADR 0019).
   */
  function warnBeforeCopy(status, people, opener) {
    opener.setAttribute("aria-expanded", "true");
    const names = people.map((p) => p.name);
    const list = names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : names[0];
    const close = () => {
      clear(status);
      opener.setAttribute("aria-expanded", "false");
      opener.focus();
    };
    const bar = ConfirmBar({
      title: "Copy text with safety-sensitive details?",
      summary: [
        "This text names ",
        h("strong", {}, list),
        `, marked safety-sensitive in People. Once copied, casefile can’t control where it goes. Check who will see it before you paste it anywhere.`,
      ],
      confirmLabel: "Copy anyway",
      onCancel: close,
      onConfirm: async () => {
        opener.setAttribute("aria-expanded", "false");
        await copy(status, true);
      },
    });
    clear(status, h("div", { id: "paste-copy-warn" }, bar));
    bar.focusPrimary();
  }

  async function copy(status, safetyConfirmed = false) {
    const text = state.result?.rich?.text ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showToast("casefile couldn’t copy. Select the text and copy it yourself.", {
        tone: "danger",
      });
      return;
    }
    await api("POST", "/api/paste/copied", {
      chars: text.length,
      ...(safetyConfirmed ? { safetyConfirmed: true } : {}),
    }).catch(() => {});
    const clearBtn = h("button", {
      type: "button",
      class: "btn",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText("");
          clear(status, h("p", { class: "muted" }, "Clipboard cleared."));
        } catch {
          clear(
            status,
            h(
              "p",
              { class: "danger-text" },
              "casefile couldn’t clear the clipboard. Copy something else to replace it.",
            ),
          );
        }
      },
    }, "Clear clipboard");
    clear(
      status,
      Callout({
        tone: "attention",
        title: "Copied",
        children: [
          h(
            "p",
            {},
            h("strong", {}, "This has real names. Don’t paste it into any AI tool"),
            " — including Claude. Copying is recorded in the AI-use log (not the text).",
          ),
          h("div", {}, clearBtn),
        ],
      }),
    );
  }

  async function openAdd(area, status, paras, opener) {
    opener.setAttribute("aria-expanded", "true");
    const drafts = await api("GET", "/api/drafts");
    const close = () => {
      clear(area);
      opener.setAttribute("aria-expanded", "false");
      opener.focus();
    };
    if (!drafts.length) {
      clear(
        area,
        h(
          "div",
          { id: "paste-add" },
          EmptyState({
            message: "There are no drafts yet. Start one in Drafts, then come back to add this.",
            action: h("a", { class: "btn", href: "#/drafts" }, "Drafts"),
          }),
        ),
      );
      return;
    }
    const select = h(
      "select",
      { class: "paste-select" },
      drafts.map((d) => h("option", { value: String(d.id) }, d.title ?? `Draft ${d.id}`)),
    );
    const bar = ConfirmBar({
      title: "Add to a draft as Claude’s",
      summary: [
        `These ${plural(paras, "paragraph")} go in marked `,
        Badge("para", "claude_needs_you"),
        ". Before an affidavit can be exported you’ll check their sources and rewrite them in your own words, or use them as your own.",
      ],
      detail: Field({ label: "Draft", control: select }),
      confirmLabel: `Add ${plural(paras, "paragraph")} as Claude’s`,
      onCancel: close,
      onConfirm: async () => {
        const draftId = Number(select.value);
        const title = select.selectedOptions[0]?.textContent ?? "the draft";
        const res = await api("POST", "/api/paste/add-to-draft", {
          draftId,
          text: state.text,
        });
        clear(area);
        opener.setAttribute("aria-expanded", "false");
        added(status, draftId, title, res.ids ?? []);
        ctx?.refreshCounts?.();
      },
    });
    clear(area, h("div", { id: "paste-add" }, bar));
    bar.focusPrimary();
  }

  function added(status, draftId, title, ids) {
    const undo = h("button", {
      type: "button",
      class: "btn",
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        for (const id of ids) await api("DELETE", `/api/paragraphs/${id}`);
        clear(status, h("p", {}, `Removed the ${plural(ids.length, "paragraph")} from ${title}.`));
        ctx?.refreshCounts?.();
        announce(`Removed from ${title}.`);
      },
    }, "Undo");
    clear(
      status,
      h(
        "div",
        { class: "paste-added" },
        h(
          "span",
          {},
          h("span", { "aria-hidden": "true" }, "✓ "),
          `Added ${plural(ids.length, "paragraph")} to `,
          h("a", { href: `#/draft/${draftId}` }, title),
          " as Claude’s. Recorded in the AI-use log.",
        ),
        undo,
      ),
    );
  }

  function render() {
    renderKey();
    renderLeft();
    renderRight();
    linker?.destroy();
    linker = state.result ? linkEntities(work) : null;
  }

  setLogged(null, 0);
  render();

  clear(
    main,
    h(
      "div",
      { class: "paste" },
      h(
        "div",
        { class: "paste-head" },
        h(
          "nav",
          { "aria-label": "Breadcrumb", class: "small" },
          h("a", { href: "#/to-check" }, "To check"),
          h("span", { class: "muted" }, " / Claude’s text with real names"),
        ),
        h("h1", {}, "See Claude’s text with real names"),
        h(
          "p",
          { class: "paste-measure" },
          "Paste something Claude wrote in the chat. casefile puts the real names back so you can read it. This stays on this computer.",
        ),
        logged,
      ),
      work,
    ),
  );
}

function outHead() {
  return h(
    "div",
    { class: "hstack between paste-out-head" },
    h(
      "h2",
      { id: "paste-out-h", class: "paste-out-title", tabindex: "-1" },
      Icon("pen", { size: 14 }),
      "Claude’s words — not for an affidavit as written",
    ),
    h("span", { class: "muted small" }, "With real names"),
  );
}
