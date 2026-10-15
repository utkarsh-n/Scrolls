// OWNER: WP1 — field mapping, the closed transform list, suggestions and mapping validation (SPEC §5.2, §5.3)

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { applyMapping, describeTransforms, normalizeLang, normalizeMapping, normalizeTransform } from '../server/ingest/mapping.mjs';
import { inferColumn, suggestMapping } from '../server/ingest/suggest.mjs';
import { validateMapping } from '../server/ingest/validate.mjs';
import { commit, dryRun, stageFile } from './fixtures/ingest/harness.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const NOW = new Date('2026-10-04T12:00:00Z');
const CTX = { fileName: 'test.csv', sha256: 'ab'.repeat(32), decoder: 'utf-8', batchId: 9, format: 'csv', now: NOW, byteRange: { start: 10, end: 90 } };
const map = (fields, extra = {}) => normalizeMapping({ format: 'csv', collection: { slug: 'c', name: 'C' }, fields, ...extra }).mapping;
const rec = (data, line = 2, ordinal = 1) => ({ line, ordinal, data });
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

describe('transforms (closed list)', () => {
  test('string and object forms normalize; anything else is refused', () => {
    assert.deepEqual(normalizeTransform('trim'), { op: 'trim', arg: null });
    assert.deepEqual(normalizeTransform('split(;)'), { op: 'split', arg: ';' });
    assert.deepEqual(normalizeTransform({ join: '\\f' }), { op: 'join', arg: '\f' });
    assert.equal(normalizeTransform({ regex_extract: { pattern: '(\\d{4})' } }).arg.group, 1);
    assert.throws(() => normalizeTransform('uppercase'), /Unknown transform/);
    assert.throws(() => normalizeTransform({ date: { circa: 5 } }), /Unknown date option/);
    assert.throws(() => normalizeTransform({ regex_extract: '(' }), /not valid/);
    assert.equal(describeTransforms(['trim', { date: { circa_radius: 5, two_digit_century: null } }]), 'trim, date(circa_radius=5)');
  });

  test('trim, lower, split, join, map, regex_extract apply in order', () => {
    const m = map({
      title: { from: 'T', transform: ['trim'] },
      kind: { from: 'K', transform: ['lower'] },
      tags: { from: 'tags', transform: [{ split: ',' }] },
      author: { from: 'names', transform: [{ split: '|' }, { join: ' & ' }] },
      language: { from: 'lang', transform: [{ map: { Inglés: 'en' } }] },
      genre: { from: 'g', transform: [{ regex_extract: { pattern: 'genre=(\\w+)' } }] },
    });
    const { doc, issues } = applyMapping(rec({ T: '  A title  ', K: 'ZINE', tags: 'punk, xerox ,', names: 'A|B', lang: 'inglés', g: 'x genre=essay y' }), m, CTX);
    assert.deepEqual(issues, []);
    assert.equal(doc.title, 'A title');
    assert.equal(doc.kind, 'zine');
    assert.deepEqual(doc.tags.map((t) => t.value), ['punk', 'xerox']);
    assert.equal(doc.author, 'A & B');
    assert.equal(doc.lang_declared, 'en');
    assert.equal(doc.genre, 'essay');
  });

  test('zero_is_unknown: a 0 year is undated, not year 0', () => {
    const m = map({ title: { from: 't' }, date: { from: 'y', transform: ['zero_is_unknown'] } });
    const r = applyMapping(rec({ t: 'x', y: '0' }), m, CTX);
    assert.equal(r.doc.dates[0].parsed.precision, 'unknown');
    assert.deepEqual(r.issues, []);
    const plain = applyMapping(rec({ t: 'x', y: '0' }), map({ title: { from: 't' }, date: { from: 'y' } }), CTX);
    assert.equal(plain.issues[0].code, 'E_DATE_AMBIGUOUS');
  });

  test('date options: two-digit decades, circa radius, open ranges', () => {
    const m = map({ title: { from: 't' }, date: { from: 'd', transform: [{ date: { two_digit_century: 19, circa_radius: 2, open_range_years: 10 } }] } });
    const p = (v) => applyMapping(rec({ t: 'x', d: v }), m, CTX).doc.dates[0].parsed;
    assert.deepEqual([p("'90s").lo_year, p("'90s").hi_year], [1990, 1999]);
    assert.deepEqual([p('c. 1900').lo_year, p('c. 1900').hi_year], [1898, 1902]);
    assert.deepEqual([p('before 1850').lo_year, p('before 1850').hi_year], [1840, 1849]);
  });
});

describe('targets', () => {
  test('ext_id: mapped, generated when unmapped, generated with a warning when blank', () => {
    const m = map({ ext_id: { from: 'id' }, title: { from: 't' } });
    assert.equal(applyMapping(rec({ id: ' z1 ', t: 'x' }), m, CTX).doc.ext_id, 'z1');
    const blank = applyMapping(rec({ id: '', t: 'x' }, 7, 6), m, CTX);
    assert.equal(blank.doc.ext_id, `${'ab'.repeat(4)}#6`);
    assert.equal(blank.issues[0].code, 'E_FIELD_TYPE');
    assert.equal(applyMapping(rec({ t: 'x' }, 3, 2), map({ title: { from: 't' } }), CTX).doc.ext_id, `${'ab'.repeat(4)}#2`);
  });

  test('language names and codes normalize; unknown values are reported, not stored', () => {
    assert.equal(normalizeLang('English'), 'en');
    assert.equal(normalizeLang('हिन्दी'), 'hi');
    assert.equal(normalizeLang('ગુજરાતી'), 'gu');
    assert.equal(normalizeLang('fra'), 'fr');
    assert.equal(normalizeLang('en_GB'), 'en-GB');
    assert.equal(normalizeLang('Klingonish'), null);
    const r = applyMapping(rec({ t: 'x', l: 'Klingonish' }), map({ title: { from: 't' }, language: { from: 'l' } }), CTX);
    assert.equal(r.doc.lang_declared, undefined);
    assert.match(r.issues[0].message, /not a language name or code/);
  });

  test('date + date_end make one interval; reversed ranges and precision overrides are honest', () => {
    const m = map({ title: { from: 't' }, date: { from: 'a' }, date_end: { from: 'b' }, date_precision: { from: 'p' } });
    const r = applyMapping(rec({ t: 'x', a: '1850', b: '1855', p: '' }), m, CTX);
    assert.deepEqual([r.doc.dates[0].parsed.lo_year, r.doc.dates[0].parsed.hi_year, r.doc.dates[0].parsed.precision], [1850, 1855, 'range']);
    assert.equal(r.doc.dates[0].raw, '1850 – 1855');
    const rev = applyMapping(rec({ t: 'x', a: '1855', b: '1850', p: '' }), m, CTX);
    assert.equal(rev.doc.dates[0].parsed.precision, 'unknown');
    assert.equal(rev.issues[0].code, 'E_DATE_INVALID');
    // widening to a decade works; narrowing a range to a year is refused
    const wide = applyMapping(rec({ t: 'x', a: '1853-04-07', b: '', p: 'decade' }), m, CTX);
    assert.deepEqual([wide.doc.dates[0].parsed.lo_year, wide.doc.dates[0].parsed.hi_year, wide.doc.dates[0].parsed.precision], [1850, 1859, 'decade']);
    const narrow = applyMapping(rec({ t: 'x', a: '1850', b: '1855', p: 'year' }), m, CTX);
    assert.equal(narrow.doc.dates[0].parsed.precision, 'range');
    assert.match(narrow.issues[0].message, /not applied/);
  });

  test('referenced dates are kept apart from chronology', () => {
    const r = applyMapping(rec({ t: 'x', d: '1958', r: '1911' }), map({ title: { from: 't' }, date: { from: 'd' }, referenced_date: { from: 'r' } }), CTX);
    assert.deepEqual(r.doc.dates.map((d) => [d.role, d.is_chronology, d.parsed.lo_year]), [['publication', true, 1958], ['referenced', false, 1911]]);
  });

  test('an unparseable date keeps its raw value, undated, with a suggestion that shows the reading', () => {
    const r = applyMapping(rec({ t: 'x', d: 'Spring-ish 1850' }, 9), map({ title: { from: 't' }, date: { from: 'issued_col' } }), CTX);
    assert.equal(r.doc.dates.length, 0, 'the column is missing: no date');
    const r2 = applyMapping(rec({ t: 'x', issued: 'Spring-ish 1850' }, 9), map({ title: { from: 't' }, date: { from: 'issued' } }), CTX);
    assert.equal(r2.doc.dates[0].parsed.rule, 'unparsed');
    assert.equal(r2.doc.dates[0].raw, 'Spring-ish 1850');
    assert.equal(r2.issues[0].message, "Row 9 date 'Spring-ish 1850' was not recognised; row imported as undated.");
    assert.match(r2.issues[0].suggestion, /'spring 1850' \(Mar–May 1850\)/);
    assert.equal(r2.issues[0].field, 'issued');
  });

  test('cites → documented explicit_citation with a locator into the stored file; relations typed and checked', () => {
    const m = map({ ext_id: { from: 'id' }, title: { from: 't' }, cites: { from: 'c' }, relations: { from: 'r' } });
    const r = applyMapping(rec({ id: 'a', t: 'x', c: 'b; c ;a', r: 'samples:d; parody_of:e:proposed; kindred:f; bogus:g' }, 5), m, CTX);
    const cites = r.rels.filter((x) => x.rel_type === 'explicit_citation');
    assert.deepEqual(cites.map((x) => x.dst.ext_id), ['b', 'c']);
    for (const rel of r.rels) assert.deepEqual(check('CanonicalRelationship', rel), []);
    assert.equal(cites[0].evidence_status, 'documented');
    assert.equal(cites[0].origin, 'source_dataset');
    assert.equal(cites[0].source_locator, `sha256:${'ab'.repeat(32)}#line=5`);
    assert.equal(cites[0].provenance_note, 'as stated in your file');
    const byType = Object.fromEntries(r.rels.map((x) => [x.rel_type, x]));
    assert.equal(byType.samples.evidence_status, 'documented');
    assert.equal(byType.parody_of.evidence_status, 'proposed');
    assert.equal(byType.parody_of.origin, 'human');
    assert.equal(byType.kindred.evidence_status, 'proposed', 'similarity is never documented from a file');
    assert.equal(byType.bogus, undefined);
    assert.ok(r.issues.some((i) => /cites its own id/.test(i.message)));
    assert.ok(r.issues.some((i) => /'bogus' is not known/.test(i.message)));
  });

  test('original_meta keeps the verbatim record (text replaced by a pointer), mapped meta.* and notes', () => {
    const m = map({ title: { from: 't' }, text: { from: 'body' }, notes: { from: 'n' }, 'meta.shelf': { from: 's' } });
    const r = applyMapping(rec({ t: 'x', body: 'Some words here.', n: 'a note', s: 'B4', extra: 'kept' }), m, CTX);
    assert.deepEqual(r.doc.original_meta.record, { t: 'x', body: { $text: 'document text', chars: 16 }, n: 'a note', s: 'B4', extra: 'kept' });
    assert.equal(r.doc.original_meta.notes, 'a note');
    assert.deepEqual(r.doc.original_meta.mapped, { shelf: 'B4' });
    assert.deepEqual(r.doc.source_file, { sha256: 'ab'.repeat(32), byte_start: 10, byte_end: 90 });
    assert.deepEqual(check('CanonicalDocument', r.doc), []);
  });

  test('objects where text is expected are reported with the column and ignored', () => {
    const r = applyMapping(rec({ t: { a: 1 }, body: 'words' }, 12), map({ title: { from: 't' }, text: { from: 'body' } }), CTX);
    assert.equal(r.issues[0].message, "Row 12 't' is an object; expected text. The field was ignored.");
    assert.equal(r.doc.title, undefined);
  });

  test('no text and no title → E_MISSING_TEXT with a suggestion', () => {
    const r = applyMapping(rec({ body: '   ', t: '' }, 55), map({ title: { from: 't' }, text: { from: 'body' } }), CTX);
    assert.equal(r.reject.code, 'E_MISSING_TEXT');
    assert.equal(r.reject.message, 'Row 55 has no text and no title.');
    assert.ok(r.reject.suggestion.length > 0);
  });
});

describe('suggestions', () => {
  test('column inference: date, number, id, url, lang, list, text', () => {
    assert.equal(inferColumn('issued', ['1977-06', 'c. 1979', '1981', '1990s', '2001-02-03'], { now: NOW }).inferred, 'date');
    assert.equal(inferColumn('pages', ['120', '45', '3', '45'], { now: NOW }).inferred, 'number');
    assert.equal(inferColumn('id', ['1001', '1002', '1003'], { now: NOW }).inferred, 'id');
    assert.equal(inferColumn('link', ['https://a.example/x', 'http://b.example'], { now: NOW }).inferred, 'url');
    assert.equal(inferColumn('l', ['English', 'Spanish', 'English'], { now: NOW }).inferred, 'lang');
    assert.equal(inferColumn('refs', ['a;b', '', 'c'], { now: NOW }).inferred, 'list');
    assert.equal(inferColumn('body', ['Some longer text, with words.', 'More words here'], { now: NOW }).inferred, 'text');
  });

  test('header synonyms in five languages, value sniffing, and transforms', () => {
    const cols = [
      { name: 'fecha', values: ['1977', '1978', '1979'] },
      { name: 'Contenu', values: ['A long body of text that goes on for a while.', 'Another long body of text here.', 'Third body text, long enough.'] },
      { name: 'नाम', values: ['One', 'Two', 'Three'] },
      { name: 'भाषा', values: ['Hindi', 'English', 'hi'] },
      { name: 'misc', values: ['x', 'y', 'z'] },
      { name: 'when_written', values: ['1901-01-02', '1902', 'c. 1903'] },
    ];
    const m = suggestMapping(cols, { format: 'csv', fileName: 'Mes lettres.csv', now: NOW });
    assert.equal(m.fields.date.from, 'fecha');
    assert.equal(m.fields.text.from, 'Contenu');
    assert.equal(m.fields.title.from, 'नाम');
    assert.equal(m.fields.language.from, 'भाषा');
    assert.deepEqual(m.fields.language.transform, [{ map: { Hindi: 'hi', English: 'en' } }]);
    assert.equal(m.fields.referenced_date, undefined);
    assert.equal(m.collection.slug, 'mes-lettres');
    assert.match(m.fields.date.reason, /common name for date/);
    // with no synonym, > 80% parsing dates wins
    const m2 = suggestMapping([{ name: 'when_written', values: ['1901-01-02', '1902', 'c. 1903'] }, { name: 'b', values: ['some text body that is long', 'another long text body here'] }], { now: NOW });
    assert.equal(m2.fields.date.from, 'when_written');
    assert.match(m2.fields.date.reason, /100% of sampled values parse as dates/);
    assert.equal(m2.fields.text.from, 'b');
  });

  test('a "date" header over non-dates is not suggested as the date', () => {
    const m = suggestMapping([{ name: 'date', values: ['tbd', 'soon', 'later'] }, { name: 'text', values: ['some words here and more'] }], { now: NOW });
    assert.equal(m.fields.date, undefined);
  });
});

describe('mapping validation', () => {
  test('unknown targets, transforms and columns are 400-worthy errors with hints', () => {
    const v = validateMapping({ collection: { slug: 'ok' }, fields: { date: { from: 'issued_on' }, nonsense: { from: 'x' }, title: { from: 'T', transform: ['shout'] } } },
      { columns: ['id', 'T', 'issued'], format: 'csv' });
    const msgs = v.errors.map((e) => e.message);
    assert.ok(msgs.includes("Target 'date' maps to column 'issued_on', which the file does not have."));
    assert.ok(msgs.some((x) => /'nonsense' is not a target/.test(x)));
    assert.ok(msgs.some((x) => /Unknown transform 'shout'/.test(x)));
    assert.ok(v.errors.every((e) => e.hint));
  });
  test('nothing to import and a bad collection are errors; per-row collection is a stated limitation', () => {
    assert.ok(validateMapping({ collection: { slug: 'ok' }, fields: { author: { from: 'a' } } }).errors.some((e) => /Neither text nor title/.test(e.message)));
    assert.ok(validateMapping({ collection: { slug: 'Not A Slug' }, fields: { title: { from: 'a' } } }).errors.some((e) => /not a slug/.test(e.message)));
    const v = validateMapping({ collection: { slug: 'ok' }, fields: { title: { from: 'a' }, collection: { from: 'b' } } });
    assert.deepEqual(v.errors, []);
    assert.match(v.warnings[0].message, /Per-row collections are not supported yet/);
  });
});

describe('mapping end to end', () => {
  let t, db;
  before(() => { t = makeTmpData({ seed: false }); db = t.db; });
  after(() => t.cleanup());

  test('a mapping with constants, transforms, dates and citations commits what the dry run projected', async () => {
    const csv = 'id,Title,body,issued,lang,refs\nz001,"  One  ",The zero holds the place where nothing is.,1977-06,English,\n' +
      'z002,Two,"Carry the zero, children: it holds the place.",c. 1979,English,z001\nz003,Tres,El cero que se lleva en la cuenta.,1981,Spanish,z001;z002\n';
    const s = stageFile(db, csv, { fileName: 'zines.csv', collection: { name: 'Zines', unit: 'tokens', license: 'own' } });
    const mapping = { ...s.mapping, fields: { ...s.mapping.fields, community: { const: 'east-side zine scene' } } };
    const projected = await dryRun(db, s.batchId, mapping);
    const c = await commit(db, s.batchId, mapping);
    assert.equal(c.error, null);
    for (const k of ['rows', 'documents', 'passages', 'tokens', 'dates', 'languages', 'relationships']) assert.deepEqual(c.summary[k], projected[k], k);
    assert.deepEqual(c.summary.problems.by_code, projected.problems.by_code);
    assert.equal(c.summary.relationships.documented, 3);
    const d = one(db, "SELECT * FROM document WHERE ext_id = 'z001'");
    assert.equal(d.title, 'One');
    assert.equal(d.community, 'east-side zine scene');
    assert.equal(d.date_label, 'Jun 1977');
    assert.equal(d.lang_declared, 'en');
    const rel = one(db, "SELECT * FROM relationship WHERE rel_type = 'explicit_citation' ORDER BY id LIMIT 1");
    assert.equal(rel.evidence_status, 'documented');
    assert.equal(rel.origin, 'source_dataset');
    const decisions = Object.fromEntries(c.summary.mapping_decisions.map((x) => [x.target, x]));
    assert.equal(decisions.date.parse_rate, 1);
    assert.equal(decisions.community.reason, 'constant "east-side zine scene"');
    assert.equal(one(db, 'SELECT mapping_json FROM import_batch WHERE id = ?', s.batchId).mapping_json.includes('east-side'), true);
  });

  test('citations across collections: a namespaced id resolves when unique; a plain id stays inside its collection', async () => {
    const a = stageFile(db, 'id,title,body\npg:77,Source book,The source text.\nq9,Plain id,Another source.\n', { fileName: 'sources.csv', collection: { name: 'Sources' } });
    assert.equal((await commit(db, a.batchId, a.mapping)).error, null);
    const b = stageFile(db, 'id,title,body,refs\nc1,Citing,It cites two things.,pg:77;q9\n', { fileName: 'citing.csv', collection: { name: 'Citing' } });
    const projected = await dryRun(db, b.batchId, b.mapping);
    const c = await commit(db, b.batchId, b.mapping);
    for (const r of [projected, c.summary]) assert.deepEqual([r.relationships.documented, r.relationships.unresolved_targets], [1, 1]);
    const rel = one(db, `SELECT r.dst_ref, d.ext_id FROM relationship r JOIN document d ON d.id = CAST(r.dst_ref AS INTEGER)
      WHERE r.src_ref = (SELECT CAST(id AS TEXT) FROM document WHERE ext_id = 'c1')`);
    assert.equal(rel.ext_id, 'pg:77');
  });
});
