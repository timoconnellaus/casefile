// deno task browsercheck (scripts/browsercheck.ts): every route gets a screen, and it stays out of ci.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { ROUTES } from "../src/app/ui/routes.js";
import { screensFor } from "../scripts/browsercheck/screens.ts";

const DATA = {
  docs: [
    { id: "D001", status: "published", state: "shared" },
    { id: "D015", status: "pending", state: "needs_review" },
  ],
  drafts: [{ id: 1 }],
};

Deno.test("browsercheck visits every route once, with its parameters filled in", () => {
  const screens = screensFor(DATA);
  assertEquals(screens.map((s) => s.name), ROUTES.map((r) => r.name));
  for (const s of screens) assert(!s.hash.includes(":"), `${s.name}: ${s.hash}`);
  const by = Object.fromEntries(screens.map((s) => [s.name, s.hash]));
  assertEquals(by.review, "#/review/D015");
  assertEquals(by.document, "#/doc/D001");
  assertEquals(by.draft, "#/draft/1");
  assertEquals(by.people, "#/people");
});

Deno.test("browsercheck refuses a route it has no parameter for", () => {
  assertThrows(() => screensFor({ docs: [], drafts: [] }), Error, "No value for #/review/:id");
});

Deno.test("browsercheck has a task and is not part of deno task ci", async () => {
  const tasks = JSON.parse(await Deno.readTextFile("deno.json")).tasks;
  assert(tasks.browsercheck?.includes("scripts/browsercheck.ts"));
  assert(!tasks.ci.includes("browsercheck"));
  assert(!tasks.browsercheck.includes("8217"));
});
