import {
  BackupDamagedError,
  BackupTooNewError,
  NotABackupError,
  RestoreTargetError,
} from "../../core/backupfile.ts";
import type { KeySecret } from "../../core/vault.ts";
import { type ErrorMapper, type Route, route, type RouteContext, str } from "./context.ts";

/** The encrypted single-file backup (ADR 29): when the last one was made, and making one. */
export function backupRoutes({ state }: RouteContext): Route[] {
  return [
    route("GET", "/api/backup", async () => await state.backupStatus()),
    // The folder is asked each time; the reply says where the file went (the user's own folder).
    route("POST", "/api/backup", async ({ body }) => {
      const b = await body();
      const r = await state.backupNow(str(b.folder, "folder"));
      return { ...r, lastAt: r.createdAt };
    }),
    // Open route, like case/open: it has to work before any case is open (on a new computer), and
    // the passphrase or recovery key is the proof, rate limited per backup file. Like case/create,
    // it can't replace a session someone else has open. With a recovery key, a new passphrase.
    route("POST", "/api/case/restore", async ({ req, body }) => {
      state.requireNoOtherSession(req);
      const b = await body();
      const file = str(b.file, "backup file");
      const dir = str(b.dir, "folder");
      const useKey = b.recoveryKey !== undefined && b.recoveryKey !== null && b.recoveryKey !== "";
      const secret: KeySecret = useKey
        ? { recoveryKey: str(b.recoveryKey, "recovery key") }
        : { passphrase: str(b.passphrase, "passphrase") };
      const r = await state.restoreCase(
        file,
        dir,
        secret,
        useKey ? str(b.newPassphrase, "new passphrase") : undefined,
      );
      return { ok: true, ...r };
    }, true),
  ];
}

export const backupErrors: ErrorMapper[] = [
  (e) => e instanceof NotABackupError ? { status: 400, body: { error: e.message } } : undefined,
  (e) => e instanceof BackupDamagedError ? { status: 422, body: { error: e.message } } : undefined,
  (e) => e instanceof BackupTooNewError ? { status: 409, body: { error: e.message } } : undefined,
  (e) => e instanceof RestoreTargetError ? { status: 409, body: { error: e.message } } : undefined,
];
