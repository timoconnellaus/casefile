import { notesOut } from "./chronology.ts";
import {
  type ErrorMapper,
  HttpError,
  num,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/** Notes on the case, a document, an entry, an issue or a draft. */
export function notesRoutes(ctx: RouteContext): Route[] {
  const { s } = ctx;
  return [
    // ── notes ───────────────────────────────────────────────────────────────
    route("GET", "/api/notes", async () => {
      // done_at is Claude-writable: "dealt with" comes from the ledger.
      await s().ledger.reconcileMarks();
      return await notesOut(ctx);
    }),
    route("POST", "/api/notes", async ({ body }) => {
      const b = await body();
      const [type, target] = String(b.on ?? "case:case").split(":");
      const note = {
        target_type: type || "case",
        target_id: target || "case",
        body: await s().tokeniseUserText(str(b.text, "text")),
      };
      const id = s().store.addNote(note.target_type, note.target_id, note.body, "user");
      await s().recordUserItem("note", id, note);
      return { id };
    }),
    // Mark a note (usually Claude's) as dealt with, or not ({done:false}).
    route("POST", "/api/notes/:id/done", async ({ params, body }) => {
      const b = await body();
      if (b.done !== undefined && typeof b.done !== "boolean") {
        throw new HttpError(400, "done must be true or false");
      }
      const done = b.done !== false;
      await s().ledger.markNoteDone(num(params.id, "id"), done);
      return { ok: true, done };
    }),
    route("DELETE", "/api/notes/:id", async ({ params }) => {
      const id = num(params.id, "id");
      s().store.getNote(id);
      await s().ledger.forgetMarks("note", id);
      await s().deleteNote(id);
      return { ok: true };
    }),
  ];
}

export const notesErrors: ErrorMapper[] = [];
