import { restoreScaffold, UnsafeCasePathError } from "../../core/case.ts";
import type { CaseSession } from "../../core/session.ts";
import { claudeCodeStatus, openTerminalIn } from "../claudecode.ts";
import { llmWords } from "../llmwords.ts";
import { EXTERNAL_LINKS, isExternalLinkId, openExternal } from "../links.ts";
import { IDLE_LOCK_MINUTES } from "../state.ts";
import {
  type ErrorMapper,
  HttpError,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/**
 * Case settings: label, name finding, local LLM, Claude setup, idle lock and shortcuts, the
 * PD-AI 5.4 confirmations, and Claude Code in the case folder (ADR 17).
 */
export function settingsRoutes({ state, s }: RouteContext): Route[] {
  const ccEnv = () => ({ home: state.opts.home, ...state.opts.claudeCode });
  return [
    // ── settings ────────────────────────────────────────────────────────────
    route("GET", "/api/settings", async () => {
      const st = s().settings;
      return Promise.resolve({
        label: st.label,
        claudeSetup: st.claudeSetup,
        nerEnabled: st.nerEnabled,
        nameDetection: s().nameDetection,
        llm: st.llm ? { ...st.llm, apiKey: st.llm.apiKey ? "••••••" : "" } : null,
        caseDir: s().paths.root,
        idleLockMinutes: state.idleLockMinutes(),
        shortcuts: st.shortcuts !== false,
        userRole: st.userRole ?? null,
        confirmations: {
          helpImproveOff: st.confirmations?.helpImproveOff ?? null,
          chatHistory: st.confirmations?.chatHistory ?? null,
        },
        plan: st.plan ?? null,
        recoveryKey: await s().vault.recoveryInfo(),
      });
    }),
    route("PUT", "/api/settings", async ({ body }) => {
      const b = await body();
      const patch: Parameters<CaseSession["updateSettings"]>[0] = {};
      // Fields from wave 1 (ADR 13 amendment, ADR 17); logged only when sent.
      const extra: Record<string, unknown> = {};
      if (b.idleLockMinutes !== undefined) {
        if (!(IDLE_LOCK_MINUTES as readonly unknown[]).includes(b.idleLockMinutes)) {
          throw new HttpError(400, "Lock after 15, 30 or 60 minutes");
        }
        patch.idleLockMinutes = b.idleLockMinutes;
        extra.idle_lock_minutes = b.idleLockMinutes;
      }
      if (b.shortcuts !== undefined) {
        if (typeof b.shortcuts !== "boolean") {
          throw new HttpError(400, "shortcuts must be true or false");
        }
        patch.shortcuts = b.shortcuts;
        extra.shortcuts = b.shortcuts;
      }
      if (b.userRole !== undefined) {
        // A role (e.g. "mother"), never a name: it must be someone in Who's who.
        const role = b.userRole === null || b.userRole === "" ? undefined : str(b.userRole, "role");
        if (role !== undefined && !s().registry.get(role)) {
          throw new HttpError(400, "Choose someone from Who's who");
        }
        patch.userRole = role;
        extra.user_role = role ?? null;
      }
      if (typeof b.label === "string") patch.label = b.label;
      if (typeof b.nerEnabled === "boolean") patch.nerEnabled = b.nerEnabled;
      if (b.llm === null) patch.llm = null;
      else if (b.llm && typeof b.llm === "object") {
        const prev = s().settings.llm;
        const apiKey = b.llm.apiKey === "••••••" ? prev?.apiKey : (b.llm.apiKey || undefined);
        patch.llm = {
          baseUrl: str(b.llm.baseUrl, "LLM base URL"),
          model: str(b.llm.model, "LLM model"),
          apiKey,
          allowRemote: b.llm.allowRemote === true,
          trustLocalServer: b.llm.trustLocalServer === true,
        };
      }
      await s().updateSettings(patch);
      await state.configureDetectors();
      // Log only the endpoint's host: a URL can carry credentials (http://user:pass@host).
      const llm = s().settings.llm;
      let host: string | null = null;
      try {
        host = llm ? new URL(llm.baseUrl).host : null;
      } catch {
        host = "invalid";
      }
      s().log("user", "settings_changed", {
        ner: s().settings.nerEnabled,
        llm_host: host,
        ...extra,
      });
      if (patch.idleLockMinutes !== undefined) await state.rememberIdleLock();
      state.touch(); // a new idle-lock setting applies from now
      return { ok: true };
    }),
    // Where the language model runs. `reason`/`why` are technical (kept for the log and older
    // screens); `summary` and `detail` are the plain words Settings shows (llmwords.ts).
    route("POST", "/api/settings/check-llm", async () => {
      const c = await state.checkLlm();
      return c ? { ...c, ...llmWords(c) } : null;
    }),

    // ── PD-AI 5.4 confirmations (ADR 17) ────────────────────────────────────
    // casefile can't see the user's Claude account, so it records what the user confirms, with
    // the date, in the vault (settings) and the AI-use log. `true` confirms (again) today;
    // `false` withdraws a confirmation.
    route("POST", "/api/settings/confirmations", async ({ body }) => {
      const b = await body();
      const keys = [["helpImproveOff", "help_improve_off"], [
        "chatHistory",
        "chat_history",
      ]] as const;
      const now = new Date().toISOString();
      const next = { ...(s().settings.confirmations ?? {}) };
      const confirmed: string[] = [];
      const withdrawn: string[] = [];
      for (const [k, logName] of keys) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== "boolean") throw new HttpError(400, `${k} must be true or false`);
        if (b[k]) {
          next[k] = now;
          confirmed.push(logName);
        } else {
          delete next[k];
          withdrawn.push(logName);
        }
      }
      if (!confirmed.length && !withdrawn.length) {
        throw new HttpError(400, "Nothing to confirm");
      }
      await s().updateSettings({ confirmations: next });
      if (confirmed.length) s().log("user", "pd_ai_confirmed", { items: confirmed });
      if (withdrawn.length) s().log("user", "pd_ai_confirmation_withdrawn", { items: withdrawn });
      return {
        helpImproveOff: next.helpImproveOff ?? null,
        chatHistory: next.chatHistory ?? null,
      };
    }),

    // ── Claude Code in the case folder (ADR 17) ─────────────────────────────
    route("GET", "/api/claude-code", async () => {
      return await claudeCodeStatus(s().paths, ccEnv());
    }),
    // Put the generated settings back. Logged with what was rewritten (file names only).
    route("POST", "/api/claude-code/restore", async () => {
      const r = await restoreScaffold(s().paths);
      s().log("user", "claude_settings_restored", {
        rewritten: r.rewritten,
        moved_aside: r.movedAside,
      });
      return { ...r, status: await claudeCodeStatus(s().paths, ccEnv()) };
    }),
    // macOS only: `open -a Terminal <case folder>`. Nothing from the request is used. When it
    // can't open Terminal, the UI shows `command` to type instead.
    route("POST", "/api/claude-code/open-terminal", async () => {
      const dir = s().paths.root;
      const opened = await openTerminalIn(dir, ccEnv());
      if (opened) s().log("user", "terminal_opened", {});
      return { opened, command: (await claudeCodeStatus(s().paths, ccEnv())).command };
    }),

    // ── help links ──────────────────────────────────────────────────────────
    // Free legal help, opened in the user's own browser. Only ids from links.ts are accepted;
    // the URL comes from that list, never from the request. Not logged: it is not case activity.
    route("POST", "/api/open-link", async ({ body }) => {
      const id: unknown = (await body()).id;
      if (!isExternalLinkId(id)) throw new HttpError(400, "Unknown link");
      const opened = await openExternal(id, ccEnv());
      return { opened, url: EXTERNAL_LINKS[id].url };
    }),
  ];
}

export const settingsErrors: ErrorMapper[] = [
  // Something in the case folder changed under casefile while it was putting files back.
  (e) =>
    e instanceof UnsafeCasePathError
      ? { status: 409, body: { error: `${e.message}. Nothing was written there; try again.` } }
      : undefined,
];
