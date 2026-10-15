-- OWNER: N0 — the device profile (IOS-SPEC §3.2, meta.profile = 'device-1'). Runs after schema.sql and ONLY creates:
-- no table of schema.sql is altered and no object of schema.sql is dropped, so the reference's readers keep working.

-- text in chunks (DP-1). document_text keeps every column; original = '' for chunked documents;
-- original_sha256 stays the sha256 of the whole UTF-8 original (the D18 anchor key).
CREATE TABLE text_storage (
  document_id INTEGER PRIMARY KEY REFERENCES document_text(document_id),
  layout TEXT NOT NULL CHECK (layout IN ('chunked-1')),
  utf16_len INTEGER NOT NULL, utf8_len INTEGER NOT NULL, chunk_count INTEGER NOT NULL
) STRICT;
CREATE TABLE text_chunk (
  document_id INTEGER NOT NULL REFERENCES document_text(document_id),
  ord INTEGER NOT NULL,
  start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,        -- UTF-16 units of the decoded original; every chunk end is a passage end
  codec TEXT NOT NULL CHECK (codec IN ('lzfse-utf8','utf8')),
  z BLOB NOT NULL,
  PRIMARY KEY (document_id, ord), CHECK (start_off < end_off)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER text_chunk_no_update BEFORE UPDATE ON text_chunk
BEGIN SELECT RAISE(ABORT, 'text chunks are immutable'); END;

-- per-source id counters (DP-2, §3.3)
CREATE TABLE id_counter (tbl TEXT NOT NULL, slot INTEGER NOT NULL, next INTEGER NOT NULL,
  PRIMARY KEY (tbl, slot)) STRICT, WITHOUT ROWID;

-- installed source packs (DP-3)
CREATE TABLE pack_install (
  pack_sha256 TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, slot INTEGER NOT NULL,
  member_count INTEGER NOT NULL, journal_seq INTEGER, installed_at TEXT NOT NULL) STRICT;

-- the journal ops applied to this generation, and the largest log-table id each one created (DP-4, §6)
CREATE TABLE journal_applied (
  seq INTEGER PRIMARY KEY, op TEXT NOT NULL, applied_at TEXT NOT NULL,
  max_ids_json TEXT NOT NULL CHECK (json_valid(max_ids_json))   -- {"import_batch":12,"relationship_revision":593101,"annotation_revision":88}
) STRICT;
CREATE TRIGGER journal_applied_no_update BEFORE UPDATE ON journal_applied
BEGIN SELECT RAISE(ABORT, 'journal_applied is append-only'); END;
CREATE TRIGGER journal_applied_no_delete BEFORE DELETE ON journal_applied
BEGIN SELECT RAISE(ABORT, 'journal_applied is append-only'); END;

-- portable cutoffs of each saved view (DP-5, §6.4); saved_view itself is untouched
CREATE TABLE saved_view_portable (
  view_id INTEGER PRIMARY KEY REFERENCES saved_view(id),
  portable_json TEXT NOT NULL CHECK (json_valid(portable_json)), created_at TEXT NOT NULL) STRICT;
CREATE TRIGGER svp_no_update BEFORE UPDATE ON saved_view_portable
BEGIN SELECT RAISE(ABORT, 'saved views are immutable'); END;
CREATE TRIGGER svp_no_delete BEFORE DELETE ON saved_view_portable
BEGIN SELECT RAISE(ABORT, 'saved views are immutable'); END;
