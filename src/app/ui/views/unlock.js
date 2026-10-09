// Unlock (W2-8): open a case with the passphrase or a recovery key, or start a new case.
// Shown without the AppHeader whenever the case is locked. Structure from wb/Unlock.dc.html.
import { h } from "../dom.js";
import { api, ApiError } from "../lib.js";
import { announce, Callout, Icon, PassField, RecoveryKeyPanel } from "../components/index.js";

// The last case folder opened in this window. When this window has none, /api/status gives the
// app's own `lastCaseDir`, but only while no case is open.
function lastCase() {
  try {
    return localStorage.getItem("casefile.lastCase") ?? "";
  } catch {
    return "";
  }
}
function remember(dir) {
  try {
    localStorage.setItem("casefile.lastCase", dir);
  } catch {
    // storage unavailable; nothing to remember
  }
}

export const MIN_PASSPHRASE = 12;

/** "2:41 pm" */
function clockTime(ms) {
  return new Date(ms)
    .toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })
    .replace(/\s?([ap])\.?\s?m\.?$/i, (_, x) => ` ${x.toLowerCase()}m`);
}

/** "40 seconds", "2 minutes" */
function waitWords(seconds) {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const m = Math.ceil(seconds / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

/** A labelled field: label, control, optional hint. */
function UField(label, control, hint) {
  const id = control.id || control.input?.id;
  return h("div", { class: "unl-field" }, h("label", { for: id }, label), control, hint ?? null);
}

/**
 * The unlock view is shown without the AppHeader, whenever the case is locked.
 * @param {HTMLElement} main @param {Record<string, string>} _params
 * @param {{status: any, rerender: () => unknown, toast?: Function}} ctx
 */
export default function view(main, _params, ctx) {
  const status = ctx.status ?? {};
  main.classList.add("unl");

  // ── open a case ───────────────────────────────────────────────────────────
  let useRecovery = false;
  let lockedUntil = status.retryAfterSeconds > 0 ? Date.now() + status.retryAfterSeconds * 1000 : 0;
  let timer = 0;

  const dir = h("input", {
    id: "u-dir",
    class: "mono",
    name: "dir",
    // The last case opened in this window. Not defaultCaseDir: that is the next *free* folder,
    // for a new case, so there is nothing there to open.
    // Falls back to the app's own record of the last case (only sent while nothing is open).
    value: lastCase() || status.lastCaseDir || "",
    placeholder: "~/Documents/casefile/case-1",
    autocomplete: "off",
    spellcheck: "false",
  });
  const pass = PassField({ id: "u-pass", name: "passphrase", describedBy: "u-msg" });
  const passLabel = h("label", { for: "u-pass" }, "Passphrase");
  const recHint = h(
    "div",
    { class: "unl-hint", id: "u-rec-hint", hidden: true },
    "Your recovery key is the code casefile showed you when you made this case, or in Settings.",
  );
  // A recovery key opens the case once; the user then chooses a new passphrase.
  const newPass2 = h("input", {
    id: "u-new2",
    class: "pf-input",
    type: "password",
    autocomplete: "new-password",
    spellcheck: "false",
  });
  const newPass = PassField({
    id: "u-new",
    autocomplete: "new-password",
    also: [newPass2],
    describedBy: "u-new-hint",
  });
  const recoverFields = h(
    "div",
    { class: "vstack unl-recover", hidden: true },
    UField("New passphrase", newPass),
    UField("Type it again", newPass2),
    h(
      "div",
      { class: "unl-hint", id: "u-new-hint" },
      `Your old passphrase stops working. At least ${MIN_PASSPHRASE} characters.`,
    ),
  );
  const msg = h("div", { id: "u-msg", class: "unl-msg", role: "status", "aria-live": "polite" });
  const submitText = () => (useRecovery ? "Unlock and set a new passphrase" : "Unlock");
  const submit = h(
    "button",
    { type: "submit", class: "btn btn-primary btn-lg unl-submit" },
    "Unlock",
  );
  const switchBtn = h("button", {
    type: "button",
    class: "btn-link unl-linkbtn",
    onclick: () => {
      useRecovery = !useRecovery;
      passLabel.textContent = useRecovery ? "Recovery key" : "Passphrase";
      pass.input.value = "";
      pass.input.removeAttribute("aria-invalid");
      pass.input.autocomplete = useRecovery ? "off" : "current-password";
      pass.input.setAttribute("aria-describedby", useRecovery ? "u-msg u-rec-hint" : "u-msg");
      pass.setWhat(useRecovery ? "recovery key" : "passphrase");
      recHint.hidden = !useRecovery;
      recoverFields.hidden = !useRecovery;
      switchBtn.textContent = useRecovery
        ? "Use my passphrase instead"
        : "Use a recovery key instead";
      if (!lockedUntil) submit.textContent = submitText();
      if (msg.dataset.kind !== "lockout") {
        msg.dataset.kind = "";
        msg.replaceChildren();
      }
      pass.input.focus();
      announce(useRecovery ? "Recovery key field shown." : "Passphrase field shown.");
    },
  }, "Use a recovery key instead");

  const lockout = () => {
    clearInterval(timer);
    const left = Math.ceil((lockedUntil - Date.now()) / 1000);
    if (left <= 0 || !main.isConnected) {
      lockedUntil = 0;
      submit.removeAttribute("aria-disabled");
      submit.textContent = submitText();
      if (main.isConnected && msg.dataset.kind === "lockout") {
        msg.dataset.kind = "";
        msg.replaceChildren(h("p", {}, "You can try again now."));
      }
      return;
    }
    const at = clockTime(lockedUntil);
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = `Unlock (available at ${at})`;
    if (msg.dataset.kind !== "lockout") {
      msg.dataset.kind = "lockout";
      msg.replaceChildren(
        Callout({
          tone: "attention",
          title: `Too many tries — wait ${waitWords(left)}`,
          children:
            `You can try again at ${at}. The pause makes it slow for anyone to guess your passphrase. Your case is fine.`,
        }),
      );
    }
    timer = setInterval(() => {
      if (Date.now() >= lockedUntil || !main.isConnected) lockout();
    }, 1000);
  };

  const showError = (title, body) => {
    msg.dataset.kind = "error";
    msg.replaceChildren(Callout({ tone: "attention", title, children: body || null }));
  };

  const openForm = h(
    "form",
    {
      class: "unl-card unl-card--open",
      "aria-labelledby": "h-open",
      novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (lockedUntil > Date.now()) {
          announce(`Wait until ${clockTime(lockedUntil)}, then try again.`);
          return;
        }
        if (submit.getAttribute("aria-disabled") === "true") return;
        const folder = dir.value.trim();
        const secret = pass.input.value;
        if (!folder) {
          dir.focus();
          return showError("Type the case folder", "The folder your case is in.");
        }
        if (!secret) {
          pass.input.focus();
          return showError(
            useRecovery ? "Type your recovery key" : "Type your passphrase",
            useRecovery
              ? "It is the code casefile showed you once, in groups of letters and numbers."
              : "casefile needs it to open your encrypted originals.",
          );
        }
        /** @type {Record<string, string>} */
        let body = { dir: folder, passphrase: secret };
        if (useRecovery) {
          if (newPass.input.value.length < MIN_PASSPHRASE) {
            newPass.input.focus();
            return showError(
              "Choose a longer new passphrase",
              `Use at least ${MIN_PASSPHRASE} characters. A few unrelated words works well.`,
            );
          }
          if (newPass.input.value !== newPass2.value) {
            newPass2.focus();
            return showError("The new passphrases don’t match", "Type the same one twice.");
          }
          body = { dir: folder, recoveryKey: secret, newPassphrase: newPass.input.value };
        }
        submit.setAttribute("aria-disabled", "true");
        announce("Opening case.");
        try {
          await api("POST", "/api/case/open", body);
        } catch (e) {
          submit.removeAttribute("aria-disabled");
          if (e instanceof ApiError && e.status === 429) {
            lockedUntil = Date.now() + (Number(e.body.retryAfterSeconds) || 30) * 1000;
            lockout();
            return;
          }
          if (e instanceof ApiError && e.status === 401) {
            pass.input.setAttribute("aria-invalid", "true");
            pass.input.select();
            return showError(
              useRecovery
                ? "That recovery key didn’t open this case"
                : "That didn’t open this case",
              useRecovery
                ? "Check each group of characters and that this is the right folder. After a few wrong tries casefile asks you to wait a little."
                : "Check Caps Lock and that this is the right folder. After a few wrong tries casefile asks you to wait a little.",
            );
          }
          return showError("casefile couldn’t open this case", e?.message ?? String(e));
        }
        remember(folder);
        if (useRecovery) {
          ctx.toast?.("Case opened with your recovery key. Your new passphrase is set.");
        }
        location.hash = "#/docs";
        await ctx.rerender();
      },
    },
    h("h2", { id: "h-open" }, "Open a case"),
    UField("Case folder", dir),
    h("div", { class: "unl-field" }, passLabel, pass, recHint),
    recoverFields,
    status.unlocked
      ? h(
        "p",
        { class: "unl-hint" },
        "A case is open in another casefile window. Opening it here takes it over.",
      )
      : null,
    msg,
    submit,
    h(
      "div",
      { class: "vstack gap-sm" },
      h("div", {}, switchBtn),
      h(
        "details",
        { class: "unl-forgot" },
        h("summary", {}, "Forgot your passphrase?"),
        h(
          "div",
          { class: "vstack" },
          h(
            "p",
            {},
            "It happens. casefile can’t reset it for you — that is what keeps your case private.",
          ),
          h(
            "p",
            {},
            h("strong", {}, "If you saved a recovery key,"),
            " choose “Use a recovery key instead” above to open the case, then choose a new passphrase.",
          ),
          h(
            "p",
            {},
            h("strong", {}, "If you didn’t,"),
            " the encrypted originals and Who’s who can’t be opened. The copies with names replaced, and Claude’s work, are still in the case folder. You can start a new case and import your originals again from wherever you keep them.",
          ),
        ),
      ),
    ),
  );

  // ── start a new case ──────────────────────────────────────────────────────
  const label = h("input", {
    id: "n-label",
    name: "label",
    placeholder: "Parenting matter 2025",
    autocomplete: "off",
  });
  const newDir = h("input", {
    id: "n-dir",
    class: "mono",
    name: "dir",
    value: status.defaultCaseDir ?? "",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": "n-dir-hint",
  });
  const p2 = h("input", {
    id: "n-p2",
    class: "pf-input",
    type: "password",
    autocomplete: "new-password",
    spellcheck: "false",
  });
  const p1 = PassField({
    id: "n-p1",
    autocomplete: "new-password",
    also: [p2],
    describedBy: "n-pass-hint",
  });
  const saveKey = h("input", {
    type: "checkbox",
    id: "n-key",
    checked: true,
    "aria-describedby": "n-key-hint",
  });
  const newMsg = h("div", { class: "unl-msg", role: "status", "aria-live": "polite" });
  const newErr = (title, body, focus) => {
    newMsg.replaceChildren(Callout({ tone: "attention", title, children: body || null }));
    focus?.focus();
  };
  const createBtn = h(
    "button",
    { type: "submit", class: "btn btn-primary btn-lg unl-submit" },
    "Create case",
  );
  const createForm = h(
    "form",
    {
      class: "unl-card",
      "aria-labelledby": "h-new",
      novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (!label.value.trim()) return newErr("Give the case a name", "Only you see it.", label);
        if (!newDir.value.trim()) return newErr("Choose a new folder", "", newDir);
        if (p1.input.value.length < MIN_PASSPHRASE) {
          return newErr(
            "Choose a longer passphrase",
            `Use at least ${MIN_PASSPHRASE} characters.`,
            p1.input,
          );
        }
        if (p1.input.value !== p2.value) {
          return newErr("The passphrases don’t match", "Type the same one twice.", p2);
        }
        newMsg.replaceChildren();
        createBtn.disabled = true;
        let r;
        try {
          r = await api("POST", "/api/case/create", {
            dir: newDir.value.trim(),
            label: label.value.trim(),
            passphrase: p1.input.value,
            recoveryKey: saveKey.checked,
          });
        } catch (e) {
          createBtn.disabled = false;
          return newErr("casefile couldn’t make the case", e?.message ?? String(e));
        }
        remember(newDir.value.trim());
        const next = async () => {
          location.hash = "#/start";
          await ctx.rerender();
        };
        if (!r.recoveryKey) {
          announce("Case created.");
          return next();
        }
        // Shown once, here, before anything else.
        announce("Case created. Your recovery key is shown next.");
        main.replaceChildren(
          h(
            "div",
            { class: "unl-wrap unl-wrap--narrow" },
            h("p", { class: "unl-brand mono" }, "casefile"),
            h(
              "div",
              { class: "unl-card" },
              RecoveryKeyPanel({
                key: r.recoveryKey,
                headingLevel: "h1",
                doneLabel: "Continue to Getting started",
                onDone: next,
              }),
            ),
          ),
        );
        const h1 = main.querySelector("h1");
        h1?.setAttribute("tabindex", "-1");
        h1?.focus();
      },
    },
    h("h2", { id: "h-new" }, "Start a new case"),
    UField("Name (only you see it)", label),
    UField(
      "New folder",
      newDir,
      h(
        "div",
        { class: "unl-hint", id: "n-dir-hint" },
        "Claude Code works inside this folder, so give it a plain name with no real names in it.",
      ),
    ),
    UField("Passphrase", p1),
    UField("Type it again", p2),
    h(
      "div",
      { class: "unl-hint", id: "n-pass-hint" },
      `At least ${MIN_PASSPHRASE} characters. A few unrelated words is easy to remember and hard to guess. casefile can’t reset it, so keep it somewhere safe.`,
    ),
    h(
      "div",
      { class: "unl-keybox" },
      h(
        "label",
        { class: "unl-check", for: "n-key" },
        saveKey,
        h("strong", {}, "Save a recovery key"),
      ),
      h(
        "div",
        { id: "n-key-hint", class: "unl-hint unl-indent" },
        "A second way in if you forget your passphrase. casefile shows it once, after the case is made. Print it or write it down and keep it away from this computer — not in the case folder.",
      ),
    ),
    newMsg,
    createBtn,
    h("div", { class: "unl-hint" }, "Next, a short checklist helps you set up Claude."),
  );

  // ── restore from a backup (ADR 29) ────────────────────────────────────────
  // Into a new, empty folder only; the restored case opens as a case of its own.
  let restoreWithKey = false;
  const rFile = h("input", {
    id: "r-file",
    class: "mono",
    name: "file",
    placeholder: "/Volumes/My USB drive/casefile-backup-….casefile-backup",
    autocomplete: "off",
    spellcheck: "false",
  });
  const rDir = h("input", {
    id: "r-dir",
    class: "mono",
    name: "dir",
    value: status.defaultCaseDir ?? "",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": "r-dir-hint",
  });
  const rPass = PassField({ id: "r-pass", name: "passphrase", describedBy: "r-msg" });
  const rPassLabel = h("label", { for: "r-pass" }, "Passphrase");
  const rNew2 = h("input", {
    id: "r-new2",
    class: "pf-input",
    type: "password",
    autocomplete: "new-password",
    spellcheck: "false",
  });
  const rNew = PassField({ id: "r-new", autocomplete: "new-password", also: [rNew2] });
  const rNewFields = h(
    "div",
    { class: "vstack unl-recover", hidden: true },
    UField("New passphrase", rNew),
    UField("Type it again", rNew2),
    h(
      "div",
      { class: "unl-hint" },
      `For the restored case. At least ${MIN_PASSPHRASE} characters.`,
    ),
  );
  const rMsg = h("div", { id: "r-msg", class: "unl-msg", role: "status", "aria-live": "polite" });
  const rErr = (title, body, focus) => {
    rMsg.replaceChildren(Callout({ tone: "attention", title, children: body || null }));
    focus?.focus();
  };
  const rSubmit = h(
    "button",
    { type: "submit", class: "btn btn-primary btn-lg unl-submit" },
    "Restore",
  );
  const rSwitch = h("button", {
    type: "button",
    class: "btn-link unl-linkbtn",
    onclick: () => {
      restoreWithKey = !restoreWithKey;
      rPassLabel.textContent = restoreWithKey ? "Recovery key" : "Passphrase";
      rPass.input.value = "";
      rPass.input.autocomplete = restoreWithKey ? "off" : "current-password";
      rPass.setWhat(restoreWithKey ? "recovery key" : "passphrase");
      rNewFields.hidden = !restoreWithKey;
      rSwitch.textContent = restoreWithKey
        ? "Use the passphrase instead"
        : "Use a recovery key instead";
      rMsg.replaceChildren();
      rPass.input.focus();
      announce(restoreWithKey ? "Recovery key field shown." : "Passphrase field shown.");
    },
  }, "Use a recovery key instead");
  const restoreForm = h(
    "form",
    {
      class: "vstack unl-restore-form",
      "aria-labelledby": "h-restore",
      novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (rSubmit.getAttribute("aria-disabled") === "true") return;
        const file = rFile.value.trim();
        const folder = rDir.value.trim();
        const secret = rPass.input.value;
        if (!file) return rErr("Type where the backup file is", "", rFile);
        if (!folder) return rErr("Choose a new folder for the restored case", "", rDir);
        if (!secret) {
          return rErr(
            restoreWithKey ? "Type your recovery key" : "Type your passphrase",
            "The one the case had when the backup was made.",
            rPass.input,
          );
        }
        /** @type {Record<string, string>} */
        let body = { file, dir: folder, passphrase: secret };
        if (restoreWithKey) {
          if (rNew.input.value.length < MIN_PASSPHRASE) {
            return rErr(
              "Choose a longer new passphrase",
              `Use at least ${MIN_PASSPHRASE} characters.`,
              rNew.input,
            );
          }
          if (rNew.input.value !== rNew2.value) {
            return rErr("The new passphrases don’t match", "Type the same one twice.", rNew2);
          }
          body = { file, dir: folder, recoveryKey: secret, newPassphrase: rNew.input.value };
        }
        rSubmit.setAttribute("aria-disabled", "true");
        rSubmit.textContent = "Restoring…";
        announce("Restoring the backup.");
        try {
          await api("POST", "/api/case/restore", body);
        } catch (e) {
          rSubmit.removeAttribute("aria-disabled");
          rSubmit.textContent = "Restore";
          if (e instanceof ApiError && e.status === 429) {
            return rErr("Too many tries — wait a little", e.message);
          }
          if (e instanceof ApiError && e.status === 401) {
            rPass.input.select();
            return rErr(
              restoreWithKey
                ? "That recovery key doesn’t open this backup"
                : "That passphrase doesn’t open this backup",
              "It needs the passphrase (or recovery key) the case had when the backup was made. Nothing was restored.",
            );
          }
          return rErr("casefile couldn’t restore this backup", e?.message ?? String(e));
        }
        remember(folder);
        ctx.toast?.(
          "Backup restored as a separate case. The case it was made from hasn’t changed.",
        );
        location.hash = "#/docs";
        await ctx.rerender();
      },
    },
    UField("Backup file", rFile),
    UField(
      "New folder for the restored case",
      rDir,
      h(
        "div",
        { class: "unl-hint", id: "r-dir-hint" },
        "A new or empty folder. casefile never restores over a case: the restored case is a separate case, and the one the backup came from is left as it is.",
      ),
    ),
    h("div", { class: "unl-field" }, rPassLabel, rPass),
    rNewFields,
    rMsg,
    rSubmit,
    h("div", {}, rSwitch),
  );
  const restoreCard = h(
    "details",
    { class: "unl-card unl-restore" },
    h("summary", { id: "h-restore" }, "Restore from a backup"),
    h(
      "p",
      { class: "unl-hint" },
      "Get a case back from a backup file made in Settings, on this computer or a new one.",
    ),
    restoreForm,
  );

  main.replaceChildren(
    h(
      "div",
      { class: "unl-wrap" },
      h(
        "div",
        { class: "vstack gap-sm" },
        h("h1", { class: "unl-brand mono" }, "casefile"),
        h(
          "p",
          { class: "unl-lede" },
          "Your originals stay encrypted on this computer. Claude only works with the copies you share, with names replaced.",
        ),
      ),
      h("div", { class: "unl-cards" }, openForm, createForm),
      restoreCard,
      h(
        "p",
        { class: "unl-foot" },
        Icon("lock", { size: 14 }),
        "casefile locks itself when it isn’t used for a while (30 minutes unless you change it in Settings), and when you close it.",
      ),
    ),
  );
  if (lockedUntil) lockout();
  else if (status.lockNotice) showError("casefile locked this case", status.lockNotice);
  // Start where the user types next: the passphrase when the folder is known (QA G5).
  (dir.value ? pass.input : dir).focus();
}
