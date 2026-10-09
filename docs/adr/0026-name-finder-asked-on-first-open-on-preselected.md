# 26. The name finder is asked about the first time a case is opened, with "On" chosen

Date: 2026-10-09
Status: Accepted. Changes the default in ADR 12 ("off by default (`nerEnabled`)").

## Context

ADR 12 made the name finder (pinned `Xenova/bert-base-NER` through transformers.js) optional and
off by default, because it downloads about 110 MB from Hugging Face the first time it runs. Off,
casefile finds only identifiers and names already in who's who, so a new name in a document is
caught only if the user spots it on review. Most users never found the switch in Settings, so
most cases ran with rules only. Turning the switch on also downloaded the model silently, at the
first import after it, and a failure showed up only then, as a detector error on that document.

The user decided the name finder should be on by default, but never downloaded without asking.

## Decision

1. **Asked once, on first open.** When a case is opened (or created) and the user has never
   answered (`settings.nameFinderAsked` unset) and the name finder is not already on, the app asks
   "Turn on the name finder?" with **On** chosen. The question says plainly that it downloads about
   110 MB once from Hugging Face, pinned to one revision and checked against recorded hashes, and
   then runs on this computer. Closing it without answering leaves the name finder off and asks
   again the next time the case is opened. Existing cases with the name finder off are asked once,
   the first time this version opens them.
2. **Downloaded only on that answer, there and then.** `POST /api/settings/name-finder {on}` is the
   one way to turn it on (the question and the Settings switch both use it). With `on: true` the
   app gets the model ready before answering (`AppStateOptions.nameFinderLoader`: the same pinned,
   hash-checked load as ADR 12, downloading the first time), so the user waits for it knowingly
   and is told the outcome. `nerEnabled` stays false until the user answers, so no other path
   downloads it.
3. **A decline or a failure leaves the case working.** If the user chooses Off, or the download
   fails (offline, Hugging Face unreachable, files that don't match the pins), the name finder
   stays off and the case opens and works with rules and known names only. The app says so, in
   the words already used ("Name finding is off…"), in the result, in Settings and on the review
   screen, and the user can turn it on later in Settings.
4. **Recorded.** The answer and its time are kept in the vault settings; the log gets
   `name_finder_chosen {asked_on, on}` (nothing about why a download failed). `PUT /api/settings`
   with `nerEnabled` (scripts and older screens) also counts as an answer.

## Consequences

- New cases get the name finder unless the user says no, so names casefile doesn't know yet are
  found far more often.
- The download happens while the user watches, once per computer; a later case on the same
  computer loads the verified copy from the model folder (ADR 12) without downloading again.
- The safety boundary is unchanged: the model runs on this computer, document text never leaves
  it, and a model that fails its pins is never used (ADR 12). Detection with the name finder on
  but failing still fails closed (ADR 6).
