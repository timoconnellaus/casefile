/**
 * public.db upgrades for a case in daily use (ADR 22). Each schema version that has shipped is
 * frozen in tests/fixtures/schemas/vN.sql, as real databases of that version look. Two rules:
 *
 * - A change to the schema bumps SCHEMA_VERSION and adds a migration: a fresh store must match the
 *   frozen schema of the current version exactly, so an edit to SCHEMA alone fails here.
 * - Every frozen version migrates to exactly what a fresh store has.
 *
 * After bumping SCHEMA_VERSION, freeze the new version with
 *   UPDATE_SCHEMA_FIXTURE=1 deno task test tests/schema_fixtures_test.ts
 * and commit the file. Never edit an older vN.sql: databases of that version already exist.
 */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { PublicStore, SCHEMA_VERSION } from "../src/core/publicdb.ts";
import { tempDir } from "./fixtures/synthetic.ts";

const DIR = fromFileUrl(new URL("./fixtures/schemas/", import.meta.url));

/** Tables SQLite makes for an FTS5 table (`lines_fts_data`…): made again by its CREATE. */
function shadowTables(db: DatabaseSync): (name: string) => boolean {
  const virtual = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
  ).all() as { name: string }[]).map((r) => r.name);
  return (name) => virtual.some((v) => name.startsWith(`${v}_`));
}

/** The schema as statements in creation order, to freeze a version. */
function dump(db: DatabaseSync): string {
  const shadow = shadowTables(db);
  const rows = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid",
  ).all() as { name: string; sql: string }[];
  const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  return [
    `-- public.db schema v${v}, frozen by tests/schema_fixtures_test.ts. Do not edit.`,
    ...rows.filter((r) => !shadow(r.name)).map((r) => `${r.sql};`),
    `PRAGMA user_version = ${v};`,
    "",
  ].join("\n");
}

/** What the schema is, independent of how its SQL text was written (CREATE or ALTER). */
function shape(db: DatabaseSync) {
  const shadow = shadowTables(db);
  const objects = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
  ).all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const out: Record<string, unknown> = {
    user_version: (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  };
  for (const o of objects) {
    if (shadow(o.name)) continue;
    if (o.type === "table" && !o.sql.startsWith("CREATE VIRTUAL")) {
      out[`table ${o.name}`] = db.prepare(`PRAGMA table_xinfo("${o.name}")`).all()
        .map((c) => ({ ...c }));
      out[`fks ${o.name}`] = db.prepare(`PRAGMA foreign_key_list("${o.name}")`).all()
        .map(({ id: _id, seq: _seq, ...c }) => c);
    } else out[`${o.type} ${o.name}`] = o.sql.replace(/\s+/g, " ").trim();
  }
  return out;
}

async function freshShape() {
  const path = join(await tempDir(), "public.db");
  PublicStore.open(path, { create: true }).close();
  const db = new DatabaseSync(path);
  try {
    return { shape: shape(db), dump: dump(db) };
  } finally {
    db.close();
  }
}

async function frozen(): Promise<{ version: number; sql: string }[]> {
  const out: { version: number; sql: string }[] = [];
  for await (const e of Deno.readDir(DIR)) {
    const m = /^v(\d+)\.sql$/.exec(e.name);
    if (m) out.push({ version: Number(m[1]), sql: await Deno.readTextFile(join(DIR, e.name)) });
  }
  return out.sort((a, b) => a.version - b.version);
}

Deno.test("a fresh public.db is exactly the frozen schema of the current version", async () => {
  const fresh = await freshShape();
  const file = join(DIR, `v${SCHEMA_VERSION}.sql`);
  if (Deno.env.get("UPDATE_SCHEMA_FIXTURE")) {
    try {
      await Deno.lstat(file);
    } catch {
      await Deno.writeTextFile(file, fresh.dump);
    }
  }
  const versions = await frozen();
  const current = versions.find((v) => v.version === SCHEMA_VERSION);
  assert(
    current,
    `No frozen schema for v${SCHEMA_VERSION}: run UPDATE_SCHEMA_FIXTURE=1 deno task test ` +
      "tests/schema_fixtures_test.ts and commit tests/fixtures/schemas/.",
  );
  const db = new DatabaseSync(":memory:");
  db.exec(current.sql);
  assertEquals(
    fresh.shape,
    shape(db),
    `The schema changed but SCHEMA_VERSION is still ${SCHEMA_VERSION}. Bump it and add a ` +
      "migration: cases in daily use have this version's databases.",
  );
});

Deno.test("every frozen public.db version migrates to exactly a fresh store", async () => {
  const fresh = await freshShape();
  const versions = await frozen();
  assert(versions.length >= 2, "expected v3 and later");
  for (const v of versions) {
    const path = join(await tempDir(), "public.db");
    const db = new DatabaseSync(path);
    db.exec(v.sql);
    db.close();
    PublicStore.open(path).close();
    const migrated = new DatabaseSync(path);
    try {
      assertEquals(shape(migrated), fresh.shape, `v${v.version} → v${SCHEMA_VERSION}`);
    } finally {
      migrated.close();
    }
  }
});
