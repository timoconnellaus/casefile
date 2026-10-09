# 15. Entity colour slots, relationship descriptions and the safety flag

Date: 2026-10-07
Status: Accepted

## Context

The v2 design (docs/rebuild/DESIGN-SPEC.md §4, CANON.md) gives who's who three new attributes:

- a **colour** for the parties and children, from a six-hue colour-blind-safe palette, with
  everyone else in neutral ink;
- a **relationship description** the user writes ("the children's maternal grandmother"), which
  Claude reads so it understands who a role is without being told a name;
- a **safety-sensitive** flag (e.g. a parent at risk), which tightens how that person's values are
  handled in the app.

It also adds screens that read the vault on the user's behalf: where a person appears, what adding
a nickname would touch, and a search across the whole case. The question for each is what, if
anything, may reach `public.db` (ADR 3).

## Decision

**Colour slots.** `Entity.colour` is a palette *index* (0–5) or null (neutral ink), kept in the
vault's entity registry. `PALETTE` in `entities.ts` holds the hex values for the UI; neither the
index nor the hex is ever written to `public.db` (`saveRegistry` publishes only role, kind and
description). New entities with the roles `mother`, `father`, `child_1`, `child_2` get slots 0–3
if free (on `add`, on renaming to such a role, and when an older registry without colours is
loaded; an explicit null, meaning the user chose neutral, is kept). A slot belongs to at most one
entity: `setColour` refuses a taken slot (`ColourTakenError`, HTTP 409 with the owner), so the user
frees it first. Colour is presentation, not evidence: it is not signed or logged.

**Relationship description.** `Entity.description` is stored tokenised in the vault and published
to `entities.description`, where the CLI prints it. Because Claude reads it, it must not carry any
value, even one casefile could replace with a token: the description describes the relationship,
and "Anna's mother" tokenised to `{{mother.first}}'s mother` still tells Claude the user wrote a
name there. So `checkDescription` (people.ts):

1. refuses the text if `findLeaks` finds anything in it as typed (known values in any form,
   aliases, identifying parts such as a suburb or middle name, identifier-like strings);
2. passes it through `tokeniseUserText`, whose detectors refuse names not yet in who's who and
   which fails closed if a detector fails;
3. refuses unknown or malformed tokens. Tokens of known roles the user types (`{{child_1}}`) are
   allowed; they are what Claude already sees.

Every check runs before anything is written, so a refused description leaves `public.db` unchanged.
Claude never writes descriptions, so the probe guard (ADR 3) does not apply. Renaming a role
rewrites it in every description, as `renameRoleInText` does in public.db. The log row for an
entity change stays `entity_updated {role}`, with no field names or values.

**Safety flag.** `Entity.safety` is kept in the vault only (whether someone is at risk is not
Claude's business, and the role name already says who they are to the case). It is shown in who's
who; the publish gate that refuses to leave a safety-sensitive value as written belongs to ADR 6/7
(W1-B) and the UI warnings to the People screen.

**Reading the vault for the user.** Who's who counts (`docs`, `mentions`), "where she appears"
(`/api/entities/:role/usage`), nickname impact (`/api/entities/:role/alias-impact`) and
`/api/search/all` read the vault's originals, replacements and tokenised text. They are app API
only: they need the session cookie (ADR 13), they write nothing to `public.db` (no log rows), and
`people.ts` is outside the CLI's module graph (`tests/boundary_test.ts`). Nickname impact uses the
same matcher as the leak check (`findKnownSpans`), so "would expose" agrees with what adding the
alias then finds. Search reads the vault rather than public.db's full-text index, which Claude can
write to: its totals are true counts of what the case holds, and include withheld documents and
documents still to review (the user may see everything).

## Consequences

- An older case gets colours for its parties and children on next open without a migration; the
  registry is saved with them the next time anything changes it.
- A description cannot use the person's own name or nickname even though the app could tokenise
  it; the error tells the user to describe the relationship. Typing a token is the way to refer to
  another person.
- Search across 300+ documents decrypts each once per session (the session caches documents);
  every query then scans the cached text. This is fine at the expected size; an index in the vault
  would be a later optimisation, not a format change.
- Document state in usage and search (`needs_review`, `shared`, `withheld`, `exposed`) comes from
  the vault and the vault's exposures file, never from public.db's columns.

## Amendment (security review after merge, 2026-10-07)

The first version checked a description against who's who *before* the rest of the same request
was applied, so `{aliases: ["Annie"], description: "Annie's ex"}` published a nickname; a rename in
the same request was likewise checked before the new values existed. All entity changes now go
through `changeEntity` (people.ts), the only path the app uses:

- the whole change is applied to a copy of the registry first, and every check runs against that
  copy (who's who as it will be) as well as the current registry; nothing is written unless all
  pass;
- every field that reaches public.db is checked: the new role name (valid grammar, no word of any
  value as it will be, no run of four or more digits, which `revealingWords` ignores), every other
  role name (a new value must not make one revealing; rename it first), `kind` (one of
  `ENTITY_KINDS`) and the description;
- a description accepted earlier that a new value now matches (written before the nickname was
  known) is withdrawn (set to null) in the same change, before the save that adds the value, and
  reported as `descriptionsCleared`. What Claude read before is not undone; this is the same kind of
  exposure as ADR 7's for documents.

`CaseSession.updateEntity` and `renameEntity` (session.ts, not this package's file) still apply a
patch without these checks; they have no other caller. Moving `changeEntity`'s checks into them is
left for wave 3.

## Amendment 2 (security review, 2026-10-07): name words and concurrent changes

**Every name word identifies.** A word of a person's full name that was not a form (e.g.
"Ellery" after the full name became "Margaret Ellery" while the surname form stayed
"Thornbury"), or a word of a several-word nickname, was not matchable, so neither the leak check
nor the description check saw it. `leakOnlyParts` (entities.ts) now adds, for people, every word
of `full` and of every alias that starts with a capital letter, is at least two letters long and
is not a title or a particle (`personNameWords`: de, da, del, van, von, der, bin, binti, ibn, al,
O', D', Jr…; lower-case words are particles by how they are written), plus the parts of
hyphenated and apostrophe'd words ("Smith-Jones" → Smith, Jones; "O'Brien" → Brien). These are
leak-only parts, as middle names were: the leak check and detection find them, tokenising never
uses them, so the longest real form still wins. This changes ADR 6's matching for every published
document, not only descriptions.

**Concurrent changes.** `changeEntity` checks and then awaits (the detectors, a rename) before it
writes, so another request could change who's who in between. Entity changes now run one at a time
per session (`withEntityLock`), and the checks run again synchronously against the registry as it
is immediately before each write (before the rename, and before the update, which changes the
registry before its first await). A publish or import that changed who's who in the meantime is
therefore caught and the change refused. `CaseSession.publish` (session.ts) is not under the lock:
it works on a copy of the registry and replaces `session.registry` with it when it finishes, so an
entity change that lands while a publish is running can be lost (not leaked: the change's own checks
still held against what it wrote, and the publish runs its leak check against its own copy). Taking
`withEntityLock` in `publish` is left to the owner of session.ts.

## Amendment 3 (wave 3, 2026-10-07): whose details these are

The People screen promised that marking someone safety-sensitive would "hide any address you mark
safety-sensitive", because casefile had no way to know which address is *hers*. An entity now has
an optional **`relatedTo`**: the role of the person a detail belongs to (an address, phone, email,
identifier, date of birth, place or organisation).

- **Vault only.** `relatedTo` is kept in the vault's entity registry and never written to
  `public.db`: `saveRegistry` still publishes only role, kind and description. Which address is
  whose is relationship information Claude doesn't need, and with a safety-sensitive person it is
  exactly what must not travel. It is not signed, and the log row stays `entity_updated {role}`.
- **Effective safety.** `EntityRegistry.safetyOf(role)` is the entity's own `safety` flag, or the
  flag of the person it belongs to (`via` names them). The app shows a linked detail of a
  safety-sensitive person as safety-sensitive (hidden on screen until shown) without setting its
  own flag, so unmarking the person, or unlinking the detail, undoes it.
- **Sound links only.** `changeEntity` refuses (before anything is written) a link to an unknown
  role, to something that is not a person, to itself, a person belonging to someone, and a kind
  change that would leave linked details pointing at a non-person. Renaming a person moves the
  links with them; removing an entity clears links to it.
- **API.** `PATCH /api/entities/:role {relatedTo: role|null}`; who's who rows gain `relatedTo` and
  `safetyVia`; `GET /api/entities/:role` returns one row plus `linked` (the person's details).

- **Every path, not just the screen** (security review). `EntityRegistry.isSafetySensitive` /
  `safetyRoles()` are the one definition, used by `CaseSession.honouredIgnore` (so an earlier "leave
  as written" of a linked address stops counting, and the exposure check that runs on every
  registry save withdraws a shared document that shows it), the publish gate (`SafetyError` for a
  new "leave as written"), the review data's `safetyRoles` and the paste warning. So linking an
  address to a safety-sensitive person, or marking the person, protects the address at once, the
  same as marking the address itself.
- **Copies and stale links.** Registry copies (`planChange`, publish) are made with
  `structuredClone`, so a link is never shared by reference. Links can't chain (only non-persons
  link, only to persons), so there are no cycles. A registry loaded with a link that doesn't name
  another person (older or altered data) drops it, so it can't attach later to whoever is next
  given that role.

## Amendment 4 (security review, 2026-10-07): labels as a fallback, and suggested links

Export protection (ADR 21 amendment 1) treats an unlinked non-person entry whose label reads as a
safety-sensitive person's (`mothers_home`, `mother_phone`) as theirs, so a case from before
`relatedTo` keeps its export warning. Elsewhere `isSafetySensitive` stays the one definition and
still reads only the flag and the link: the label is a hint, not a statement about whose a
detail is. To close that gap the app suggests the link (`GET /api/people/link-suggestions`, shown
when a case is opened and on the People screen) and the user confirms it; casefile never links
on its own. Protection for a linked person covers every non-person kind (phone, email,
identifier, date of birth, place, organisation), not only addresses, on export as everywhere
else.
