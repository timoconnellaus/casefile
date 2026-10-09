-- public.db schema v3 as it shipped (copied from tests/schema_v4_test.ts). Do not edit.
CREATE TABLE case_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entities (role TEXT PRIMARY KEY, kind TEXT NOT NULL);
CREATE TABLE documents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  doc_type TEXT, doc_date TEXT, author_role TEXT, source TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'none', withheld INTEGER NOT NULL DEFAULT 0, body TEXT,
  line_count INTEGER NOT NULL DEFAULT 0, published_at TEXT NOT NULL, meta_by TEXT NOT NULL DEFAULT 'app'
);
CREATE TABLE lines (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, line_no INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (doc_id, line_no));
CREATE VIRTUAL TABLE lines_fts USING fts5(text, content='lines', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER lines_ai AFTER INSERT ON lines BEGIN INSERT INTO lines_fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER lines_ad AFTER DELETE ON lines BEGIN INSERT INTO lines_fts(lines_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TABLE tags (doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, tag TEXT NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY (doc_id, tag));
CREATE TABLE chronology (id INTEGER PRIMARY KEY, event_date TEXT NOT NULL, description TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, verified_sig TEXT);
CREATE TABLE chronology_sources (entry_id INTEGER NOT NULL REFERENCES chronology(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL);
CREATE TABLE issues (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, verified_sig TEXT);
CREATE TABLE evidence (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id),
  doc_id TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '', stance TEXT NOT NULL DEFAULT 'supports',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, verified_at TEXT, verified_sig TEXT);
CREATE TABLE notes (id INTEGER PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, body TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE drafts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE paragraphs (id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  position REAL NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, claude_body TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, adopted_at TEXT, adopted_sig TEXT);
CREATE TABLE ai_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', chain TEXT, chain_kind TEXT);
PRAGMA user_version = 3;
