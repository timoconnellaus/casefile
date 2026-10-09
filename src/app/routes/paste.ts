import { checkClaim, type CitedLines, splitSentences } from "../../core/claimcheck.ts";
import { citableLines, entityKinds } from "../../core/drafting.ts";
import { formatSourceRef } from "../../core/publicdb.ts";
import {
  type ErrorMapper,
  HttpError,
  num,
  type Route,
  route,
  type RouteContext,
  str,
} from "./context.ts";

/** Most text the paste screen takes at once (characters). */
const MAX_PASTE_CHARS = 200_000;
/** Most paragraphs one "Add to a draft" adds. */
const MAX_PASTE_PARAGRAPHS = 200;

/**
 * Per sentence: ✓ every check casefile made against the cited lines passed; ● not checked (no
 * citation, or something to look at); ▲ can't check (a citation that can't be quoted, a check
 * that failed badly, or a name token casefile doesn't know).
 */
export type PasteSentenceState = "checked" | "not_checked" | "cant_check";

function pasteText(v: unknown): string {
  const text = str(v, "text");
  if (text.length > MAX_PASTE_CHARS) {
    throw new HttpError(
      400,
      `That is too long to paste at once (over ${MAX_PASTE_CHARS} characters)`,
    );
  }
  return text;
}

/** Paragraphs are separated by blank lines. */
function paragraphsOf(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/**
 * Paste (ADR 0019): the user pastes what Claude wrote (names replaced) to read it with real names,
 * checked sentence by sentence against the lines it cites. Every use is logged with counts only,
 * never the text.
 */
export function pasteRoutes(ctx: RouteContext): Route[] {
  const { s, show, guardedSave } = ctx;
  return [
    route("POST", "/api/paste/view", async ({ body }) => {
      const text = pasteText((await body()).text);
      const kinds = entityKinds(s());
      // Sentences paragraph by paragraph, so each carries its paragraph's index (0-based, the
      // paragraphs `paragraphsOf` finds, as "Add to a draft" splits them).
      const split = paragraphsOf(text).flatMap((p, paragraph) =>
        splitSentences(p).map((sen) => ({ ...sen, paragraph }))
      );
      const sentences = await Promise.all(
        split.map(async (sen) => {
          const rich = show(sen.text);
          const cited: CitedLines[] = [];
          let uncitable = false;
          for (const ref of sen.cites) {
            const lines = await citableLines(s(), ref);
            if (lines) cited.push({ ref, lines });
            else uncitable = true;
          }
          const checks = cited.length ? checkClaim(sen.text, cited, kinds) : [];
          const state: PasteSentenceState =
            uncitable || rich.unknown.length || rich.malformed.length ||
              checks.some((c) => c.level === "danger" || c.ok === null)
              ? "cant_check"
              : sen.cites.length && checks.length && checks.every((c) => c.level === "ok")
              ? "checked"
              : "not_checked";
          return {
            paragraph: sen.paragraph,
            text: rich,
            cites: sen.cites.map(formatSourceRef),
            checks: ctx.checks(checks),
            state,
          };
        }),
      );
      const rich = show(text);
      // Someone marked safety-sensitive is named: the screen warns before the text is copied.
      const safetyRoles = new Set(
        s().registry.safetyRoles(),
      );
      const safety = [
        ...new Set(
          rich.segs.flatMap((g) => "role" in g && safetyRoles.has(g.role) ? [g.role] : []),
        ),
      ].map((role) => ({ role, name: s().registry.resolve(role, "full") ?? role }));
      s().log("user", "paste_viewed", {
        chars: text.length,
        paragraphs: paragraphsOf(text).length,
        sentences: sentences.length,
        unknown: rich.unknown.length,
        ...(safety.length ? { safety: safety.length } : {}),
      });
      return {
        rich,
        sentences,
        paragraphs: paragraphsOf(text).length,
        unknown: rich.unknown,
        malformed: rich.malformed,
        safety,
      };
    }),
    route("POST", "/api/paste/copied", async ({ body }) => {
      const b = await body();
      const chars = typeof b.chars === "number" && Number.isInteger(b.chars) && b.chars >= 0
        ? b.chars
        : undefined;
      if (b.safetyConfirmed !== undefined && b.safetyConfirmed !== true) {
        throw new HttpError(400, "safetyConfirmed must be true when sent");
      }
      s().log("user", "paste_copied", {
        ...(chars === undefined ? {} : { chars }),
        // The user was warned that it names someone marked safety-sensitive, and copied anyway.
        ...(b.safetyConfirmed === true ? { safety_confirmed: true } : {}),
      });
      return { ok: true };
    }),
    route("POST", "/api/paste/add-to-draft", async ({ body }) => {
      const b = await body();
      const draftId = num(String(b.draftId), "draftId");
      const text = pasteText(b.text);
      s().store.getDraft(draftId);
      const paras = paragraphsOf(text);
      if (!paras.length) throw new HttpError(400, "Nothing to add");
      if (paras.length > MAX_PASTE_PARAGRAPHS) {
        throw new HttpError(400, `At most ${MAX_PASTE_PARAGRAPHS} paragraphs at once`);
      }
      // This is Claude's text. A known value it holds as plain text must not be tokenised, or the
      // stored paragraph would tell Claude which of its guesses were real names (probing).
      await guardedSave(`paste:draft:${draftId}`, [[text, [text]]]);
      // Tokenise (and detection-check) everything before storing anything.
      const bodies: string[] = [];
      for (const p of paras) bodies.push(await s().tokeniseUserText(p));
      const ids = bodies.map((body) => s().store.addParagraph(draftId, body, "claude"));
      s().log("user", "paste_added", { draft: draftId, paragraphs: ids.length });
      return { ids, state: "claude_needs_you" };
    }),
  ];
}

export const pasteErrors: ErrorMapper[] = [];
