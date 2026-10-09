/**
 * Checking area seed (v3/check-api). SYNTHETIC data only (ADR 11).
 *
 * The user is the mother and wrote her affidavit (D002), as recorded in the app (vault), so an
 * entry or evidence link whose only source is D002 shows "Only source is your own statement".
 * She swore it on 2 April 2025 (the day it was filed), so exports cite it as "my affidavit sworn
 * 2 April 2025, para 4" (ADR 27).
 */
import type { SeedContext } from "../seed.ts";
import { setDocAuthor } from "../../src/core/checking.ts";
import { setEarlierAffidavit } from "../../src/core/export/affidavits.ts";

export default async function seedChecking({ session: s, log }: SeedContext) {
  if (!s.settings.userRole) await s.updateSettings({ userRole: "mother" });
  await setDocAuthor(s, "D002", "mother");
  await setEarlierAffidavit(s, "D002", { oath: "sworn", date: "2025-04-02" });
  log("checking: D002 recorded as the user's own affidavit, sworn 2 April 2025");
}
