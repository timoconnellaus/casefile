import { CaseInUseError } from "../../core/caselock.ts";
import {
  MalformedRecoveryKeyError,
  WrongPassphraseError,
  WrongRecoveryKeyError,
} from "../../core/vault.ts";
import { claudeCodeStatus } from "../claudecode.ts";
import { type BackupRecord, BACKUPS_FILE } from "../state.ts";
import {
  type ErrorMapper,
  HttpError,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/** Vault file for the Getting started steps only the user can mark (ADR 17). */
export const START_FILE = "start";

interface StartRecord {
  /** When the user said they opened Claude Code in the case folder (step 5). */
  claudeOpenedAt?: string | null;
}

/**
 * Case lifecycle: status, create, open (with the passphrase or a recovery key), lock,
 * passphrase, recovery key, and the Getting started checklist.
 */
export function caseRoutes({ state, s }: RouteContext): Route[] {
  return [
    // ── case lifecycle ──────────────────────────────────────────────────────
    // Open route: anyone on this machine (including Claude Code) can call it, so it reveals
    // nothing about the case unless the caller holds the session cookie.
    route("GET", "/api/status", async ({ req }) => {
      const signedIn = state.isSignedIn(req);
      return {
        unlocked: state.session !== null,
        signedIn,
        caseDir: signedIn ? state.session!.paths.root : null,
        // The last case opened on this computer, to fill in the Unlock screen. Only while no case
        // is open at all: an unlocked case's folder is for its own user.
        lastCaseDir: state.session === null ? state.lastCaseDir() : null,
        label: signedIn ? state.session!.settings.label : null,
        // The next free ~/Documents/casefile/case-N, for "New case".
        defaultCaseDir: await state.suggestCaseDir(),
        retryAfterSeconds: state.retryAfterSeconds(),
        nameDetection: signedIn ? state.session!.nameDetection : null,
        // Per case; while locked, the last-opened case's (an app-level copy), so the locked
        // screen can say when it will lock again.
        idleLockMinutes: signedIn ? state.idleLockMinutes() : state.lastIdleLockMinutes(),
        // Why the case was locked when the user didn't lock it (its folder was replaced while
        // open): a fixed sentence, shown on the unlock screen.
        lockNotice: state.session === null ? state.lockNotice : null,
        // Which copy of casefile is running, and whether an update is waiting (ADR 22, 23).
        // Nothing about any case.
        build: state.build,
        update: state.updateStatus,
      };
    }, true),
    // Signed in only, like every route but four (ADR 13, ADR 29). Locked, the user quits and reopens
    // casefile instead, which applies the update just the same (ADR 24).
    route("POST", "/api/update/restart", () => {
      if (!state.updateStatus.ready) throw new HttpError(409, "There is no update waiting.");
      // After the reply: the restart closes the case and ends this process.
      setTimeout(() => state.restartForUpdate().catch((e) => console.error(e)), 50);
      return Promise.resolve({ ok: true });
    }),
    // Signed in only (Settings → casefile updates): check now, and answer with the status after.
    route("POST", "/api/update/check", async () => ({ update: await state.checkForUpdate() })),
    // Open route. With `recoveryKey: true` a recovery key is made and returned, once.
    route("POST", "/api/case/create", async ({ req, body }) => {
      state.requireNoOtherSession(req);
      const b = await body();
      const r = await state.createCase(
        str(b.dir, "folder"),
        str(b.passphrase, "passphrase"),
        str(b.label, "label"),
        { recoveryKey: b.recoveryKey === true },
      );
      return r.recoveryKey ? { ok: true, recoveryKey: r.recoveryKey } : { ok: true };
    }, true),
    // Open route. The passphrase (or the recovery key) itself proves who is asking, so opening
    // may replace an existing session (e.g. after the window lost its cookie). Both are rate
    // limited together, per vault, in AppState. A recovery key must come with a new passphrase:
    // someone using it has forgotten the old one.
    route("POST", "/api/case/open", async ({ body }) => {
      const b = await body();
      const dir = str(b.dir, "folder");
      if (b.recoveryKey !== undefined && b.recoveryKey !== null && b.recoveryKey !== "") {
        await state.recoverCase(
          dir,
          str(b.recoveryKey, "recovery key"),
          str(b.newPassphrase, "new passphrase"),
        );
        return { ok: true, recovered: true };
      }
      await state.openCase(dir, str(b.passphrase, "passphrase"));
      return { ok: true };
    }, true),
    route("POST", "/api/lock", async () => {
      // Answer once the case's last vault writes are on disk, so a caller may exit straight after.
      await state.lock();
      return { ok: true };
    }),
    route("POST", "/api/case/passphrase", async ({ body }) => {
      const b = await body();
      // Re-check the current passphrase before changing it.
      await state.verifyPassphrase(str(b.current, "current passphrase"));
      await s().vault.changePassphrase(str(b.next, "new passphrase"));
      s().log("user", "passphrase_changed");
      return { ok: true };
    }),

    // ── recovery key (ADR 4, amended) ───────────────────────────────────────
    route("GET", "/api/case/recovery-key", async () => {
      return await s().vault.recoveryInfo();
    }),
    // Make a recovery key, replacing any earlier one. Needs the passphrase; the key is in this
    // response only (responses are `no-store`) and is never logged or kept in plain text.
    route("POST", "/api/case/recovery-key", async ({ body }) => {
      const b = await body();
      const r = await state.rotateRecoveryKey(str(b.passphrase, "passphrase"));
      const info = await s().vault.recoveryInfo();
      return { recoveryKey: r.recoveryKey, replaced: r.replaced, createdAt: info.createdAt };
    }),
    route("POST", "/api/case/recovery-key/remove", async ({ body }) => {
      const b = await body();
      await state.removeRecoveryKey(str(b.passphrase, "passphrase"));
      return { ok: true };
    }),

    // ── Getting started (ADR 17) ────────────────────────────────────────────
    // Each step's state is derived from records casefile keeps, except step 5, which only the
    // user can know.
    route("GET", "/api/start", async () => {
      const sess = s();
      const st = sess.settings;
      const cc = await claudeCodeStatus(sess.paths, {
        home: state.opts.home,
        ...state.opts.claudeCode,
      });
      // Document states from the vault's full records (`listDocInfo`, the same source as
      // /api/docs and /api/to-check), so the leak backstop and exposures are counted too.
      const docs = await sess.listDocInfo();
      const count = (st: string) => docs.filter((d) => d.state === st).length;
      const rec = await sess.readVaultJson<StartRecord>(START_FILE, {});
      const backup = await sess.readVaultJson<BackupRecord>(BACKUPS_FILE, {});
      const conf = st.confirmations ?? {};
      const steps = [
        {
          id: "plan",
          done: Boolean(st.plan) && Boolean(conf.helpImproveOff) && Boolean(conf.chatHistory) &&
            cc.webBlocked,
          plan: st.plan ? { setup: st.plan.setup, at: st.plan.at } : null,
          confirmations: {
            helpImproveOff: conf.helpImproveOff ?? null,
            chatHistory: conf.chatHistory ?? null,
          },
          webBlocked: cc.webBlocked,
        },
        { id: "claude_code", done: cc.claude.found, path: cc.claude.path },
        { id: "import", done: docs.length > 0, imported: docs.length },
        {
          id: "share",
          done: docs.some((d) => d.status === "published"),
          shared: count("shared"),
          withheld: count("withheld"),
          exposed: count("exposed"),
          needsReview: count("needs_review"),
        },
        {
          id: "open_claude",
          done: Boolean(rec.claudeOpenedAt),
          at: rec.claudeOpenedAt ?? null,
          command: cc.command,
          canOpenTerminal: cc.canOpenTerminal,
        },
        // The last single-file backup, from the vault (ADR 29). The screen says how long ago.
        { id: "backup", done: Boolean(backup.lastAt), lastAt: backup.lastAt ?? null },
      ];
      return { done: steps.filter((x) => x.done).length, total: steps.length, steps };
    }),
    route("POST", "/api/start/claude-opened", async ({ body }) => {
      const b = await body();
      if (typeof b.done !== "boolean") throw new HttpError(400, "done must be true or false");
      const at = b.done ? new Date().toISOString() : null;
      await s().writeVaultJson(START_FILE, { claudeOpenedAt: at } satisfies StartRecord);
      s().log("user", "start_step_marked", { step: "open_claude", done: b.done });
      return { done: b.done, at };
    }),
  ];
}

export const caseErrors: ErrorMapper[] = [
  // Another casefile process has the case open (ADR 4, amended). The message names its pid.
  (e) => e instanceof CaseInUseError ? { status: 409, body: { error: e.message } } : undefined,
  (e) =>
    e instanceof MalformedRecoveryKeyError
      ? { status: 400, body: { error: e.message } }
      : undefined,
  // Before WrongPassphraseError, which it extends.
  (e) =>
    e instanceof WrongRecoveryKeyError
      ? { status: 401, body: { error: "Wrong recovery key" } }
      : undefined,
  (e) =>
    e instanceof WrongPassphraseError
      ? { status: 401, body: { error: "Wrong passphrase" } }
      : undefined,
];
