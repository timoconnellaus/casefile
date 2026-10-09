/** The version a push to main is released as (ADR 24, scripts/release/next_version.ts). */
import { assertEquals } from "@std/assert";
import { bump, bumpOf, latest } from "../scripts/release/next_version.ts";

Deno.test("each push to main bumps PATCH unless a commit asks for more", () => {
  assertEquals(bumpOf(["Fix the review queue (#12)"]), "patch");
  assertEquals(bumpOf(["PDF import [minor] (#13)", "small fix"]), "minor");
  assertEquals(bumpOf(["[MAJOR] new case format"]), "major");
  assertEquals(bump("0.2.9", "patch"), "0.2.10");
  assertEquals(bump("0.2.9", "minor"), "0.3.0");
  assertEquals(bump("0.2.9", "major"), "1.0.0");
});

Deno.test("the last release is the highest version tag, not the latest-sorted string", () => {
  assertEquals(latest(["v0.2.9", "v0.2.10", "v0.10.0", "use-2026-10-09-1", "vnext"]), "0.10.0");
  assertEquals(latest(["v0.2.9", "v0.2.10"]), "0.2.10");
  assertEquals(latest([]), null);
});
