// Settings (W2-8): wb/Settings.dc.html. The Claude plan (with the commercial three-condition
// panel), Claude Code in the case folder, the PD-AI 5.4 confirmations, finding names, extra
// checks, lock and shortcuts, this case, backup and recovery, and the passphrase.
import { h } from "../dom.js";
import { api, ApiError, errorText } from "../lib.js";
import { buildNote, updateCheckNote } from "../model.js";
import {
  announce,
  Callout,
  confirmDialog,
  ExternalLink,
  Icon,
  PassField,
  RecoveryKeyPanel,
  showToast,
  StatusRow,
  SwitchRow,
  TypedConfirm,
} from "../components/index.js";
import { MIN_PASSPHRASE } from "./unlock.js";
import { CommercialPanel, PLAN_LABELS, recordPlan, whenDay } from "./_plan.js";

/** "09:00" */
function clock(iso) {
  return new Date(iso).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ── local helpers ────────────────────────────────────────────────────────────

/**
 * A small marker that isn't a §3 state ("● Changed", "● No backup yet"): status text with a
 * glyph in neutral ink, not a Badge (spec §5, QA Pa1).
 */
function Flag(text, tone = "attention") {
  const glyph = tone === "danger" ? "triangle" : tone === "attention" ? "dot" : null;
  return h("span", { class: "status-text" }, glyph ? Icon(glyph) : null, text);
}

/** Run an async handler from a button: disables it, shows errors as a toast. */
function act(fn) {
  return async (ev) => {
    const b = ev?.currentTarget;
    if (b?.getAttribute?.("aria-disabled") === "true") return;
    if (b) b.disabled = true;
    try {
      await fn(ev);
    } catch (e) {
      showToast(errorText(e), { tone: "danger" });
      console.error(e);
    } finally {
      if (b) b.disabled = false;
    }
  };
}

// ── sections ─────────────────────────────────────────────────────────────────

const SECTIONS = [
  ["claude", "Claude plan"],
  ["code", "Claude Code in this folder"],
  ["confirm", "Claude settings to confirm"],
  ["detect", "Finding names"],
  ["extra", "Extra checks"],
  ["lock", "Lock and shortcuts"],
  ["case", "This case"],
  ["backup", "Backup and recovery"],
  ["pass", "Passphrase"],
  ["updates", "casefile updates"],
];

function section(id, title, ...children) {
  return h(
    "section",
    { id: `set-${id}`, class: "set-section", "aria-labelledby": `set-${id}-h` },
    h("h2", { id: `set-${id}-h`, tabindex: "-1" }, title),
    ...children,
  );
}

/** Replace a section's body (everything after its heading). */
function fill(sec, ...children) {
  const head = sec.firstElementChild;
  sec.replaceChildren(head, ...children.flat(Infinity).filter((c) => c != null && c !== false));
}

/** @param {HTMLElement} main @param {Record<string, string>} _params @param {any} ctx */
export default async function view(main, _params, ctx) {
  const [st, plan, cc, people, judge] = await Promise.all([
    api("GET", "/api/settings"),
    api("GET", "/api/plan"),
    api("GET", "/api/claude-code"),
    api("GET", "/api/people?group=people").catch(() => null),
    api("GET", "/api/judge").catch(() => null),
  ]);
  const S = { st, plan, cc, people: people?.entities ?? [], llmCheck: null, judge };

  const secs = Object.fromEntries(SECTIONS.map(([id]) => [id, null]));
  const titles = {
    claude: "Which Claude plan do you use?",
    code: "Claude Code in this folder",
    confirm: "Claude settings to confirm (PD-AI 5.4)",
    detect: "Finding names",
    extra: "Extra checks",
    lock: "Lock and shortcuts",
    case: "This case",
    backup: "Backup and recovery",
    pass: "Passphrase",
    updates: "casefile updates",
  };
  for (const [id] of SECTIONS) secs[id] = section(id, titles[id]);

  const goTo = (id, focus = true) => {
    const sec = secs[id];
    if (!sec) return;
    sec.scrollIntoView({ block: "start" });
    if (focus) sec.querySelector("h2")?.focus();
  };

  const nav = h(
    "nav",
    { class: "set-nav", "aria-label": "Settings sections" },
    h(
      "ul",
      {},
      SECTIONS.map(([id, label]) =>
        h(
          "li",
          {},
          h("a", {
            class: "set-nav-link",
            href: `#/settings?s=${id}`,
            onclick: (e) => {
              e.preventDefault();
              history.replaceState(null, "", `#/settings?s=${id}`);
              goTo(id);
            },
          }, label),
        )
      ),
    ),
    h(
      "p",
      { class: "set-nav-foot" },
      h("a", { href: "#/start" }, "Getting started checklist"),
    ),
  );

  // ── Claude plan ─────────────────────────────────────────────────────────
  let commercialOpen = false;
  const renderPlan = () => {
    const recorded = S.st.plan;
    const current = recorded ? S.plan.setup : null;
    const shown = commercialOpen ? "commercial" : current;
    const radio = (value, title, body) => {
      const input = h("input", {
        type: "radio",
        name: "set-plan",
        value,
        id: `set-plan-${value}`,
        checked: shown === value,
        "aria-describedby": `set-plan-${value}-d`,
        onchange: () => onPick(value),
      });
      return h(
        "label",
        { class: `set-card${shown === value ? " is-on" : ""}`, for: input.id },
        input,
        h(
          "span",
          { class: "vstack gap-sm" },
          h("span", { class: "strong" }, title),
          h("span", { class: "muted", id: `set-plan-${value}-d` }, body),
        ),
      );
    };
    fill(
      secs.claude,
      h(
        "p",
        { class: "set-lede" },
        "The Court’s rules on AI (PD-AI 5.5) say material from a subpoena or the court, from the other side, or under an order or undertaking must not go into an AI tool unless three conditions are met. casefile can’t see your Claude account, so it records what you tell it here.",
      ),
      h(
        "fieldset",
        { class: "set-cards" },
        h("legend", { class: "sr" }, "Claude plan"),
        radio(
          "consumer",
          PLAN_LABELS.consumer,
          "Restricted documents stay withheld from Claude. Your own documents are shared with names replaced, once you share them.",
        ),
        radio(
          "commercial",
          PLAN_LABELS.commercial,
          "You’ll be asked to confirm the three PD-AI 5.5 conditions before any restricted document can be shared.",
        ),
      ),
      recorded
        ? h(
          "p",
          { class: "muted" },
          `Recorded: ${
            recorded.setup === "commercial" ? "commercial plan" : "consumer plan"
          }, set by you on ${whenDay(recorded.at, false)}.`,
        )
        : h("p", { class: "muted" }, "Not recorded yet. Choose the plan you use."),
      recorded && S.plan.attested === false
        ? Callout({
          tone: "danger",
          title: "casefile can’t confirm this record",
          children:
            "The recorded plan doesn’t match casefile’s signed record, so casefile treats it as a consumer plan. Choose your plan again.",
        })
        : null,
      commercialOpen
        ? CommercialPanel({
          plan: S.plan,
          onConfirm: async (conditions) => {
            S.plan = await recordPlan("commercial", conditions);
            S.st = await api("GET", "/api/settings");
            commercialOpen = false;
            renderPlan();
            secs.claude.querySelector("#set-plan-commercial")?.focus();
          },
          onCancel: () => {
            commercialOpen = false;
            renderPlan();
            announce(
              recorded ? `Kept the ${recorded.setup} plan setting.` : "No plan recorded yet.",
            );
            secs.claude.querySelector(`#set-plan-${current ?? "commercial"}`)?.focus();
          },
        })
        : null,
    );
  };
  const onPick = async (value) => {
    if (value === "commercial") {
      if (S.plan.setup === "commercial" && S.st.plan) return;
      commercialOpen = true;
      renderPlan();
      secs.claude.querySelector(".set-commercial input")?.focus();
      return;
    }
    commercialOpen = false;
    if (S.st.plan && S.plan.setup === "consumer") return renderPlan();
    if (S.plan.setup === "commercial") {
      const ok = await confirmDialog(
        "Switch to a consumer plan?",
        "Documents from the other side, or from a subpoena or the court, that you shared will be withdrawn from Claude. Your own documents stay shared.",
        "Switch to consumer",
      );
      if (!ok) {
        renderPlan();
        return secs.claude.querySelector("#set-plan-commercial")?.focus();
      }
    }
    try {
      S.plan = await recordPlan("consumer");
      S.st = await api("GET", "/api/settings");
    } catch (e) {
      showToast(errorText(e), { tone: "danger" });
    }
    renderPlan();
    secs.claude.querySelector("#set-plan-consumer")?.focus();
  };

  // ── Claude Code ─────────────────────────────────────────────────────────
  let ccNote = null; // a message under the buttons (open-terminal fallback)
  const renderCode = () => {
    const c = S.cc;
    const filesOk = c.settingsFile === "ok" && c.guideFile === "ok" &&
      !c.localOverrides.length && !c.links.length;
    const fileProblems = [
      c.settingsFile !== "ok"
        ? `.claude/settings.json ${
          c.settingsFile === "missing" ? "is missing" : "has been changed"
        }`
        : null,
      c.guideFile !== "ok"
        ? `CLAUDE.md, casefile’s guide for Claude, ${
          c.guideFile === "missing" ? "is missing" : "has been changed"
        }`
        : null,
      ...c.localOverrides.map((o) => `In .claude/settings.local.json: ${o}`),
      ...c.links.map((l) => `${l} is a link to somewhere else`),
    ].filter(Boolean);
    const checked = `casefile checked ${whenDay(c.checkedAt)}, ${clock(c.checkedAt)}`;
    fill(
      secs.code,
      h(
        "p",
        { class: "set-lede" },
        "casefile writes settings for Claude Code into the case folder and checks them each time you open the case. These are the only things it can check.",
      ),
      c.state === "changed"
        ? h(
          "div",
          { class: "set-changed", role: "group", "aria-labelledby": "set-changed-h" },
          h(
            "p",
            { id: "set-changed-h", class: "hstack" },
            Flag("Changed"),
            h(
              "span",
              {},
              "casefile’s settings for Claude Code in this folder aren’t as it made them.",
            ),
          ),
          h(
            "p",
            {},
            "Putting them back rewrites them as casefile made them",
            c.localOverrides.length ? " and moves .claude/settings.local.json aside" : "",
            ". It is recorded in the Log.",
          ),
          h(
            "div",
            {},
            h("button", {
              type: "button",
              class: "btn btn-primary btn-lg",
              onclick: act(async () => {
                const r = await api("POST", "/api/claude-code/restore");
                S.cc = r.status;
                const what = [
                  ...(r.rewritten ?? []),
                  // movedAside is relative to the case folder (".claude/settings.local.json.disabled-…").
                  ...(r.movedAside
                    ? [
                      `moved .claude/settings.local.json aside (now ${r.movedAside}, in the case folder)`,
                    ]
                    : []),
                ];
                const msg = `Settings put back${
                  what.length ? `: ${what.join(", ")}` : ""
                }. Recorded in the Log.`;
                showToast(msg, { glyph: "check" });
                announce(msg);
                renderCode();
                renderConfirm();
                secs.code.querySelector("h2")?.focus();
              }),
            }, "Put the settings back"),
          ),
        )
        : null,
      h(
        "ul",
        { class: "set-box" },
        StatusRow({
          level: filesOk ? "ok" : "attention",
          title: filesOk
            ? "Case folder settings for Claude Code: present and unchanged"
            : "Case folder settings for Claude Code: changed",
          sub: filesOk
            ? null
            : h("ul", { class: "set-sublist" }, fileProblems.map((p) => h("li", {}, p))),
          meta: checked,
        }),
        StatusRow({
          level: c.webBlocked ? "ok" : "attention",
          title: [
            c.webBlocked
              ? "Web search and web fetch blocked for this folder "
              : "Web search and web fetch may not be blocked for this folder ",
            h("span", { class: "muted" }, "(PD-AI 5.4)"),
          ],
          meta: "casefile checked",
        }),
        StatusRow({
          level: c.sandbox ? "ok" : "attention",
          title: c.sandbox
            ? "Claude Code is asked to keep its commands inside the case folder"
            : "Claude Code may not be asked to keep its commands inside the case folder",
          sub: "Claude Code enforces this, not casefile.",
          meta: "casefile checked",
        }),
        StatusRow({
          level: c.claude.found ? "ok" : "attention",
          title: c.claude.found
            ? "Claude Code is installed"
            : "casefile didn’t find Claude Code on this computer",
          sub: c.claude.found ? null : h(
            "span",
            {},
            "See ",
            h("a", { href: "#/start" }, "Getting started"),
            " for how to install it.",
          ),
          meta: "casefile checked",
        }),
        StatusRow({
          level: c.casefile.found ? "ok" : "attention",
          title: c.casefile.found
            ? "The casefile command is installed"
            : "casefile didn’t find the casefile command on this computer",
          sub: c.casefile.found ? null : "Claude Code needs it to read the documents you share.",
          meta: "casefile checked",
        }),
      ),
      h(
        "p",
        {},
        "If any of these change, this shows ",
        Flag("Changed"),
        " and offers to put the settings back. casefile can’t see what Claude Code does outside the casefile command.",
      ),
      h(
        "div",
        { class: "hstack set-actions" },
        c.canOpenTerminal
          ? h("button", {
            type: "button",
            class: "btn btn-lg",
            onclick: act(async () => {
              const r = await api("POST", "/api/claude-code/open-terminal");
              ccNote = r.opened
                ? "Terminal opened in your case folder. Type claude and press Return."
                : `casefile couldn’t open Terminal. Open it yourself and type: ${r.command}`;
              announce(ccNote);
              renderCode();
            }),
          }, "Open Terminal in the case folder")
          : null,
        h("button", {
          type: "button",
          class: "btn btn-lg",
          onclick: act(async () => {
            S.cc = await api("GET", "/api/claude-code");
            ccNote = `Checked again at ${clock(S.cc.checkedAt)}.`;
            announce(ccNote);
            renderCode();
            renderConfirm();
          }),
        }, "Check again"),
      ),
      ccNote ? h("p", { class: "muted", role: "status" }, ccNote) : null,
      h(
        "details",
        { class: "set-details" },
        h("summary", {}, "Details"),
        h(
          "div",
          { class: "vstack gap-sm" },
          h("span", { class: "muted" }, "To start Claude Code yourself, type this in Terminal:"),
          h("pre", { class: "set-pre mono" }, c.command),
          h(
            "span",
            { class: "muted" },
            "Settings file: .claude/settings.json (web search and web fetch denied; commands kept inside the case folder). Case folder: ",
            h("span", { class: "mono" }, c.caseDir),
          ),
        ),
      ),
    );
  };

  // ── PD-AI 5.4 confirmations ─────────────────────────────────────────────
  const renderConfirm = () => {
    const conf = S.st.confirmations ?? {};
    const item = (key, title, sub) => {
      const id = `set-c-${key}`;
      const box = h("input", {
        type: "checkbox",
        id,
        checked: Boolean(conf[key]),
        "aria-describedby": `${id}-d`,
      });
      box.addEventListener("change", async () => {
        box.disabled = true;
        try {
          const r = await api("POST", "/api/settings/confirmations", { [key]: box.checked });
          S.st.confirmations = r;
          const withdrawn = !box.checked;
          renderConfirm();
          const again = () => secs.confirm.querySelector(`#${id}`);
          again()?.focus();
          if (withdrawn) {
            // One keypress changes the compliance record, so offer Undo (QA Se2). Undoing
            // confirms it again, which the Log also records.
            showToast(`Confirmation withdrawn: ${title}. Recorded in the Log.`, {
              returnFocus: again(),
              undo: async () => {
                S.st.confirmations = await api("POST", "/api/settings/confirmations", {
                  [key]: true,
                });
                renderConfirm();
                again()?.focus();
                announce(`Confirmed again: ${title}. Recorded in the Log.`);
              },
            });
          } else announce(`Confirmed today: ${title}. Recorded in the Log.`);
        } catch (e) {
          box.checked = !box.checked;
          box.disabled = false;
          showToast(errorText(e), { tone: "danger" });
        }
      });
      return h(
        "li",
        { class: "status-row" },
        h("span", { class: "status-row-lead" }, box),
        h(
          "label",
          { class: "status-row-text", for: id },
          h("span", { class: "status-row-title" }, title),
          h("span", { class: "status-row-sub muted", id: `${id}-d` }, sub),
        ),
        h(
          "span",
          { class: "status-row-meta muted" },
          conf[key] ? `Confirmed by you, ${whenDay(conf[key])}` : "Not confirmed",
        ),
      );
    };
    const confirmed = ["helpImproveOff", "chatHistory"].filter((k) => conf[k]);
    fill(
      secs.confirm,
      h(
        "p",
        { class: "set-lede" },
        "PD-AI 5.4 asks you to turn off chat history and web search where you can. casefile can’t see your Claude account, so you confirm these yourself. Each confirmation is recorded with the date.",
      ),
      h(
        "ul",
        { class: "set-box" },
        item("helpImproveOff", "“Help improve Claude” is off", "In Claude’s privacy settings."),
        item(
          "chatHistory",
          "Chat history and memory are set the way you want for this case",
          "In Claude’s settings. Turning memory and chat history off is safest.",
        ),
        StatusRow({
          level: S.cc.webBlocked ? "ok" : "attention",
          title: S.cc.webBlocked
            ? "Web search blocked for the case folder"
            : "Web search may not be blocked for the case folder",
          sub: S.cc.webBlocked
            ? "Automatic — casefile sets and checks this."
            : "See Claude Code in this folder, above, to put the settings back.",
          meta: `casefile checked ${whenDay(S.cc.checkedAt)}`,
        }),
      ),
      h(
        "div",
        { class: "hstack set-actions" },
        h("button", {
          type: "button",
          class: "btn btn-lg",
          "aria-disabled": confirmed.length ? null : "true",
          "aria-describedby": "set-confirm-again-d",
          onclick: act(async () => {
            if (!confirmed.length) return;
            const r = await api(
              "POST",
              "/api/settings/confirmations",
              Object.fromEntries(confirmed.map((k) => [k, true])),
            );
            S.st.confirmations = r;
            const msg = "Confirmed again today. Recorded in the Log.";
            announce(msg);
            showToast(msg, { glyph: "check" });
            renderConfirm();
            secs.confirm.querySelector(".set-actions button")?.focus();
          }),
        }, "Confirm again today"),
        h(
          "span",
          { id: "set-confirm-again-d", class: "muted" },
          confirmed.length
            ? "Confirms the ticked items again, with today’s date."
            : "Tick an item first.",
        ),
      ),
    );
  };

  // ── Finding names ───────────────────────────────────────────────────────
  const checkLlm = async () => {
    S.llmCheck = S.st.llm ? await api("POST", "/api/settings/check-llm").catch(() => null) : null;
  };
  const saveLlm = async (patch) => {
    const cur = S.st.llm ?? {};
    await api("PUT", "/api/settings", {
      llm: {
        baseUrl: cur.baseUrl,
        model: cur.model,
        apiKey: cur.apiKey ?? "",
        allowRemote: cur.allowRemote === true,
        trustLocalServer: cur.trustLocalServer === true,
        ...patch,
      },
    });
    S.st = await api("GET", "/api/settings");
    await checkLlm();
  };
  let llmOpen = false;
  const renderDetect = () => {
    const st = S.st;
    const llm = st.llm;
    const chk = S.llmCheck;
    const nerStatus = !st.nerEnabled
      ? "Off. Look for names yourself when you review each document."
      : st.nameDetection
      ? "Working."
      : "On, but not working yet. It may still be getting ready, or it couldn’t start. Until it works, look for names yourself when you review.";
    const url = h("input", {
      id: "set-llm-url",
      class: "mono",
      value: llm?.baseUrl ?? "",
      placeholder: "http://127.0.0.1:11434/v1",
      autocomplete: "off",
      spellcheck: "false",
    });
    const model = h("input", {
      id: "set-llm-model",
      class: "mono",
      value: llm?.model ?? "",
      autocomplete: "off",
      spellcheck: "false",
    });
    const key = h("input", {
      id: "set-llm-key",
      type: "password",
      value: llm?.apiKey ?? "",
      autocomplete: "off",
    });
    const details = h(
      "details",
      { class: "set-details", open: llmOpen || undefined },
      h("summary", {}, "Details"),
      h(
        "div",
        { class: "vstack" },
        h(
          "p",
          { class: "muted" },
          "Name finder: a model on this computer, checked against its recorded fingerprint when casefile starts.",
        ),
        h(
          "form",
          {
            class: "vstack",
            "aria-label": "Language model on this computer",
            onsubmit: act(async (ev) => {
              ev.preventDefault();
              if (!url.value.trim() || !model.value.trim()) {
                announce("Type the server address and the model name.");
                (url.value.trim() ? model : url).focus();
                return;
              }
              await saveLlm({
                baseUrl: url.value.trim(),
                model: model.value.trim(),
                apiKey: key.value,
              });
              llmOpen = true;
              const msg = S.llmCheck?.permitted
                ? "Saved. casefile will use this language model for new documents."
                : "Saved, but casefile won’t use this language model. See why below.";
              announce(msg);
              showToast(msg, { glyph: S.llmCheck?.permitted ? "check" : "dot" });
              renderDetect();
            }),
          },
          h(
            "div",
            { class: "set-grid2" },
            h(
              "div",
              { class: "set-field" },
              h("label", { for: url.id }, "Language model server address"),
              url,
            ),
            h("div", { class: "set-field" }, h("label", { for: model.id }, "Model name"), model),
            h(
              "div",
              { class: "set-field" },
              h("label", { for: key.id }, "Key (only if the server needs one)"),
              key,
            ),
          ),
          h(
            "div",
            { class: "hstack set-actions" },
            h("button", { type: "submit", class: "btn btn-lg" }, "Save"),
            llm
              ? h("button", {
                type: "button",
                class: "btn btn-lg",
                onclick: act(async () => {
                  await checkLlm();
                  llmOpen = true;
                  renderDetect();
                  announce(llmWords(S.llmCheck).title);
                }),
              }, "Check where text goes")
              : null,
          ),
        ),
        h(
          "div",
          { class: "vstack set-riskybox" },
          h("h3", {}, "Riskier options"),
          h(
            "p",
            {},
            "These can send original documents, with real names, off this computer. Most people should leave them off. To turn one on, type the words shown.",
          ),
          !llm ? h("p", { class: "muted" }, "Set up a language model above first.") : null,
          riskyOption({
            id: "set-r-local",
            on: llm?.trustLocalServer === true,
            label:
              "Treat this server as running on this computer, even though casefile can’t confirm it.",
            phrase: "I checked this server",
            field: "trustLocalServer",
          }),
          riskyOption({
            id: "set-r-remote",
            on: llm?.allowRemote === true,
            label: "Allow original documents to go to a model on another computer.",
            phrase: "send originals",
            field: "allowRemote",
          }),
          h("p", { class: "muted" }, "Either one is recorded in the AI-use log."),
        ),
      ),
    );
    details.addEventListener("toggle", () => (llmOpen = details.open));
    const words = llmWords(chk);
    fill(
      secs.detect,
      h(
        "p",
        { class: "set-lede" },
        "Before you share a document, casefile looks for names and identifying details so you can review them. All of this runs on this computer.",
      ),
      h(
        "div",
        { class: "set-box" },
        StatusRow({
          tag: "div",
          level: "ok",
          title: "Australian identifiers",
          sub:
            "Medicare, TFN and ABN numbers, phone numbers, emails, addresses, dates of birth, court file numbers",
          meta: "Always on",
        }),
        SwitchRow({
          id: "set-ner",
          checked: st.nerEnabled,
          title: "Name finder",
          sub: `Finds people, places, schools and organisations. ${nerStatus}`,
          onChange: async (on) => {
            await api("PUT", "/api/settings", { nerEnabled: on });
            S.st = await api("GET", "/api/settings");
            announce(
              on
                ? "Name finder turned on. Recorded in the Log."
                : "Name finder turned off. Recorded in the Log.",
            );
            renderDetect();
            secs.detect.querySelector("#set-ner")?.focus();
          },
        }),
        SwitchRow({
          id: "set-llm",
          checked: Boolean(llm),
          title: "Extra name checks with a language model on this computer",
          sub:
            "Catches nicknames, family words (“his nan”) and details that point to someone without naming them.",
          onChange: async (on) => {
            if (on) {
              llmOpen = true;
              renderDetect();
              secs.detect.querySelector("#set-llm-url")?.focus();
              announce("Type the language model’s address and name under Details, then Save.");
              return;
            }
            await api("PUT", "/api/settings", { llm: null });
            S.st = await api("GET", "/api/settings");
            S.llmCheck = null;
            announce("Language model turned off. Recorded in the Log.");
            renderDetect();
            secs.detect.querySelector("#set-llm")?.focus();
          },
        }),
      ),
      llm
        ? h(
          "div",
          { class: "set-llm-status", role: "status" },
          words.ok ? Flag("Used", "neutral") : Flag("Not used"),
          h(
            "span",
            {},
            h("span", {}, words.title),
            words.body ? [" ", words.body] : null,
          ),
        )
        : null,
      details,
    );
  };
  /** Plain words for the language model check: the server's `summary` and `detail`. */
  const llmWords = (chk) => {
    if (!chk?.summary) {
      return {
        ok: false,
        title: "casefile couldn’t check where this language model runs, so it isn’t using it.",
        body:
          "Until it can, nicknames and family words may be missed, so look for them yourself when you review.",
      };
    }
    return { ok: chk.used === true, title: chk.summary, body: chk.detail ?? "" };
  };
  const riskyOption = ({ id, on, label, phrase, field }) => {
    if (on) {
      return h(
        "div",
        { class: "set-risky" },
        h("p", {}, Flag("On"), " ", label),
        h(
          "div",
          {},
          h("button", {
            type: "button",
            class: "btn btn-lg",
            onclick: act(async () => {
              await saveLlm({ [field]: false });
              llmOpen = true;
              announce("Turned off. Recorded in the Log.");
              renderDetect();
              secs.detect.querySelector(`#${id}`)?.focus();
            }),
            "aria-label": `Turn off: ${label}`,
          }, "Turn off"),
        ),
      );
    }
    return TypedConfirm({
      id,
      label,
      phrase,
      disabled: !S.st.llm,
      onConfirm: async () => {
        await saveLlm({ [field]: true });
        llmOpen = true;
        announce("Turned on. Recorded in the AI-use log.");
        renderDetect();
        secs.detect.querySelector(`#${id}`)?.closest(".set-risky")?.querySelector("button")
          ?.focus();
      },
    });
  };

  // ── Extra checks (ADR 14) ───────────────────────────────────────────────
  const saveJudge = async (patch) => {
    S.judge = await api("PUT", "/api/judge", patch);
  };
  const renderExtra = () => {
    const J = S.judge;
    if (!J) {
      fill(secs.extra, h("p", {}, "casefile couldn’t load the extra checks. Reload to try again."));
      return;
    }
    const tuned = (b) =>
      J[b]?.calibrated === false
        ? " Not tuned on casefile’s test sentences yet, so it may point out too much or too little."
        : "";
    const choices = [
      ["off", "Off: only the built-in checks", "Nothing else looks at Claude’s work.", false],
      ["local", "On this computer", J.local.summary + tuned("local"), false],
      [
        "llm",
        "The language model on this computer",
        J.llm.summary + tuned("llm"),
        !J.llm.setUp,
      ],
      [
        "jev",
        "Jev by TypeSafe",
        `${J.jev.summary}${tuned("jev")}`,
        J.backend !== "jev",
      ],
    ];
    const radios = choices.map(([value, title, sub, disabled]) => {
      const id = `set-judge-${value}`;
      const input = h("input", {
        type: "radio",
        name: "set-judge",
        id,
        value,
        checked: J.backend === value,
        disabled,
        "aria-describedby": `${id}-d`,
      });
      input.addEventListener(
        "change",
        act(async () => {
          await saveJudge({ backend: value });
          announce(`Extra checks: ${title}. Recorded in the Log.`);
          renderExtra();
          secs.extra.querySelector(`#${id}`)?.focus();
        }),
      );
      return h(
        "div",
        { class: "status-row" },
        h("span", { class: "status-row-lead" }, input),
        h(
          "span",
          { class: "status-row-text" },
          h("label", { for: id, class: "status-row-title" }, title),
          h("span", { id: `${id}-d`, class: "status-row-sub muted" }, sub),
        ),
        h("span"),
      );
    });
    const result = h("p", { class: "muted", role: "status" });
    const key = h("input", {
      id: "set-jev-key",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: J.jev.hasKey ? "Saved (type a new one to replace it)" : "",
    });
    const jevOn = J.backend === "jev";
    fill(
      secs.extra,
      h(
        "p",
        { class: "set-lede" },
        "casefile checks Claude’s work for you — for example, whether the names, dates and numbers in a chronology entry appear in the lines it cites. An extra check can also point out a sentence that gives feelings or opinions, a note that may not match its cited lines, or a shared document that may not be yours. It only points things out: it never marks anything as checked, and it can be wrong both ways.",
      ),
      h(
        "div",
        { class: "set-box" },
        StatusRow({
          tag: "div",
          level: "ok",
          title: "Built in: names, dates and numbers, on this computer",
          sub: "Matches them word for word against the cited lines. Nothing leaves this computer.",
          meta: "Always on",
        }),
      ),
      h(
        "fieldset",
        { class: "set-box" },
        h("legend", {}, "Where extra checks run"),
        radios,
      ),
      h(
        "div",
        { class: "hstack set-actions" },
        h("button", {
          type: "button",
          class: "btn btn-lg",
          disabled: J.backend === "off" || undefined,
          onclick: act(async () => {
            result.textContent = "Testing…";
            try {
              const r = await api("POST", "/api/judge/test");
              result.textContent = r.message;
            } catch (e) {
              result.textContent = errorText(e);
            }
          }),
        }, "Test the connection"),
        h(
          "span",
          { class: "muted" },
          "Asks about an invented sentence. Nothing from your case is sent.",
        ),
      ),
      result,
      h(
        "div",
        { class: "vstack set-riskybox" },
        h("h3", {}, "Jev by TypeSafe"),
        h(
          "p",
          {},
          "Jev is an AI run by TypeSafe AI on its own computers in the United States. If you turn it on, casefile sends it only text with names replaced, from documents shared with Claude: never your original documents and never anything kept from Claude. TypeSafe says it does not train on what it is sent. It does not say how long it keeps it.",
        ),
        h(
          "p",
          {},
          `casefile last checked TypeSafe’s terms on ${
            whenDay(J.jev.termsChecked, false)
          }. Read them before you turn Jev on: `,
          ExternalLink("typesafe_privacy"),
          " and ",
          ExternalLink("typesafe_legal"),
          ".",
        ),
        h(
          "p",
          {},
          "Turning Jev on or off is recorded in the Log, and “If the Court asks” lists Jev as a second AI tool.",
        ),
        h(
          "form",
          {
            class: "vstack",
            "aria-label": "Jev key",
            onsubmit: act(async (ev) => {
              ev.preventDefault();
              if (!key.value.trim()) {
                announce("Type your Jev key first.");
                key.focus();
                return;
              }
              await saveJudge({ jevKey: key.value.trim() });
              key.value = "";
              announce("Jev key saved. It stays in this case’s locked folder.");
              renderExtra();
              secs.extra.querySelector("#set-jev-key")?.focus();
            }),
          },
          h(
            "div",
            { class: "set-field" },
            h("label", { for: key.id }, J.jev.hasKey ? "Jev key (saved)" : "Jev key"),
            key,
          ),
          h(
            "div",
            { class: "hstack set-actions" },
            h("button", { type: "submit", class: "btn btn-lg" }, "Save key"),
            J.jev.hasKey
              ? h("button", {
                type: "button",
                class: "btn btn-lg",
                onclick: act(async () => {
                  await saveJudge({ jevKey: null });
                  announce("Jev key removed. Jev is off. Recorded in the Log.");
                  renderExtra();
                  secs.extra.querySelector("#set-jev-key")?.focus();
                }),
              }, "Remove key")
              : null,
          ),
        ),
        jevOn
          ? h(
            "div",
            { class: "set-risky" },
            h("p", {}, Flag("On"), ` Jev is on, since ${whenDay(J.jev.onSince, false)}.`),
            h(
              "div",
              {},
              h("button", {
                type: "button",
                class: "btn btn-lg",
                "aria-label": "Turn off Jev",
                onclick: act(async () => {
                  await saveJudge({ backend: "local" });
                  announce(
                    "Jev turned off. Extra checks run on this computer. Recorded in the Log.",
                  );
                  renderExtra();
                  secs.extra.querySelector("#set-judge-local")?.focus();
                }),
              }, "Turn off"),
            ),
          )
          : TypedConfirm({
            id: "set-jev-on",
            label: "Send text with names replaced to Jev for extra checks.",
            phrase: J.confirmPhrase,
            disabled: !J.jev.hasKey,
            onConfirm: async () => {
              await saveJudge({ backend: "jev", confirm: J.confirmPhrase });
              announce("Jev turned on. Recorded in the AI-use log.");
              renderExtra();
              secs.extra.querySelector("#set-judge-jev")?.focus();
            },
          }),
        !J.jev.hasKey && !jevOn ? h("p", { class: "muted" }, "Save your key first.") : null,
      ),
    );
  };

  // ── Lock and shortcuts ──────────────────────────────────────────────────
  const renderLock = () => {
    const sel = h(
      "select",
      { id: "set-idle" },
      [[15, "15 minutes idle"], [30, "30 minutes idle"], [60, "1 hour idle"]].map(([v, t]) =>
        h("option", { value: String(v), selected: S.st.idleLockMinutes === v }, t)
      ),
    );
    sel.addEventListener("change", async () => {
      const v = Number(sel.value);
      try {
        await api("PUT", "/api/settings", { idleLockMinutes: v });
        S.st.idleLockMinutes = v;
        if (ctx.settings) ctx.settings.idleLockMinutes = v;
        ctx.setIdleMinutes?.(v);
        announce(`casefile now locks after ${v === 60 ? "1 hour" : `${v} minutes`} idle.`);
      } catch (e) {
        sel.value = String(S.st.idleLockMinutes);
        showToast(errorText(e), { tone: "danger" });
      }
    });
    fill(
      secs.lock,
      h(
        "div",
        { class: "set-box" },
        h(
          "div",
          { class: "status-row" },
          h("span", { class: "status-row-lead" }, Icon("lock")),
          h(
            "span",
            { class: "status-row-text" },
            h("label", { for: "set-idle", class: "status-row-title" }, "Lock after"),
            h("span", { class: "status-row-sub muted" }, "casefile also locks when you close it."),
          ),
          sel,
        ),
        SwitchRow({
          id: "set-keys",
          checked: S.st.shortcuts !== false,
          title: "Keyboard shortcuts",
          sub:
            "Single-key shortcuts work only when a list has focus. Turn them off if you use a screen reader or keep pressing them by accident.",
          onChange: async (on) => {
            await api("PUT", "/api/settings", { shortcuts: on });
            S.st.shortcuts = on;
            ctx.shortcuts = on;
            if (ctx.settings) ctx.settings.shortcuts = on;
            announce(on ? "Keyboard shortcuts on." : "Keyboard shortcuts off.");
          },
        }),
      ),
    );
  };

  // ── This case ───────────────────────────────────────────────────────────
  const renderCase = () => {
    const name = h("input", { id: "set-label", value: S.st.label ?? "", autocomplete: "off" });
    const role = h(
      "select",
      { id: "set-role", "aria-describedby": "set-role-d" },
      h("option", { value: "", selected: !S.st.userRole }, "Not set"),
      S.people
        .filter((p) => p.kind === "person")
        .map((p) =>
          h(
            "option",
            { value: p.role, selected: S.st.userRole === p.role },
            `${p.forms?.full ?? p.role} (${p.role.replaceAll("_", " ")})`,
          )
        ),
    );
    role.addEventListener("change", async () => {
      try {
        await api("PUT", "/api/settings", { userRole: role.value || null });
        S.st.userRole = role.value || null;
        announce(
          role.value ? "Saved who you are in this case." : "Cleared who you are in this case.",
        );
      } catch (e) {
        role.value = S.st.userRole ?? "";
        showToast(errorText(e), { tone: "danger" });
      }
    });
    fill(
      secs.case,
      h(
        "form",
        {
          class: "vstack",
          onsubmit: act(async (ev) => {
            ev.preventDefault();
            const v = name.value.trim();
            if (!v) {
              announce("Give the case a name.");
              return name.focus();
            }
            await api("PUT", "/api/settings", { label: v });
            S.st.label = v;
            ctx.setCaseName?.(v);
            announce("Case name saved.");
          }),
        },
        h(
          "div",
          { class: "set-field set-field--row" },
          h("label", { for: "set-label" }, "Name (only you see it)"),
          h(
            "div",
            { class: "hstack nowrap" },
            name,
            h("button", { type: "submit", class: "btn btn-lg" }, "Save"),
          ),
        ),
      ),
      h(
        "div",
        { class: "set-field set-field--row" },
        h("label", { for: "set-role" }, "You in this case"),
        role,
        h(
          "span",
          { id: "set-role-d", class: "muted" },
          "casefile uses this to tell you when Claude relies only on your own statement.",
        ),
      ),
      h("p", { class: "muted" }, "Case folder: ", h("span", { class: "mono" }, S.st.caseDir)),
    );
  };

  // ── Backup and recovery ─────────────────────────────────────────────────
  let keyMode = null; // null | "make" | "remove" | {key, replaced}
  const renderBackup = async () => {
    const info = S.st.recoveryKey ?? { set: false, createdAt: null };
    let panel = null;
    if (keyMode && typeof keyMode === "object") {
      panel = h(
        "div",
        { class: "set-keypanel" },
        RecoveryKeyPanel({
          key: keyMode.key,
          replaced: keyMode.replaced,
          headingLevel: "h3",
          doneLabel: "Done",
          onDone: async () => {
            keyMode = null;
            S.st = await api("GET", "/api/settings");
            renderBackup();
            announce("Recovery key stored.");
            secs.backup.querySelector("h2")?.focus();
          },
        }),
      );
    } else if (keyMode === "make" || keyMode === "remove") {
      const pf = PassField({ id: "set-rk-pass", autocomplete: "current-password" });
      const making = keyMode === "make";
      const err = h("div", { role: "status" });
      panel = h(
        "form",
        {
          class: "set-keypanel vstack",
          "aria-label": making ? "Make a recovery key" : "Remove the recovery key",
          onsubmit: act(async (ev) => {
            ev.preventDefault();
            if (!pf.input.value) {
              pf.input.focus();
              return announce("Type your passphrase.");
            }
            try {
              if (making) {
                const r = await api("POST", "/api/case/recovery-key", {
                  passphrase: pf.input.value,
                });
                keyMode = { key: r.recoveryKey, replaced: r.replaced };
              } else {
                await api("POST", "/api/case/recovery-key/remove", { passphrase: pf.input.value });
                keyMode = null;
                S.st = await api("GET", "/api/settings");
                showToast("Recovery key removed. Recorded in the Log.", { glyph: "check" });
              }
            } catch (e) {
              if (e instanceof ApiError && (e.status === 401 || e.status === 429)) {
                err.replaceChildren(
                  Callout({
                    tone: "attention",
                    title: e.status === 401
                      ? "That isn’t your current passphrase"
                      : "Too many tries — wait a little",
                    children: e.status === 429 ? errorText(e) : null,
                  }),
                );
                pf.input.select();
                return;
              }
              throw e;
            }
            renderBackup();
            const target = secs.backup.querySelector(".rk-title") ??
              secs.backup.querySelector("h2");
            target?.setAttribute("tabindex", "-1");
            target?.focus();
          }),
        },
        h(
          "p",
          {},
          making
            ? info.set
              ? "A new recovery key replaces the one you have now; the old one stops working. casefile shows the new key once."
              : "casefile shows the key once. Print it or write it down and keep it away from this computer."
            : "Without a recovery key, a forgotten passphrase means the originals can’t be opened.",
        ),
        h("label", { for: "set-rk-pass" }, "Your passphrase"),
        pf,
        err,
        h(
          "div",
          { class: "hstack set-actions" },
          h(
            "button",
            { type: "submit", class: "btn btn-primary btn-lg" },
            making ? "Make the recovery key" : "Remove the recovery key",
          ),
          h("button", {
            type: "button",
            class: "btn btn-lg",
            onclick: () => {
              keyMode = null;
              renderBackup();
              secs.backup.querySelector(".set-rk-btn")?.focus();
            },
          }, "Cancel"),
        ),
      );
    }
    fill(
      secs.backup,
      h(
        "p",
        { class: "set-lede" },
        "If this computer is lost or the case folder is damaged, a copy is the only way to get your work back. casefile doesn’t keep a copy anywhere else.",
      ),
      h(
        "div",
        { class: "set-box" },
        h(
          "div",
          { class: "status-row" },
          h("span", { class: "status-row-lead" }),
          h(
            "span",
            { class: "status-row-text" },
            h("span", { class: "status-row-title hstack" }, Flag("No backup yet")),
            h(
              "span",
              { class: "status-row-sub" },
              "casefile can’t make an encrypted backup yet. Until it can: while casefile is closed (or locked), copy the whole case folder to a USB drive only you use. Originals stay encrypted; the copies Claude reads have names replaced.",
            ),
            h(
              "span",
              { class: "status-row-sub muted" },
              "Case folder: ",
              h("span", { class: "mono" }, S.st.caseDir),
            ),
          ),
          h("span", { class: "status-row-meta muted" }, "Not available yet"),
        ),
        h(
          "div",
          { class: "status-row" },
          h(
            "span",
            { class: "status-row-lead" },
            info.set ? Icon("check") : Icon("dot"),
          ),
          h(
            "span",
            { class: "status-row-text" },
            h(
              "span",
              { class: "status-row-title" },
              info.set
                ? `Recovery key: set up${
                  info.createdAt ? ` on ${whenDay(info.createdAt, false)}` : ""
                }`
                : "Recovery key: not set up",
            ),
            h(
              "span",
              { class: "status-row-sub muted" },
              "If you forget your passphrase, the recovery key is the only way back in. casefile can’t reset it for you, and can’t show an existing key again.",
            ),
          ),
          h(
            "span",
            { class: "vstack gap-sm status-row-meta" },
            h("button", {
              type: "button",
              class: "btn set-rk-btn",
              "aria-expanded": String(keyMode === "make"),
              onclick: () => {
                keyMode = keyMode === "make" ? null : "make";
                renderBackup();
                secs.backup.querySelector("#set-rk-pass")?.focus();
              },
            }, info.set ? "Make a new recovery key…" : "Make a recovery key…"),
            info.set
              ? h("button", {
                type: "button",
                class: "btn",
                "aria-expanded": String(keyMode === "remove"),
                onclick: () => {
                  keyMode = keyMode === "remove" ? null : "remove";
                  renderBackup();
                  secs.backup.querySelector("#set-rk-pass")?.focus();
                },
              }, "Remove it…")
              : null,
          ),
        ),
      ),
      panel,
    );
  };

  // ── Passphrase ──────────────────────────────────────────────────────────
  const renderPass = () => {
    const cur = PassField({ id: "set-pc", autocomplete: "current-password" });
    const n2 = h("input", {
      id: "set-pn2",
      class: "pf-input",
      type: "password",
      autocomplete: "new-password",
    });
    const n1 = PassField({ id: "set-pn", autocomplete: "new-password", also: [n2] });
    const msg = h("div", { role: "status" });
    const bad = (title, body, el) => {
      msg.replaceChildren(Callout({ tone: "attention", title, children: body || null }));
      el?.focus();
    };
    fill(
      secs.pass,
      h(
        "form",
        {
          class: "vstack",
          novalidate: true,
          onsubmit: act(async (ev) => {
            ev.preventDefault();
            msg.replaceChildren();
            if (!cur.input.value) return bad("Type your current passphrase", "", cur.input);
            if (n1.input.value.length < MIN_PASSPHRASE) {
              return bad(
                "Choose a longer new passphrase",
                `Use at least ${MIN_PASSPHRASE} characters.`,
                n1.input,
              );
            }
            if (n1.input.value !== n2.value) {
              return bad("The new passphrases don’t match", "Type the same one twice.", n2);
            }
            try {
              await api("POST", "/api/case/passphrase", {
                current: cur.input.value,
                next: n1.input.value,
              });
            } catch (e) {
              if (e instanceof ApiError && e.status === 401) {
                return bad("That isn’t your current passphrase", "", cur.input);
              }
              throw e;
            }
            renderPass();
            const m = "Passphrase changed. Recorded in the Log.";
            showToast(m, { glyph: "check" });
            announce(m);
          }),
        },
        h(
          "div",
          { class: "set-grid2" },
          h(
            "div",
            { class: "set-field" },
            h("label", { for: "set-pc" }, "Current passphrase"),
            cur,
          ),
          h("div", { class: "set-field" }, h("label", { for: "set-pn" }, "New passphrase"), n1),
          h("div", { class: "set-field" }, h("label", { for: "set-pn2" }, "Type it again"), n2),
        ),
        h(
          "p",
          { class: "muted" },
          `At least ${MIN_PASSPHRASE} characters. casefile can’t reset it for you. Your recovery key keeps working.`,
        ),
        msg,
        h("div", {}, h("button", { type: "submit", class: "btn btn-lg" }, "Change passphrase")),
      ),
    );
  };

  // ── casefile updates (ADR 24) ───────────────────────────────────────────
  const when = (iso) => `${new Date(iso).toLocaleDateString("en-AU")} ${clock(iso)}`;
  const renderUpdates = (u) => {
    const restart = act(async () => {
      const ok = await confirmDialog(
        `Restart to update to casefile ${u.ready}?`,
        "casefile closes the case, saving everything, and opens the new version. You'll need " +
          "your passphrase to open the case again.",
        "Restart now",
      );
      if (!ok) return;
      await api("POST", "/api/update/restart");
      announce("Restarting casefile…");
    });
    const check = act(async () => {
      renderUpdates({ ...u, checking: true });
      try {
        const r = await api("POST", "/api/update/check");
        renderUpdates(r.update);
        announce(updateCheckNote(r.update, when));
      } catch (e) {
        renderUpdates(u);
        throw e;
      }
    });
    const note = updateCheckNote(u, when);
    fill(
      secs.updates,
      h("p", { class: "muted set-build" }, buildNote(ctx.status?.build)),
      note ? h("p", { id: "set-update-note", role: "status" }, note) : null,
      u?.enabled
        ? h(
          "div",
          { class: "hstack" },
          h("button", {
            type: "button",
            class: "btn",
            disabled: Boolean(u.checking),
            onclick: check,
          }, u.checking ? "Checking…" : "Check for updates"),
          u.ready
            ? h(
              "button",
              { type: "button", class: "btn btn-primary", onclick: restart },
              "Restart to update",
            )
            : null,
        )
        : null,
    );
  };

  await checkLlm();
  renderPlan();
  renderCode();
  renderConfirm();
  renderDetect();
  renderExtra();
  renderLock();
  renderCase();
  renderBackup();
  renderPass();
  renderUpdates(ctx.status?.update);

  main.replaceChildren(
    h(
      "div",
      { class: "set-layout" },
      nav,
      h(
        "div",
        { class: "set-main" },
        h("h1", {}, "Settings"),
        Object.values(secs),
      ),
    ),
  );
  const want = /[?&]s=(\w+)/.exec(location.hash)?.[1];
  if (want && secs[want]) requestAnimationFrame(() => goTo(want, false));
}
