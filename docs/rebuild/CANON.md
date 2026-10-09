# Canonical example case (all boards must agree with this)

Synthetic data only. Where a board disagrees with this file, change the board.

## Case
- Name (only the user sees it): "Parenting matter 2025". Folder `~/Documents/casefile/case-1`.
- Claude plan as recorded by the user: Claude Pro (consumer). Confirmed with the PD-AI 5.4 checklist on **3 September 2025**.
- "Today" in the mockups: **Tuesday 7 October 2025**.

## Who's who (role → real value → colour per DESIGN-SPEC §4)
| Role | Real | Kind | Colour |
|---|---|---|---|
| mother | Anna Thornbury (first Anna, surname Thornbury, title Ms Thornbury; aliases Annie, Ana) — **safety-sensitive** | person | #FFAABB |
| father | Daniel Okafor (Daniel, Okafor, Mr Okafor) | person | #77AADD |
| child_1 | Mia Okafor (Mia) | person | #44BB99 |
| child_2 | Lachlan Okafor (Lachlan) | person | #BBCC33 |
| maternal_grandmother | Margaret Thornbury | person | neutral |
| class_teacher | Ms Priya Raman | person | neutral |
| school | Kiama Downs Public School | school | neutral, dashed |
| childcare | Little Gumnuts Childcare | organisation | neutral, dashed |
| fathers_business | Okafor Joinery | organisation | neutral, dashed |
| mothers_home | 14 Banksia Crescent, Gerringong NSW 2534 | address | identifier style |
| place_1 | Dapto | place | neutral, dashed |
| phone_1 / email_1 / medicare_1 / tfn_1 / abn_1 / dob_1 (Mia, 3 March 2017) / dob_2 (Lachlan, 21/09/2019) / file_number (PAC1234/2024) | as in the affidavit | identifier | identifier style |
Spare colour slots: #99DDFF, #EEDD88 (free). Who's who totals: 41 (People 18, Places & organisations 14, Numbers & dates 9).

## Documents (312 total)
- **D001** Text messages, March 2025 — Mine — Shared with Claude. Lines (exactly):
  1 `14/03/2025 3:05pm Anna: Where are you? Mia has been waiting at school since 3.`
  2 `14/03/2025 4:31pm Daniel: Traffic. Got them now.`
  3 `15/03/2025 9:12am Anna: Mr Okafor, this is the third time this term.`
  4 `15/03/2025 9:40am Daniel: Mia said she was fine. Stop making a big deal Anna.`
  5 `22/03/2025 6:02pm Anna: Swimming is moved to Saturday 8am at Dapto pool.`
  6 `22/03/2025 6:30pm Daniel: Fine.`
  7 `29/03/2025 8:41am Anna: Lachlan has a temperature, keeping him home.`
- **D002** Affidavit of Anna Thornbury (filed 2 April 2025) — Mine — Shared. Line 9 is exactly:
  `4. On 14 March 2025 Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public School.`
  (other lines as in the review board's affidavit; line 7 "2. The father of the children is Daniel Okafor. Mr Okafor and I separated in June 2023.")
- **D004, D005, D007** — From a subpoena or the court — Withheld. **D008** — From the other side — Withheld. **D009** — Under a court order — Withheld. **D010** — Not sure — Withheld. (6 withheld.)
- **D006** Letter from the other side's lawyer — Exposed — re-check: shared 28 Sep 2025; Claude read lines 1–12 on 2 Oct 2025; the user added the nickname "Annie" and casefile withdrew D006 on 5 Oct 2025. Exposure window: 28 Sep – 5 Oct 2025. New "Annie" matches also in D015, D016 (not yet shared). On 2 Oct Claude also cited D006 in one chronology entry (26 September 2025, "{{father.first}}'s lawyers proposed that changeovers happen at {{school}}", D006:2–5) and one evidence link (Communication between parents, D006:4, points the other way); the user checked both on 3 Oct, before D006 was withdrawn. They count among the checked items below, and the exposure banner lists them under "When you share D006 again, these go back to To check": re-checking D006 shares it again and both become Changed since you checked (To check 14 → 15).
- **D015** Email from childcare centre, **D016** School reports term 2 — Needs review.
- All other documents: Shared with Claude. Status totals: Needs review 2 · Exposed 1 · Withheld 6 · Shared 303 = 312.

## Claude's work and checking
- Chronology: 17 entries — 12 Checked against source, **4 To check**, **1 Can't check**.
  - Can't-check example: 29 March 2025 entry where Claude wrote `{{child_1}}` (Mia) has a temperature, but D001:7 names Lachlan (`{{child_2}}`).
  - Main checking example: 14 March 2025 "Daniel collected Mia and Lachlan 90 minutes late from Kiama Downs Public School" citing D002:9 and D001:1–2 (CheckList: ✓ date, ✓ Daniel, ✓ 90 minutes, ✓ school in D002:9; ▲ Lachlan is not in D001:1–2, only in D002:9). Only-own-affidavit flag applies to D002.
  - Changed since you checked: none in this snapshot (show the state only as an example row if needed, counted in "To check").
- Issues: 4 issues ("Reliability of changeovers", "Children's schooling and attendance", "Communication between parents", "Medical care"). Evidence links: 11 — 9 Checked, **2 To check** (D001:3 and D001:6 under Reliability of changeovers).
- Affidavit draft (Affidavit of Anna Thornbury, 7 paragraphs): Your words ¶1, ¶2, ¶7 · Drafted by Claude — adopted ¶3 · Drafted by Claude — rewritten by you, adopt to confirm ¶4 · Drafted by Claude — needs you ¶5, ¶6. Annexure AT-1 = D001.
- Paste: 3 uses logged; 2 passages added to the affidavit draft as Claude's (they are ¶5 and ¶6's origin — count them under paragraphs, not separately).

## "To check" queue (nav count = 14)
Exposed documents 1 (D006) · Documents to review 2 (D015, D016) · Chronology entries 5 (4 To check + 1 Can't check) · Evidence links 2 · Affidavit paragraphs 3 (¶4 adopt to confirm, ¶5, ¶6) · Issue descriptions 1 (Claude's description of "Medical care") = **14**.
Every board's AppHeader shows "To check 14".

## AI-use log / Court summary figures
Chronology 12 of 17 checked; evidence 9 of 11 checked; affidavit: 3 paragraphs your words, Claude drafted 4 — 1 adopted, 1 rewritten by you awaiting adoption, 2 still need you; 6 documents kept from Claude (3 subpoena/court, 1 other side, 1 under order, 1 not sure); 1 exposure (D006, 28 Sep – 5 Oct 2025, withdrawn); tools: Claude (Claude Code, Pro plan as recorded by you), casefile's name finder on this computer, no local language model, Jev off. Log checked: no changes found (since 3 Sep 2025).

## Addendum: document titles (fixed during the consistency pass)
D004 "School records, 2024" · D005, D007 subpoena/court material · D008 "Daniel's affidavit, May 2025" · D009 family report (under an order) · D010 "Handover notebook, 2024" · D006 "Letter from the other side's lawyer" · D015 "Email from childcare centre" · D016 "School reports term 2". Withheld documents are never cited. Issue: "Reliability of changeovers". AppHeader markup: identical to wb/Documents.dc.html on every board.

## Addendum: the user's own statement (wave 3)
The user is the **mother** (Settings: "Your role in the case"). D002 is her own statement: its author is recorded in the app as `mother` (vault only; Claude cannot set it), so chronology entries citing only D002 carry "Only source is your own statement". The D006 exposure was triggered by the nickname "Annie" (shown to the user as "a nickname you added: Annie"); D015 and D016 show "New match: a nickname you added: Annie".

## Addendum: D002 as an earlier affidavit (ADR 27)
The user recorded on D002's page that she swore it on **2 April 2025** (the day it was filed). Exports of her affidavit draft and of the chronology cite D002:9 as "my affidavit sworn 2 April 2025, para 4".
