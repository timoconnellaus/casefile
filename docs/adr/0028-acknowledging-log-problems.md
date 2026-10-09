# 28. Acknowledging recorded log problems

Date: 2026-10-09
Status: Accepted

## Context

ADR 8 (amendment "problems found in the log are recorded and never cleared") made every problem
casefile finds in the AI-use log permanent: a lost or damaged record of the last entry, entries
cut from or changed at the end of the log, missing settings. Each is kept in the vault's settings
(`CaseSettings.logProblems`), the log check reports the log as not intact from then on, the Log
screen shows a red warning, and the Court summary (ADR 18) says "Log checked: casefile found a
problem (…)".

That is right for the record, but the warning never changes. A user who has read it, and perhaps
explained it to the Court, sees the same alarm every time they open the Log, with no way to say
"I know". Worse, a second problem found later looks exactly like the first, so it is easy to miss.
A crash that loses the last database rows while the fsynced head survives can also record a false
`tail_changed` problem (ADR 8 amendment), which the user has no way to put to rest.

## Decision

The user can **acknowledge** each recorded log problem, one at a time, on the Log screen.

- **The problem is kept.** Acknowledging never deletes, edits or hides a problem. `logProblems`
  stays append-only; the log check still reports the log as not intact and still lists every
  recorded problem (`LogCheck.recorded`), each with `acknowledged: {at}` once acknowledged.
- **The acknowledgement is its own record.** `CaseSettings.logProblemAcks` (vault, app only) holds
  `{at, problemAt, kind}` per acknowledgement, matched to a problem by its `at` and `kind` (which
  never change). Like `logProblems`, the session keeps its own copy and `saveSettings` always
  writes it, so no settings change can drop one, and `updateSettings` cannot set it. Only
  `CaseSession.acknowledgeLogProblem(n)` (`POST /api/log/problems/:n/acknowledge`, `n` = 1 for the
  oldest) adds to it. A problem can be acknowledged once (409 after that); an unknown number is
  404. Nothing about it is written to public.db except the log entry below, so Claude can neither
  make nor undo an acknowledgement.
- **It is logged.** After the vault write, the app writes a sealed user entry
  `log_problem_acknowledged {problem, kind, found, after?}` to the hash-chained log: when (the
  entry's time) and which problem (its number, kind, when it was found and, for `tail_changed`,
  the entry after which the log changed). The readable log shows "You acknowledged a problem
  casefile found in the log".
- **The warning shrinks.** On the Log screen an acknowledged problem becomes one quiet line ("Log
  problem found on …: …. Acknowledged by you on …; still listed in “If the Court asks”"). The red
  warning stays while any recorded problem is not acknowledged, or while checking the chain finds
  something now (`LogCheck.chainProblem`, which cannot be acknowledged). It leads with the oldest
  problem not yet acknowledged, so **a problem recorded later shows the full warning again**.
- **The Court summary still lists it.** The record section lists every recorded problem once there
  is more than one or any is acknowledged: "Problem found on <date>: <what>; acknowledged by you
  on <date>." When every problem is acknowledged and the chain shows nothing new, the first line
  reads "Log checked: casefile found a problem earlier, listed below. Figures above that come from
  the log may be affected." The wording is in core (`summary.ts`), as ADR 18 requires.
- Acknowledging is the user's statement that they have seen the problem. It does not say the log is
  sound, and no screen or summary line says so.

## Consequences

- The public.db schema does not change (the log entry is an ordinary `ai_log` row). Vault settings
  gain an optional field. Older builds carry unknown settings fields through their writes but
  ignore this one, so a case opened in an older build shows the full warning again; the
  acknowledgement is not lost.
- Someone who can delete the whole vault can delete acknowledgements along with the problems (ADR
  8's limitation is unchanged).
- A false `tail_changed` problem after a crash can now be acknowledged; it is still reported.
- Tests: `tests/log_ack_test.ts` (acknowledging, the log entry and the chain, the summary wording,
  a new problem after an acknowledgement).
