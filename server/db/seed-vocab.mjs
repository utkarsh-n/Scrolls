// OWNER: WP0 — idempotent seed of the closed vocabularies stored as rows (SPEC §3.1)

import { CORPORA, DIMENSIONS, LANGUAGE_PERIODS, REL_TYPES } from '../../src/shared/vocab.mjs';
import { nowIso, stmt, tx } from './open.mjs';

/**
 * Upsert rel_type, language_period, dimension_def (built-ins) and corpus rows. Safe to run on every boot:
 * vocabulary rows are refreshed from src/shared/vocab.mjs; corpus rows keep their created_at.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function seedVocab(db) {
  tx(db, () => {
    const relType = stmt(db, `INSERT INTO rel_type (code, family, label, inverse_label, directed, requires_precedence,
        implies_transmission, feedback_capable, glyph, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET family = excluded.family, label = excluded.label,
        inverse_label = excluded.inverse_label, directed = excluded.directed,
        requires_precedence = excluded.requires_precedence, implies_transmission = excluded.implies_transmission,
        feedback_capable = excluded.feedback_capable, glyph = excluded.glyph, description = excluded.description`);
    for (const r of REL_TYPES) {
      relType.run(r.code, r.family, r.label, r.inverse_label, r.directed, r.requires_precedence,
        r.implies_transmission, r.feedback_capable, r.glyph, r.description);
    }

    const period = stmt(db, `INSERT INTO language_period (lang, label, lo_year, hi_year, core_lo, core_hi, fuzz_years, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lang) DO UPDATE SET label = excluded.label, lo_year = excluded.lo_year, hi_year = excluded.hi_year,
        core_lo = excluded.core_lo, core_hi = excluded.core_hi, fuzz_years = excluded.fuzz_years,
        source = excluded.source, note = excluded.note`);
    for (const p of LANGUAGE_PERIODS) {
      period.run(p.lang, p.label, p.lo_year, p.hi_year, p.core_lo, p.core_hi, p.fuzz_years, p.source, p.note);
    }

    const dim = stmt(db, `INSERT INTO dimension_def (key, label, type, options_json, builtin, created_by)
      VALUES (?, ?, ?, ?, 1, 'system')
      ON CONFLICT(key) DO UPDATE SET label = excluded.label, type = excluded.type,
        options_json = excluded.options_json, builtin = 1`);
    for (const d of DIMENSIONS) dim.run(d.key, d.label, d.type, d.options === null ? null : JSON.stringify(d.options));

    const corpus = stmt(db, `INSERT INTO corpus (slug, name, kind, is_synthetic, description, license, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description,
        license = excluded.license`);
    const now = nowIso();
    for (const c of CORPORA) corpus.run(c.slug, c.name, c.kind, c.is_synthetic, c.description, c.license, now);
  });
}
