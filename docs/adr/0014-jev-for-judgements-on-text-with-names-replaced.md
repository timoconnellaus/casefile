# 14. Jev (TypeSafe) for judgements, only on text with names replaced

Date: 2026-10-07
Status: Accepted; implemented (see the amendment)

## Context

Several checks the design review asked for are bounded judgements rather than text generation:

- does this cited line support this claim?
- is this sentence a direct quote, or an interpretation of the source?
- does this affidavit paragraph state the witness's feelings or opinions?
- does this text cite a case or legislation (so it goes on the "law to check" list)?
- could this detail still identify someone (a rare event, a small-town detail)?
- does this document look like subpoenaed or produced material?

Jev, by TypeSafe AI, is a hosted decision model with typed answers: choice, probability and score,
with confidence. That suits these checks better than prompting a chat model and parsing its reply.
The user already uses Jev.

TypeSafe's published terms, checked 2026-10-07:

- **Training.** "We will not train or fine tune any artificial intelligence or machine learning
  models on your prompts or other Input." This applies by default, not only on a paid tier.
  Sources: <https://typesafe.ai/legal/privacy-policy>, <https://docs.typesafe.ai/models>.
- **Retention.** No period is stated for ordinary accounts ("as long as reasonably necessary").
  Zero data retention (ZDR) is offered to enterprise customers only, through sales@typesafe.ai.
  Source: <https://docs.typesafe.ai/legal>.
- **Location.** "The Services are hosted in the United States."
- **Deployment.** No self-hosted or on-premises option is documented.

Relevant parts of FCFCOA PD-AI: 3.3 (safety), 4.18–4.19 (read the tool's terms and be satisfied
about its safeguards), 4.11 (be able to say which AI was used and how), 5.2 (identifying
publication offence), 5.4 (no confidential or sensitive information in a public tool) and 5.5
(restricted material needs all three conditions).

## Decision

Use of Jev depends on what text it would see:

| Text | Jev allowed? |
|---|---|
| Originals (un-redacted) | **Never.** |
| Names replaced, ordinary documents | **Yes**, opt-in, recorded in the AI-use log. |
| Names replaced, restricted material (discovery, subpoena, under an order, "not sure") | **No**, unless the user confirms an agreement that meets all three PD-AI 5.5 conditions. |

1. **Originals.** Detection on original text stays on the user's computer (ADR 12). Under
   standard terms, confidentiality is not assured: retention is unstated and the service is
   hosted in the US. PD-AI 3.3, 5.2 and 5.4 rule this out, and so does casefile's founding rule
   (ADR 3) that originals never leave the computer.
2. **Text with names replaced, ordinary documents.** Jev may see exactly what Claude may see,
   which is the contents of `public.db` for documents that are not withheld. This text has the
   same basis as sharing it with Claude. Replacing names is what PD-AI 5.4 requires before any
   public tool is used, and TypeSafe's no-training term is at least as protective as the user's
   consumer Claude plan. Conditions:
   - **Off by default.** The user turns it on in Settings, where TypeSafe's terms are linked
     (PD-AI 4.18).
   - **Recorded.** Turning it on, every call (by type of check and document id, never content)
     and turning it off go into the AI-use log, and the Court summary lists Jev as a separate
     AI tool (PD-AI 4.11).
   - **Flags only.** Jev's answers only raise things for the user to look at. They never mark
     anything as checked, never adopt or change text, and never decide what is shared. Every
     threshold and every consequence lives in casefile's code.
   - **Least data.** Each call sends the smallest state the question needs, for example one
     claim and its cited lines, not a whole document.
3. **Restricted material.** Jev never receives withheld documents, the same rule as for Claude
   (ADR 7). The no-training term covers only one of PD-AI 5.5's three conditions. The other two,
   a closed environment under enforceable confidentiality terms and use only for this
   proceeding, are not shown for a standard account with unstated retention. This could only
   change under an enterprise agreement with ZDR and a signed data processing agreement, after
   the user confirms all three conditions in casefile. That is the same gate as the
   "commercial" Claude plan, recorded separately for Jev.

### One judgement interface, three backends

casefile defines a single `Judge` interface for these checks: typed questions and typed answers
with a probability or confidence. It has three interchangeable backends:

- **On this computer (default).** A pinned zero-shot classifier run through transformers.js,
  verified and loaded the same way as the name finder (ADR 12). Good for coarse labels (feeling
  or opinion versus fact, mentions of law, document kind); weaker on claim support.
- **A language model on this computer.** The OpenAI-compatible local endpoint from ADR 12, with
  structured output. Same locality rules.
- **Jev.** Opt-in, text with names replaced only, under the rules above.

The local backends may see original text where a check needs it; Jev may not. Every backend
receives the same question shape. Thresholds
are calibrated on the synthetic test set for each backend separately: a threshold is never
carried over from one backend, question wording or model version to another without
re-evaluation.

## Consequences

- casefile can use typed, confidence-gated judgements to make the user's checking more
  meaningful (PD-AI 4.7) without new exposure of originals.
- Turning Jev on adds a second AI provider the user must be able to explain to the Court. The
  AI-use log and Court summary make that explicit.
- If TypeSafe's terms change, for example to allow training or to state a different retention
  or location, this decision must be revisited. Settings shows the date the terms were last
  checked.
- Implementation is future work: the `Judge` interface, the local classifier backend, the Jev
  client (server-side API key in the vault, never in the UI), logging, and calibration tests on
  the synthetic fixtures.
- Not legal advice. This records the project's reading of PD-AI against TypeSafe's published
  terms as at 2026-10-07.

## Amendment: what was built (2026-10-09)

The `Judge` interface and its three backends are built in `src/core/judge/`. Where this differs
from the decision above, this amendment says so and why.

**One reviewable module.** `judge/questions.ts` holds every question (instructions and criteria in
Jev's typed shape), the state fields each reads, the local classifier's recipe, the threshold and
calibration record per backend, the wording of each flag, and the policy that turns an answer into
a flag. Three questions are built: `feeling_or_opinion` (a sentence of a draft gives the witness's
feelings or opinions), `fair_reading` (Claude's note, or a cited draft sentence, against its cited
lines) and `origin_hint` (a shared document's title and first 15 lines; it flags only when the
judged origin is stricter than the one the user gave). The other checks in the Context list (direct
quote, law to check, quasi-identifiers) are not built. Arithmetic, dates, lookups and every rule
stay in code: the existing deterministic checks are unchanged.

**What a judge may see: the same for every backend.** The decision allowed the local backends to
see originals where a check needs one. None of the built checks needs one, so all three backends
get the same text, built only by `judge/texts.ts`: document text only from documents shared with
Claude now, as `publishedView` gives it; Claude's notes and draft sentences as public.db holds
them; and a leak check of every field against who's who as it is now (values the cited documents
leave as written are allowed, as for Claude). An item citing a document that is withheld, exposed
or not yet reviewed is not sent at all, and the user sees why. `JudgeState` is a branded type only
`texts.ts` constructs, so a backend cannot be handed anything else by mistake.

**Backends.**

- *On this computer* (the default): `Xenova/nli-deberta-v3-xsmall` (ONNX q8, about 87 MB), an NLI
  model, pinned by commit and SHA-256 of each file and served from memory exactly as the name
  finder is (ADR 12; the pinned loader in `detect/ner.ts` is now shared, `withPinnedModel`). It
  was chosen over `mobilebert-uncased-mnli` and `distilbert-base-uncased-mnli` on the evaluation
  set. NLI cannot read instructions, so each question carries a recipe: the claim against its
  cited lines (`pair`), one fixed hypothesis (`single`), or one hypothesis per option (`labels`).
  Labels such as `{{father.first}}` are shown to it as plain role words ("father").
- *A language model*: the one set up under Finding names, under ADR 12's rules unchanged (local
  confirmed, or `trustLocalServer`, or `allowRemote`; checked before every check; no redirects; no
  echo). It gets the same questions as Jev and answers in JSON. Requests now send
  `"reasoning_effort": "none"`: with thinking on, `qwen/qwen3.6-35b-a3b` in LM Studio did not
  finish a chunk within 120 s; without, it answers in about 2–20 s. A server that rejects
  `response_format` or `reasoning_effort` (400) is asked again without one, then the other, then
  both, and the working combination is remembered. The name pass (`LlmDetector`) shares this
  client (`ChatCompletions`).
- *Jev*: `POST https://api.typesafe.ai/v1/systemone` with the model pinned to `jev-1.13.0` (not
  the `jev-latest` alias, which could change answers without a code change), no redirects, one
  retry on 429/529, and no echo of replies.

**Jev's conditions, as built.** Off by default. Turning it on needs a saved key and the typed
phrase "send to Jev" (checked by the server, not only the screen). Settings links TypeSafe's
privacy policy and legal terms and says when casefile last checked them (`JEV_TERMS.checked`,
2026-10-07). The key is kept in the vault's settings (`judge.jevKey`), used only by the server, and
never returned by any API (Settings shows only whether one is saved), logged or written to
public.db; a test scans every response, the log, and every file in the case and config folders for
it. Turning Jev on and off, and saving or removing the key, are logged; the Court summary lists Jev
as a second AI tool with the periods it was on and how many questions it answered, and says it
never saw originals or withheld documents.

**Logging: counts only, stricter than the decision.** The decision said every call would be logged
"by type of check and document id". It is logged instead as one `judge_ran` row per item with only
`backend`, `judgements` and `flags` (and `failed` when it failed). An item id next to a flag count
would tell Claude, who can read the log, what the extra check thought of its work. "Test the
connection" sends one fixed invented sentence and logs `judge_tested {backend, ok}`.

**Flags only.** A flag is a `JudgeFlag` (`states.ts`), never a `CheckRow`, so it cannot make an
item "Can't check". The judge writes nothing but its log row; nothing that marks an item checked,
adopted or shared imports it (a test checks the import graph, and that public.db, every state and
the To-check queue are unchanged after flags). Flags appear on request ("Ask casefile's extra
check") on chronology entries and evidence by Claude, on paragraphs being adopted or rewritten, and
on shared documents; they are never computed in the background.

**Calibration.** `tests/fixtures/judge_eval.ts` is a labelled synthetic set (36 sentences, 28 claim
and citation pairs, 18 document openings). `deno task judge-eval <backend>` scores a backend and
picks the threshold with the best F1 (midpoint of the widest gap on ties); the results are recorded
next to the questions, and `tests/judge_calibration_test.ts` re-runs them when the model is
available. On 2026-10-09:

| Question | On this computer (deberta-v3-xsmall) | Language model (qwen3.6-35b-a3b, LM Studio) | Jev (jev-1.13.0) |
|---|---|---|---|
| feeling or opinion | threshold 0.998: precision 85%, recall 94% | 0.5: 100%, 100% | 0.475: 100%, 100% |
| fair reading | 0.7027: precision 88%, recall 100% | 0.525: 93%, 93% | 0.79: 100%, 100% |
| origin hint | 0.5893: precision 100%, recall 92% | 0.495: 100%, 83% | 0.075: 100%, 100% |

These figures are optimistic: the set is small, and the local recipes' hypotheses were chosen on it.
The language model's figures hold only for that model. Jev's origin threshold is low because its
scores are: the father's affidavit scored 0.09 and the user's own text messages 0.06, so the margin
is thin; a false flag only asks the user to look again.

**Open.** A larger, held-out evaluation set (in particular more documents from the other side, where
Jev's origin margin is thin); whether the extra checks should use their own language model
setting rather than the one under Finding names; the unbuilt checks listed above.
