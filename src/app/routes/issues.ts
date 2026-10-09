import {
  evidenceState,
  issueDescState,
  mergeUsedIn,
  ownStatementOnly,
  userRemoved,
} from "../../core/checking.ts";
import { cantCheck } from "../../core/claimcheck.ts";
import {
  type EvidenceRow,
  type IssueRow,
  parseSourceRef,
  type Stance,
  STANCES,
} from "../../core/publicdb.ts";
import { checkFlags, notesOut, refuseCantCheck, usedInOut } from "./chronology.ts";
import {
  type ErrorMapper,
  HttpError,
  num,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/** Issues and the evidence linked to them. */
export function issuesRoutes(ctx: RouteContext): Route[] {
  const { s, show, plain, quote, guardedSave } = ctx;

  const evidenceOut = async (e: EvidenceRow, removedAt: string | null) => {
    const c = await evidenceState(s(), e);
    return {
      id: e.id,
      issue_id: e.issue_id,
      doc_id: e.doc_id,
      line_start: e.line_start,
      line_end: e.line_end,
      stance: e.stance,
      note: show(e.note),
      created_by: await s().isUserItem("evidence", e) ? "user" : "claude",
      verified: c.verified,
      version: await s().itemVersion("evidence", e),
      verified_at: c.verified ? e.verified_at : null,
      state: c.state,
      checks: ctx.checks(c.checks),
      lapsed: c.lapsed,
      ownStatementOnly: await ownStatementOnly(s(), [e]),
      quote: await quote(e.doc_id, e.line_start, e.line_end),
      sources: await ctx.sources([e]),
      removed_at: removedAt,
      usedIn: usedInOut(ctx, s().store.usedIn({ type: "evidence", id: e.id }, [e])),
    };
  };

  /** An issue; `evidence: "live"` lists links the user has not removed, "all" lists every one. */
  const issueOut = async (
    i: IssueRow,
    removedAt: string | null,
    evidence: "live" | "all",
    removed: Awaited<ReturnType<typeof userRemoved>>,
  ) => {
    const c = await issueDescState(s(), i);
    const ev = [];
    const used = [];
    const live: EvidenceRow[] = [];
    for (const e of s().store.listEvidence(i.id, { includeRemoved: true })) {
      const at = await s().ledger.removedByUser("evidence", e);
      if (at !== null && evidence === "live") continue;
      ev.push(await evidenceOut(e, at));
      if (at === null) {
        used.push(s().store.usedIn({ type: "evidence", id: e.id }, [e]));
        live.push(e);
      }
    }
    // Chronology entries bearing on the issue (their sources overlap its evidence): "Used in".
    const chrono = s().store.chronologyForEvidence(live, removed);
    return {
      id: i.id,
      title: show(i.title),
      description: show(i.description),
      created_by: await s().isUserItem("issue", i) ? "user" : "claude",
      verified: c.verified,
      version: await s().itemVersion("issue", i),
      verified_at: c.verified ? i.verified_at : null,
      descState: c.state,
      checks: ctx.checks(c.checks),
      lapsed: c.lapsed,
      removed_at: removedAt,
      usedIn: usedInOut(ctx, mergeUsedIn(used)),
      chronologyCount: chrono.length,
      chronology: chrono.map((r) => ({ id: r.id, event_date: r.event_date })),
      evidence: ev,
      notes: await notesOut(ctx, "issue", String(i.id)),
    };
  };

  /** Withdraw the user's check before their own edit: "To check", not "Changed since…". */
  const refuseRemoved = async (type: "issue" | "evidence", row: IssueRow | EvidenceRow) => {
    if (await s().ledger.removedByUser(type, row) !== null) {
      throw new HttpError(409, "Restore this item before changing it.");
    }
  };

  const stanceOf = (v: unknown): Stance | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || !STANCES.includes(v as Stance)) {
      throw new HttpError(400, `stance is one of ${STANCES.join(", ")}`);
    }
    return v as Stance;
  };

  return [
    // ── issues & evidence ───────────────────────────────────────────────────
    route("GET", "/api/issues", async ({ url }) => {
      const wantRemoved = url.searchParams.get("removed") === "1";
      // public.db's removed_at is Claude-writable: what the user removed comes from the ledger.
      await s().ledger.reconcileMarks();
      const removed = await userRemoved(s());
      const out = [];
      for (const i of s().store.listIssues({ includeRemoved: true })) {
        const at = await s().ledger.removedByUser("issue", i);
        if ((at !== null) !== wantRemoved) continue;
        out.push(await issueOut(i, at, wantRemoved ? "all" : "live", removed));
      }
      return out;
    }),
    route("POST", "/api/issues", async ({ body }) => {
      const b = await body();
      const issue = {
        title: await s().tokeniseUserText(str(b.title, "title")),
        description: b.description ? await s().tokeniseUserText(String(b.description)) : "",
      };
      const id = s().store.addIssue(issue, "user");
      await s().recordUserItem("issue", id, issue);
      return { id };
    }),
    // The user edits an issue's title or description (real names allowed; tokenised). Like a
    // chronology edit, it withdraws their check of the description, and may not keep a name that
    // Claude wrote as plain text (probe guard, ADR 3).
    route("PATCH", "/api/issues/:id", async ({ params, body }) => {
      const b = await body();
      const id = num(params.id, "id");
      const cur = s().store.getIssue(id);
      await refuseRemoved("issue", cur);
      const title = b.title === undefined ? undefined : str(b.title, "title");
      const desc = b.description === undefined || b.description === null
        ? undefined
        : typeof b.description === "string"
        ? b.description
        : (() => {
          throw new HttpError(400, "description must be text");
        })();
      const titleChanged = title !== undefined && title !== plain(cur.title);
      const descChanged = desc !== undefined && desc !== (plain(cur.description) ?? "");
      await guardedSave(`issue:${id}`, [
        ...(titleChanged ? [[title!, [cur.title]] as [string, string[]]] : []),
        ...(descChanged ? [[desc!, [cur.description]] as [string, string[]]] : []),
      ]);
      if (!titleChanged && !descChanged) return { ok: true, changed: false };
      const wasUsers = await s().isUserItem("issue", cur);
      const patch = {
        title: titleChanged ? await s().tokeniseUserText(title!) : undefined,
        description: descChanged ? (desc ? await s().tokeniseUserText(desc) : "") : undefined,
      };
      await s().unverify("issue", id);
      s().store.updateIssue(id, patch);
      if (wasUsers) {
        await s().recordUserItem("issue", id, {
          title: patch.title ?? cur.title,
          description: patch.description ?? cur.description,
        });
      }
      s().log("user", "issue_edited", {
        issue: id,
        title: titleChanged,
        description: descChanged,
      });
      return { ok: true, changed: true };
    }),
    route("DELETE", "/api/issues/:id", async ({ params }) => {
      const id = num(params.id, "id");
      s().store.getIssue(id);
      await s().ledger.forgetMarks("issue", id);
      for (const e of s().store.listEvidence(id, { includeRemoved: true })) {
        await s().ledger.forgetMarks("evidence", e.id);
      }
      await s().deleteIssue(id);
      return { ok: true };
    }),
    route("POST", "/api/issues/:id/remove", async ({ params }) => {
      const id = num(params.id, "id");
      await s().ledger.removeItem("issue", id);
      const used = s().store.listEvidence(id, { includeRemoved: true }).map((e) =>
        s().store.usedIn({ type: "evidence", id: e.id }, [e])
      );
      return { ok: true, usedIn: usedInOut(ctx, mergeUsedIn(used)) };
    }),
    route("POST", "/api/issues/:id/restore", async ({ params }) => {
      await s().ledger.restoreItem("issue", num(params.id, "id"));
      return { ok: true };
    }),
    route("POST", "/api/issues/:id/verify", async ({ params, body }) => {
      const b = await body();
      const id = num(params.id, "id");
      const version = str(b.version, "version");
      const flags = checkFlags(b, ["neutral"]);
      const c = await issueDescState(s(), s().store.getIssue(id));
      if (cantCheck(c.checks)) refuseCantCheck(ctx, c.checks);
      await s().ledger.verifyIssue(id, version, flags);
      return { ok: true };
    }),
    route("POST", "/api/issues/:id/unverify", async ({ params }) => {
      await s().unverify("issue", num(params.id, "id"));
      return { ok: true };
    }),
    route("POST", "/api/issues/:id/evidence", async ({ params, body }) => {
      const b = await body();
      const issueId = num(params.id, "id");
      const ev = {
        ...parseSourceRef(str(b.source, "source")),
        note: b.note ? await s().tokeniseUserText(String(b.note)) : "",
        stance: b.stance || "supports",
      };
      const id = s().store.addEvidence(issueId, ev, "user");
      await s().recordUserItem("evidence", id, { ...ev, issue_id: issueId });
      return { id };
    }),
    // Evidence links the user removed (with their issue's title).
    route("GET", "/api/evidence", async ({ url }) => {
      if (url.searchParams.get("removed") !== "1") {
        throw new HttpError(400, "Use /api/issues for evidence; ?removed=1 lists removed links");
      }
      await s().ledger.reconcileMarks();
      const out = [];
      for (const i of s().store.listIssues({ includeRemoved: true })) {
        for (const e of s().store.listEvidence(i.id, { includeRemoved: true })) {
          const at = await s().ledger.removedByUser("evidence", e);
          if (at === null) continue;
          out.push({ ...(await evidenceOut(e, at)), issueTitle: plain(i.title) });
        }
      }
      return out;
    }),
    // The user edits an evidence link's note or stance. Withdraws their check ("To check");
    // a changed note may not keep a name Claude wrote as plain text (probe guard, ADR 3).
    route("PATCH", "/api/evidence/:id", async ({ params, body }) => {
      const b = await body();
      const id = num(params.id, "id");
      const cur = s().store.getEvidence(id);
      await refuseRemoved("evidence", cur);
      const stance = stanceOf(b.stance);
      const note = b.note === undefined || b.note === null
        ? undefined
        : typeof b.note === "string"
        ? b.note
        : (() => {
          throw new HttpError(400, "note must be text");
        })();
      const noteChanged = note !== undefined && note !== (plain(cur.note) ?? "");
      const stanceChanged = stance !== undefined && stance !== cur.stance;
      await guardedSave(`evidence:${id}`, noteChanged ? [[note!, [cur.note]]] : []);
      if (!noteChanged && !stanceChanged) return { ok: true, changed: false };
      const wasUsers = await s().isUserItem("evidence", cur);
      const patch = {
        note: noteChanged ? (note ? await s().tokeniseUserText(note) : "") : undefined,
        stance: stanceChanged ? stance : undefined,
      };
      await s().unverify("evidence", id);
      s().store.updateEvidence(id, patch);
      if (wasUsers) {
        const after = s().store.getEvidence(id);
        await s().recordUserItem("evidence", id, {
          doc_id: after.doc_id,
          line_start: after.line_start,
          line_end: after.line_end,
          note: patch.note ?? cur.note,
          stance: patch.stance ?? cur.stance,
          issue_id: cur.issue_id,
        });
      }
      s().log("user", "evidence_edited", {
        evidence: id,
        note: noteChanged,
        stance: stanceChanged,
      });
      return { ok: true, changed: true };
    }),
    route("DELETE", "/api/evidence/:id", async ({ params }) => {
      const id = num(params.id, "id");
      s().store.getEvidence(id);
      await s().ledger.forgetMarks("evidence", id);
      await s().deleteEvidence(id);
      return { ok: true };
    }),
    route("POST", "/api/evidence/:id/remove", async ({ params }) => {
      const id = num(params.id, "id");
      const e = s().store.getEvidence(id);
      await s().ledger.removeItem("evidence", id);
      return {
        ok: true,
        usedIn: usedInOut(ctx, s().store.usedIn({ type: "evidence", id }, [e])),
      };
    }),
    route("POST", "/api/evidence/:id/restore", async ({ params }) => {
      await s().ledger.restoreItem("evidence", num(params.id, "id"));
      return { ok: true };
    }),
    route("POST", "/api/evidence/:id/verify", async ({ params, body }) => {
      const b = await body();
      const id = num(params.id, "id");
      const version = str(b.version, "version");
      const flags = checkFlags(b, ["quoteAccurate", "fairReading"]);
      const c = await evidenceState(s(), s().store.getEvidence(id));
      if (cantCheck(c.checks)) refuseCantCheck(ctx, c.checks);
      await s().ledger.verifyEvidence(id, version, flags);
      return { ok: true };
    }),
    route("POST", "/api/evidence/:id/unverify", async ({ params }) => {
      await s().unverify("evidence", num(params.id, "id"));
      return { ok: true };
    }),
  ];
}

export const issuesErrors: ErrorMapper[] = [];
