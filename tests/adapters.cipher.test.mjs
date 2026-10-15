// OWNER: WP2 — Cipher adapters (SPEC §6, §11 rows "a real corpus imports" and "inferred lineage cannot be mistaken
// for documented citation"): Gutenberg body bounds and regions (three marker variants, licence paragraphs,
// apparatus), sibling mapping by source code and tag provenance, theme/mood provenance, parent semantics of
// roots, the STEMM field map, and real slices of the Cipher files through adapter-load → DocumentWriter (a
// 3-book Gutenberg slice with #1661 → 1 document + 2 aliases and #135 flagged as a translation; Wikisource
// pages; culture-works rows). Parts that read Cipher files skip with a message when the files are absent.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { check } from '../src/shared/contracts.mjs';
import { CIPHER, cipherStatus, paths } from '../server/config.mjs';
import { registerAdapters, loadAdapter } from '../server/adapters/registry.mjs';
import { gutenbergBounds, gutenbergRegions } from '../server/adapters/cipher/gutenberg-text.mjs';
import { mapSibling, parseSiblings, pageLocator, joinTitle } from '../server/adapters/cipher/siblings.mjs';
import { parseWeighted, splitMakers, tagProvenance, workTags } from '../server/adapters/cipher/tags-provenance.mjs';
import { editDistance, loadRoots, parentSemantics } from '../server/adapters/cipher/roots.mjs';
import { firstAuthorBirth, parseCsv } from '../server/adapters/cipher/books.mjs';
import { frontMatterRegions } from '../server/adapters/cipher/wikisource.mjs';
import { laneForField, laneForLocc } from '../server/adapters/stemm/field-map.mjs';
import { makeTaskContext } from '../server/jobs/context.mjs';
import { ensureAdapterCollections, loadCollection } from '../server/jobs/tasks/adapter-load.mjs';
import { makeTmpData } from './helpers/tmpdata.mjs';

const HAVE_CIPHER = cipherStatus().ok;
const NO_CIPHER = !HAVE_CIPHER && `Cipher files not found (${cipherStatus().missing.join(', ')})`;
const NOW = new Date('2026-10-04T12:00:00Z');
const taskCtx = (db) => makeTaskContext({ db, jobId: null, cancelFlag: new Int32Array(new SharedArrayBuffer(4)), post: () => {} });

// ── Gutenberg text ──────────────────────────────────────────────────────────────────────────────────

const body = 'CHAPTER I.\n\nIt was a dark and stormy night; the rain fell in torrents.\n\nThe end of the chapter came at last.\n';
const licence = 'Project Gutenberg-tm electronic works may contain a computer virus, or computer codes that damage your equipment.';

describe('gutenberg-text.mjs (§4.3, §6.3)', () => {
  test('exact marker: the body is between *** START OF … and *** END OF …', () => {
    const t = `Header text\n*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n${body}*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\n${licence}\n`;
    const r = gutenbergRegions(t);
    assert.equal(r.marker, 'exact');
    assert.equal(t.slice(r.body_start, r.body_end), body);
    assert.deepEqual(r.issues, []);
  });

  test('no-space marker (***START OF …), case-insensitive', () => {
    const t = `x\r\n***Start of this Project Gutenberg EBook X***\r\n${body}***END OF THIS PROJECT GUTENBERG EBOOK X***\r\n`;
    const r = gutenbergBounds(t);
    assert.equal(r.marker, 'nospace');
    assert.equal(t.slice(r.body_start, r.body_end), body);
  });

  test('old SMALL PRINT header: the body starts after *END*THE SMALL PRINT and ends before "End of … Project Gutenberg Etext"', () => {
    const t = `Old header\n***START**THE SMALL PRINT!**FOR PUBLIC DOMAIN ETEXTS**START***\nlawyers.\n*END*THE SMALL PRINT! FOR PUBLIC DOMAIN ETEXTS*Ver.04.29.93*END*\n\n${body}\nEnd of Project Gutenberg Etext of Test\n`;
    const r = gutenbergBounds(t);
    assert.equal(r.marker, 'small_print');
    assert.equal(t.slice(r.body_start, r.body_end).trim(), body.trim());
  });

  test('no marker: the whole file is the body and W_NO_GUTENBERG_MARKERS is reported', () => {
    const r = gutenbergRegions(body);
    assert.equal(r.marker, 'none');
    assert.deepEqual([r.body_start, r.body_end], [0, body.length]);
    assert.equal(r.issues[0].code, 'W_NO_GUTENBERG_MARKERS');
    assert.ok(r.issues[0].suggestion);
  });

  test('licence paragraphs left inside the body are flagged boilerplate (the "computer virus" canary)', () => {
    const t = `*** START OF THE PROJECT GUTENBERG EBOOK T ***\n${body}\n${licence}\n\nA last paragraph of the book.\n*** END OF THE PROJECT GUTENBERG EBOOK T ***\n`;
    const r = gutenbergRegions(t);
    const bp = r.regions.filter((x) => x.quality === 'boilerplate');
    assert.equal(bp.length, 1);
    assert.equal(t.slice(bp[0].start, bp[0].end), licence);
  });

  test('editorial apparatus: a PREFACE by another person with a later year is apparatus; the author\'s own is not', () => {
    const later = `*** START OF THE PROJECT GUTENBERG EBOOK T ***\nPREFACE\n\nBy George Saintsbury\n\nThis edition of 1894 reprints the novel.\n\nCHAPTER I\n\n${'Words of the novel itself. '.repeat(200)}\n*** END OF THE PROJECT GUTENBERG EBOOK T ***\n`;
    const r = gutenbergRegions(later, { yHi: 1813, author: 'Jane Austen' });
    const ap = r.regions.filter((x) => x.time_role === 'apparatus');
    assert.equal(ap.length, 1);
    assert.match(later.slice(ap[0].start, ap[0].end), /^PREFACE[\s\S]*1894 reprints the novel\.$/);
    const own = later.replace('By George Saintsbury', 'By Jane Austen').replace('1894', '1812');
    assert.equal(gutenbergRegions(own, { yHi: 1813, author: 'Jane Austen' }).regions.filter((x) => x.time_role === 'apparatus').length, 0);
  });
});

// ── siblings, tags, roots, field map ────────────────────────────────────────────────────────────────

describe('siblings.mjs: Cipher relation → rel_type, direction and evidence status (§6.6)', () => {
  test('parseSiblings reads row:relation:strength[:source] items', () => {
    assert.deepEqual(parseSiblings('11135:remade as:1.00|15196:based on:1.00|526:counterpart:0.60').map((x) => [x.row, x.relation, x.strength, x.source]),
      [[11135, 'remade as', 1, null], [15196, 'based on', 1, null], [526, 'counterpart', 0.6, null]]);
    assert.equal(parseSiblings('12:samples:0.90:w')[0].source, 'w');
    assert.equal(parseSiblings('x:samples')[0].ok, false);
  });

  const cases = [
    // [relation, source, taggedPair] → [rel_type, src, dst, evidence_status, origin]
    ['samples', 'w', false, ['samples', 1, 2, 'documented', 'source_dataset']],
    ['sampled by', 'm', false, ['samples', 2, 1, 'documented', 'source_dataset']],
    ['covered as', 'm', false, ['cover_of', 2, 1, 'documented', 'source_dataset']],
    ['other version', 'd', false, ['version_of', 2, 1, 'documented', 'source_dataset']],
    ['inspired by', 'i', false, ['inspired_by', 1, 2, 'documented', 'source_dataset']],
    ['from film', 'w', false, ['part_of', 1, 2, 'documented', 'source_dataset']],
    ['features song', 'd', false, ['part_of', 2, 1, 'documented', 'source_dataset']],
    ['answered by', 'w', false, ['answer_to', 2, 1, 'documented', 'source_dataset']],
    ['kindred', null, false, ['kindred', 2, 1, 'computed', 'algorithm']],
    ['counterpart', null, true, ['counterpart', 2, 1, 'proposed', 'machine_tagger']],
    ['based on', null, true, ['adaptation_of', 1, 2, 'proposed', 'machine_tagger']],
    ['remade as', null, false, ['remake_of', 2, 1, 'documented', 'source_dataset']],
    ['echoed by', null, false, ['homage_to', 2, 1, 'documented', 'source_dataset']],
  ];
  for (const [relation, source, taggedPair, want] of cases) {
    test(`${relation} [${source ?? '-'}]${taggedPair ? ' (in a tagging batch)' : ''} → ${want[0]} ${want[3]}`, () => {
      const m = mapSibling({ row: 2, relation, source }, { from: 1, taggedPair });
      assert.deepEqual([m.rel_type, m.src, m.dst, m.evidence_status, m.origin], want);
    });
  }
  test('an unknown label maps to nothing (never guessed)', () => {
    assert.equal(mapSibling({ row: 2, relation: 'loosely related to', source: null }, { from: 1 }), null);
  });
  test('locators: Wikipedia page titles become article URLs; MusicBrainz/ItwoFS pages are URLs already', () => {
    assert.equal(pageLocator('w', 'Black on Both Sides'), 'https://en.wikipedia.org/wiki/Black_on_Both_Sides');
    assert.equal(pageLocator('w', 'fr:La Bohème (chanson)'), 'https://fr.wikipedia.org/wiki/La_Boh%C3%A8me_(chanson)');
    assert.equal(pageLocator('m', 'https://musicbrainz.org/recording/x'), 'https://musicbrainz.org/recording/x');
    assert.equal(joinTitle('Crazy in Love (feat. Jay-Z)'), 'crazy in love');
  });
});

describe('tags-provenance.mjs (§6.5)', () => {
  const tagged = { themes: new Set(['found family']) };
  test('themes: machine_tag when in the tagging batch, genre_heuristic at exactly 0.55, else documented_category', () => {
    assert.equal(tagProvenance({ scheme: 'theme', value: 'Found family', weight: 0.92, tagged }), 'machine_tag');
    assert.equal(tagProvenance({ scheme: 'theme', value: 'sitcom', weight: 0.55, tagged }), 'genre_heuristic');
    assert.equal(tagProvenance({ scheme: 'theme', value: 'friendship', weight: 1, tagged }), 'documented_category');
  });
  test('moods: genre_heuristic when every value is at 0.50, else machine_tag; motifs machine_tag; maker catalog', () => {
    const genre = workTags({ maker: 'A, B', canon: '', themes: '', motifs: 'blue skin', mood: 'tense:0.50|dark:0.50' }, null);
    assert.ok(genre.filter((t) => t.scheme === 'mood').every((t) => t.provenance === 'genre_heuristic'));
    const tagMood = workTags({ maker: '', canon: 'AFI 100', themes: 'love:0.68', motifs: '', mood: 'lush|epic' }, null);
    assert.ok(tagMood.filter((t) => t.scheme === 'mood').every((t) => t.provenance === 'machine_tag'));
    assert.equal(genre.find((t) => t.scheme === 'motif').provenance, 'machine_tag');
    assert.deepEqual(genre.filter((t) => t.scheme === 'maker').map((t) => [t.value, t.provenance]), [['A', 'catalog'], ['B', 'catalog']]);
    assert.equal(tagMood.find((t) => t.scheme === 'canon').provenance, 'documented_category');
    assert.ok([...genre, ...tagMood].every((t) => t.method));
  });
  test('weighted lists keep colons inside phrases; makers keep a trailing Jr.', () => {
    assert.deepEqual(parseWeighted('teenage pregnancy in:0.35'), [{ value: 'teenage pregnancy in', weight: 0.35 }]);
    assert.deepEqual(splitMakers('Sammy Davis, Jr., Dean Martin'), ['Sammy Davis, Jr.', 'Dean Martin']);
  });
});

describe('roots.mjs parent semantics (§1.7, §6.7) and the field map (§10.3)', () => {
  test('none / single / listed_chain / listed_variants / listed_unresolved', () => {
    assert.equal(parentSemantics([]), 'none');
    assert.equal(parentSemantics(['ine-pro:*kewh₁-']), 'single');
    assert.equal(parentSemantics(['ine-pro:*kewh₁-', 'sa:शू']), 'listed_chain');
    assert.equal(parentSemantics(['ine-pro:*krews-', 'ine-pro:*krows-']), 'listed_variants');
    assert.equal(parentSemantics(['ine-pro:*weys-', 'ine-pro:*dʰewb-', 'ine-pro:*dʰewbʰ-']), 'listed_unresolved');
    assert.equal(editDistance([...'abc'], [...'abd']), 1);
  });
  test('real roots.tsv: 704 chains, 351 variant lists, 1,170 unresolved; la:signale has no roots; sa:शून्य → en zero', { skip: !existsSync(CIPHER.roots) && 'roots.tsv absent' }, () => {
    const { rows } = loadRoots();
    const by = rows.reduce((m, r) => ({ ...m, [r.parent_semantics]: (m[r.parent_semantics] ?? 0) + 1 }), {});
    assert.equal(rows.length, 54989);
    assert.deepEqual([by.listed_chain, by.listed_variants, by.listed_unresolved], [704, 351, 1170]);
    assert.equal(rows.find((r) => r.key === 'la:signale').parents.length, 0);
    const sunya = rows.find((r) => r.key === 'sa:शून्य');
    assert.equal(sunya.members[0].word, 'zero');
    assert.equal(sunya.parent_semantics, 'listed_chain');
  });
  test('LoCC → STEMM lane; non-STEMM classes → null', () => {
    assert.equal(laneForField({ source: 'locc', value: 'QA' }), 'mathematics');
    assert.equal(laneForField({ source: 'locc', value: 'QA76.9' }), 'computing');
    assert.equal(laneForField({ source: 'locc', value: 'QH' }), 'life-sciences');
    assert.equal(laneForField({ source: 'locc', value: 'T58' }), 'engineering-technology');
    assert.equal(laneForField({ source: 'openalex', value: 27 }), 'medicine-health');
    assert.equal(laneForLocc('PR; PS'), null);
    assert.equal(laneForLocc('PR; QC'), 'physical-sciences');
  });
  test('books helpers: catalogue CSV with quoted newlines; first author birth year', () => {
    assert.deepEqual(parseCsv('a,b\n1,"x, ""y""\nz"\n'), [['a', 'b'], ['1', 'x, "y"\nz']]);
    assert.equal(firstAuthorBirth('Darwin, Charles, 1809-1882; Someone, 1900-1950'), 1809);
    assert.equal(firstAuthorBirth('Homer, 751? BCE-651? BCE'), -750);
    assert.equal(firstAuthorBirth('Anonymous'), null);
  });
  test('Wikisource front matter: the first two pages when they average < 30 tokens per line', () => {
    const t = 'Title\nAuthor\n१९२०\fPublisher\nPrice\fA long page of prose with many words on a single line that goes on and on and on for well over thirty tokens in total length here.';
    const r = frontMatterRegions(t);
    assert.equal(r.length, 2);
    assert.ok(r.every((x) => x.quality === 'front_matter'));
  });
});

// ── real slices through adapter-load → DocumentWriter ───────────────────────────────────────────────

describe('real Cipher slices (adapter-load → DocumentWriter)', { skip: NO_CIPHER }, () => {
  let t, db;
  before(async () => {
    t = makeTmpData({ seed: false });
    db = t.db;
    await registerAdapters(db);
  });
  after(() => t.cleanup());

  test('a 3-book Gutenberg slice: #1661 → 1 document + 2 aliases; #135 a translation; "Bennet" found with offsets; no licence text in ok passages', async () => {
    const books = await loadAdapter('cipher.books');
    ensureAdapterCollections(db, books);
    const c = await loadCollection(taskCtx(db), books, 'cipher-gutenberg', { ids: [1342, 135, 1661], writerOptions: { now: NOW } });
    assert.equal(c.documents.created, 3);
    const doc = (ext) => db.prepare("SELECT * FROM document WHERE ext_id = ?").get(ext);
    assert.equal(db.prepare('SELECT count(*) AS n FROM document_alias WHERE document_id = ?').get(doc('pg:1661').id).n, 2);
    const lm = doc('pg:135');
    assert.equal(lm.lang_declared, 'fr');
    assert.equal(lm.lang_text, 'en');
    assert.equal(lm.is_translation, 1);
    assert.equal(lm.original_lang, 'fr');
    assert.equal(lm.date_role, 'original_publication');
    assert.ok(c.issues.by_code.W_LANG_MISMATCH >= 1);
    const hit = db.prepare(`SELECT p.id, p.start_off, p.end_off, d.id AS doc FROM passage_fts f JOIN passage p ON p.id = f.rowid
      JOIN document d ON d.id = p.document_id WHERE passage_fts MATCH 'bennet' AND d.ext_id = 'pg:1342' LIMIT 1`).get();
    assert.ok(hit, 'Bennet is searchable');
    const text = db.prepare('SELECT original FROM document_text WHERE document_id = ?').get(hit.doc).original;
    assert.match(text.slice(hit.start_off, hit.end_off), /Bennet/);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM passage_fts f JOIN passage p ON p.id = f.rowid
      WHERE passage_fts MATCH '"computer virus or computer codes that damage"' AND p.quality = 'ok'`).get().n, 0);
    // originals first (§4.2): the source file is stored by sha256 and the document points at it
    const pp = doc('pg:1342');
    assert.ok(pp.source_file_sha256);
    assert.ok(existsSync(path.join(paths().originals, pp.source_file_sha256.slice(0, 2), pp.source_file_sha256)));
    // dates: Cipher list year stated (unverified) or a lifetime estimate; Issued is a release, never chronology
    const dates = db.prepare("SELECT role, basis, rule, is_chronology, note FROM date_assertion WHERE subject_type = 'document' AND subject_id = ?").all(pp.id);
    assert.ok(dates.some((d) => d.role === 'publication' && d.is_chronology === 1 && /unverified/.test(d.note)));
    assert.ok(dates.some((d) => d.role === 'release' && d.is_chronology === 0));
  });

  test('Wikisource pages: pages joined with \\f, page numbers kept, the index year is publication_unspecified', async () => {
    const ws = await loadAdapter('cipher.wikisource');
    ensureAdapterCollections(db, ws);
    const c = await loadCollection(taskCtx(db), ws, 'cipher-wikisource-hi', { limit: 2, pages: 10, writerOptions: { now: NOW } });
    assert.equal(c.documents.created, 2);
    const d = db.prepare("SELECT d.*, t.decoder, t.original FROM document d JOIN document_text t ON t.document_id = d.id WHERE d.ext_id LIKE 'ws-hi:%' LIMIT 1").get();
    assert.equal(d.decoder, 'pages-joined-ff');
    assert.ok(d.original.includes('\f'));
    assert.ok(db.prepare('SELECT max(page_no) AS m FROM passage WHERE document_id = ?').get(d.id).m > 1);
    assert.equal(d.date_role, 'publication_unspecified');
    assert.equal(d.lang_text, 'hi');
  });

  test('culture works: every record matches the CanonicalDocument contract; titles dated with the work, summaries describe', async () => {
    const works = await loadAdapter('cipher.works');
    let n = 0;
    for await (const doc of works.documents({ limit: 3000 }, {})) {
      assert.deepEqual(check('CanonicalDocument', doc), [], doc.ext_id);
      if (doc.fields.summary) {
        assert.equal(doc.field_roles.summary, 'describes');
        assert.ok(doc.dates.some((d) => d.role === 'authored_description' && d.parsed.basis === 'estimated'));
      }
      n++;
    }
    assert.equal(n, 3000);
    // §0.1 facts of the file: 94,385 rows, the empty year (never 0) is unknown for 8,227 rows, 28 rows dated 2027–2038
    const { loadWorks } = await import('../server/adapters/cipher/works.mjs');
    const { rows, bad } = loadWorks();
    assert.equal(rows.length, 94385);
    assert.deepEqual(bad, []);
    assert.equal(rows.filter((r) => r.year === null).length, 8227);
    assert.equal(rows.filter((r) => r.cols.year === '0').length, 0);
    assert.equal(rows.filter((r) => r.year > 2026).length, 28);
  });

  test('sibling mapping over the whole file: every relationship satisfies the contract and the evidence rules', async () => {
    const { siblingMapping } = await import('../server/adapters/cipher/works.mjs');
    const { relationships, stats } = siblingMapping({ runIds: { cipher_load: 1 } });
    assert.equal(stats.unparsed, 0);
    assert.equal(stats.unknown_relation, 0);
    for (const r of relationships) {
      assert.deepEqual(check('CanonicalRelationship', r), []);
      if (r.evidence_status === 'documented') {
        assert.equal(r.origin, 'source_dataset');
        assert.ok(r.source_dataset);
        assert.ok(r.source_locator || r.provenance_quality === 'source_unrecorded');
      }
      if (r.rel_type === 'kindred') assert.deepEqual([r.evidence_status, r.origin, r.run_id], ['computed', 'algorithm', 1]);
      if (r.rel_type === 'counterpart') assert.deepEqual([r.evidence_status, r.origin], ['proposed', 'machine_tagger']);
      assert.equal(r.score.kind, 'heuristic_strength');
    }
    assert.ok(relationships.some((r) => r.source_locator?.startsWith('https://musicbrainz.org/')));
    assert.ok(relationships.some((r) => r.source_locator?.startsWith('https://en.wikipedia.org/')));
  });
});

describe('bootstrap-cipher cancellation (§6.8, §4.12)', { skip: NO_CIPHER }, () => {
  let t, db;
  before(async () => {
    t = makeTmpData({ seed: false });
    db = t.db;
    await registerAdapters(db);
  });
  after(() => t.cleanup());

  test('a cancel during phase A rolls the culture-works batch back and leaves the bootstrap resumable', async () => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    // the main thread sets this flag in a real job; here the first progress report of the works load does it
    const post = (m) => { if (m.kind === 'progress' && /culture works/.test(m.message ?? '')) Atomics.store(flag, 0, 1); };
    const ctx = makeTaskContext({ db, jobId: null, cancelFlag: flag, post });
    const { run, nextStep, readState } = await import('../server/jobs/tasks/bootstrap-cipher.mjs');
    await assert.rejects(run(ctx, { mode: 'chain' }), (err) => err.code === 'E_CANCELLED');
    const n = db.prepare(`SELECT count(*) AS n FROM document d JOIN collection c ON c.id = d.collection_id
      WHERE c.slug = 'cipher-culture-works'`).get().n;
    assert.equal(n, 0, 'no half-loaded works');
    assert.equal(db.prepare("SELECT status FROM import_batch ORDER BY id DESC LIMIT 1").get().status, 'cancelled', 'a cancelled batch says so');
    assert.equal(readState(db).A, undefined);
    assert.equal(nextStep(db), 'A');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'collection_status:cipher-gutenberg'").get().value, 'pending');
  });
});

describe('source.mjs decodeBytes: offsets into a standard UTF-8 decode (fix pass, D4)', () => {
  test('only the first BOM is stripped: a second U+FEFF is text, as in a standard decode of the file', async () => {
    const { decodeBytes } = await import('../server/adapters/cipher/source.mjs');
    const bytes = Buffer.from([0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF, 0x41, 0x42]);
    const dec = decodeBytes(bytes);
    assert.equal(dec.hadBom, true);
    assert.equal(dec.text, '\uFEFFAB');
    assert.equal(dec.text, new TextDecoder('utf-8').decode(bytes), 'the same string as a standard UTF-8 decode');
    assert.equal(decodeBytes(Buffer.from([0xEF, 0xBB, 0xBF, 0x41])).text, 'A');
    assert.equal(decodeBytes(Buffer.from('AB')).text, 'AB');
  });
});

describe('relations.mjs: a record must state the link it is loaded as (fix pass, §13 rules 5–6)', () => {
  test("ItwoFS coincidence-page rows (a resemblance, not an inspiration) are left out; other ItwoFS pages are kept", async () => {
    const { statesLink } = await import('../server/adapters/cipher/relations.mjs');
    assert.equal(statesLink('i', { page: 'https://www.itwofs.com/coincidence.html', forward: 'inspired by' }), false);
    assert.equal(statesLink('i', { page: 'https://www.itwofs.com/hindi-pritam.html', forward: 'inspired by' }), true);
    assert.equal(statesLink('m', { page: 'https://musicbrainz.org/recording/x' }), true);
    assert.equal(statesLink('w', { page: 'Coincidence (song)' }), true);
  });

  test('over the raw files: no loaded record comes from the coincidence page, and the rows left out are counted', { skip: NO_CIPHER }, async () => {
    const { loadRelations, clearCache, statesLink } = await import('../server/adapters/cipher/relations.mjs');
    clearCache();
    const m = loadRelations({ works: [] });
    assert.ok(m.records.every(({ code, rec }) => statesLink(code, rec)));
    assert.equal(m.counts.left_out, 8, 'the 8 rows of itwofs.com/coincidence.html (Cipher strength 0.4)');
    clearCache();
  });
});

describe('relations.mjs: the documented music genealogy (§6.6, cipher.relations)', { skip: NO_CIPHER }, () => {
  test('endpoints are keyed by MusicBrainz recording, Wikidata item or folded title|artist|year', async () => {
    const { endpointKey } = await import('../server/adapters/cipher/relations.mjs');
    assert.equal(endpointKey({ qid: 'mb:9f514a7c-e3e7-4cdd-ba90-cc72682233c3', title: 'Sway' }), 'mb:9f514a7c-e3e7-4cdd-ba90-cc72682233c3');
    assert.equal(endpointKey({ qid: 'Q602375', title: 'Kernkraft 400' }), 'wd:Q602375');
    assert.equal(endpointKey({ qid: null, title: 'Fear Not for Man', artist: 'Fela Kuti', year: null }), 't:fear not for man|fela kuti|');
  });

  test('an endpoint that is a culture work becomes an alias of it (same Wikidata item, or title + a shared artist, years ±1)', async () => {
    const { loadRelations, clearCache } = await import('../server/adapters/cipher/relations.mjs');
    const { loadWorks } = await import('../server/adapters/cipher/works.mjs');
    const { joinTitle, joinArtists } = await import('../server/adapters/cipher/siblings.mjs');
    const m = loadRelations({ works: loadWorks().rows });
    assert.equal(m.counts.endpoints, m.counts.aliased + m.counts.documents);
    assert.ok(m.counts.aliased > 1000);
    for (const ep of [...m.endpoints.values()].filter((x) => x.work).slice(0, 2000)) {
      if (typeof ep.e.qid === 'string' && ep.e.qid === ep.work.qid) continue;
      assert.equal(joinTitle(ep.e.title), joinTitle(ep.work.title));
      assert.ok([...joinArtists(ep.e.artist)].some((a) => joinArtists(ep.work.maker).has(a)), `${ep.e.artist} / ${ep.work.maker}`);
      if (Number.isInteger(ep.e.year) && ep.work.year !== null) assert.ok(Math.abs(ep.e.year - ep.work.year) <= 1);
    }
    clearCache();
  });

  test('every relation is documented by its record; nothing is inferred', async () => {
    const rel = await loadAdapter('cipher.relations');
    let n = 0;
    for await (const r of rel.relationships({})) {
      assert.deepEqual(check('CanonicalRelationship', r), []);
      assert.equal(r.evidence_status, 'documented');
      assert.ok(r.source_locator || r.provenance_quality === 'source_unrecorded');
      if (++n >= 5000) break;
    }
    assert.equal(n, 5000);
  });
});
