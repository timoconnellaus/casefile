/**
 * Free legal help links (DESIGN-SPEC §6): a vetted list, opened in the user's own browser by the
 * server (`open <url>` on macOS) with a URL from the list only. SYNTHETIC data only (ADR 11).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { EXTERNAL_LINKS, openUrlCommand } from "../src/app/links.ts";
import { EXTERNAL_LINKS as UI_LINKS } from "../src/app/ui/components/links.js";
import { withCase } from "./helpers/app.ts";

Deno.test("the UI's link list is the server's list, https only", () => {
  assertEquals(UI_LINKS, JSON.parse(JSON.stringify(EXTERNAL_LINKS)));
  for (const l of Object.values(EXTERNAL_LINKS)) {
    assert(new URL(l.url).protocol === "https:", l.url);
    assertEquals(openUrlCommand(l.url), { cmd: "open", args: [l.url] });
  }
  assertThrows(() => openUrlCommand("https://example.com/"), Error, "Not an allowed link");
  assertThrows(() => openUrlCommand("-a Terminal"), Error, "Not an allowed link");
});

Deno.test("POST /api/open-link opens only listed links, and needs the session", async () => {
  const opened: string[] = [];
  const t = await withCase({
    claudeCode: { os: "darwin", openUrl: (u) => Promise.resolve(void opened.push(u)) },
  });
  try {
    const r = await t.user.post("/api/open-link", { id: "legal_aid_nsw" });
    assertEquals(r.status, 200, r.text);
    assertEquals(r.json, { opened: true, url: EXTERNAL_LINKS.legal_aid_nsw.url });
    assertEquals(opened, [EXTERNAL_LINKS.legal_aid_nsw.url]);
    for (const id of ["https://example.com/", "toString", "__proto__", "", 1, null]) {
      assertEquals((await t.user.post("/api/open-link", { id })).status, 400, String(id));
    }
    assertEquals(
      (await t.user.post("/api/open-link", { id: "legal_aid_nsw", url: "https://example.com/" }))
        .json.url,
      EXTERNAL_LINKS.legal_aid_nsw.url,
      "a URL in the request is ignored",
    );
    assertEquals((await t.other.post("/api/open-link", { id: "legal_aid_nsw" })).status, 401);
    assertEquals(opened.length, 2);
  } finally {
    t.state.lock();
  }
  // Elsewhere than macOS nothing is run; the UI opens a new window instead.
  const u = await withCase({
    claudeCode: { os: "linux", openUrl: () => Promise.reject(new Error("must not run")) },
  });
  try {
    const r = await u.user.post("/api/open-link", { id: "family_advice_line" });
    assertEquals(r.json.opened, false);
  } finally {
    u.state.lock();
  }
});
