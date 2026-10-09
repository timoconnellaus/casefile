# 5. Token grammar and line preservation

Date: 2026-10-07
Status: Accepted

## Context

The user asked for tokens that are easy to swap in and out (`{{mother}}`), with the app always
showing real names. People are referred to in several forms ("Anna Thornbury", "Anna",
"Ms Thornbury"), and citations must point at the same lines in the original and tokenised text.

## Decision

- Grammar: `{{role}}`, `{{role.first}}`, `{{role.surname}}`, `{{role.title}}`. A role is
  `[a-z][a-z0-9_]{0,47}`. Anything else that looks like a token is *malformed*.
- `{{role}}` renders the full form; a missing form falls back to the full form.
- The registry learns the title form from what was actually written ("Mr Okafor"), so
  re-identification reproduces the original text exactly.
- Unknown and malformed tokens are reported and shown, never silently dropped. The CLI rejects
  them on write.
- Detection never produces a span across a line break; if a manual span does, its newlines are
  kept after the token. Line *N* of the tokenised text is always line *N* of the original, so a
  citation like `D003:12-15` is valid in both.
- Roles are suggested by the detectors (e.g. `mother`, `child_1`) and confirmed or renamed by the
  user. Renaming rewrites every stored token.

## Consequences

Re-identification is a pure string substitution with a strong round-trip test
(`session_test.ts`: re-identified text equals the original). A value written in an equivalent
but different form (full-width letters, a zero-width space, odd spacing; ADR 6) is tokenised as the
entity and so re-identifies as its stored form: equal to the original after folding, not byte for
byte. Plurals and possessives keep their suffix outside the token ("{{father.surname}}s"). Role names are visible to Claude, so
they must describe a relationship, not identify a person.
