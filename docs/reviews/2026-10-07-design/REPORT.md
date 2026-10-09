# casefile design review: synthesis of 16 reviews

Angle codes: **V1** visual-1 · **V2** visual-2 · **F1** features-1 · **F2** features-2 · **S1** stress-1 · **S2** stress-2 · **L1** legal-1 · **L2** legal-2 · **VER** verification · **PRIV** privacy · **A11Y** accessibility · **CS** claude-side · **SC** scale · **BG** build-gap · **DA** devil's advocate · **DEC** decisions

I checked these claims against the files:
- The Chronology "To check" button is pressed while the list still shows verified rows.
- `issues` → `evidence` is `ON DELETE CASCADE` in publicdb.ts.
- `FORMS = ["first","surname","title"]`, so `{{mother.phone}}` is malformed.
- The CLI runs `checkTokens` on chronology writes.
- case.ts has no WebSearch/WebFetch deny.
- PD-AI 4.9 and 5.4 say what the reviewers quote.

---

## 1. Verdict

The mockups have a trustworthy core. Documents are reviewed before Claude sees them. The "You see / Claude sees" view links each name to its token by colour. The Chronology shows Claude's entry next to the source lines it cites. Unknown tokens are flagged. Affidavit export is blocked until Claude's paragraphs are dealt with. The "If the Court asks" summary is written in plain language.

The biggest risks are places where the product says more than it can know:
- A word-similarity score turns Claude's text into "your words".
- The Court summary says Claude only ever saw de-identified copies, while another screen shows a nickname that was never replaced.
- Settings says "vault blocked", which casefile cannot enforce.
- The Paste screen gets real-name Claude text out of the app with no gate and no log entry.

Restricted material is set once per import batch, with "Ordinary" as the default, which makes it the most likely way a PD-AI 5.5 breach happens. On the colour rollout you asked to do first, the idea is sound, but the palette is not ready. It collides with the status colours and fails under colour-blindness simulation, it has no rule for 20 to 40 entities, and the data model and API have no colour or per-name segments yet. The front of the journey (starting Claude, importing PDFs) and the end (court-form affidavits, annexures) are mostly missing. Status colours, state names and the app header also drift from screen to screen.

## 2. Top priorities

**1. Remove the "38% · will count as your words" meter as the thing that decides authorship**
- **Why:** PD-AI 4.9 needs the witness's own knowledge and own words. A paragraph Claude drafted and the user reworded is not that. The Log then counts it as "written by me", so the authorship gate can be gamed and the Court summary becomes wrong.
- **Fix:** Store "drafted by Claude" permanently. Use a third state, "Claude's, rewritten by you", which still needs the adopt step. Report it honestly in the 4.11 summary. Show similarity as a hint at most, or not at all. Do not build BG's live similarity-preview endpoint.
- **Screens:** Draft, Log.
- **Raised by:** L1 (critical), L2, VER (critical), F1, S1, S2, V1 (meter is ambiguous), DA, CS.
- **Confidence:** High.

**2. Draft paragraphs carry no sources, and the adopt dialog shows none**
- **Why:** Paragraph 4 adds "I was worried about how upset Mia gets", which no source supports. Paragraph 5 says "Daniel agreed to take them" when the source line is just "Fine.". The adopt dialog asks the user to swear it is true from two checkboxes, with no source lines in front of them. The CLI's `para add` has no `--source`.
- **Fix:**
  - Add per-paragraph sources (CLI and schema).
  - Show the cited lines in the Draft and in the Adopt panel, using the Chronology panel as the pattern.
  - Highlight claims no source supports, especially feelings, motives and children's states.
  - Add a CLAUDE.md rule that Claude never writes the witness's feelings.
  - Show the full paragraph when adopting, not a cut-off quote.
  - Link adopted paragraphs to the verified status of the chronology entries they rely on.
- **Screens:** Draft.
- **Raised by:** F1, S2, L1, L2, VER, CS, SC.
- **Confidence:** High.

**3. The Court (4.11) summary must be built only from what is actually recorded**
- **Why:** It says "replaced before Claude saw anything" while D006 still exposes "Annie". It says "3 subpoenaed withheld" when the count covers all restricted kinds. It says "verified against the source lines" when the log doesn't record that the sources were looked at. It names "Pro" when the app only knows "consumer". It leaves out the local name model, 5.4 settings and Paste use. And the obvious data source, `/api/stats`, reads a `verified_at` column that Claude can write. An overstated answer to the Court is itself a PD-AI 4.4 problem.
- **Fix:** Add a server-side summary built from signed checks (`isChronologyVerified`, `isEvidenceVerified`, `isParagraphAdopted`, `isWithheld`). Use hedged wording. List exposures and open items, every AI component used, and the 5.4 settings the user confirmed.
- **Screens:** Log, Documents, Settings.
- **Raised by:** L1, L2, VER, S1, DEC, BG.
- **Confidence:** High.

**4. A known leak has to change the document's state at once**
- **Why:** D006 shows a positive cyan "Available" chip while the nickname "Annie" is exposed. The alert is a quiet amber side card, and it doesn't say whether Claude has already read those lines. Fixing it one document at a time won't work when a nickname is in 60 documents.
- **Fix:**
  - Add an "Exposed" danger state and withdraw the document from Claude automatically until it is re-reviewed.
  - Check the log and tell the user whether Claude already read the affected lines, and record the exposure window.
  - Offer a batch re-review of only the new hits.
  - List the chronology entries and evidence that will drop back to "to check" when the document is republished (ADR 8 hashes the cited lines).
  - Use calm, specific wording.
- **Screens:** Documents, People, Chronology.
- **Raised by:** V1, F1, F2, S1, S2, L1, PRIV, SC, DEC.
- **Confidence:** High.

**5. Restricted-material classification**
- **Problems:**
  - One batch-level "New documents are: Ordinary" control applies to a whole dropped folder.
  - The Document screen offers only Ordinary or Subpoenaed, while the ADR has five kinds.
  - The Workbench review never shows the setting.
  - The categories miss family reports, Notices of Risk, medical and counselling records, implied-undertaking material and protected addresses.
- **Fix:**
  - Ask in plain words, per document, at review time: "Where did you get this? Mine / from the other side / from the court or a subpoena / under an order / Not sure".
  - Treat "Not sure" as restricted.
  - Use the same category list everywhere.
  - Flag likely produced material automatically (cover sheets, "produced under subpoena" stamps).
  - Warn that raising the sensitivity strips details and tags, and that Claude's earlier work from the document stays.
  - Reclassifying a document after Claude has read it should list what cites it.
- **Screens:** Documents, Document, Workbench.
- **Raised by:** S1 (critical), S2, F1, F2, L1, L2, PRIV, DEC, DA.
- **Confidence:** High.

**6. Colour, step 1: build the data plumbing first**
- **Why:** The `Entity` type has no colour, and every endpoint returns flat re-identified strings, so the client can't tell which words belong to whom.
- **Fix:**
  - Store a palette *index* (not a hex value) on each entity in the vault (size S).
  - Have `renderTokens` emit segments `{text, role, form, unknown}`, and have `show()` and `quote()` pass them through (size M).
  - Write one client segment renderer and one shared EntityMark / TokenChip / EntityDot component, with one spec per kind (V2's alpha rules).
  - Remove the 3 to 4 different hand-built highlight styles and the differing place glyphs.
  - Put colours in a token layer: there are no CSS variables today, and the entity map is redefined in four files.
- **Screens:** All screens that show entities.
- **Raised by:** BG, V2, V1.
- **Confidence:** High.

**7. Colour, step 2: fix the palette before rolling it out**
- **Measured problems (V1, V2, A11Y):**
  - Dapto vs the accent/verified cyan: ΔE 11.6.
  - childcare vs the error red: ΔE 8.5. An invented person could look like a known one.
  - class_teacher vs body text: ΔE 6.8.
  - Under deuteranopia, child_2 vs school is ΔE 2.4 and mother vs child_1 is ΔE 4.6. Both of those are people, so they share the same underline shape.
  - The picker's own swatches collide.
  - Nothing says what happens at 20 to 40 entities.
  - None of the inks pass contrast on the app's light theme (1.5:1 to 2.0:1).
- **Fix:**
  - Give hues only to the principal parties and the children (6 to 8, a colour-blind-safe set that varies lightness as well as hue).
  - Show everyone else in neutral ink with the role chip, and let the user promote someone to a colour.
  - Enforce a minimum distance between any entity colour and every status colour, and between entities, both under colour-blindness simulation.
  - Store a light/dark pair per palette entry.
  - Keep the swatch picker only if it greys out colours that are taken or too close.
- **Screens:** All screens that show entities.
- **Raised by:** V1, V2, A11Y, BG, DA, S1.
- **Confidence:** High.

**8. Colour, step 3: decide where it shows, and back it with more than colour**
- **Why:** Colour on every name in the affidavit, Chronology and Issues competes with the status colours. It also amplifies the other party's name (S2). The meaning is only available on hover, through a `title` attribute on elements that can't be focused, so keyboard and screen-reader users never get it.
- **Fix:**
  - Use full colour on the de-identification screens (Workbench, Document, Paste).
  - On reading and writing screens, show plain names by default with a "Highlight people" toggle. The Draft should look like the filed document.
  - Add a visible key wherever colour appears.
  - Make marks focusable, with a popover giving name, role and token.
  - Add a per-person "quiet" option.
  - Use the single-column view as the default.
  - Add a hover delay, dim less, and keep text at 4.5:1 or better while a mark is pinned.
- **Screens:** Draft, Chronology, Issues, Document, Paste, Workbench.
- **Raised by:** V1, V2, S1, S2, A11Y.
- **Confidence:** Medium to high.

**9. Status colours and state names need a fixed vocabulary**
- **Why:**
  - Cyan currently means primary action, link, selected, verified, available, adopted and intact.
  - Amber means both "Claude did this" and "needs you".
  - There is no danger level for a breach.
  - "to check / unverified / needs you / needs decision / needs review" all name the same state.
  - Draft authorship is shown only by a 3px coloured bar, which fails WCAG 1.4.1.
- **Fix:**
  - Define four statuses: info, attention, danger, verified.
  - Make selection a neutral raised surface.
  - Show the actor (Claude or You) with an icon or text, never amber.
  - Give each object type an enum of states, and a Badge component that only accepts those values.
  - Put a text label on every Draft paragraph.
- **Screens:** Log, Chronology, Documents, Draft, Settings, Workbench.
- **Raised by:** V1, V2, A11Y, S1.
- **Confidence:** High.

**10. Paste and Copy are an unchecked way out**
- **Why:** Real-name Claude text can be copied and filed. That skips the affidavit gate and verification, and none of it is logged. No ADR records Paste as a feature.
- **Fix:**
  - Log each use (without the content).
  - Turn citations in pasted text into links.
  - Mark unverified sentences.
  - Label the output "Claude's words, not for an affidavit".
  - Warn "don't paste this back into any AI".
  - Offer "Add to draft as Claude's", so it goes through the gate.
  - Decide whether Paste is a top-level screen at all.
- **Screens:** Paste, Log.
- **Raised by:** VER, L2, DEC, F1, PRIV, S1, DA.
- **Confidence:** High.

**11. Consequential actions sit behind single keys and misleading words**
- **Why:**
  - **Publish:** in family law, "publishing" identifying details is an offence (PD-AI 5.2). The word frightens and misleads, and the action has no confirmation beyond ⌘↵.
  - **Leave as written:** X sends a real surname to Claude with no warning.
  - **Verify:** V records an attestation.
  - **Delete and Merge:** no undo.
  - **Shortcuts:** they can't be turned off (WCAG 2.1.4), and they clash with screen-reader browse keys.
- **Fix:**
  - Rename Publish to "Share with Claude" and add a short "Claude will see…" confirmation.
  - "Leave as written" on a person or place needs a reason, and shows the exact text Claude will see.
  - Show undo toasts.
  - Shortcuts work only when the list has focus, and there is a setting to turn them off.
- **Screens:** Workbench, Chronology, Draft, People, Issues.
- **Raised by:** S1, S2, PRIV, A11Y, VER, DA.
- **Confidence:** High.

**12. Verification is too shallow**
- **Why:**
  - One Verify covers a compound claim that holds about five facts.
  - Nothing separates the quote from Claude's reading of it ("shows a pattern").
  - "Verified" means the source says it, not that it's true. Some sources are only the user's own affidavit.
  - It isn't clear whether the discrepancy note comes from the app or from Claude.
- **Fix:**
  - Run deterministic app-side checks: every entity, date and number in the claim must appear in the cited lines. This also catches swaps between valid tokens (child_1 vs child_2), which `checkTokens` cannot.
  - Separate "quote accurate" from "characterisation fair".
  - Rename the state "checked against source".
  - Flag entries whose only source is the user's own statement.
  - Label notes Claude wrote.
  - V does nothing until the source panel has been seen.
- **Screens:** Chronology, Issues.
- **Raised by:** VER, L2, F1, CS.
- **Confidence:** High.

**13. A first-run path for a non-technical parent**
- **Why:** The only way to start Claude is `cd … / claude` in Settings. Nothing in the app lets the user ask Claude to do anything. Copy is full of developer jargon (name model, leak check, Intact, sandbox, Ollama ids, `{{father.title}}`, bare PD-AI numbers). The guidance that matters most is set at 12px in grey.
- **Fix:**
  - A first-run checklist: plan, "Help improve Claude" off, Claude Code installed, import, open terminal here, suggested first requests.
  - Task templates the user can copy into Claude.
  - A glossary with a plain-English default, and technical detail under "Details".
  - Guidance at body size, placed next to the action it governs.
  - Expand PD-AI on first mention on each screen.
- **Screens:** Unlock, Settings, Documents, Workbench, Log, and all others.
- **Raised by:** F1, S1, S2, A11Y, V1, DA.
- **Confidence:** High.

**14. Import handles only .txt and .md**
- **Why:** A real pile is PDFs, screenshots and email. Annexures must be the original files, not retyped transcripts (PD-AI 4.6 authenticity).
- **Fix:**
  - PDF with on-device OCR.
  - .eml and .msg with attachments as linked child documents.
  - Keep the original file next to the extracted text, and show extraction quality.
  - Until then, tell users on screen how to convert what they have.
- **Screens:** Documents.
- **Raised by:** F1, F2 (critical), L1, L2.
- **Confidence:** High.

**15. No court-ready output**
- **Missing:**
  - The affidavit has no FCFCOA heading or file number, no deponent, no oath or affirmation, no jurat.
  - There are no annexures or marks.
  - Citations like `D002:9` mean nothing to the Court.
  - Chronology, outline and log exports have no stated format.
  - There is no pre-filing checklist.
- **Fix:**
  - .docx and PDF in the Court layout.
  - An annexure workflow that uses vault originals.
  - Convert citations on export ("Affidavit of A Thornbury sworn … at [4]", "Annexure AT-1").
  - Chronology exported as a table.
  - A short Portal filing checklist that points to the Court's own guidance.
  - Validate against the Court's own templates.
- **Screens:** Draft, Chronology, Log.
- **Raised by:** F1, F2, L1, L2, SC.
- **Confidence:** Medium. The exact form rules are not in the files.

## 3. By area

### Visual & interaction
- **Strikethrough means "left as written"** on a redaction screen, where it reads as "removed". Use a faint "kept" marker instead. (V1, high confidence)
- **The most sensitive identifiers get the weakest treatment.** Medicare, TFN and the rest share the muted-text grey and are collapsed into one sidebar row. List each one, with its own chip style. (V1)
- **The app header and nav differ by screen.** Workbench lacks Paste, Settings and the case name, and has no aria-current. Search appears on only two screens. Badges are inconsistent, and the Kind selects differ. Use one AppHeader component. (V1, V2, A11Y)
- **Disabled buttons look different** on Workbench and Draft (a grey fill vs a faded accent). (V2)
- **Too many type sizes (9), control heights (7) and radii (7).** Collapse to scales. Low priority. (V2)
- **Empty, error and first-run states are undesigned.** That covers a wrong passphrase, a corrupted vault, zero documents, failed imports, empty Chronology and Issues, a name-model failure, and the "This case" settings section, which is linked but missing. (V1)
- **Two edit contexts open at once on Draft** (paragraph 4 being edited and the paragraph 5 adopt panel). Allow only one. (V1)
- **Workbench findings show no per-item decision state or counts.** Add a glyph and a filter for "auto-applied, not yet looked at". (V1)
- **Line numbers are at 3.1:1 contrast**, and they are the citation targets. Raise them to the muted tier. (V2, A11Y)
- **The dark-only palette fails on light**, and the build has a light theme. Use token pairs, and decide whether colour appears in export at all. (V2, BG; folded into priority 7)
- **Inputs, button borders and the selected segment fail 3:1 non-text contrast.** (A11Y)

### Features & workflow
- **No way to direct Claude from the app.** Add task templates that say what Claude will see. (F1; linked to priority 13)
- **No encrypted backup, restore or recovery key for a vault that can't be recovered.** (F1, F2, S1)
- **Identity decisions don't carry across documents.** Apply to all pending documents, add a queue sorted by distinct strings, and remember "leave as written" decisions. (F2)
- **No bulk actions, sorting or paging on Documents**, and the row order is unexplained. (F2, SC)
- **No hearings, orders or deadlines model.** (F2)
- **Drafts have no versions, no filed state, no lock and no diff.** (F2)
- **Chronology needs filters by person, document, issue, date and author**, search, merging of duplicates, and a year jump. (F2, SC)
- **Search is on two screens only, and there is no results design.** The build has a Search page with no mockup. Use one search, or a ⌘K palette, everywhere, matching real names. (F2, SC, BG)
- **No single "To check" view across screens.** Add one, or put counts on the nav. (SC; agrees with DA's single-queue idea)
- **Workbench needs a review queue for multi-document imports**, replacing tabs that won't scale. (SC, BG)
- **Evidence is added by typing `D004:12-15`.** Add "link selection to issue…" and a document picker. (SC)
- **Issues has no filter, sort, keys, or "Used in" links.** (SC)
- **The Log shows times without dates, uses plain-text references, and has one filter.** Add date grouping, links and filters. (SC, F2)
- **Long drafts have no outline**, and the checklist's paragraph numbers aren't links. (SC)
- **Legend chips and "Where she appears" turn into a wall at scale.** Cap them, page them, and add chronology and issue sections. (SC)
- **Two Claude workflows (Claude Code and Paste) with no clear primary.** (DA)
- **Delete document, editing tags, the "kind changed" state, and the submission/other draft kinds** are built but have no mockup. (BG)

### Plain language & wellbeing
- **Delete, Remove and Merge give no warning or undo.** Removing an alias should warn that Claude may see the nickname again. (S1; partly folded into priority 11)
- **The passphrase warning is stark** and the second field is labelled "Again". Add show/hide, a "Type it again" label, and say what is actually lost. (S1, S2)
- **The "Check again" alert alarms without saying whether harm happened.** (S1, S2; folded into priority 4)
- **Evidence labels feel adversarial** ("Undermines", "cooperative on this occasion"). Use "Helps your account" and "Points the other way". (S2, low)
- **Adopt is disabled with no stated reason.** Add "Tick both boxes to adopt". (A11Y)
- **The workbench's cognitive load.** Offer a guided one-decision-at-a-time mode. (A11Y)
- **No content note before opening the other side's messages.** (S2; folded into priority 8)

### Legal & court fit
- **Choosing a commercial plan is treated as satisfying all of PD-AI 5.5.** Confirm all three limbs and the terms, log it, and release restricted documents one at a time. (L1, L2, DA, DEC)
- **Subpoena access terms (inspect-only) aren't recorded.** Confirm with a lawyer. (L1, medium)
- **Withheld content leaks through titles, issues, chronology and user-written text.** Neutralise these and warn. (L1, PRIV)
- **No Notice of Risk, s 60I certificate, current orders, or Applicant/Respondent/ICL roles.** (L1)
- **PD-AI 5.4 isn't covered.** Claude Code's web search and fetch are not denied in the generated settings (confirmed in case.ts), and there is no checklist covering chat history. (L1, L2, CS)
- **The 4.11 summary is case-wide, not per filed document.** Generate a provenance report on export. (F1, F2, L2)
- **The 4.11 summary leaves out the local models and the "how principles were observed" question.** (L1, L2; folded into priority 3)
- **Removing names doesn't make the content safe** (medical, family-violence detail). Add a sensitive-content flag. (L1)
- **No protected-address or safety-sensitive flag on entities**, and no export check for one. (F1, S2)
- **Claude edges toward legal advice.** Add a "not a lawyer" note with Legal Aid links, and a CLAUDE.md rule against predicting outcomes. (F1, L1, L2, CS, DA)
- **The "own knowledge" attestation is generic.** Ask per fact: "Did you see this yourself, or read it?" Rewrite-first. (L2)

### Verification
- **No detection or checking of legal citations** (PD-AI 4.7). Add a "Law to check" panel with AustLII links, and block export until it's done. (L2 high, VER, F1)
- **Chronology, outline and letter exports have no gate.** Uncited Claude entries can be exported. (L2, CS, VER)
- **The export checklist's "Check every fact" is a passive dash.** (VER; folded into priority 2)
- **The log should record what was on screen at verification.** (VER; folded into priority 3)
- **Some Claude outputs have no verify state** (notes, issue descriptions), and "verify issue" is undefined. (VER)
- **Verified status should reset when a cited document changes.** (VER low, DEC; folded into priority 4)
- **Tiered checking effort by use.** (VER, medium. Reasonable, but spot-check sampling is optional.)

### Privacy
- **No prompt to check quasi-identifiers** (rare events, jobs, small towns). Add a "could still identify someone" pass and a generalise action. Say plainly when no LLM checked them. (PRIV, high)
- **User-typed text (drafts with "real names are fine", chronology edits) has no visible detection step.** Run detection on save and show a preview. (PRIV)
- **Titles, author fields and file names have no visible token treatment.** The build has a leak check and an editable public title, but they aren't in the mockups. (PRIV, BG)
- **No single "What Claude can see" page.** (PRIV)
- **Real-name copies and exports carry no labels or warnings.** Offer to clear the clipboard. (PRIV, S1, S2)
- **Shoulder-surfing.** Use a neutral window title, a hide-now key, and neutral export file names. (S2, PRIV) Auto-lock already exists (ADR 13, 30 minutes) but isn't shown. Show it.
- **The Advanced checkboxes (send originals to a remote model, trust a local server) are one click away.** Require typed confirmation, or remove them from the parent-facing build. (S1, PRIV, DA)
- **Free-text role names could identify someone.** Validate them. (PRIV)
- **Original files and stray copies in the case folder can be read by Claude Code.** Scan for them and warn. (PRIV, CS)

### Accessibility
- **Focus styles are removed or unspecified.** Add one global `:focus-visible`. (A11Y, high)
- **Chronology entries can't be focused.** There is no aria-selected and no announcement. (A11Y)
- **Text selection plus M is the only way to mark a missed identifier.** Add a button. (A11Y)
- **Missing h1s, and section labels that are divs instead of headings.** (A11Y)
- **The side-by-side view isn't a table.** (A11Y)
- **No live-region announcements.** `aria-label` sits on divs with no role. (A11Y)
- **Repeated identical button names** ("Verify", "Delete"). (A11Y)
- **The amber "●" tab dot** is read as "black circle". (A11Y)

### Claude-side
- **Claude can delete verified and adopted work, and `issue rm` cascades to the user's own evidence** (confirmed in schema). Refuse these, and soft-delete into a restorable view. (CS, high; arguably top-priority as a code bug)
- **Settings claims "Vault blocked: yes" and "works only through the casefile command",** which ADR 3 says casefile cannot know or enforce. Report only what the app can check. (DEC, high)
- **Entities give Claude no context** (relationship, age, which child is which). Add short de-identified descriptions. (CS)
- **Most notes have nowhere to appear** (chronology, document, case notes), and notes have no done state. (CS)
- **Evidence with the "context" stance is never shown.** (CS)
- **Document details Claude sets are shown as fact.** (CS)
- **Files Claude writes into the folder, and long chat analyses, are untracked.** Add a no-files rule and denyWrite, plus `casefile report add`. (CS)
- **Search is blunt.** Results are capped at 50 with no total, and `{{father}}` matches the word "father". This invites false "not in any document" claims. (CS)
- **The chronology can't attribute who asserts what,** or express periods. (CS)
- **No feedback loop** from the user's rejections back to Claude. (CS)
- **Non-affidavit drafts have no Claude-authorship or checked state.** (CS; overlaps L2)

### Scale
- **Side-by-side rendering and per-name hover will lag on long documents.** Render only visible lines, highlight with a class on the container, and add go-to-line. (SC)
- **The Chronology filter contradicts the list**: "To check" is pressed but verified rows still show (confirmed). "Can't verify" has no filter. (SC)

### Build gap
- **The identifier tokens in the Workbench break the ADR 5 grammar** (`{{mother.phone}}`, `{{child_1.dob}}`; FORMS is first, surname and title only). Show `{{phone_1}}`-style roles, or write an ADR. (DEC, high; confirmed)
- **The Workbench colours spans by decision status, not by entity.** The numbered "Which person?" list is not built. (BG)
- **Review shortcuts, the "As Claude sees it" preview and tabs are not built.** (BG)
- **Unmocked safety states:**
  - leak-check refusal (BG, high)
  - probe-guard refusal on edits, and the security log (BG, DEC)
  - detector-failure and name-detection-off warnings (BG, DEC; NER is off by default per ADR 12)
  - unlock lockout wait (DEC)
  - "local, unconfirmed" LLM state (DEC)
  - kind-changed draft (DEC, BG)
- **The Log mock needs `/api/log/verify`, an actor filter, readable labels and re-identified detail.** Show pending-countersign and forged counts. Rename "Claude's use of this document", because reads through the shell aren't logged. (BG, DEC)
- **People needs occurrence counts (S) and merge (L, can be deferred).** (BG)
- **Chronology export, context lines and the source of the discrepancy note.** (BG)
- **Settings' Claude Code status rows have no backing check.** Add a status endpoint and a "changed" state. (BG; ties to DEC)
- **A withheld document shows a date and type** that ADR 7 says are removed. (DEC)
- **Switching plans has no confirmation or stated consequences.** (DEC)

### Simplification
- **Merge Chronology, Issues and Paste checking into one "To check" queue**, and cut the nav to about four destinations. (DA; see Disagreements)
- **Make Document the same component as the Workbench** (read-only), with one view toggle instead of three modes. (DA)
- **Defer Merge and the colour picker. Generate name forms automatically.** (DA)
- **Make the 4.11 answers the Log page itself, with the raw log available as a download.** (DA)
- **Defer the optional LLM, and remove the remote-originals toggle.** (DA)

## 4. Disagreements

| Topic | Positions | Call |
|---|---|---|
| Should Claude draft affidavit paragraphs at all? | DA: no. Claude prompts, the parent writes, and adopt and the meter are cut. Most others: keep adoption but tie it to sources. | Keep the adopt gate (it is built, per ADR 9), drop the meter, and make the UI rewrite-first. Claude never writes feelings or opinions. Revisit DA's "prompt, don't draft" after user testing. |
| How much colour | DA: colour by category only, no per-person hues. V1 and V2: a budget of 6 to 8 hues plus neutral. BG: assign a colour to every entity. | Budget approach. It keeps the main benefit and scales. No free picker in v1. |
| Issues screen | DA: defer it (risk of legal advice). CS and SC: extend it (context stance, filters). | Keep it, with neutral framing and Claude's notes labelled. Merits judgement belongs in CLAUDE.md, not in removing the screen. |
| Keyboard shortcuts | F2 and SC: more shortcuts. S1, S2, A11Y and DA: fewer, opt-in. | Keep them, scoped to the focused list, with a setting to turn them off. No single key for Leave, Verify or Publish without undo or confirmation. |
| Log | DA: drop the integrity badge and filters. F2, SC and DEC: more filters and more integrity detail. | Summary first. Keep integrity with honest caveats (ADR 8). Put filters behind "Full log". |
| Commercial-plan branch | DA: cut it. L1 and DEC: keep it with a three-part confirmation. | Keep it (it is built), with a confirmation dialog and logging. |
| Optional local LLM | DA: defer it. PRIV: needed for quasi-identifiers. | Keep it optional. Remove the remote toggle from the default UI. |
| "Unknown token" in Chronology | VER, L2 and DA praise it. CS: the CLI makes it impossible. | CS is right (`checkTokens` runs on chronology writes). Keep the state for Paste and renamed entities. Spend the Chronology error design on valid-token swaps. |
| Auto-lock | S2 and PRIV: missing. DEC: it exists (ADR 13). | It exists. The design should show it. |
| Single-queue vs separate screens | DA: merge them. SC: add a cross-screen To-check view. | Add the queue, keep the screens as views. |

## 5. Weak or speculative findings

- **BG: live similarity-preview endpoint.** Moot if the meter goes (priority 1). Don't build it.
- **CS: the rewrite measure counts additions as the user's words.** Low confidence, and moot for the same reason.
- **L2: check restored quotes character by character.** Re-identification is deterministic from the token key. The real risk is retyped transcripts, which priority 14 covers. Low value.
- **F2: adoption wording assumes the user is the deponent.** A real edge case, but rare for v1. Defer.
- **V1: hover dimming may flicker.** Plausible but untested. Fold it into priority 8's hover delay.
- **PRIV: window titles show real names.** The mock `<title>`s are generic. Only worth a one-line spec.
- **V2: collapse type sizes, radii and spacing.** Valid tidy-up, not a user problem. Do it when the token layer is built.
- **VER: random spot-check sampling.** Speculative, and it risks annoying users. Prefer deterministic checks (priority 12).
- **L1: subpoena inspect-only terms.** Plausible, but the reviewer flags the rule references as unconfirmed. Needs a lawyer before it is designed.
- **DA: the Document screen duplicates the Workbench.** Partly true, but the post-publish provenance ("Cited in", "Claude's use") is distinct. Merge components, not purpose.

## 6. Strengths to keep

- Colour linking between each real name and its token, with hover and pin, and a tooltip naming the entity and token. (V1, V2)
- The "Original / As Claude sees it / Side by side" view, with the vault outside Claude's reach. (F1, PRIV)
- Publish is blocked until every finding is decided, with a clear "Which person?" choice. (F1)
- The Chronology's "Does the source say this?" panel, with the cited lines and the discrepancy note. (F2, L1, L2, VER, CS, SC, DA)
- Unknown or invented tokens are flagged. (F1, L2, VER, DA)
- Affidavit export is blocked until Claude's paragraphs are dealt with. The two adopt attestations are in plain first-person wording. Exports never go into the case folder. (F1, L2, S2, DEC)
- The tamper-evident log and the plain-language "If the Court asks" panel. (F1, L2, S2, DA)
- Cloud-model detection and refusal. (L1, DEC)
- The CLI's provenance rules and refusals that tell Claude what to do instead. (CS)
- "Cited in" backlinks. (SC)
- The keyboard flow, kept opt-in. (F2, SC)
- Strong text contrast and good ARIA basics. (A11Y)
- Unlock, adopt and export already match the built app. (BG)
- Plain, honest copy at the key moments, as the model for the rest of the app. (S1, S2)

Files: brief and PD-AI in `(brief and PD-AI saved alongside this report) `; mockups in `the design canvas`; code checked in `src/core/tokens.ts`, `src/core/publicdb.ts`, `src/cli/commands.ts`, `src/core/case.ts`.