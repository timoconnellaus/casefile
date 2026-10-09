/**
 * The language-model check in plain words for Settings (DESIGN-SPEC §6: no developer words such as
 * server product names, "endpoint" or "proxy"). The core's `reason`/`why` stay technical for the
 * log and for tests; the screen shows `summary` (one sentence) and `detail` (what it means and
 * what to do), which never repeat each other.
 */

export interface LlmCheckResult {
  local: boolean;
  confirmed: boolean;
  reason: string;
  permitted?: boolean;
  why?: string;
}

export type LlmCheckKind =
  | "runs_here"
  | "riskier_option"
  | "bad_address"
  | "other_computer"
  | "online_model"
  | "network_setting"
  | "model_not_found"
  | "cannot_confirm"
  | "unavailable";

export interface LlmWords {
  kind: LlmCheckKind;
  /** Whether casefile will use the model. */
  used: boolean;
  summary: string;
  detail: string;
}

const MISSED =
  "Until then, nicknames and family words may be missed, so look for them yourself when you review.";

/** Which case of `classifyEndpoint` (core/detect/llm.ts) a result is. */
export function llmCheckKind(c: LlmCheckResult | null): LlmCheckKind {
  if (!c) return "unavailable";
  const r = c.reason ?? "";
  if (/not a valid URL|unsupported protocol/i.test(r)) return "bad_address";
  if (/cloud model/i.test(r)) return "online_model";
  if (/proxy/i.test(r)) return "network_setting";
  if (/does not list model/i.test(r)) return "model_not_found";
  if (c.local && c.confirmed) return "runs_here";
  if (c.local) return "cannot_confirm";
  if (/not this machine/i.test(r)) return "other_computer";
  return /not available/i.test(r) ? "unavailable" : "other_computer";
}

/** Plain words for a language-model check (null: no check could be made). */
export function llmWords(c: LlmCheckResult | null): LlmWords {
  const kind = llmCheckKind(c);
  if (kind === "unavailable") {
    return {
      kind,
      used: false,
      summary: "casefile couldn’t check where this language model runs, so it isn’t using it.",
      detail: MISSED,
    };
  }
  if (c!.permitted) {
    return kind === "runs_here"
      ? {
        kind,
        used: true,
        summary: "The language model runs on this computer, so casefile uses it.",
        detail: "Documents you add are checked with it on this computer.",
      }
      : {
        kind: "riskier_option",
        used: true,
        summary: "casefile uses this language model because you turned on a riskier option.",
        detail: `${WHY[kind]} You chose to use it anyway; turn the option off to stop.`,
      };
  }
  const offComputer = kind === "other_computer" || kind === "online_model";
  return {
    kind,
    used: false,
    summary: offComputer
      ? "This language model would send text off this computer, so casefile isn’t using it."
      : kind === "bad_address"
      ? "casefile can’t use this language model: the address isn’t right."
      : "casefile can’t confirm this language model runs on this computer, so it isn’t using it.",
    detail: `${WHY[kind]} ${FIX[kind]} ${MISSED}`,
  };
}

/** Why, in one sentence, per kind (never the summary again). */
const WHY: Record<LlmCheckKind, string> = {
  runs_here: "It runs on this computer.",
  riskier_option: "",
  bad_address: "It isn’t a web address casefile can use.",
  other_computer:
    "The address you gave is another computer, so documents would go over the internet.",
  online_model:
    "The address is on this computer, but this model runs online: the program passes your text on to another company’s computers.",
  network_setting:
    "A network setting on this computer could send its requests to another computer.",
  model_not_found: "The program at that address doesn’t list a model with this name.",
  cannot_confirm:
    "The address is on this computer, but casefile can’t ask the program there whether it passes text on to another computer.",
  unavailable: "",
};

const FIX: Record<LlmCheckKind, string> = {
  runs_here: "",
  riskier_option: "",
  bad_address: "Check the address in Details.",
  other_computer: "Choose a language model that runs on this computer (see Details).",
  online_model: "Choose a model that runs on this computer (see Details).",
  network_setting: "Ask whoever set up this computer, or choose another model.",
  model_not_found: "Check the model name in Details.",
  cannot_confirm: "If you are sure it runs here, you can turn on the riskier option below.",
  unavailable: "",
};
