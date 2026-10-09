import { judgeSettingsOf } from "../../core/judge/factory.ts";
import { JEV_TERMS } from "../../core/judge/jev.ts";
import { judgeModelDownloaded } from "../../core/judge/local.ts";
import { calibrated } from "../../core/judge/questions.ts";
import { judgeItem, type JudgeItemType, testJudge } from "../../core/judge/run.ts";
import { JudgeError } from "../../core/judge/types.ts";
import type { JudgeSettings } from "../../core/session.ts";
import { type ErrorMapper, HttpError, type Route, route, type RouteContext } from "./context.ts";

/**
 * casefile's extra checks (ADR 14): Settings → Extra checks (which backend, its status, a test),
 * and asking the extra check about one item. Jev's key is accepted here and kept in the vault's
 * settings; no response ever contains it, and the log gets only that it was saved or removed.
 */

/** What the user types to turn Jev on (the same pattern as the other risky options). */
export const JEV_CONFIRM_PHRASE = "send to Jev";

const BACKENDS = ["off", "local", "llm", "jev"] as const;
const ITEM_TYPES: readonly JudgeItemType[] = ["chronology", "evidence", "paragraph", "document"];

export function judgeRoutes({ state, s, show }: RouteContext): Route[] {
  const status = async () => {
    const st = s().settings;
    const j = judgeSettingsOf(st);
    const downloaded = await judgeModelDownloaded();
    return {
      backend: j.backend,
      local: {
        downloaded,
        calibrated: calibrated("local"),
        summary: downloaded
          ? "Ready. Runs on this computer; nothing is sent anywhere."
          : "Downloads about 90 MB the first time it is used, then runs on this computer.",
      },
      llm: {
        setUp: Boolean(st.llm),
        calibrated: calibrated("llm"),
        summary: st.llm
          ? "Uses the language model set up under Finding names, with the same rules about " +
            "where text may go."
          : "Set up a language model under Finding names first.",
      },
      jev: {
        hasKey: Boolean(j.jevKey),
        onSince: j.backend === "jev" ? j.jevOnSince ?? null : null,
        calibrated: calibrated("jev"),
        termsChecked: JEV_TERMS.checked,
        summary: j.backend === "jev"
          ? "On. Jev sees only text with names replaced, from documents shared with Claude."
          : j.jevKey
          ? "Off. Your key is saved."
          : "Off. Add your Jev key to turn it on.",
      },
      confirmPhrase: JEV_CONFIRM_PHRASE,
    };
  };

  return [
    route("GET", "/api/judge", async () => await status()),

    // Choose the backend, and save or remove Jev's key. Turning Jev on needs the key and the typed
    // phrase; it, turning it off and every backend change go in the log (no key, ever).
    route("PUT", "/api/judge", async ({ body }) => {
      const b = await body();
      const cur = judgeSettingsOf(s().settings);
      const next: JudgeSettings = { ...cur };
      let keyChange: "saved" | "removed" | null = null;
      if (b.jevKey !== undefined) {
        if (b.jevKey === null || b.jevKey === "") {
          if (next.jevKey) keyChange = "removed";
          delete next.jevKey;
        } else {
          if (typeof b.jevKey !== "string" || !/^[\x21-\x7e]{8,512}$/.test(b.jevKey.trim())) {
            throw new HttpError(400, "That doesn't look like a Jev key.");
          }
          next.jevKey = b.jevKey.trim();
          keyChange = "saved";
        }
      }
      if (b.backend !== undefined) {
        if (!(BACKENDS as readonly unknown[]).includes(b.backend)) {
          throw new HttpError(400, "Choose where the extra checks run.");
        }
        next.backend = b.backend;
      }
      // Without a key Jev can't be on.
      if (next.backend === "jev" && !next.jevKey) {
        if (b.backend === "jev") throw new HttpError(400, "Add your Jev key first.");
        next.backend = "off";
      }
      const turningOn = next.backend === "jev" && cur.backend !== "jev";
      if (turningOn) {
        if (
          typeof b.confirm !== "string" ||
          b.confirm.trim().toLowerCase() !== JEV_CONFIRM_PHRASE.toLowerCase()
        ) {
          throw new HttpError(400, `To turn Jev on, type “${JEV_CONFIRM_PHRASE}”.`);
        }
        next.jevOnSince = new Date().toISOString();
      }
      if (next.backend !== "jev") delete next.jevOnSince;
      await s().updateSettings({ judge: next });
      state.forgetJudge();
      if (keyChange === "saved") s().log("user", "jev_key_saved", {});
      if (keyChange === "removed") s().log("user", "jev_key_removed", {});
      if (next.backend !== cur.backend) {
        if (cur.backend === "jev") s().log("user", "jev_turned_off", {});
        if (turningOn) s().log("user", "jev_turned_on", { terms_checked: JEV_TERMS.checked });
        s().log("user", "judge_backend_changed", { backend: next.backend });
      }
      return await status();
    }),

    // A fixed, invented sentence through the chosen backend: never case text.
    route("POST", "/api/judge/test", async () => {
      const judge = state.judge();
      if (!judge) throw new HttpError(409, notReady(judgeSettingsOf(s().settings)));
      await testJudge(s(), judge);
      return { ok: true, message: "It works. casefile asked it about an invented sentence." };
    }),

    // Ask the extra check about one item. Flags only: nothing is marked, changed or shared.
    route("POST", "/api/judge/check", async ({ body }) => {
      const b = await body();
      if (!ITEM_TYPES.includes(b.type)) throw new HttpError(400, "Unknown kind of item");
      const id = b.type === "document" ? String(b.id ?? "") : Number(b.id);
      if (b.type === "document" ? !/^D\d{3,}$/.test(id as string) : !Number.isInteger(id)) {
        throw new HttpError(400, "Bad id");
      }
      const judge = state.judge();
      if (!judge) throw new HttpError(409, notReady(judgeSettingsOf(s().settings)));
      const out = await judgeItem(s(), judge, { type: b.type, id });
      return {
        backend: out.backend,
        judgements: out.judgements,
        notChecked: out.notChecked,
        flags: out.flags.map((f) => {
          const text = f.text === undefined ? null : show(f.text);
          return { ...f, text: text?.text ?? null, segs: text?.segs ?? null };
        }),
      };
    }),
  ];
}

function notReady(j: JudgeSettings): string {
  return j.backend === "off"
    ? "Extra checks are off. Choose where they run in Settings."
    : j.backend === "llm"
    ? "Set up a language model under Finding names first."
    : j.backend === "jev"
    ? "Add your Jev key in Settings first."
    : "The extra check isn't available.";
}

export const judgeErrors: ErrorMapper[] = [
  (e) =>
    e instanceof JudgeError
      ? { status: e.code === "refused" ? 409 : 503, body: { error: e.message, code: e.code } }
      : undefined,
];
