import {
  BackupDamagedError,
  BackupTooNewError,
  NotABackupError,
  RestoreTargetError,
} from "../../core/backupfile.ts";
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
  ];
}

export const backupErrors: ErrorMapper[] = [
  (e) => e instanceof NotABackupError ? { status: 400, body: { error: e.message } } : undefined,
  (e) => e instanceof BackupDamagedError ? { status: 422, body: { error: e.message } } : undefined,
  (e) => e instanceof BackupTooNewError ? { status: 409, body: { error: e.message } } : undefined,
  (e) => e instanceof RestoreTargetError ? { status: 409, body: { error: e.message } } : undefined,
];
