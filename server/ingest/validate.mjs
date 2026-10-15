// OWNER: WP1
// validate.mjs — static checks of a mapping, and the dry-run projector (SPEC §5.2 step 3, §5.5).
//
// The projector has DocumentWriter's interface (addDocument, addRelationship, addIssue, finish, counts) and
// repeats its per-document computation — the same segmenter, tokenizer and language identifier, the same
// duplicate rules — without writing anything, so the projected summary has the commit's numbers. It reads
// the database (read-only) for what an import is compared against: existing ids, texts and signatures.
// Two checks are approximate and say so in `notes`: near duplicates on files over 15 M characters are left
// to the commit (MinHash over every document would blow the 10 s budget), and nothing about the database
// can change between the dry run and the commit.

import { createHash } from 'node:crypto';
import { check } from '../../src/shared/contracts.mjs';
import { parseDate } from '../../src/shared/dates.mjs';
import { slugify } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';
import { DOC_FIELDS, fillTemplate, ISSUE_CODES } from '../../src/shared/vocab.mjs';
import { minhashSignature } from '../store/document-writer.mjs';
import { detectLangFromTokens, documentLang, scriptOf } from '../text/langid.mjs';
import { segment } from '../text/segment.mjs';
import { createNearDupIndex } from './dedupe.mjs';
import { normalizeMapping, TARGETS } from './mapping.mjs';

const CHRONO_ROLES = ['publication', 'original_publication', 'creation', 'publication_unspecified', 'release', 'recording', 'performance'];
const SCAN_LANG_CLASSES = new Set(['text', 'title', 'abstract']);
const ISSUES_KEPT = 20;
const MAX_TEXT_CHARS = 20 * 1024 * 1024;
/** Above this many characters of file text, near duplicates are checked at commit only. */
export const NEAR_DUP_DRY_RUN_CHARS = 15 * 1024 * 1024;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const excerpt = (v) => (v === undefined || v === null ? null : String(v).slice(0, 200));

// ── static checks ───────────────────────────────────────────────────────────────────────────────────

/**
 * Static checks of a mapping (targets, transforms, columns, collection). `errors` make the mapping
 * unusable (400 E_MAPPING_INVALID); `warnings` are shown with the dry run.
 * @param {object} mapping
 * @param {{columns?: string[]|null, format?: string|null}} [opts] columns of the file (null = do not check)
 * @returns {{mapping: object, errors: Array<{target: string|null, message: string, hint: string, from?: unknown}>, warnings: object[]}}
 */
export function validateMapping(mapping, { columns = null, format = null } = {}) {
  const { mapping: m, errors } = normalizeMapping(mapping);
  const warnings = [];
  const fmt = format ?? m.format ?? null;
  const strictColumns = Array.isArray(columns) && (fmt === 'csv' || fmt === 'tsv' || fmt === 'txt' || fmt === 'md');
  for (const [target, spec] of Object.entries(m.fields)) {
    if (spec.from === undefined) continue;
    if (typeof spec.from === 'number') {
      if (!Number.isInteger(spec.from) || spec.from < 1 || (columns && spec.from > columns.length)) {
        errors.push({ target, from: spec.from, message: `Target '${target}' maps to column number ${spec.from}, which the file does not have.`,
          hint: columns ? `The file has ${columns.length} columns.` : 'Column numbers start at 1.' });
      }
      continue;
    }
    if (typeof spec.from !== 'string') {
      errors.push({ target, from: spec.from, message: `Target '${target}': 'from' must be a column name, a column number or a JSON Pointer.`, hint: 'Pick a column from the preview.' });
      continue;
    }
    if (strictColumns && !columns.includes(spec.from)) {
      errors.push({ target, from: spec.from, message: `Target '${target}' maps to column '${spec.from}', which the file does not have.`, hint: 'Pick a column from the preview.' });
    } else if (Array.isArray(columns) && !columns.includes(spec.from) && !spec.from.startsWith('/')) {
      warnings.push({ code: 'E_FIELD_TYPE', severity: 'warning', line: null, col: null, field: spec.from, value_excerpt: null,
        message: `Target '${target}' reads '${spec.from}', which none of the sampled records has.`,
        suggestion: 'Check the spelling; records without that key leave the target empty.' });
    }
  }
  if (!m.fields.text && !m.fields.title) {
    errors.push({ target: 'text', message: 'Neither text nor title is mapped, so every row would be rejected (E_MISSING_TEXT).',
      hint: 'Map a text column, or a title for metadata-only records.' });
  }
  if (m.fields.collection) {
    warnings.push({ code: 'E_FIELD_TYPE', severity: 'info', line: null, col: null, field: String(m.fields.collection.from ?? 'collection'), value_excerpt: null,
      message: `Per-row collections are not supported yet: every row goes into '${m.collection?.slug ?? 'the chosen collection'}'; the row's value is kept in its metadata.`,
      suggestion: 'Import each collection as its own file, or keep the value as metadata.' });
  }
  if (m.fields.date_end && !m.fields.date) {
    warnings.push({ code: 'E_FIELD_TYPE', severity: 'warning', line: null, col: null, field: String(m.fields.date_end.from ?? 'date_end'), value_excerpt: null,
      message: 'An end date is mapped without a start date; rows will be undated.', suggestion: 'Map the start date as well.' });
  }
  const c = m.collection;
  if (!c || !c.slug) {
    errors.push({ target: null, message: 'The mapping names no collection.', hint: 'Give the collection a name in the upload step.' });
  } else {
    const slug = slugify(String(c.slug));
    if (slug !== String(c.slug)) errors.push({ target: null, message: `Collection slug '${c.slug}' is not a slug (try '${slug}').`, hint: 'Use lower-case letters, digits and hyphens.' });
    if (c.unit !== undefined && c.unit !== null && !['tokens', 'works'].includes(c.unit)) errors.push({ target: null, message: `Collection unit '${c.unit}' is not 'tokens' or 'works'.`, hint: "Use 'tokens' for texts and 'works' for title lists." });
    if (c.name !== undefined && c.name !== null && typeof c.name !== 'string') errors.push({ target: null, message: 'Collection name must be text.', hint: 'Type a name.' });
    if (c.license !== undefined && c.license !== null && typeof c.license !== 'string') errors.push({ target: null, message: 'Collection licence must be text.', hint: 'Type the licence, e.g. "own" or "CC BY 4.0".' });
  }
  for (const k of Object.keys(m.fields)) if (!(k in TARGETS) && !k.startsWith('meta.')) errors.push({ target: k, message: `'${k}' is not a target field.`, hint: 'See Docs/IMPORT-SCHEMA.md.' });
  return { mapping: m, errors, warnings };
}

// ── the projector ───────────────────────────────────────────────────────────────────────────────────

const foldKey = (doc, yLo) => {
  const f = (s) => tokenize(String(s ?? '')).tokens.join(' ');
  return `${f(doc.title)}|${f(doc.author)}|${yLo ?? ''}`;
};

/**
 * A dry-run sink with DocumentWriter's interface. Nothing is written; `onIssue` receives every issue (the
 * pipeline streams them to the dry-run problems.csv).
 * @param {import('node:sqlite').DatabaseSync|null} db read-only connection, or null (no database checks)
 * @param {{collectionSlug: string, options?: {dedupe?: string, detectLanguage?: boolean}, textChars?: number,
 *   onIssue?: (issue: object) => void}} cfg
 */
export function createProjector(db, { collectionSlug, options = {}, textChars = 0, onIssue = null }) {
  const { dedupe = 'flag', detectLanguage = true } = options;
  const coll = db ? db.prepare('SELECT id FROM collection WHERE slug = ?').get(collectionSlug) ?? null : null;
  const nearDupOn = dedupe !== 'off' && textChars <= NEAR_DUP_DRY_RUN_CHARS;
  const notes = [];
  if (dedupe !== 'off' && !nearDupOn) notes.push('Near-duplicate texts (W_NEAR_DUP) are checked at commit only for files over 15 M characters; they are not counted in this projection.');
  const counts = {
    documents: { created: 0, rejected: 0, duplicates_flagged: 0, near_duplicates: 0, metadata_only: 0, translations: 0 },
    passages: 0, tokens: 0,
    dates: { day: 0, month: 0, year: 0, decade: 0, century: 0, millennium: 0, range: 0, period: 0, circa: 0, unknown: 0, scheduled: 0, span: { from: null, to: null } },
    languages: {},
    relationships: { documented: 0, computed: 0, proposed: 0, unresolved_targets: 0, rejected: 0 },
    annotations: { created: 0, rejected: 0 },
    issues: { total: 0, by_code: {}, first: [] },
  };
  let spanLo = null, spanHi = null;
  const shaSeen = new Map();     // text sha → line of the first document with it (this import)
  const metaSeen = new Map();
  let metaDb = null;
  const near = createNearDupIndex();
  let nearLoaded = false;
  const accepted = new Set();
  const pendingRels = [];
  let seq = 0;

  const qSha = db ? db.prepare('SELECT id FROM document WHERE text_sha256 = ? AND deleted_at IS NULL AND dup_of IS NULL ORDER BY id LIMIT 1') : null;
  const qExt = db && coll ? db.prepare('SELECT 1 FROM document WHERE collection_id = ? AND ext_id = ? AND deleted_at IS NULL UNION SELECT 1 FROM document_alias a JOIN document d ON d.id = a.document_id WHERE d.collection_id = ? AND a.ext_id = ? AND d.deleted_at IS NULL LIMIT 1') : null;

  function recordIssue(issue) {
    const def = ISSUE_CODES[issue.code];
    const full = {
      code: issue.code, severity: issue.severity ?? def?.severity ?? 'warning',
      line: Number.isInteger(issue.line) ? issue.line : null, col: Number.isInteger(issue.col) ? issue.col : null,
      field: issue.field ?? null, value_excerpt: excerpt(issue.value_excerpt),
      message: issue.message || (def ? fillTemplate(def.template, issue.vars ?? {}) : issue.code),
      suggestion: issue.suggestion || 'See the message for what to change.',
    };
    counts.issues.total++;
    counts.issues.by_code[full.code] = (counts.issues.by_code[full.code] ?? 0) + 1;
    if (counts.issues.first.length < ISSUES_KEPT) counts.issues.first.push(full);
    onIssue?.(full);
    return full;
  }

  function langOf(tokens, slice, declared) {
    if (!detectLanguage) return { lang: declared ?? 'und', confidence: declared ? 1 : 0 };
    return detectLangFromTokens(tokens, { declared, script: scriptOf(slice) });
  }

  function loadNear() {
    if (nearLoaded) return;
    nearLoaded = true;
    if (!db || !coll) return;
    const n = db.prepare('SELECT count(*) AS n FROM doc_minhash m JOIN document d ON d.id = m.document_id WHERE d.collection_id = ? AND d.deleted_at IS NULL').get(coll.id).n;
    if (n > 100000) return;
    for (const r of db.prepare('SELECT m.document_id AS id, m.sig FROM doc_minhash m JOIN document d ON d.id = m.document_id WHERE d.collection_id = ? AND d.deleted_at IS NULL').iterate(coll.id)) {
      near.add(`document ${r.id}`, new Uint32Array(r.sig.buffer.slice(r.sig.byteOffset, r.sig.byteOffset + r.sig.byteLength)));
    }
  }

  function metadataDuplicate(key) {
    if (metaSeen.has(key)) return `the row on line ${metaSeen.get(key)}`;
    if (!metaDb) {
      metaDb = new Map();
      if (db && coll) {
        for (const r of db.prepare('SELECT id, title, author, y_lo FROM document WHERE collection_id = ? AND deleted_at IS NULL AND has_full_text = 0').iterate(coll.id)) {
          metaDb.set(foldKey(r, r.y_lo), r.id);
        }
      }
    }
    return metaDb.has(key) ? `document ${metaDb.get(key)}` : null;
  }

  function reject(issues, issue) {
    issues.push(recordIssue({ severity: 'rejected', ...issue }));
    counts.documents.rejected++;
    return { documentId: null, issues };
  }

  function project(doc, line, issues) {
    const assertions = (doc.dates ?? []).map((d) => {
      let parsed = d.parsed ?? null;
      if (!parsed) { const r = parseDate(d.raw ?? null, {}); parsed = r.issue ? null : r; }
      return { ...d, parsed };
    });
    const chrono = assertions.find((a) => a.is_chronology) ?? assertions.find((a) => CHRONO_ROLES.includes(a.role)) ?? null;
    const cp = chrono?.parsed && chrono.parsed.lo_day !== null ? chrono.parsed : null;
    const chronoStatus = !cp ? 'undated' : cp.basis === 'announced' ? 'scheduled' : 'dated';

    const fields = { ...(doc.fields ?? {}) };
    if (!doc.text && !Object.values(fields).some((v) => typeof v === 'string' && v) && doc.title) fields.title = doc.title;
    const passages = [];
    let bodyTokens = [];
    if (doc.text) {
      const t = doc.text;
      const tok = tokenize(t.original);
      const start = t.body_start ?? 0, end = t.body_end ?? t.original.length;
      const segs = segment(t.original, { mode: t.mode ?? 'auto', lang: doc.lang_declared ?? null, regions: t.regions ?? [], start, end, tokens: tok });
      let k = 0;
      for (const s of segs) {
        while (k < tok.starts.length && tok.starts[k] < s.start) k++;
        let k1 = k;
        while (k1 < tok.starts.length && tok.starts[k1] < s.end) k1++;
        const tokens = tok.tokens.slice(k, k1);
        passages.push({ ...s, field: 'body', token_count: s.token_count, ...langOf(tokens, t.original.slice(s.start, s.end), doc.lang_declared) });
      }
      let b0 = 0;
      while (b0 < tok.starts.length && tok.starts[b0] < start) b0++;
      let b1 = b0;
      while (b1 < tok.starts.length && tok.starts[b1] < end) b1++;
      bodyTokens = tok.tokens.slice(b0, b1);
    }
    for (const field of DOC_FIELDS) {
      const value = fields[field];
      if (typeof value !== 'string' || !value) continue;
      const tokens = tokenize(value).tokens;
      const fc = field === 'title' || field === 'native_title' ? 'title' : field === 'abstract' && (doc.field_roles?.abstract ?? 'document') === 'document' ? 'abstract'
        : field === 'summary' && doc.field_roles?.summary === 'document' ? 'text' : 'describes';
      passages.push({ field, quality: 'ok', field_class: fc, token_count: tokens.length, ...langOf(tokens, value, doc.lang_declared) });
    }

    const langPassages = passages.filter((p) => SCAN_LANG_CLASSES.has(p.field_class) && p.quality === 'ok')
      .map((p) => ({ lang: p.lang, tokens: p.token_count, confidence: p.confidence }));
    const dl = detectLanguage ? documentLang(langPassages, doc.lang_declared ?? null)
      : { lang_text: doc.lang_declared ?? 'und', confidence: doc.lang_declared ? 1 : 0, is_translation: false, by_lang: {} };
    if (dl.is_translation) {
      issues.push(recordIssue({ code: 'W_LANG_MISMATCH', line, field: 'lang_declared', value_excerpt: doc.lang_declared,
        vars: { declared: doc.lang_declared, detected: dl.lang_text,
          scores: Object.entries(dl.by_lang).map(([l, s]) => `${l} ${s.toFixed(2)}`).join(' / ') },
        suggestion: 'Nothing to do if this is a translation (excluded from text-language chronology by default); otherwise correct the declared language.' }));
    }
    const detected = Object.entries(dl.by_lang ?? {}).filter(([l]) => !l.startsWith('und'));
    if (detected.length > 1 && detected[1][1] >= 0.15) {
      issues.push(recordIssue({ code: 'W_MIXED_LANGUAGE', line,
        vars: { title: doc.title ?? doc.ext_id, mix: detected.map(([l, s]) => `${l} (${Math.round(s * 100)}%)`).join(' and ') },
        suggestion: 'Nothing to do: lanes split by passage language.' }));
    }

    const textSha = bodyTokens.length ? sha256(bodyTokens.join(' ')) : null;
    let dup = null;
    if (textSha && dedupe !== 'off') {
      if (shaSeen.has(textSha)) dup = `the row on line ${shaSeen.get(textSha)}`;
      else {
        const d = qSha?.get(textSha);
        if (d) dup = `document ${d.id}`;
      }
      if (dup) {
        if (dedupe === 'skip') {
          return reject(issues, { code: 'W_DUP_CONTENT', line, value_excerpt: doc.ext_id,
            message: `${doc.ext_id}: same text as ${dup}; skipped (dedupe = skip).`, suggestion: 'Set duplicates to "flag" to keep both, excluded from counts.' });
        }
        issues.push(recordIssue({ code: 'W_DUP_CONTENT', line, value_excerpt: doc.ext_id,
          message: `Same text as ${dup}; excluded from counts by default.`,
          suggestion: 'Keep it flagged (excluded from counts by default), or remove one of the two from the file.' }));
        counts.documents.duplicates_flagged++;
      } else shaSeen.set(textSha, line);
    }
    if (doc.text && !dup && nearDupOn) {
      const sig = minhashSignature(bodyTokens);
      if (sig) {
        loadNear();
        const hit = near.query(sig);
        if (hit) {
          issues.push(recordIssue({ code: 'W_NEAR_DUP', line, value_excerpt: doc.ext_id,
            message: `Nearly the same text as ${hit.id} (MinHash Jaccard ${hit.j.toFixed(2)}).`,
            suggestion: 'Choose "keep both" or "mark as duplicate" in the import summary.' }));
          counts.documents.near_duplicates++;
        }
        near.add(`the row on line ${line}`, sig);
      }
    }
    if (!doc.text && dedupe !== 'off' && doc.title) {
      const key = foldKey(doc, cp?.lo_year ?? null);
      const other = metadataDuplicate(key);
      if (other) {
        issues.push(recordIssue({ code: 'W_DUP_METADATA', line, value_excerpt: doc.title, message: `Same title, author and year as ${other}.`,
          suggestion: 'Check whether the two records describe the same work.' }));
      } else metaSeen.set(key, line);
    }

    const tokenTotal = passages.reduce((s, p) => s + p.token_count, 0);
    counts.documents.created++;
    if (!doc.text) counts.documents.metadata_only++;
    if (dl.is_translation) counts.documents.translations++;
    counts.passages += passages.length;
    counts.tokens += tokenTotal;
    counts.languages[dl.lang_text] = (counts.languages[dl.lang_text] ?? 0) + 1;
    const dk = chronoStatus === 'undated' ? 'unknown' : chronoStatus === 'scheduled' ? 'scheduled' : cp.approx ? 'circa' : cp.precision;
    counts.dates[dk] = (counts.dates[dk] ?? 0) + 1;
    if (chronoStatus === 'dated') {
      if (spanLo === null || cp.lo_day < spanLo.day) spanLo = { day: cp.lo_day, label: cp.label };
      if (spanHi === null || cp.hi_day > spanHi.day) spanHi = { day: cp.hi_day, label: cp.label };
      counts.dates.span = { from: spanLo.label, to: spanHi.label };
    }
    accepted.add(doc.ext_id);
    return { documentId: `projected:${++seq}`, issues };
  }

  // a real import never links into the synthetic demo (§13 rule 1); only the demo itself may (its collection is synthetic)
  const targetsSynthetic = Boolean(db && coll && db.prepare('SELECT k.is_synthetic FROM collection c JOIN corpus k ON k.id = c.corpus_id WHERE c.id = ?').get(coll.id)?.is_synthetic === 1);
  /** Whether an endpoint names a synthetic document (document:<id>, or an ext_id of a synthetic collection). */
  function syntheticRef(e) {
    if (!db || !e) return false;
    if (e.ref) {
      const m = /^document:(\d+)$/.exec(String(e.ref));
      return Boolean(m && db.prepare('SELECT is_synthetic FROM document WHERE id = ?').get(Number(m[1]))?.is_synthetic === 1);
    }
    if (!e.ext_id || !e.collection || e.collection === collectionSlug) return false;
    return Boolean(db.prepare(`SELECT 1 FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.ext_id = ?
      AND d.is_synthetic = 1 AND d.deleted_at IS NULL LIMIT 1`).get(e.collection, e.ext_id));
  }

  function resolves(e) {
    if (!e) return false;
    if (e.ref) {
      const m = /^document:(\d+)$/.exec(String(e.ref));
      return Boolean(m && db?.prepare('SELECT 1 FROM document WHERE id = ? AND deleted_at IS NULL').get(Number(m[1])));
    }
    if (!e.ext_id) return false;
    const slug = e.collection ?? collectionSlug;
    if (slug === collectionSlug && accepted.has(e.ext_id)) return true;
    if (!db) return false;
    if (slug === collectionSlug) return Boolean(qExt?.get(coll.id, e.ext_id, coll.id, e.ext_id));
    return Boolean(db.prepare(`SELECT 1 FROM document d JOIN collection c ON c.id = d.collection_id WHERE c.slug = ? AND d.ext_id = ? AND d.deleted_at IS NULL
      UNION SELECT 1 FROM document_alias a JOIN document d ON d.id = a.document_id JOIN collection c ON c.id = d.collection_id
      WHERE c.slug = ? AND a.ext_id = ? AND d.deleted_at IS NULL LIMIT 1`).get(slug, e.ext_id, slug, e.ext_id));
  }

  return {
    notes,
    addDocument(doc, { line } = {}) {
      const issues = [];
      const errs = check('CanonicalDocument', doc);
      if (errs.length) {
        return reject(issues, { code: 'E_FIELD_TYPE', line, value_excerpt: doc?.ext_id,
          message: `Record ${doc?.ext_id ?? '(no ext_id)'} does not match the document contract: ${errs.slice(0, 3).join('; ')}` });
      }
      if (doc.text && doc.text.original.length > MAX_TEXT_CHARS) {
        return reject(issues, { code: 'E_ROW_TOO_LARGE', line, field: 'text', value_excerpt: doc.ext_id,
          vars: { line: line ?? doc.ext_id, field: 'text', size: `${(doc.text.original.length / 1048576).toFixed(1)} M characters` } });
      }
      return project(doc, line ?? null, issues);
    },
    addRelationship(rel) { pendingRels.push(rel); return { pending: true }; },
    addAnnotation() { return { pending: false }; },
    addIssue(issue) { recordIssue(issue); },
    flush() {},
    counts() { return counts; },
    finish() {
      for (const rel of pendingRels) {
        const srcOk = resolves(rel.src), dstOk = resolves(rel.dst);
        const fake = srcOk && dstOk && !targetsSynthetic ? [rel.src, rel.dst].find(syntheticRef) ?? null : null;
        if (fake) {
          counts.relationships.unresolved_targets++;
          const end = fake === rel.src ? 'source' : 'target';
          recordIssue({ code: 'W_SYNTHETIC_TARGET', severity: 'warning', field: end === 'source' ? 'src' : 'dst', value_excerpt: fake.ext_id ?? fake.ref ?? null,
            message: `Relationship ${rel.rel_type}: ${end} '${fake.ext_id ?? fake.ref ?? '?'}' is in the synthetic demo (invented material); the link was not created.`,
            suggestion: 'Link real records to real records only: the demo is invented material and never part of your data.' });
          continue;
        }
        if (!srcOk || !dstOk) {
          counts.relationships.unresolved_targets++;
          const which = !srcOk ? rel.src : rel.dst;
          recordIssue({ code: 'W_UNRESOLVED_TARGET', severity: 'warning', field: !srcOk ? 'src' : 'dst', value_excerpt: which?.ext_id ?? which?.ref ?? null,
            message: `Relationship ${rel.rel_type}: ${!srcOk ? 'source' : 'target'} '${which?.ext_id ?? which?.ref ?? '?'}' was not found; the link was not created.`,
            suggestion: 'Check the target id: it must be an id in this file or this collection (or a unique id elsewhere in Scrolls).' });
          continue;
        }
        counts.relationships[rel.evidence_status] = (counts.relationships[rel.evidence_status] ?? 0) + 1;
      }
      return { batch_id: null, collection: collectionSlug, ...counts, data_version: null };
    },
    rollback() {},
  };
}
