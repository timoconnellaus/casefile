// Getting started (W2-8): wb/Start.dc.html. The six-step checklist from /api/start, the PD-AI 5.4
// confirmations, Claude Code (look again, Open Terminal here), "Ask Claude to…" requests, the
// glossary and the "not legal advice" panel.
import { h } from "../dom.js";
import { api } from "../lib.js";
import { ExternalLink, Icon, showToast, TokenChip } from "../components/index.js";
import { plural } from "../model.js";
import { CommercialPanel, PLAN_LABELS, recordPlan, whenDay } from "./_plan.js";

/** Requests the user can copy into Claude Code. Static copy (no case data). */
const TEMPLATES = [
  {
    id: "chron",
    title: "Build a chronology from the documents I’ve shared",
    text:
      "Please read the documents I’ve shared in casefile and build a chronology. For each event, give the date, what happened, and the document and line it comes from. Only use what the documents say — if something is unclear, add a note instead of guessing. Leave every entry for me to check.",
    sees: "The documents you’ve shared, with names replaced. Not the ones kept from Claude.",
    check: "Each entry against the lines it cites, in To check.",
  },
  {
    id: "change",
    title: "Find everything about changeovers and link it to an issue",
    text:
      "Find every mention of changeovers (when the children move between homes) in the documents I’ve shared. Link each one to my issue about changeovers, or suggest one if there isn’t one yet. Say whether each one helps my account, points the other way, or is background, and cite the document and line.",
    sees: "Your shared documents and your list of issues.",
    check: "Each evidence link and whether its label is fair.",
  },
  {
    id: "outline",
    title: "Draft an outline of my case (not an affidavit)",
    text:
      "Using only the documents I’ve shared and the chronology, draft an outline of my case as headings and short points. This is a plan for me to work from, not an affidavit: don’t write in my voice or about how I feel. Cite the document and line for each point and list anything you’re unsure of.",
    sees: "Your shared documents, the chronology and your issues.",
    check: "Each cited point. Anything you later put in an affidavit must be in your own words.",
  },
  {
    id: "missing",
    title: "List what’s missing — events mentioned but not documented",
    text:
      "Look through the documents I’ve shared and the chronology. List events that are mentioned but where I haven’t shared a document that shows them — for example a text that refers to an email. For each, say where it is mentioned (document and line). Don’t guess what the missing documents say.",
    sees: "Your shared documents and the chronology.",
    check: "Whether you have the document. If you do, import it and check the names first.",
  },
];

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** @param {HTMLElement} main @param {Record<string, string>} _params @param {any} _ctx */
export default async function view(main, _params, _ctx) {
  let [start, plan, settings] = await Promise.all([
    api("GET", "/api/start"),
    api("GET", "/api/plan"),
    api("GET", "/api/settings"),
  ]);
  let commercialOpen = false;
  let ccMsg = null;
  let termMsg = null;
  const live = h("div", { class: "sr", role: "status", "aria-live": "polite" });
  const say = (m) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = m), 30);
  };

  const reload = async () => {
    [start, plan, settings] = await Promise.all([
      api("GET", "/api/start"),
      api("GET", "/api/plan"),
      api("GET", "/api/settings"),
    ]);
  };

  const list = h("ol", { class: "start-steps" });
  const head = h("div", { class: "start-progress" });

  /** Re-render the steps, keeping focus on the element with `focusSel` if given. */
  const render = (focusSel) => {
    const byId = Object.fromEntries(start.steps.map((s) => [s.id, s]));
    head.replaceChildren(
      h("h2", { id: "h-steps" }, "Your checklist"),
      h("span", { class: "muted" }, `${start.done} of ${start.total} done`),
      h(
        "span",
        { class: "start-bar", "aria-hidden": "true" },
        start.steps.map((_, i) => h("span", { class: i < start.done ? "is-done" : "" })),
      ),
    );
    list.replaceChildren(
      ...start.steps.map((s, i) => {
        const body = STEP[s.id]?.(s, byId) ?? null;
        if (!body) return null;
        return h(
          "li",
          { class: `start-step${s.done ? " is-done" : ""}`, "aria-labelledby": `st-${s.id}-h` },
          h(
            "span",
            { class: "start-num", "aria-hidden": "true" },
            s.done ? Icon("check", { size: 14 }) : String(i + 1),
          ),
          h(
            "div",
            { class: "start-step-body" },
            h(
              "div",
              { class: "start-step-head" },
              h("h3", { id: `st-${s.id}-h` }, body.title),
              h(
                "span",
                { class: "start-state" },
                h("span", { class: "sr" }, `Step ${i + 1}: `),
                body.state,
              ),
            ),
            body.content,
          ),
        );
      }),
    );
    if (focusSel) list.querySelector(focusSel)?.focus();
  };

  const STEP = {
    plan: (s) => {
      const recorded = settings.plan;
      const current = recorded ? plan.setup : null;
      const shown = commercialOpen ? "commercial" : current;
      const conf = s.confirmations ?? {};
      const radio = (value) =>
        h(
          "label",
          { class: "start-check" },
          h("input", {
            type: "radio",
            name: "st-plan",
            id: `st-plan-${value}`,
            value,
            checked: shown === value,
            onchange: () => pickPlan(value),
          }),
          h(
            "span",
            {},
            value === "consumer"
              ? "Free, Pro or Max"
              : "Team, Enterprise or API (commercial terms)",
          ),
        );
      const tick = (key, content) => {
        const id = `st-c-${key}`;
        const box = h("input", { type: "checkbox", id, checked: Boolean(conf[key]) });
        box.addEventListener("change", async () => {
          box.disabled = true;
          try {
            await api("POST", "/api/settings/confirmations", { [key]: box.checked });
            await reload();
            say(
              box.checked
                ? "Confirmed and recorded in the Log."
                : "Confirmation withdrawn. Recorded in the Log.",
            );
            render(`#${id}`);
          } catch (e) {
            box.checked = !box.checked;
            box.disabled = false;
            showToast(e?.message ?? String(e), { tone: "danger" });
          }
        });
        return h("label", { class: "start-check", for: id }, box, h("span", {}, content));
      };
      const both = Boolean(conf.helpImproveOff) && Boolean(conf.chatHistory);
      let state;
      if (s.done) {
        const latest = [conf.helpImproveOff, conf.chatHistory].sort().at(-1);
        state = `Done · ${PLAN_LABELS[s.plan.setup]}, confirmed ${
          whenDay(latest, false)
        } · recorded in the Log`;
      } else if (!s.plan) state = "Choose your plan to start this step";
      else if (!both) state = "Tick both boxes to finish this step";
      else state = "Claude Code’s settings in your case folder need putting back";
      return {
        title: "Tell casefile which Claude plan you have",
        state,
        content: [
          h(
            "fieldset",
            { class: "start-plans" },
            h("legend", { class: "sr" }, "Which Claude plan do you have?"),
            radio("consumer"),
            radio("commercial"),
          ),
          commercialOpen
            ? CommercialPanel({
              plan,
              headingLevel: "h4",
              onConfirm: async (conditions) => {
                await recordPlan("commercial", conditions);
                commercialOpen = false;
                await reload();
                render("#st-plan-commercial");
              },
              onCancel: () => {
                commercialOpen = false;
                render(`#st-plan-${current ?? "commercial"}`);
                say(current ? "Kept your recorded plan." : "No plan recorded yet.");
              },
            })
            : null,
          h(
            "p",
            {},
            "On a Free, Pro or Max plan, casefile doesn’t share documents from a subpoena or the court, from the other side, or under an order with Claude, as the Court’s rules on AI require (PD-AI 5.5).",
          ),
          h(
            "div",
            { class: "vstack gap-sm" },
            tick(
              "helpImproveOff",
              [
                "I’ve turned off ",
                h("strong", {}, "“Help improve Claude”"),
                " (claude.ai › Settings › Privacy).",
              ],
            ),
            tick(
              "chatHistory",
              "I’ve checked chat history: if I use Claude in a browser or the app for this case, I use an incognito chat and don’t type real names.",
            ),
          ),
          h(
            "p",
            {},
            "The Court’s rules on AI ask you to turn off chat history and web search where you can (PD-AI 5.4). casefile can’t see your Claude account, so it records what you tick here in the Log.",
          ),
          h(
            "p",
            { class: "start-checked" },
            "casefile checked: ",
            s.webBlocked
              ? h(
                "span",
                { class: "start-ok" },
                Icon("check"),
                " Claude Code in your case folder is set not to search or fetch from the web.",
              )
              : h(
                "span",
                { class: "start-attn" },
                Icon("dot"),
                " Claude Code’s settings in your case folder have changed, so web search may not be blocked. ",
                h("a", { href: "#/settings?s=code" }, "Put the settings back in Settings"),
              ),
          ),
        ],
      };
    },
    claude_code: (s) => ({
      title: "Install Claude Code",
      state: s.done ? "Done · casefile found Claude Code" : "Not found on this computer yet",
      content: [
        h(
          "p",
          {},
          "Claude Code is the part of Claude that can work with the files in your case folder. It runs in Terminal, a window where you type short commands.",
        ),
        s.done ? null : h(
          "ol",
          { class: "start-how" },
          h(
            "li",
            {},
            "Open the ",
            ExternalLink("claude_code_setup"),
            " and copy the install line for a Mac.",
          ),
          h(
            "li",
            {},
            "Open Terminal (Applications › Utilities › Terminal), paste the line and press Return.",
          ),
          h(
            "li",
            {},
            "Type ",
            h("code", {}, "claude"),
            ", press Return, and sign in with your Claude account.",
          ),
        ),
        h(
          "div",
          { class: "hstack start-row" },
          h("button", {
            type: "button",
            class: "btn",
            id: "st-look",
            onclick: async (ev) => {
              const b = ev.currentTarget;
              b.disabled = true;
              try {
                const before = s.done;
                await api("GET", "/api/claude-code");
                await reload();
                const found = start.steps.find((x) => x.id === "claude_code")?.done;
                ccMsg = found
                  ? "Found Claude Code on this computer."
                  : before
                  ? "Claude Code is no longer where casefile found it."
                  : "Still not found. Finish the install, then look again.";
                say(ccMsg);
                render("#st-look");
              } catch (e) {
                b.disabled = false;
                showToast(e?.message ?? String(e), { tone: "danger" });
              }
            },
          }, "Look for Claude Code again"),
          h(
            "span",
            { class: "muted" },
            ccMsg ??
              (s.done
                ? "Found Claude Code on this computer."
                : "casefile looks for Claude Code on this computer."),
          ),
        ),
      ],
    }),
    import: (s) => ({
      title: "Import your first documents",
      state: s.done ? `Done · ${plural(s.imported, "document")} imported` : "No documents yet",
      content: [
        h(
          "p",
          {},
          "Start with a few: your own affidavit, or a month of messages. Your originals stay encrypted on this computer.",
        ),
        h("div", {}, h("a", { class: "btn", href: "#/docs" }, "Import documents")),
      ],
    }),
    share: (s) => {
      const bits = [
        s.shared ? `${s.shared} shared with Claude` : null,
        s.needsReview ? `${s.needsReview} ${s.needsReview === 1 ? "needs" : "need"} review` : null,
        s.exposed ? `${s.exposed} exposed — re-check` : null,
      ].filter(Boolean);
      return {
        title: "Check the names in each one, then share it with Claude",
        state: s.done
          ? ["Done", ...bits].join(" · ")
          : bits.length
          ? bits.join(" · ")
          : "Nothing shared yet",
        content: [
          h(
            "p",
            {},
            "casefile finds names, schools, places and numbers and suggests a label for each, such as ",
            TokenChip({ role: "mother", form: "first", kind: "person" }),
            " for the mother’s first name. You check every one before Claude sees the document.",
          ),
          h(
            "div",
            {},
            h("a", { class: "btn", href: "#/to-check" }, "See documents to review"),
          ),
        ],
      };
    },
    open_claude: (s) => {
      const cmd = h("input", {
        id: "st-cmd",
        class: "mono start-cmd",
        readonly: true,
        value: s.command,
      });
      return {
        title: "Open Claude Code in your case folder",
        state: s.done
          ? `Done${s.at ? ` · ${whenDay(s.at, false)}` : ""}`
          : "Mark it done when Claude Code is open",
        content: [
          h(
            "p",
            {},
            "Claude Code must start inside your case folder. That folder only holds the copies you’ve shared, with names replaced.",
          ),
          h(
            "div",
            { class: "hstack start-row" },
            h(
              "label",
              { for: "st-cmd", class: "sr" },
              "Command to open Claude Code in your case folder",
            ),
            cmd,
            h("button", {
              type: "button",
              class: "btn",
              "aria-label": "Copy the command",
              onclick: async () => {
                const ok = await copyText(s.command);
                termMsg = ok
                  ? "Command copied. Paste it into Terminal and press Return."
                  : "casefile couldn’t copy it. Select the command and copy it yourself.";
                say(termMsg);
                render(null);
                list.querySelector("#st-cmd")?.select();
              },
            }, "Copy"),
            s.canOpenTerminal
              ? h("button", {
                type: "button",
                class: "btn btn-primary btn-lg",
                id: "st-term",
                onclick: async (ev) => {
                  const b = ev.currentTarget;
                  b.disabled = true;
                  try {
                    const r = await api("POST", "/api/claude-code/open-terminal");
                    termMsg = r.opened
                      ? "Terminal is opening in your case folder. Type claude and press Return."
                      : `casefile couldn’t open Terminal. Open it yourself, paste the command above and press Return.`;
                  } catch (e) {
                    termMsg = `casefile couldn’t open Terminal (${
                      e?.message ?? e
                    }). Open it yourself, paste the command above and press Return.`;
                  }
                  say(termMsg);
                  render("#st-term");
                },
              }, "Open Terminal here")
              : null,
          ),
          termMsg
            ? h("p", { class: "muted" }, termMsg)
            : s.canOpenTerminal
            ? null
            : h("p", { class: "muted" }, "Open Terminal, paste the command and press Return."),
          h(
            "div",
            {},
            h("button", {
              type: "button",
              class: "btn",
              id: "st-done5",
              "aria-pressed": Boolean(s.done),
              onclick: async (ev) => {
                const b = ev.currentTarget;
                b.disabled = true;
                try {
                  await api("POST", "/api/start/claude-opened", { done: !s.done });
                  await reload();
                  say(s.done ? "Step 5 marked not done." : "Step 5 marked done.");
                  render("#st-done5");
                } catch (e) {
                  b.disabled = false;
                  showToast(e?.message ?? String(e), { tone: "danger" });
                }
              },
            }, "I’ve done this"),
          ),
        ],
      };
    },
    backup: (s) => ({
      title: "Back up your case",
      state: s.available === false
        ? "No backup yet · casefile can’t make one yet"
        : "No backup yet",
      content: [
        h(
          "p",
          {},
          "If this computer is lost or breaks, a copy of the case folder is the only way back to your originals. Until casefile can make an encrypted backup: while casefile is closed, copy the whole case folder to a USB drive only you use. Originals stay encrypted; the copies Claude reads have names replaced.",
        ),
        h(
          "div",
          {},
          h("a", { class: "btn", href: "#/settings?s=backup" }, "Backup and recovery in Settings"),
        ),
      ],
    }),
  };

  const pickPlan = async (value) => {
    const recorded = settings.plan;
    if (value === "commercial") {
      if (recorded && plan.setup === "commercial") return;
      commercialOpen = true;
      render(".set-commercial input");
      return;
    }
    commercialOpen = false;
    if (recorded && plan.setup === "consumer") return render("#st-plan-consumer");
    if (plan.setup === "commercial") {
      // Switching down withdraws shared restricted documents: do it in Settings, with its warning.
      location.hash = "#/settings?s=claude";
      return;
    }
    try {
      await recordPlan("consumer");
      await reload();
    } catch (e) {
      showToast(e?.message ?? String(e), { tone: "danger" });
    }
    render("#st-plan-consumer");
  };

  render(null);

  const templates = h(
    "section",
    { class: "start-ask", "aria-labelledby": "h-ask" },
    h(
      "div",
      { class: "vstack gap-sm" },
      h("h2", { id: "h-ask" }, "Ask Claude to…"),
      h(
        "p",
        {},
        "Copy a request and paste it into Claude Code. Claude knows how to work with casefile, so plain words are enough. Everything it writes comes back to ",
        h("a", { href: "#/to-check" }, "To check"),
        ".",
      ),
    ),
    h(
      "div",
      { class: "start-cards" },
      TEMPLATES.map((t) => {
        const btn = h("button", {
          type: "button",
          class: "btn",
          "aria-label": `Copy request: ${t.title}`,
          onclick: async () => {
            const ok = await copyText(t.text);
            btn.textContent = ok ? "Copied ✓" : "Copy request";
            say(
              ok
                ? `Request copied: ${t.title}. Paste it into Claude Code.`
                : "casefile couldn’t copy it. Select the text and copy it yourself.",
            );
          },
        }, "Copy request");
        return h(
          "article",
          { class: "start-card", "aria-labelledby": `t-${t.id}` },
          h("h3", { id: `t-${t.id}` }, t.title),
          h("p", { class: "start-quote" }, t.text),
          h(
            "dl",
            { class: "start-dl" },
            h("dt", {}, "Claude will see"),
            h("dd", {}, t.sees),
            h("dt", {}, "You’ll check"),
            h("dd", {}, t.check),
          ),
          h("div", {}, btn),
        );
      }),
    ),
  );

  const glossary = h(
    "section",
    { "aria-labelledby": "h-words", class: "vstack gap-sm" },
    h("h2", { id: "h-words" }, "Words in casefile"),
    h(
      "dl",
      { class: "start-words" },
      h("dt", {}, "Share with Claude"),
      h(
        "dd",
        {},
        "Put a copy of a document, with names replaced, where Claude Code can read it. You do this after checking the names.",
      ),
      h("dt", {}, "Names replaced"),
      h(
        "dd",
        {},
        "Real names and numbers are swapped for labels, so Claude reads a label such as ",
        TokenChip({ role: "mother", form: "first", kind: "person" }),
        " where you see the mother’s first name. You always see the real names.",
        h(
          "details",
          { class: "start-more" },
          h("summary", {}, "Details"),
          h(
            "span",
            {},
            "Rules, and a name finder that runs on this computer, suggest what to replace. Nothing is sent anywhere to do this.",
          ),
        ),
      ),
      h("dt", {}, "Who’s who"),
      h(
        "dd",
        {},
        "The list that links each label to the real person, place or number. It stays encrypted on this computer and Claude never sees it.",
      ),
      h("dt", {}, "Check against the document"),
      h(
        "dd",
        {},
        "Open the lines Claude cited and confirm they say what Claude wrote. Until you do, Claude’s work shows as “To check”.",
      ),
      h("dt", {}, "Use these words as my own"),
      h(
        "dd",
        {},
        "For an affidavit paragraph Claude drafted: you confirm it is true, from your own knowledge, and how you would say it. Rewriting it yourself is usually better.",
      ),
      h("dt", {}, "Withheld from Claude"),
      h(
        "dd",
        {},
        "Documents casefile doesn’t share, such as material from a subpoena or the court, or from the other side, because of the Court’s rules on AI (PD-AI 5.5).",
      ),
    ),
  );

  const advice = h(
    "section",
    { "aria-labelledby": "h-advice", class: "start-advice vstack gap-sm" },
    h("h2", { id: "h-advice", class: "hstack" }, Icon("info", { size: 14 }), "Not legal advice"),
    h(
      "p",
      {},
      "casefile and Claude can help you organise your documents. They can’t give legal advice or tell you how a court will decide. Free help:",
    ),
    h(
      "ul",
      {},
      h(
        "li",
        {},
        ExternalLink("legal_aid_nsw"),
        " (or Legal Aid in your state or territory)",
      ),
      h(
        "li",
        {},
        ExternalLink("family_advice_line"),
        " — ",
        h("a", { href: "tel:1800050321" }, "1800 050 321"),
      ),
    ),
  );

  main.replaceChildren(
    h(
      "div",
      { class: "columns start" },
      h(
        "div",
        { class: "col-main start-main" },
        h(
          "div",
          { class: "vstack gap-sm start-intro" },
          h("h1", {}, "Getting started"),
          h(
            "p",
            {},
            "Six steps to get your case ready for Claude. Take them in any order and at your own pace — you can come back to this page from Settings.",
          ),
        ),
        live,
        h("section", { class: "start-list", "aria-labelledby": "h-steps" }, head, list),
        templates,
      ),
      h(
        "aside",
        { class: "col-side start-side", "aria-label": "Words and help" },
        glossary,
        advice,
      ),
    ),
  );
}
