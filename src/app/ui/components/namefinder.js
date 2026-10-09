// The name finder question (ADR 26): asked the first time a case is opened, with "On" chosen, and
// the one way to turn the name finder on (Settings uses it too). Turning it on downloads the model
// once, while the user waits and is told; it never downloads unasked.
import { h } from "../dom.js";
import { api } from "../lib.js";
import { openDialog } from "./dialog.js";
import { announce, showToast } from "./feedback.js";

/** What turning it on involves, in the words both screens use. */
export const NAME_FINDER_DOWNLOAD =
  "The first time, casefile downloads the name finder once from Hugging Face, about 110 MB. It asks for one fixed version and checks every file against its recorded fingerprint before using it. After that it runs on this computer and needs no internet; your documents are never sent anywhere.";

/** Words when the name finder is off (declined, or it couldn't be set up). */
export const NAME_FINDER_OFF =
  "Name finding is off: casefile only finds numbers, addresses and the names already in Who’s who. Look for other names yourself when you review each document. You can turn the name finder on in Settings → Finding names.";

/**
 * Turn the name finder on or off and say what happened. Resolves with the server's answer
 * (`{on, error}`), or null if the request failed.
 * @param {boolean} on
 */
export async function chooseNameFinder(on) {
  if (on) {
    const wait = "Getting the name finder ready. The first time this downloads about 110 MB…";
    announce(wait);
    showToast(wait, { timeout: 0 });
  }
  let r = null;
  try {
    r = await api("POST", "/api/settings/name-finder", { on });
  } catch (e) {
    r = { on: false, error: String(e?.message ?? e) };
  }
  const msg = r.on
    ? "Name finder on. It runs on this computer. Recorded in the Log."
    : on
    ? `casefile couldn’t set up the name finder: ${r.error ?? "it didn’t load"}. ${NAME_FINDER_OFF}`
    : `Name finder off. Recorded in the Log. ${NAME_FINDER_OFF}`;
  announce(msg);
  showToast(msg, r.on ? { glyph: "check" } : { tone: "danger", timeout: 0 });
  return r;
}

/**
 * Ask whether to turn the name finder on, with "On" chosen. Closing the dialog without answering
 * leaves it off and asks again next time the case is opened.
 * @returns {Promise<boolean>} whether the user answered
 */
export async function askNameFinder() {
  const option = (value, label, sub) =>
    h(
      "label",
      { class: "choice" },
      h("input", { type: "radio", name: "nf-choice", value, checked: value === "on" }),
      h("span", {}, h("strong", {}, label), h("span", { class: "muted" }, ` ${sub}`)),
    );
  const group = h(
    "fieldset",
    { class: "vstack gap-sm" },
    h("legend", { class: "sr" }, "Name finder"),
    option("on", "On (recommended)", "Finds people, places, schools and organisations for you."),
    option("off", "Off", "Only numbers, addresses and names already in Who’s who are found."),
  );
  const ok = await openDialog({
    title: "Turn on the name finder?",
    body: [
      h(
        "p",
        {},
        "Before you share a document with Claude, casefile looks for names so they can be replaced. The name finder catches names casefile doesn’t know yet.",
      ),
      h("p", {}, NAME_FINDER_DOWNLOAD),
      group,
    ],
    actions: [{ label: "Continue", value: true, variant: "primary" }],
  });
  if (!ok) return false;
  const on = group.querySelector("input:checked")?.value !== "off";
  await chooseNameFinder(on);
  return true;
}
