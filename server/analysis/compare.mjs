// OWNER: WP4
// compare.mjs — the Compare payload (SPEC §2.E): multiplicity, coverage and composition first, modality and
// prominence checks, frequency with exact CIs, representative passages, neighbouring terms (collocates +
// keyness), context groups, the three drift measures, tone and human stance counts, and OpenAlex
// within-cell presence shares (§10.4). A gated measure carries no value (§13 rule 7).
//
// Runs in the read pool (compareQuery(db, args), §12.2) and never writes: the multiplicity log is read and
// written by routes/compare.mjs, which passes k and the notable count in `args`. What is cheap is computed
// here (context-share shift from a clustering run's assignments, with document-block bootstrap CIs); what
// needs minutes is read from stored runs that match this exact comparison on the current data — slice
// spaces for neighbour overlap and aligned displacement (the 'drift' job), machine tone (the 'tone' job).
// Without such a run a measure whose evidence gate passes is `not_run` with a suggestion to start it.

import { canonicalJson, fnv1a32, mulberry32 } from '../../src/shared/ids.mjs';
import { formatCount, formatTokens } from '../../src/shared/format.mjs';
import { dataVersion } from '../db/open.mjs';
import { badRequest } from '../http/errors.mjs';
import { baselineRho } from './baseline-rho.mjs';
import { shareIntervals } from './bootstrap.mjs';
import { CONTEXT_LABEL, collocates, sliceContexts, thresholdsOut, WINDOW } from './collocations.mjs';
import { COMPOSITION_CAVEAT_JSD, COMPOSITION_MISMATCH_JSD, compositionJsd, STANDARDIZE_MIN_COVER, standardizedRates, topShare } from './composition.mjs';
import { clusterDocCounts, clusterRunFor, contextShareShift, driftRunParams, driftRunScope, eraNote, eraSlices, languageName,
  measureSentence, SLICE_GATE, storedDriftResults, verdict } from './drift.mjs';
import { collocatesNote, gated, lowCoverageNote, NO_WIDENING_NOTE, rangeLabel, SAMPLING_DESIGN_NOTE, THRESHOLDS,
  tokensHave, TONE_ADAPTER_MISSING, unitsLabel, widenLabel, widenSuggestion } from './gates.mjs';
import { poissonRate, poissonRateRatio, proportionRate, wilsonCI } from './intervals.mjs';
import { keyness } from './keyness.mjs';
import { multiplicityBlock, notableThreshold } from './multiplicity.mjs';
import { pooledSpaceFor } from './occvec.mjs';
import { DOMINANT_MODALITY_SHARE, loadScope, modalityEvidence, normalizeAsSaved, normalizeSlice, normalizeToggles, passageTextReader,
  resolveExpressions, samplePassages, scopeDocFilter, sliceStats, windowStats, wideningIndex } from './slices.mjs';
import { annotationShownAt } from '../provenance/annotations.mjs';
import { adapterStatus, storedTone, TONE_LABEL, TONE_METHOD, toneDistribution, toneRunParams } from './tone.mjs';

/** Pipeline version printed on Compare payloads. */
export const COMPARE_VERSION = 'compare@1.2.0';
/** Every measure a request may name (§7.2). */
export const MEASURES = Object.freeze(['freq', 'collocates', 'clusters', 'sense_share_jsd', 'neighbor_overlap', 'aligned_displacement', 'tone']);
const DRIFT = ['sense_share_jsd', 'neighbor_overlap', 'aligned_displacement'];
const LANE_FACETS = ['collection', 'community', 'kind', 'culture', 'language', 'field', 'domain', 'modality', 'date_basis'];

// ── Request ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Validate a POST /api/compare body (idempotent: a normalized request normalizes to itself). A saved view opened "as saved"
 * sends its pins and cutoffs (`runs`, `cutoffs`; RF-2, D17): the comparison then counts what the view counted at its save.
 * @param {unknown} body
 * @returns {{expr: number[], a: {years: [number, number], f: string}, b: {years: [number, number], f: string}, measures: string[],
 *   toggles: object, seed: number|null, lane_facet: string, corpus: string|null, override: 'descriptive'|null,
 *   runs?: {materialize?: Record<string, number>, cluster?: number}, cutoffs?: {import_batch?: number, at?: string, annotation_rev?: number}}}
 * @throws {HttpError} 400 E_VALIDATION
 */
export function normalizeCompareRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('E_VALIDATION', 'The comparison request must be a JSON object.', 'Send {expr, a, b}.', null);
  }
  const expr = body.expr;
  if (!Array.isArray(expr) || expr.length < 1 || expr.length > 2 || !expr.every((x) => Number.isSafeInteger(x) && x > 0)) {
    throw badRequest('E_VALIDATION', 'expr must list one or two expression ids.', 'Track the expression first, then compare.', { field: 'expr' });
  }
  const measures = body.measures ?? MEASURES;
  if (!Array.isArray(measures) || measures.some((m) => !MEASURES.includes(m))) {
    throw badRequest('E_VALIDATION', 'measures may only name ' + MEASURES.join(', ') + '.', 'Leave measures out for all of them.', { field: 'measures' });
  }
  const seed = body.seed ?? null;
  if (seed !== null && !(Number.isSafeInteger(seed) && seed >= 0)) {
    throw badRequest('E_VALIDATION', 'seed must be a non-negative integer.', 'Leave it out for the default draw.', { field: 'seed' });
  }
  const lane = body.lane_facet ?? 'collection';
  if (!LANE_FACETS.includes(lane)) {
    throw badRequest('E_VALIDATION', `lane_facet must be one of ${LANE_FACETS.join(', ')}.`, null, { field: 'lane_facet' });
  }
  if (body.override !== undefined && body.override !== null && body.override !== 'descriptive') {
    throw badRequest('E_VALIDATION', "override may only be 'descriptive'.", 'It shows each rate in its own unit, with no ratio, test or verdict.',
      { field: 'override' });
  }
  if (body.corpus !== undefined && body.corpus !== null && typeof body.corpus !== 'string') {
    throw badRequest('E_VALIDATION', 'corpus must be a corpus slug.', null, { field: 'corpus' });
  }
  const ids = [...new Set(expr)];
  const { runs, cutoffs } = normalizeAsSaved(body, ids);
  return {
    expr: ids, a: normalizeSlice(body.a, 'a'), b: normalizeSlice(body.b, 'b'),
    measures: MEASURES.filter((m) => measures.includes(m)), toggles: normalizeToggles(body.toggles), seed, lane_facet: lane,
    corpus: body.corpus ?? null, override: body.override ?? null, ...(runs ? { runs } : {}), ...(cutoffs ? { cutoffs } : {}),
  };
}

/** The pins and cutoffs of an as-saved comparison, spread into its run parameters (empty for current data). */
export const asSavedParams = (req) => ({ ...(req.runs ? { runs: req.runs } : {}), ...(req.cutoffs ? { cutoffs: req.cutoffs } : {}) });

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────

const r4 = (x) => (x === null || x === undefined ? null : Number(x.toFixed(4)));
const r2 = (x) => (x === null || x === undefined ? null : Number(x.toFixed(2)));
const ci2 = (ci) => ci.map((x) => (x === null ? null : Number(x.toFixed(2))));
const shares = (ev, key) => {
  let t = 0;
  for (const v of Object.values(ev)) t += v[key];
  const out = {};
  if (t > 0) for (const [k, v] of Object.entries(ev)) if (v[key] > 0) out[k] = r4(v[key] / t);
  return out;
};

/**
 * The dominant modality of a slice: ≥ 80% of its matches (or, without matches, of its covered documents).
 * @param {Record<string, {n: number, docs: number}>} ev
 * @returns {string|null}
 */
export function dominantModality(ev) {
  const byN = shares(ev, 'n');
  const use = Object.keys(byN).length ? byN : shares(ev, 'docs');
  for (const [m, s] of Object.entries(use)) if (s >= DOMINANT_MODALITY_SHARE) return m;
  return null;
}

const MEDIUM = { text: 'text', titles: 'titles', abstracts: 'abstracts', lexical: 'entries', baseline: 'baseline' };

function describeSlice(stats) {
  const top = topShare(stats.mix);
  const noun = MEDIUM[stats.modality] ?? stats.modality;
  if (!top) return `no ${noun}`;
  return top.share >= 0.995 ? `${top.key} ${noun}` : `${Math.round(top.share * 100)}% ${top.key} ${noun}`;
}

// ── The comparison context (shared with the drift and tone jobs) ─────────────────────────────────────

/**
 * Everything a comparison is computed from: the normalized request, the expressions, the scope, each
 * slice's statistics in the compared modality, the composition JSD, the modality and sampling refusals,
 * and the widening search. compareQuery builds the payload from it; the drift and tone jobs use it to
 * evaluate the same evidence gates and select the same documents.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} args a Compare request
 * @returns {object}
 */
export function compareContext(db, args) {
  const req = normalizeCompareRequest(args);
  const exprs = resolveExpressions(db, req.expr, { pinned: req.runs?.materialize ?? null });
  const label = exprs.map((e) => e.surface).join(' + ');
  const scope = loadScope(db, { exprs, slices: [req.a, req.b], toggles: req.toggles, corpus: req.corpus, cutoffs: req.cutoffs ?? null });
  const [specA, specB] = scope.specs;
  const evA = modalityEvidence(scope, specA), evB = modalityEvidence(scope, specB);
  const domA = dominantModality(evA), domB = dominantModality(evB);
  const mismatch = Boolean(domA && domB && domA !== domB);
  const descriptive = mismatch && req.override === 'descriptive';
  let modality = null;
  if (!mismatch) {
    modality = domA ?? domB;
    if (!modality) {
      const pooled = {};
      for (const ev of [evA, evB]) for (const [m, v] of Object.entries(ev)) {
        const p = pooled[m] ?? (pooled[m] = { n: 0, docs: 0 });
        p.n += v.n;
        p.docs += v.docs;
      }
      modality = Object.entries(pooled).sort(([, x], [, y]) => y.n - x.n || y.docs - x.docs)[0]?.[0] ?? 'text';
    }
  }
  const statsA = sliceStats(scope, specA, mismatch ? domA : modality);
  const statsB = sliceStats(scope, specB, mismatch ? domB : modality);
  const collectionsUsed = [...new Set([...statsA.collections, ...statsB.collections])].sort();
  const collBySlug = new Map([...scope.collections.values()].map((c) => [c.slug, c]));
  const sampled = collectionsUsed.some((s) => collBySlug.get(s)?.sampling === 'top_cited_per_cell');
  const jsd = mismatch ? null : compositionJsd(statsA.composition, statsB.composition);
  const indexes = {};
  const indexOf = (which) => (indexes[which] ??= wideningIndex(scope, which === 'a' ? specA : specB, which === 'a' ? statsA.modality : statsB.modality));

  // suggestions: widen failing slices (A first, then B against A's new years)
  function suggest(failing, crit, describe) {
    const out = { would_have: {} };
    let yearsA = req.a.years;
    const labels = [];
    for (const which of ['a', 'b']) {
      if (!failing[which]) continue;
      const spec = which === 'a' ? specA : specB;
      const other = which === 'a' ? req.b.years : yearsA;
      const w = widenSuggestion(indexOf(which), spec.years, crit, { other });
      if (!w) return null;
      if (which === 'a') yearsA = w.years;
      out[which] = { years: w.years, f: spec.fStr };
      out.would_have[which] = describe.data(w.stats);
      labels.push(widenLabel(which, w.years, describe.text(w.stats)));
    }
    return { label: labels.join(' and '), ...out };
  }
  const evidenceText = { text: (s) => `${formatCount(s.n)} occurrences in ${formatCount(s.docs)} documents`,
    data: (s) => ({ occurrences: s.n, documents: s.docs, authors: s.authors }) };
  const runParams = { expr: req.expr, a: req.a, b: req.b, toggles: req.toggles, corpus: req.corpus, ...asSavedParams(req) };
  return { req, exprs, label, scope, specA, specB, evA, evB, domA, domB, mismatch, descriptive, modality, statsA, statsB, collectionsUsed,
    collBySlug, sampled, jsd, indexOf, suggest, evidenceText, runParams, fp: driftRunScope(collectionsUsed, exprs),
    lang: exprs[0].lang ?? primaryLanguage(statsA, statsB) };
}

/** The language holding most of both slices' tokens (for language-free expressions). */
function primaryLanguage(statsA, statsB) {
  const w = {};
  for (const st of [statsA, statsB]) for (const [l, s] of Object.entries(st.languages ?? {})) w[l] = (w[l] ?? 0) + s * st.units;
  return Object.entries(w).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
}

/**
 * Documents of a slice that hold counted matches (the units context groups and tone are read from).
 * @param {object} st slice stats
 * @returns {number[]}
 */
export function evidenceDocIds(st) {
  return st.perDoc.filter((d) => d.n > 0).map((d) => d.id);
}

/**
 * Documents a slice space is built from: every included document of the slice except translations (§4.8).
 * @param {object} cx compareContext()
 * @param {object} st slice stats
 * @returns {number[]}
 */
export function spaceDocIds(cx, st) {
  return st.perDoc.map((d) => d.id).filter((id) => !cx.scope.docs.get(id)?.tr).sort((a, b) => a - b);
}

// ── The query ────────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/compare. Read-query convention (§12.2): runs in the read pool via ctx.pool.run(moduleUrl,
 * 'compareQuery', args).
 * @param {import('node:sqlite').DatabaseSync} db read-only connection
 * @param {object} args the request body (normalized here) plus `multiplicity: {k, notable_so_far}` from the route
 * @returns {object} the Compare payload
 */
export function compareQuery(db, args) {
  const cx = compareContext(db, args);
  const { req, exprs, label, scope, specA, specB, evA, evB, mismatch, descriptive, statsA, statsB, collectionsUsed, collBySlug,
    sampled, jsd, indexOf, suggest, evidenceText } = cx;
  const mult = args.multiplicity ?? { k: 1, notable_so_far: 0 };
  const expressions = exprs.map((e) => ({ id: e.id, surface: e.surface, lang: e.lang, run: e.run, synthetic: e.synthetic }));
  const seed = req.seed ?? (fnv1a32(canonicalJson({ expr: req.expr, a: req.a, b: req.b, toggles: req.toggles })) % 1000000);
  const want = new Set(req.measures);
  const readText = passageTextReader(db);
  const synthetic = statsA.synthetic || statsB.synthetic || exprs.some((e) => e.synthetic);
  const provenance = {
    data_version: dataVersion(db), run_ids: { materialize: Object.fromEntries(exprs.map((e) => [e.id, e.run])) },
    tokenizer: 'u61m-1', segmenter: 'seg-1', synthetic, collections: collectionsUsed,
    licenses: [...new Set(collectionsUsed.map((s) => collBySlug.get(s)?.license).filter(Boolean))].sort(),
  };

  // ── coverage ──
  const coverageOf = (st, ev, rateGate) => ({
    years: st.years, f: st.f, modality_compared: st.modality, unit: st.unit, [st.unit]: st.units, docs: st.docs,
    authors: st.authors.size, translations: req.toggles.tr ? st.translationsIncluded : st.excluded.translations.docs,
    translations_included: Boolean(req.toggles.tr),
    translation_share: r4(req.toggles.tr ? (st.docs ? st.translationsIncluded / st.docs : 0)
      : (st.docs + st.excluded.translations.docs ? st.excluded.translations.docs / (st.docs + st.excluded.translations.docs) : 0)),
    undated_share: r4(st.undatedShare), undated: st.undated, scheduled: st.scheduled,
    mix: st.mix, languages: st.languages, collection_mix: st.collectionMix, collections: [...st.collections].sort(),
    stack: [...st.strata].map(([key, v]) => {
      const [kind, lang, collection] = key.split('|');
      return { kind, lang, collection, share: r4(st.units > 0 ? v.units / st.units : 0) };
    }).sort((x, y) => y.share - x.share),
    modality: shares(ev, 'docs'), evidence_modality: shares(ev, 'n'), basis: st.basisMix,
    prominence_terciles: Object.fromEntries(Object.entries(st.terciles).map(([t, v]) => [t, r4(st.units > 0 ? v.units / st.units : 0)])),
    washes: st.excluded.washes, excluded: st.excluded, selection: st.selection,
    rate_gate: rateGate, filter_warnings: st.filterWarnings, synthetic: st.synthetic,
  });
  const caveats = [];
  const notes = [];
  const multiplicity = multiplicityBlock({ k: mult.k, notableSoFar: mult.notable_so_far, label });

  // ── modality refusal (default for cross-modality slices, D15) ──
  if (mismatch && !descriptive) {
    const common = Object.keys(evA).filter((m) => evB[m]);
    let suggestion = null;
    if (common.length) {
      const m = common.sort((x, y) => (evB[y].n + evA[y].n) - (evB[x].n + evA[x].n) || (evB[y].docs + evA[y].docs) - (evB[x].docs + evA[x].docs))[0];
      const colls = (spec) => [...spec.collIds].map((id) => scope.collections.get(id)).filter((c) => c.modality === m).map((c) => c.slug).sort();
      const withColl = (spec) => {
        const keep = spec.fStr.split(';').filter((seg) => seg.trim() && !seg.trim().startsWith('coll:'));
        return [...keep, `coll:${colls(spec).join(',')}`].join(';');
      };
      suggestion = { label: `Compare ${MEDIUM[m]} with ${MEDIUM[m]}`, a: { years: req.a.years, f: withColl(specA) },
        b: { years: req.b.years, f: withColl(specB) } };
    }
    const sentence = `A is ${describeSlice(statsA)}, B is ${describeSlice(statsB)}: different media.`;
    const have = { a: statsA.modality, b: statsB.modality };
    const card = () => gated('modality_mismatch', { needed: { modality: 'same' }, have, suggestion: null });
    caveats.push('modality');
    return {
      version: COMPARE_VERSION,
      expressions, toggles: req.toggles,
      ...asSavedBlock(req),
      multiplicity,
      coverage: { a: coverageOf(statsA, evA, null), b: coverageOf(statsB, evB, null), composition_jsd: null, caveats,
        modality_gate: 'modality_mismatch' },
      freq: gated('modality_mismatch', { needed: { modality: 'the same dominant modality in both slices' }, have: { a: shares(evA, 'n'), b: shares(evB, 'n') },
        suggestion, note: `${sentence} Compare anyway shows each rate in its own unit, with no ratio, test or verdict.` }),
      passages: { a: [], b: [], seed },
      collocates: card(),
      clusters: null,
      measures: DRIFT.filter((m) => want.has(m)).map((metric) => ({ metric, ...card() })),
      tone: { ...card(), reason: 'Tone is not compared across media.' },
      human: humanCounts(db, scope, statsA, statsB, { revCutoff: req.cutoffs?.annotation_rev ?? null }),
      coverage_note: `A is ${describeSlice(statsA)} and B is ${describeSlice(statsB)}: a change of medium, not of meaning. Nothing is compared across media by default.`,
      provenance,
    };
  }

  // ── frequency ──
  const rateGateOf = (st) => (st.units >= st.gateUnits ? 'ok' : 'insufficient_coverage');
  const freqSlice = (st, which) => {
    const gate = rateGateOf(st);
    const base = { n: st.rateN, occurrences: st.n, unit: st.rateUnit, units: st.units, docs: st.evidenceDocs, covered_docs: st.docs,
      authors: st.evidenceAuthors.size, dp: r4(st.dp), single_source: st.topDocShare !== null && st.topDocShare >= 0.6,
      top_doc_share: r4(st.topDocShare), synthetic: st.synthetic };
    if (gate !== 'ok') {
      const crit = { units: st.gateUnits };
      const w = suggest({ [which]: true }, crit, { text: (s) => unitsLabel(s.units, st.unit), data: (s) => ({ [st.unit]: s.units, occurrences: s.n }) });
      return gated('insufficient_coverage', { ...base, needed: { [st.unit]: st.gateUnits }, have: { [st.unit]: st.units }, suggestion: w,
        note: lowCoverageNote(st.rateN, st.units, st.unit) + (w ? '' : `; ${NO_WIDENING_NOTE}`) });
    }
    const r = st.unit === 'tokens' ? poissonRate(st.n, st.units, st.scale) : proportionRate(st.k, st.units, st.scale);
    return { gate: 'ok', ...base, rate: r2(r.rate), ci: ci2(r.ci) };
  };
  let freq;
  let withinCell = null;
  if (sampled && !descriptive) {
    freq = gated('sampling_design', { needed: { comparison: 'within one OpenAlex cell' },
      have: { a: { works_matching: statsA.k, works_sampled: statsA.units }, b: { works_matching: statsB.k, works_sampled: statsB.units } },
      note: SAMPLING_DESIGN_NOTE });
    caveats.push('sampling_design');
    withinCell = withinCellShares(db, scope, [specA, specB], req.toggles);
  } else {
    const fa = freqSlice(statsA, 'a'), fb = freqSlice(statsB, 'b');
    freq = { a: fa, b: fb, ci_method: statsA.unit === 'tokens' ? 'Garwood exact Poisson 95%' : 'Wilson score 95%' };
    if (descriptive) {
      freq.rate_ratio = gated('modality_mismatch', { needed: { modality: 'same' }, have: { a: statsA.modality, b: statsB.modality },
        note: 'Descriptive only: each rate is in its own unit; no ratio, test or verdict across media.' });
    } else if (fa.gate !== 'ok' || fb.gate !== 'ok') {
      const failing = { a: fa.gate !== 'ok', b: fb.gate !== 'ok' };
      freq.rate_ratio = gated('insufficient_coverage', { needed: { [statsA.unit]: Math.max(statsA.gateUnits, statsB.gateUnits) },
        have: { a: statsA.units, b: statsB.units },
        suggestion: combineSuggestions([fa, fb], failing),
        note: `Not estimated: ${['a', 'b'].filter((w) => failing[w]).map((w) => `slice ${w.toUpperCase()} has ${unitsLabel((w === 'a' ? statsA : statsB).units, statsA.unit)}`).join(' and ')} (needs ${unitsLabel(Math.max(statsA.gateUnits, statsB.gateUnits), statsA.unit)}).` });
    } else {
      const rr = poissonRateRatio(statsA.rateN, statsA.units, statsB.rateN, statsB.units);
      freq.rate_ratio = { value: r2(rr.value), ci: rr.ci ? ci2(rr.ci) : null, unbounded: rr.unbounded, direction: 'B relative to A',
        method: statsA.unit === 'tokens' ? 'exact conditional (Clopper–Pearson on n_B of n_A + n_B)'
          : 'exact conditional, Poisson approximation for works (Clopper–Pearson on k_B of k_A + k_B)',
        note: rr.value === null ? (rr.ci ? 'A has no occurrences: the ratio has no upper bound.' : 'Neither slice has an occurrence: no ratio.') : null };
      if (jsd !== null && jsd > COMPOSITION_CAVEAT_JSD) {
        const strata = new Map();
        for (const [st, side] of [[statsA, 'a'], [statsB, 'b']]) {
          for (const [k, v] of st.strata) {
            const e = strata.get(k) ?? { a: { n: 0, denom: 0 }, b: { n: 0, denom: 0 } };
            e[side] = { n: st.unit === 'tokens' ? v.n : v.k, denom: v.units };
            strata.set(k, e);
          }
        }
        const std = standardizedRates(strata, { scale: statsA.scale });
        // fix pass: a standardized rate speaks only for the strata both slices share; when those hold little of the mix or
        // of a slice's matches it is withheld (a slice with matches never reads 0/M), and a reversal is said
        const thin = std && (std.weight_covered < STANDARDIZE_MIN_COVER
          || ['a', 'b'].some((k) => std.matches_covered[k] !== null && std.matches_covered[k] < STANDARDIZE_MIN_COVER));
        const raw = [statsA, statsB].map((st) => (st.units > 0 ? (st.unit === 'tokens' ? st.n : st.k) / st.units : null));
        const reversed = std && !thin && raw.every((x) => x !== null) && Math.sign(raw[1] - raw[0]) * Math.sign(std.b - std.a) < 0;
        freq.standardized = !std ? { a: null, b: null, note: 'no kind × language × collection stratum occurs in both slices' }
          : thin ? { a: null, b: null, strata: std.strata, weight_covered: r4(std.weight_covered),
            note: `The slices share too little of their mix for standardized rates: the strata found in both hold ${Math.round(std.weight_covered * 100)}% of the pooled ${statsA.unit === 'tokens' ? 'tokens' : 'works'}${
              ['a', 'b'].filter((k) => std.matches_covered[k] !== null).map((k) => `, ${Math.round(std.matches_covered[k] * 100)}% of ${k.toUpperCase()}'s matches`).join('')} (needs ${Math.round(STANDARDIZE_MIN_COVER * 100)}%).` }
            : { a: r2(std.a), b: r2(std.b), strata: std.strata, weight_covered: r4(std.weight_covered),
              method: 'direct standardization to the pooled kind × language × collection mix',
              ...(reversed ? { note: 'Standardized and raw rates point in opposite directions: the difference lies in the mix of sources, not within them.' } : {}) };
      }
    }
  }
  if (descriptive) caveats.push('modality');

  // ── prominence ──
  const prominence = prominenceCheck(statsA, statsB);
  if (prominence.consistent === false) caveats.push('prominence');

  // ── context groups (needed by the passages' strata and by measure (a)) ──
  const allTime = windowStats(indexOf('a'), -Infinity, Infinity);
  const groups = contextGroups(db, cx, allTime);

  // ── passages ──
  const rng = mulberry32(seed);
  const passages = {
    a: samplePassages(db, scope, specA, statsA, { rng, laneFacet: req.lane_facet, readText }),
    b: samplePassages(db, scope, specB, statsB, { rng, laneFacet: req.lane_facet, readText }),
    seed,
    stratified_by: null,
    note: 'One passage per document at most, drawn with the printed seed; a new seed reshuffles. Not stratified by context group.',
  };

  // ── neighbouring terms ──
  let colloc;
  if (!want.has('collocates')) colloc = { requested: false, label: CONTEXT_LABEL };
  else if (descriptive) colloc = gated('modality_mismatch', { needed: { modality: 'same' }, have: { a: statsA.modality, b: statsB.modality } });
  else colloc = neighbourTerms(db, scope, specA, specB, statsA, statsB, { suggest, readText });

  // ── context groups, drift measures, tone ──
  const clusters = want.has('clusters') ? groups.block : null;
  const measures = driftBlock(db, cx, { want, allTime, groups, k: mult.k });

  // ── caveats and the coverage paragraph ──
  if (jsd !== null && jsd > COMPOSITION_CAVEAT_JSD) {
    caveats.push('composition');
    notes.push(`The slices differ in composition (JSD ${jsd.toFixed(2)}): A is ${describeSlice(statsA)}, B is ${describeSlice(statsB)}. ` +
      `Differences below may reflect source mix${freq.standardized ? '; directly standardized rates are shown beside the raw rates' : ''}.`);
  }
  if (descriptive) notes.push(`A is ${describeSlice(statsA)} and B is ${describeSlice(statsB)}: shown descriptively, each in its own unit, with no ratio, test or verdict.`);
  for (const st of [statsA, statsB]) {
    const S = st.which.toUpperCase();
    const om = st.excluded.other_modality;
    if (om.docs) {
      caveats.push('mixed_modality');
      notes.push(`Slice ${S} also holds ${Object.keys(om.modalities).map((m) => MEDIUM[m] ?? m).join(' and ')} (${plural(om.docs, 'document', 'documents')}, ${plural(om.n, 'match', 'matches')}); only ${MEDIUM[st.modality]} is compared.`);
    }
    if (rateGateOf(st) !== 'ok') {
      caveats.push('low_coverage');
      notes.push(`Slice ${S} has ${unitsLabel(st.units, st.unit)} (needs ${unitsLabel(st.gateUnits, st.unit)}): its rate is not estimated.`);
    }
    if (st.undatedShare >= 0.2) {
      caveats.push('undated');
      notes.push(`${Math.round(st.undatedShare * 100)}% of the documents matching slice ${S}'s filters are undated and cannot be placed in it.`);
    }
    if (st.excluded.washes.docs) {
      caveats.push('washes');
      notes.push(`${plural(st.excluded.washes.docs, 'document', 'documents')} (${plural(st.excluded.washes.n, 'match', 'matches')}) ${st.excluded.washes.docs === 1 ? 'has a date' : 'have dates'} too coarse to fit slice ${S} and ${st.excluded.washes.docs === 1 ? 'is' : 'are'} left out.`);
    }
    if (st.excluded.translations.docs) {
      caveats.push('translations_excluded');
      notes.push(`${plural(st.excluded.translations.docs, 'translated document is', 'translated documents are')} excluded from slice ${S} (text-language chronology).`);
    }
    if (st.names) {
      caveats.push('names_excluded');
      notes.push(`${plural(st.names, 'match', 'matches')} in slice ${S} ${st.names === 1 ? 'is' : 'are'} excluded as names.`);
    }
    if ((st.basisMix.estimated ?? 0) >= 0.5) {
      caveats.push('estimated_dates');
      notes.push(`Most of slice ${S}'s documents are dated by estimate.`);
    }
    for (const s of st.selection) {
      caveats.push('selection');
      // "cipher-gutenberg in slice A: selected by prominence (…)" — the labels mix nouns and participles (fix pass)
      notes.push(`${s.collection} in slice ${S}: ${s.label}${s.note ? ` (${s.note})` : ''}.`);
    }
  }
  if (prominence.consistent === false) notes.push('The result depends on prominence stratum: rates move in different directions across prominence terciles.');
  if (sampled) notes.push(`${SAMPLING_DESIGN_NOTE} Within-cell presence shares are shown side by side, descriptively.`);
  if (overlaps(req.a.years, req.b.years)) {
    caveats.push('overlapping_slices');
    notes.push(`The slices overlap (${rangeLabel(req.a.years)} and ${rangeLabel(req.b.years)}): documents in both are counted twice and the interval of the ratio is too narrow.`);
  }
  if (exprs.length > 1) notes.push(`Counts pool ${exprs.length} expressions (${label}).`);
  if (req.toggles.bp) notes.push('Boilerplate passages are not counted even with the boilerplate toggle on: counts and denominators come from passages of ok quality only.');
  if (statsA.synthetic && statsB.synthetic) notes.push('Both slices are synthetic.');
  else if (statsA.synthetic || statsB.synthetic) notes.push(`Slice ${statsA.synthetic ? 'A' : 'B'} contains synthetic documents.`);

  return {
    version: COMPARE_VERSION,
    expressions, toggles: req.toggles,
    ...asSavedBlock(req),
    multiplicity,
    coverage: { a: coverageOf(statsA, evA, rateGateOf(statsA)), b: coverageOf(statsB, evB, rateGateOf(statsB)), composition_jsd: r4(jsd),
      caveats: [...new Set(caveats)], modality_gate: descriptive ? 'modality_mismatch' : 'ok', modality_compared: statsA.modality,
      descriptive_override: descriptive, prominence, spaces: spacesInfo(db, cx) },
    freq,
    ...(withinCell ? { within_cell: withinCell } : {}),
    baseline_rho: baselineRhoBlock(cx),
    passages,
    collocates: colloc,
    clusters,
    measures,
    tone: want.has('tone') ? toneBlock(db, cx) : { requested: false },
    human: humanCounts(db, scope, statsA, statsB, { revCutoff: req.cutoffs?.annotation_rev ?? null }),
    coverage_note: notes.length ? notes.join(' ') : 'No coverage caveat fired for these slices.',
    provenance,
  };
}

const overlaps = ([a0, a1], [b0, b1]) => a0 <= b1 && b0 <= a1;

/** The note of an as-saved comparison (RF-2). */
export const AS_SAVED_NOTE = 'As saved: the counting runs pinned at the save and only the imports it counted (documents of a later revert still count); reader annotations as they stood then.';

/** `as_saved` of a comparison opened from a saved view as saved (RF-2): the pins and cutoffs it was computed under. */
function asSavedBlock(req) {
  if (!req.runs && !req.cutoffs) return {};
  return { as_saved: { runs: req.runs ?? {}, cutoffs: req.cutoffs ?? {}, note: AS_SAVED_NOTE } };
}

/** §10.2 external-baseline correlation; a missing or unreadable Ngram store never breaks the comparison. */
function baselineRhoBlock(cx) {
  try {
    return baselineRho(cx);
  } catch (err) {
    const reason = `The external baseline could not be read (${err?.code ?? err?.message ?? 'error'}).`;
    return { available: false, reason, note: reason };
  }
}
const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;

function combineSuggestions(blocks, failing) {
  const parts = [];
  const out = { would_have: {} };
  for (const [i, which] of ['a', 'b'].entries()) {
    if (!failing[which]) continue;
    const s = blocks[i].suggestion;
    if (!s) return null;
    parts.push(s.label);
    out[which] = s[which];
    out.would_have[which] = s.would_have[which];
  }
  return { label: parts.join(' and '), ...out };
}

/**
 * Rate direction per prominence tercile (§2.E item 1): a tercile points 'up' or 'down' when its exact rate-ratio
 * interval (B over A) excludes 1, else 'flat'; terciles pointing both ways fire the "result depends on
 * prominence stratum" caveat. A tercile is compared only when both slices cover it.
 * @param {object} a slice stats
 * @param {object} b slice stats
 * @returns {{consistent: boolean|null, terciles: object[], note: string|null}}
 */
export function prominenceCheck(a, b) {
  const rows = [];
  for (const t of ['1', '2', '3']) {
    const ta = a.terciles[t], tb = b.terciles[t];
    if (!ta && !tb) continue;
    const na = a.unit === 'tokens' ? ta?.n ?? 0 : ta?.k ?? 0, nb = b.unit === 'tokens' ? tb?.n ?? 0 : tb?.k ?? 0;
    const ua = ta?.units ?? 0, ub = tb?.units ?? 0;
    let direction = null, ci = null;
    if (ua > 0 && ub > 0 && na + nb > 0) {
      const rr = poissonRateRatio(na, ua, nb, ub);
      ci = ci2(rr.ci);
      direction = rr.ci[0] > 1 ? 'up' : rr.ci[1] !== null && rr.ci[1] < 1 ? 'down' : 'flat';
    }
    rows.push({ tercile: Number(t), a: { n: na, units: ua }, b: { n: nb, units: ub }, direction, ratio_ci: ci });
  }
  const dirs = new Set(rows.map((r) => r.direction));
  const comparable = rows.filter((r) => r.direction !== null).length;
  if (comparable < 2) {
    return { consistent: null, terciles: rows, note: rows.length ? 'fewer than two prominence terciles are covered by both slices' : 'no prominence data in these slices' };
  }
  const split = dirs.has('up') && dirs.has('down');
  return { consistent: !split, terciles: rows, note: split ? 'result depends on prominence stratum' : null };
}

function neighbourTerms(db, scope, specA, specB, statsA, statsB, { suggest, readText }) {
  const need = THRESHOLDS.collocates.occurrences;
  const base = { label: CONTEXT_LABEL, window: `±${WINDOW} tokens`, measure: 'logDice', thresholds: thresholdsOut() };
  if (statsA.n < need || statsB.n < need) {
    const failing = { a: statsA.n < need, b: statsB.n < need };
    const suggestion = suggest(failing, { occurrences: need }, { text: (s) => `${formatCount(s.n)} occurrences`, data: (s) => ({ occurrences: s.n }) });
    return gated('insufficient_occurrences', { ...base, needed: { occurrences: need }, have: { a: statsA.n, b: statsB.n }, suggestion,
      note: collocatesNote({ a: statsA.n, b: statsB.n }, need) + (suggestion ? '' : ` No widening inside this corpus reaches the gate.`) });
  }
  const ca = sliceContexts(db, scope, specA, statsA, { readText });
  const cb = sliceContexts(db, scope, specB, statsB, { readText });
  for (const c of [ca, cb]) {
    if (!c.unavailable) continue;
    const langs = [...new Set([...(ca.unavailable?.langs ?? []), ...(cb.unavailable?.langs ?? [])])];
    return gated('not_run', { ...base, needed: { token_streams: langs },
      have: { a: ca.unavailable?.status ?? 'current', b: cb.unavailable?.status ?? 'current' },
      suggestion: { label: `Build token streams for ${langs.join(', ')}`, run: { stage: 'tokstream', params: { langs } } },
      note: `Collocates for slices this large (${formatTokens(ca.unavailable?.tokens ?? ca.N)} and ${formatTokens(cb.unavailable?.tokens ?? cb.N)} tokens) need current token streams.` });
  }
  const sa = collocates(ca, { limit: 1000 }), sb = collocates(cb, { limit: 1000 });
  const inA = new Map(sa.rows.map((r) => [r.term, r])), inB = new Map(sb.rows.map((r) => [r.term, r]));
  const brief = (r) => ({ term: r.term, f_xy: r.f_xy, logDice: r.logDice, g2: r.g2, q: r.q, ppmi: r.ppmi });
  const stop = new Set([...ca.stop, ...cb.stop]);
  const drop = (m) => new Map([...m].filter(([t]) => !stop.has(t)));
  const key = keyness(drop(ca.fxy), drop(cb.fxy), { totalA: ca.W, totalB: cb.W })
    .map((r) => ({ term: r.term, log_ratio: r2(r.log_ratio), q: Number(r.q.toPrecision(3)), side: r.side, f_a: r.f_a, f_b: r.f_b }));
  return {
    gate: 'ok', ...base,
    a: sa.rows.filter((r) => !inB.has(r.term)).slice(0, 50).map(brief),
    b: sb.rows.filter((r) => !inA.has(r.term)).slice(0, 50).map(brief),
    shared: sa.rows.filter((r) => inB.has(r.term)).slice(0, 50).map((r) => ({ term: r.term,
      a: { f_xy: r.f_xy, logDice: r.logDice }, b: { f_xy: inB.get(r.term).f_xy, logDice: inB.get(r.term).logDice } })),
    keyness: key,
    new_uses: sb.rows.filter((r) => (ca.fxy.get(r.term) ?? 0) < 3).map((r) => r.term),
    declining: sa.rows.filter((r) => (cb.fxy.get(r.term) ?? 0) < 3).map((r) => r.term),
    hidden_stopwords: { a: sa.hidden_stopwords, b: sb.hidden_stopwords },
    candidates: { a: sa.candidates, b: sb.candidates },
    f_x: { a: ca.fx, b: cb.fx }, window_positions: { a: ca.W, b: cb.W }, source: { a: ca.source, b: cb.source },
  };
}

/**
 * Context groups (§4.8, §4.11): the clustering gate over all of the expression's matches in the slices'
 * collections (≥ 60 occurrences in ≥ 5 documents); passing it gives `not_run` until a clustering run exists.
 * @param {{n: number, docs: number}} allTime
 * @param {string} label
 * @param {{run?: object|null}} [opts] run = {stage, params} offered as the suggestion when the gate passes
 * @returns {object} a gated object
 */
export function clusterGate(allTime, label, { run = null } = {}) {
  const t = THRESHOLDS.clustering;
  const have = { occurrences: allTime.n, documents: allTime.docs };
  const text = `Clustering unavailable: ${formatCount(allTime.n)} occurrences in ${formatCount(allTime.docs)} documents.`;
  if (allTime.n < t.occurrences) {
    return gated('insufficient_occurrences', { needed: { occurrences: t.occurrences, documents: t.documents }, have, note: `${text} '${label}' needs ≥ ${t.occurrences} in ≥ ${t.documents} documents.` });
  }
  if (allTime.docs < t.documents) {
    return gated('insufficient_documents', { needed: { occurrences: t.occurrences, documents: t.documents }, have, note: text });
  }
  return gated('not_run', { needed: { run: 'cluster' }, have: { run: null, ...have },
    suggestion: run ? { label: `Group the contexts of '${label}' (a clustering run)`, run } : null,
    note: 'No clustering run exists for this expression yet; context groups need one.' });
}

/**
 * The evidence gate of one drift measure (§4.9, §4.11), in the order the contract fixtures use: (a)
 * context-share shift — occurrences, documents, authors, top-document share, then the clustering run; (b)
 * neighbour overlap — occurrences, then slice size; (c) aligned displacement — slice size, occurrences,
 * documents, authors, composition (JSD > 0.4), then the slice spaces. When the evidence passes, the result
 * is `not_run`: Compare then computes (a) from a clustering run or reads (b) and (c) from a drift run, and the
 * drift job evaluates the gates that need the spaces (word frequency, anchors, alignment, controls).
 * driftGate itself never returns a value.
 * @param {'sense_share_jsd'|'neighbor_overlap'|'aligned_displacement'} metric
 * @param {object} ctx slice stats of A and B, composition JSD, flags, a suggest(failing, crit, describe) function and,
 *   optionally, `runs: {cluster, drift}` — the {stage, params} offered when the evidence passes
 * @returns {object} {metric, gate, value: null, ci: null, needed, have, suggestion, note, n, docs, authors}
 */
export function driftGate(metric, { statsA, statsB, jsd, descriptive, sampled, suggest, evidenceText, allTime, label, runs = {} }) {
  const counts = { n: [statsA.n, statsB.n], docs: [statsA.evidenceDocs, statsB.evidenceDocs],
    authors: [statsA.evidenceAuthors.size, statsB.evidenceAuthors.size] };
  const out = (gate) => ({ metric, ...gate, ...counts });
  if (descriptive) return out(gated('modality_mismatch', { needed: { modality: 'same' }, have: { a: statsA.modality, b: statsB.modality } }));
  if (sampled) return out(gated('sampling_design', { needed: { comparison: 'within one OpenAlex cell' }, have: { a: statsA.k, b: statsB.k }, note: SAMPLING_DESIGN_NOTE }));
  const sl = (st) => ({ occurrences: st.n, documents: st.evidenceDocs, authors: st.evidenceAuthors.size, top_document_share: r4(st.topDocShare) });
  const noWiden = ` No widening inside this corpus reaches the gate ('${label}' has ${formatCount(allTime.n)} matches in all).`;
  const driftRun = runs.drift ? { label: 'Estimate it: build the two slice spaces and their controls (a drift run, minutes)', run: runs.drift } : null;

  if (metric === 'sense_share_jsd') {
    const t = THRESHOLDS.sense_share_jsd;
    const checks = [['insufficient_occurrences', (st) => st.n >= t.occurrences], ['insufficient_documents', (st) => st.evidenceDocs >= t.documents],
      ['insufficient_authors', (st) => st.evidenceAuthors.size >= t.authors],
      ['single_source', (st) => st.topDocShare !== null && st.topDocShare <= t.top_doc_share]];
    for (const [code, ok] of checks) {
      const failing = { a: !ok(statsA), b: !ok(statsB) };
      if (!failing.a && !failing.b) continue;
      const crit = { occurrences: t.occurrences, documents: t.documents, authors: t.authors, max_top_doc_share: t.top_doc_share };
      const suggestion = suggest(failing, crit, evidenceText);
      const needs = `context-share shift needs ≥ ${t.occurrences} per slice in ≥ ${t.documents} documents by ≥ ${t.authors} authors, no document holding more than half`;
      return out(gated(code, { needed: { occurrences_per_slice: t.occurrences, documents_per_slice: t.documents, authors_per_slice: t.authors,
        max_top_document_share: t.top_doc_share }, have: { a: sl(statsA), b: sl(statsB) }, suggestion,
      note: `Not estimated. A has ${formatCount(statsA.n)} occurrences in ${formatCount(statsA.evidenceDocs)} documents, B ${formatCount(statsB.n)} in ${formatCount(statsB.evidenceDocs)}; ${needs}.` +
        (suggestion ? ` ${suggestion.label} would reach it.` : noWiden) }));
    }
    return out(gated('not_run', { needed: { run: 'cluster', clusters: 2 }, have: { run: null },
      suggestion: runs.cluster ? { label: `Group the contexts of '${label}' (a clustering run)`, run: runs.cluster } : null,
      note: 'Not estimated yet: the evidence gate passes; context-share shift needs a clustering run with at least two context groups.' }));
  }

  if (metric === 'neighbor_overlap') {
    const t = THRESHOLDS.neighbor_overlap;
    const failing = { a: statsA.n < t.occurrences, b: statsB.n < t.occurrences };
    if (failing.a || failing.b) {
      const suggestion = suggest(failing, { occurrences: t.occurrences }, { text: (s) => `${formatCount(s.n)} occurrences`, data: (s) => ({ occurrences: s.n }) });
      const rare = 'Word too rare ' + ['a', 'b'].filter((w) => failing[w]).map((w) => {
        const st = w === 'a' ? statsA : statsB;
        return `in ${rangeLabel(st.years)} (${formatCount(st.n)}; needs ${t.occurrences})`;
      }).join(' and ');
      return out(gated('insufficient_occurrences', { needed: { occurrences_per_slice: t.occurrences }, have: { a: statsA.n, b: statsB.n }, suggestion,
        note: rare + (suggestion ? `. ${suggestion.label} would reach it.` : `; ${NO_WIDENING_NOTE}`) }));
    }
    const spaceGate = spaceSizeGate(statsA, statsB, t, suggest);
    if (spaceGate) return out(spaceGate);
    return out(gated('not_run', { needed: { run: 'drift' }, have: { run: null }, suggestion: driftRun,
      note: 'Not estimated yet: the evidence gate passes; neighbour overlap needs the two slice spaces (a drift run).' }));
  }

  // aligned_displacement — order as the contract fixtures: slice size, evidence, composition, alignment
  const t = THRESHOLDS.aligned_displacement;
  const spaceGate = spaceSizeGate(statsA, statsB, t, suggest);
  if (spaceGate) return out(spaceGate);
  for (const [code, key, ok] of [['insufficient_occurrences', 'occurrences', (st) => st.n >= t.occurrences],
    ['insufficient_documents', 'documents', (st) => st.evidenceDocs >= t.documents],
    ['insufficient_authors', 'authors', (st) => st.evidenceAuthors.size >= t.authors]]) {
    const failing = { a: !ok(statsA), b: !ok(statsB) };
    if (!failing.a && !failing.b) continue;
    const suggestion = suggest(failing, { occurrences: t.occurrences, documents: t.documents, authors: t.authors, tokensNoTr: t.tokens }, evidenceText);
    return out(gated(code, { needed: { [`${key}_per_slice`]: t[key] }, have: { a: sl(statsA)[key], b: sl(statsB)[key] }, suggestion,
      note: suggestion ? null : NO_WIDENING_NOTE }));
  }
  if (jsd !== null && jsd > COMPOSITION_MISMATCH_JSD) {
    return out(gated('composition_mismatch', { needed: { max_composition_jsd: COMPOSITION_MISMATCH_JSD }, have: { composition_jsd: r4(jsd) },
      note: `Not estimated: the slices differ too much in composition (JSD ${jsd.toFixed(2)} > ${COMPOSITION_MISMATCH_JSD}).` }));
  }
  return out(gated('not_run', { needed: { run: 'drift', anchors: t.anchors }, have: { run: null }, suggestion: driftRun,
    note: 'Not estimated yet: the evidence gate passes; aligned displacement needs the two slice spaces aligned on ≥ 3,000 anchor words (a drift run).' }));
}

/** §4.9 (b)/(c): each slice must hold enough running text for its own space; translations never count. */
export function spaceSizeGate(statsA, statsB, t, suggest) {
  if (statsA.unit !== 'tokens' || statsB.unit !== 'tokens') {
    return gated('slice_too_small', { needed: { tokens_per_slice: t.tokens }, have: { a: null, b: null },
      note: 'Slice spaces need running text; these slices are counted in works (titles), so no space can be built.' });
  }
  const have = { a: statsA.unitsNoTr, b: statsB.unitsNoTr };
  const failing = { a: have.a < t.tokens, b: have.b < t.tokens };
  if (!failing.a && !failing.b) return null;
  const suggestion = suggest(failing, { tokensNoTr: t.tokens }, { text: (s) => `${formatTokens(s.unitsNoTr)} tokens`, data: (s) => ({ tokens: s.unitsNoTr }) });
  const which = ['a', 'b'].filter((w) => failing[w]).map((w) => `slice ${w.toUpperCase()} has ${tokensHave(have[w])} tokens`).join(' and ');
  return gated('slice_too_small', { needed: { tokens_per_slice: t.tokens }, have, suggestion,
    note: `Not estimated: ${which} (needs ${formatTokens(t.tokens)})` + (suggestion ? `. ${suggestion.label} would reach it.` : `; ${NO_WIDENING_NOTE}`) });
}

// ── Context groups and context-share shift (from a clustering run) ───────────────────────────────────

const NEW_USE = { before: 0.02, after: 0.10 };

/** The clustering run a comparison suggests: this expression, in the compared medium's collections (cluster@1.1.0 scope). */
function clusterRunSuggestion(cx) {
  const params = { expr: cx.exprs[0].id };
  if (cx.collectionsUsed.length) params.collections = [...cx.collectionsUsed];
  return { stage: 'cluster', params };
}

/**
 * Context groups of the comparison: the clustering gate, then the newest clustering run of the expression —
 * shares per slice with document-block bootstrap 95% CIs (§2.E item 5) and the per-document counts measure
 * (a) is computed from.
 * @returns {{block: object, run: object|null, blocksA: Float64Array[], blocksB: Float64Array[], gate: object|null}}
 */
function contextGroups(db, cx, allTime) {
  const { exprs, label, statsA, statsB } = cx;
  const single = exprs.length === 1;
  const runSuggestion = single ? clusterRunSuggestion(cx) : null;
  const g = clusterGate(allTime, label, { run: runSuggestion });
  if (g.gate !== 'not_run') return { block: g, run: null, gate: g };
  if (!single) {
    const ng = gated('not_run', { needed: { expressions: 1 }, have: { expressions: exprs.length },
      note: 'Context groups are found per expression; compare one expression to see them.' });
    return { block: ng, run: null, gate: ng };
  }
  if (cx.sampled && !cx.descriptive) {
    const sg = gated('sampling_design', { needed: { comparison: 'within one OpenAlex cell' }, have: { a: statsA.k, b: statsB.k },
      note: `${SAMPLING_DESIGN_NOTE} Context-group shares are not compared across its cells.` });
    return { block: sg, run: null, gate: sg };
  }
  // as saved (RF-2): the clustering run the view pinned, else the newest one that had finished at its save; labels as then
  const cr = clusterRunFor(db, exprs[0].id, { modality: statsA.modality, run: cx.req.runs?.cluster ?? null, before: cx.req.cutoffs?.at ?? null,
    revCutoff: cx.req.cutoffs?.annotation_rev ?? null });
  if (!cr) return { block: g, run: null, gate: g };
  const k = cr.clusters.length;
  const counts = clusterDocCounts(db, cr, exprs[0].id);
  const zero = new Float64Array(k);
  const blocksOf = (st) => evidenceDocIds(st).map((id) => counts.get(id) ?? zero).filter((b) => b.some((x) => x > 0));
  const blocksA = blocksOf(statsA), blocksB = blocksOf(statsB);
  const total = (blocks) => {
    const t = new Float64Array(k);
    for (const b of blocks) for (let j = 0; j < k; j++) t[j] += b[j];
    return t;
  };
  const ta = total(blocksA), tb = total(blocksB);
  const nA = ta.reduce((s, x) => s + x, 0), nB = tb.reduce((s, x) => s + x, 0);
  const ciA = shareIntervals(blocksA, k), ciB = shareIntervals(blocksB, k);
  const share = (t, n, j, ci) => ({ share: n ? r4(t[j] / n) : null, ci: ci[j] ? ci[j].map(r4) : null, n: t[j] });
  const rows = cr.clusters.map((c, j) => ({ cluster: c.id, ord: c.ord, label: c.label, human_label: c.human_label ?? undefined, status: c.status,
    a: share(ta, nA, j, ciA), b: share(tb, nB, j, ciB) }));
  const isNew = (r) => r.a.share !== null && r.b.share !== null && r.a.share < NEW_USE.before && r.b.share >= NEW_USE.after;
  const isGone = (r) => r.a.share !== null && r.b.share !== null && r.b.share < NEW_USE.before && r.a.share >= NEW_USE.after;
  const block = { gate: 'ok', run: cr.run, representation: cr.representation, modality: cr.modality, k, shares: rows,
    n: { a: nA, b: nB }, docs: { a: blocksA.length, b: blocksB.length },
    new_uses: rows.filter(isNew).map((r) => r.human_label ?? r.label), declining: rows.filter(isGone).map((r) => r.human_label ?? r.label),
    note: 'Context groups are machine hypotheses about usage contexts (context words, not meanings); shares count occurrences with a group, with document-block bootstrap 95% CIs.' };
  return { block, run: cr, blocksA, blocksB, gate: null };
}

/** Measure (a) from a clustering run (§4.9): gates on groups and assigned occurrences, then JSD with a bootstrap CI. */
function senseShareMeasure(cx, groups, live) {
  if (!groups.run) return live;
  const cr = groups.run;
  const groupsFound = cr.clusters.filter((c) => c.status !== 'residual').length;
  const counts = { n: live.n, docs: live.docs, authors: live.authors };
  const base = { metric: 'sense_share_jsd', run: cr.run, representation: cr.representation };
  if (groupsFound < 2) {
    return { ...base, ...gated('no_cluster_structure', { needed: { context_groups: 2 }, have: { context_groups: groupsFound },
      note: 'Not estimated: the clustering run found no separable context groups.' }), ...counts };
  }
  const nA = groups.blocksA.reduce((s, b) => s + b.reduce((x, y) => x + y, 0), 0);
  const nB = groups.blocksB.reduce((s, b) => s + b.reduce((x, y) => x + y, 0), 0);
  const need = THRESHOLDS.sense_share_jsd.occurrences;
  if (nA < need || nB < need) {
    return { ...base, ...gated('insufficient_occurrences', { needed: { grouped_occurrences_per_slice: need }, have: { a: nA, b: nB },
      note: `Not estimated: ${formatCount(nA)} and ${formatCount(nB)} occurrences have a context group (needs ${need} per slice; occurrences with fewer than 3 usable context words are not grouped).` }), ...counts };
  }
  const r = contextShareShift(groups.blocksA, groups.blocksB, cr.clusters.length);
  if (r.value === null) return live;
  const m = { ...base, gate: 'ok', value: r4(r.value), ci: r.ci ? r.ci.map(r4) : null, n: [nA, nB], docs: [groups.blocksA.length, groups.blocksB.length],
    authors: live.authors, k: cr.clusters.length, method: 'JSD (base 2) of context-group shares; document-block bootstrap, 1,000 resamples' };
  return { ...m, text: measureSentence('sense_share_jsd', m, { n: m.n, docs: m.docs }) };
}

/**
 * The three drift measures of a comparison: live evidence gates, (a) from a clustering run, (b) and (c) from a
 * stored drift run of exactly this comparison, and the verdict (§4.9) — with the session's adjusted threshold.
 */
function driftBlock(db, cx, { want, allTime, groups, k }) {
  const { statsA, statsB, jsd, descriptive, sampled, suggest, evidenceText, label, exprs, runParams } = cx;
  const runs = { cluster: exprs.length === 1 ? clusterRunSuggestion(cx) : null, drift: { stage: 'drift', params: runParams } };
  const live = Object.fromEntries(DRIFT.filter((m) => want.has(m)).map((metric) => [metric,
    driftGate(metric, { statsA, statsB, jsd, descriptive, sampled, suggest, evidenceText, allTime, label, runs })]));
  let stored;
  const storedOf = () => (stored ??= storedDriftResults(db, driftRunParams(runParams), cx.fp));
  const out = {};
  for (const [metric, g] of Object.entries(live)) {
    if (g.gate !== 'not_run') { out[metric] = g; continue; }
    if (metric === 'sense_share_jsd') { out[metric] = senseShareMeasure(cx, groups, g); continue; }
    const s = storedOf()?.measures?.[metric];
    if (!s) { out[metric] = g; continue; }
    out[metric] = { metric, ...s, n: g.n, docs: g.docs, authors: g.authors, run: storedOf().run };
  }
  const nb = out.neighbor_overlap, ad = out.aligned_displacement;
  if (nb?.gate === 'ok') nb.text = measureSentence('neighbor_overlap', nb, { n: nb.n, docs: nb.docs });
  if (ad?.gate === 'ok') {
    const v = verdict(ad, nb ?? null, k);
    ad.threshold_percentile = Number(notableThreshold(k).toFixed(4));
    ad.verdict = v ?? (nb?.gate === 'ok' ? 'within typical variation' : null);
    ad.verdict_note = v ? null : 'No verdict: neighbour overlap is not estimated for these slices.';
    ad.text = measureSentence('aligned_displacement', ad, { n: ad.n, docs: ad.docs, overlap: nb ?? null, verdict: ad.verdict });
  }
  return DRIFT.filter((m) => out[m]).map((m) => out[m]);
}

// ── Spaces, era slices, tone, OpenAlex cells ─────────────────────────────────────────────────────────

/**
 * What vector spaces exist or could exist for the strand's language (§4.8): the pooled space if built and
 * the era slices computed now from the corpus scope ("no slice count is promised in advance").
 */
function spacesInfo(db, cx) {
  const lang = cx.lang;
  if (!lang) return null;
  const docs = [];
  const all = { tokens: 0, docs: 0, authors: new Set() };
  for (const d of cx.scope.docs.values()) {
    if (d.tr || d.dup) continue;
    const coll = cx.scope.collections.get(d.coll);
    if (!coll || !['text', 'abstracts'].includes(coll.modality)) continue;
    let tokens = 0;
    for (const t of d.tok) if (t.plang === lang && (t.fc === 'text' || t.fc === 'abstract')) tokens += t.tokens;
    if (!(tokens > 0)) continue;
    all.tokens += tokens;
    all.docs++;
    if (d.author) all.authors.add(d.author);
    if (d.chrono === 'dated') docs.push({ y_lo: d.y_lo, y_hi: d.y_hi, tokens, author: d.author });
  }
  const era = eraSlices(docs);
  const pooled = pooledSpaceFor(db, lang, { collections: cx.collectionsUsed });
  const could = all.tokens >= SLICE_GATE.tokens && all.docs >= SLICE_GATE.docs && all.authors.size >= SLICE_GATE.authors;
  const corpora = [...new Set(cx.collectionsUsed.map((s) => cx.collBySlug.get(s)?.corpus_slug).filter(Boolean))].sort();
  return {
    lang, language: languageName(lang),
    pooled: pooled ? { space: pooled.id, run: pooled.run_id, tokens: pooled.tokens, vocab: pooled.vocab_size, dim: pooled.dim } : null,
    pooled_gate: { tokens: all.tokens, docs: all.docs, authors: all.authors.size, eligible: could, needs: SLICE_GATE },
    suggestion: !pooled && could && corpora.length
      ? { label: `Build the ${languageName(lang)} vector spaces: pooled and era slices (a vectors run, minutes)`, run: { stage: 'vectors', params: { lang, corpora } } }
      : null,
    era: { slices: era.slices.map((s) => ({ years: s.years, tokens: s.tokens, docs: s.docs, authors: s.authors, eligible: s.eligible })),
      eligible: era.eligible, needs: SLICE_GATE, note: eraNote(lang, era) },
  };
}

/**
 * Machine tone (§4.10, §2.E item 7): a stored tone run of this comparison → per-slice distribution with a
 * document-block bootstrap CI of the mean (≥ 30 paragraphs per slice); otherwise why it is not estimated.
 */
function toneBlock(db, cx) {
  const status = adapterStatus();
  const lang = cx.lang;
  const t = THRESHOLDS.tone.paragraphs;
  const stored = storedTone(db, toneRunParams(cx.runParams), cx.fp);
  if (stored) {
    const inA = new Set(evidenceDocIds(cx.statsA)), inB = new Set(evidenceDocIds(cx.statsB));
    const pick = (set) => stored.rows.filter((r) => set.has(r.doc));
    const ra = pick(inA), rb = pick(inB);
    if (ra.length < t || rb.length < t) {
      return gated('insufficient_occurrences', { needed: { paragraphs_per_slice: t }, have: { a: ra.length, b: rb.length },
        reason: `Machine tone needs ≥ ${t} scored paragraphs per slice (A ${formatCount(ra.length)}, B ${formatCount(rb.length)}).`, run: stored.run });
    }
    const dist = (rows) => {
      const d = toneDistribution(rows.map((r) => r.score), { docs: rows.map((r) => r.doc) });
      return { n: d.n, docs: d.docs, mean: r4(d.mean), ci: d.ci ? d.ci.map(r4) : null, sd: r4(d.sd), median: r4(d.median), histogram: d.histogram };
    };
    return { gate: 'ok', label: TONE_LABEL, method: TONE_METHOD, model_version: stored.model_version, run: stored.run, a: dist(ra), b: dist(rb),
      note: 'Distribution of machine scores over paragraphs holding the expression (−1 negative … 1 positive); never a label on one passage.' };
  }
  const needed = { adapter: 'scrolls-nl', paragraphs_per_slice: t };
  if (!status.installed) return gated('not_run', { needed, have: { adapter: null }, reason: TONE_ADAPTER_MISSING });
  if (status.sentimentLanguages && lang && !status.sentimentLanguages.includes(lang)) {
    return gated('not_run', { needed: { ...needed, language: status.sentimentLanguages }, have: { adapter: 'scrolls-nl', language: lang },
      reason: `Tone is not available for ${languageName(lang)}` });
  }
  return gated('not_run', { needed, have: { adapter: 'scrolls-nl', run: null },
    suggestion: { label: 'Score the paragraphs of both slices with the on-device adapter (a tone run)', run: { stage: 'tone', params: cx.runParams } },
    reason: 'Machine tone has not been estimated for these slices.' });
}

/** OpenAlex's 30 sampling bins (§10.4). */
export const OPENALEX_BINS = Object.freeze([[1665, 1799], [1800, 1849], [1850, 1874], [1875, 1899],
  ...Array.from({ length: 25 }, (_, i) => [1900 + 5 * i, 1904 + 5 * i]), [2025, 2026]]);
const binOfYear = (y) => OPENALEX_BINS.find(([lo, hi]) => y >= lo && y <= hi) ?? null;

/**
 * Within-cell presence shares (§10.4): for each OpenAlex cell (field × period) that fits a slice, k of n
 * sampled works whose title or abstract mention the expression, with a Wilson 95% CI and how many have an
 * abstract. Cells are separate top-cited samples, so shares are shown side by side — never as a rate,
 * ratio or trend across cells.
 * @returns {{a: object[], b: object[], method: string, note: string}}
 */
function withinCellShares(db, scope, specs, toggles) {
  const sampledColls = [...scope.collections.values()].filter((c) => c.sampling === 'top_cited_per_cell').map((c) => c.id);
  const cellOf = new Map();
  if (sampledColls.length) {
    const live = scopeDocFilter(scope.cutoffs);
    for (const r of db.prepare(`SELECT d.id, json_extract(d.original_meta_json, '$.sample_cell') AS cell FROM document d
      WHERE d.collection_id IN (SELECT value FROM json_each(?)) AND ${live.sql}`).iterate(JSON.stringify(sampledColls), ...live.args)) {
      if (typeof r.cell === 'string') cellOf.set(r.id, r.cell);
    }
  }
  const one = (spec) => {
    const cells = new Map();
    for (const d of scope.docs.values()) {
      if (!spec.collIds.has(d.coll) || !sampledColls.includes(d.coll) || !facetsMatch(d, spec)) continue;
      if (!toggles.dup && d.dup) continue;
      // n is what the Scroll's share cell counts (C3, fix pass): sampled works of the slice with a title or abstract in
      // the strand's languages, under the same toggles — so Compare and the Scroll give one n for one cell
      if (!toggles.tr && d.tr) continue;
      if (!toggles.est && d.basis === 'estimated') continue;
      if (!d.tok.some((t) => (t.fc === 'title' || t.fc === 'abstract') && spec.langOk(t.plang, t.fc, d.lang_text))) continue;
      let key = cellOf.get(d.id) ?? null;
      let years;
      if (key && /\|\d{4}-\d{4}$/.test(key)) {
        const [lo, hi] = key.slice(key.lastIndexOf('|') + 1).split('-').map(Number);
        years = [lo, hi];
      } else {
        const bin = d.chrono === 'dated' ? binOfYear(d.y_lo) : null;
        if (!bin || d.y_hi > bin[1]) continue;
        years = bin;
        key = `${d.field ?? 'unknown field'}|${bin[0]}-${bin[1]}`;
      }
      if (years[0] < spec.years[0] || years[1] > spec.years[1]) continue;
      const c = cells.get(key) ?? { cell: key, field: key.slice(0, key.lastIndexOf('|')), years, n: 0, k: 0, abstracts: 0 };
      c.n++;
      if (d.tok.some((t) => t.fc === 'abstract' && t.tokens > 0)) c.abstracts++;
      const hit = d.hits.some((h) => (h.fc === 'title' || h.fc === 'abstract') && spec.langOk(h.plang, h.fc, d.lang_text) && (h.n + (toggles.nm ? h.names : 0)) > 0);
      if (hit) c.k++;
      cells.set(key, c);
    }
    return [...cells.values()].sort((x, y) => x.field.localeCompare(y.field) || x.years[0] - y.years[0])
      .map((c) => ({ ...c, share: r4(c.k / c.n), ci: wilsonCI(c.k, c.n).map(r4), text: `${formatCount(c.k)} of ${formatCount(c.n)} · abstracts for ${formatCount(c.abstracts)}` }));
  };
  return { a: one(specs[0]), b: one(specs[1]), method: 'k of n sampled works (title or abstract) mention the expression; Wilson 95% CI',
    note: 'Each cell is OpenAlex\'s own sample of the 200 most-cited works for one field and period; shares are shown side by side, never as a rate, ratio or trend across cells.' };
}

/** The slice's facet filters (kind, culture, field, community, basis, syn) on one document. */
function facetsMatch(doc, spec) {
  if (spec.f?.syn === 0 && doc.syn) return false;
  for (const [k, { inc, exc }] of Object.entries(spec.facets ?? {})) {
    const v = doc[k] ?? '';
    if (inc && !inc.has(v)) return false;
    if (exc.has(v)) return false;
  }
  return true;
}

/**
 * Human annotation counts per slice (§2.E item 7): pragmatic_function and stance dimensions of active
 * human annotations whose target lies in a slice document. Never inferred by a machine. As saved (`revCutoff`, RF-2): the
 * annotations active at the view's annotation revision cutoff, with the revision then shown.
 */
function humanCounts(db, scope, statsA, statsB, { revCutoff = null } = {}) {
  if (revCutoff !== null) return humanCountsAt(db, statsA, statsB, revCutoff);
  const inA = new Set(statsA.perDoc.map((d) => d.id)), inB = new Set(statsB.perDoc.map((d) => d.id));
  const out = { pragmatic_function: { a: {}, b: {} }, stance: { a: {}, b: {} } };
  let rows = [];
  try {
    rows = db.prepare(`SELECT a.target_type, a.target_ref, r.dimensions_json,
        CASE a.target_type WHEN 'document' THEN CAST(a.target_ref AS INTEGER)
          WHEN 'passage' THEN (SELECT p.document_id FROM passage p WHERE p.id = CAST(a.target_ref AS INTEGER))
          WHEN 'occurrence' THEN (SELECT o.document_id FROM occurrence o WHERE o.id = CAST(a.target_ref AS INTEGER)) END AS doc
      FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id AND r.rev = a.current_rev
      WHERE a.status = 'active' AND a.is_machine = 0 AND a.target_type IN ('document', 'passage', 'occurrence')
        AND (json_extract(r.dimensions_json, '$.pragmatic_function') IS NOT NULL OR json_extract(r.dimensions_json, '$.stance') IS NOT NULL)`).all();
  } catch { rows = []; }
  for (const r of rows) {
    let dims;
    try { dims = JSON.parse(r.dimensions_json); } catch { continue; }
    for (const [side, set] of [['a', inA], ['b', inB]]) {
      if (!set.has(r.doc)) continue;
      for (const dim of ['pragmatic_function', 'stance']) {
        const v = dims[dim];
        if (typeof v === 'string' && v) out[dim][side][v] = (out[dim][side][v] ?? 0) + 1;
      }
    }
  }
  return { ...out, note: HUMAN_NOTE };
}

const HUMAN_NOTE = 'Counts of human annotations in each slice; no automatic irony or stance detection.';

/** humanCounts at an annotation revision cutoff (a saved view opened as saved). */
function humanCountsAt(db, statsA, statsB, revCutoff) {
  const inA = new Set(statsA.perDoc.map((d) => d.id)), inB = new Set(statsB.perDoc.map((d) => d.id));
  const out = { pragmatic_function: { a: {}, b: {} }, stance: { a: {}, b: {} } };
  const rows = db.prepare(`SELECT a.*, CASE a.target_type WHEN 'document' THEN CAST(a.target_ref AS INTEGER)
      WHEN 'passage' THEN (SELECT p.document_id FROM passage p WHERE p.id = CAST(a.target_ref AS INTEGER))
      WHEN 'occurrence' THEN (SELECT o.document_id FROM occurrence o WHERE o.id = CAST(a.target_ref AS INTEGER)) END AS doc
    FROM annotation a WHERE a.is_machine = 0 AND a.target_type IN ('document', 'passage', 'occurrence')
      AND EXISTS (SELECT 1 FROM annotation_revision r WHERE r.annotation_id = a.id AND r.id <= ?)`).all(revCutoff);
  for (const a of rows) {
    const shown = annotationShownAt(db, a, revCutoff);
    if (!shown || shown.status !== 'active') continue;
    let dims;
    try { dims = JSON.parse(shown.revision.dimensions_json); } catch { continue; }
    for (const [side, set] of [['a', inA], ['b', inB]]) {
      if (!set.has(a.doc)) continue;
      for (const dim of ['pragmatic_function', 'stance']) {
        const v = dims[dim];
        if (typeof v === 'string' && v) out[dim][side][v] = (out[dim][side][v] ?? 0) + 1;
      }
    }
  }
  return { ...out, note: HUMAN_NOTE };
}
