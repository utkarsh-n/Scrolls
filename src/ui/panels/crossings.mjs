// OWNER: WP7
// panels/crossings.mjs — the Crossings card (SPEC §2.D header, §10.5 Term trail): where the selected expression is
// found across the record, one row per lane of the Term trail — etymology (periods, not dates), literature text,
// STEMM text and abstracts per field, culture titles, music relations — plus the Wiktionary claim (an external
// claim, dimmed when the display rule says so) and the Ngram baseline (a different corpus).
//
// Each lane row says when the expression was first and last observed in this corpus, with the basis of the
// first date, in the lane's own unit (never pooled across units or media; OpenAlex lanes print no rate at all:
// a share exists only inside one of OpenAlex's cells). The first-observed date is a button that opens the first
// passage; a row without a passage says why. The fixed line: first observation in this corpus is not coinage or
// borrowing.
//
// Data: POST /api/timeline/query with corpus 'real' (every non-synthetic corpus; the demo never) and lanes
// {facet: 'trail'} (contract 1.3.0). A synthetic expression, or a server without the trail, gets the per-domain
// lanes of its own corpus instead, and the card says which it shows. Etymology comes from GET /api/etymology
// (each listed root once, with the etyma that list it); the first passage of a lane from the lane's `first`
// when the server names it, else from GET /api/kwic (sorted by date, one row) and its basis from the passage.

import { h, clear } from '../core/dom.mjs';
import { yearLabel } from '../../shared/dates.mjs';
import { formatCount, formatNumber, formatTokens } from '../../shared/format.mjs';
import { LANGUAGE_PERIODS } from '../../shared/vocab.mjs';
import { renderErrorCard, renderLoadingLine } from './gate-card.mjs';
import { followJob } from './runs.mjs';

/** The fixed line of the card (§2.D, §10.5, §13 rule 11). */
export const CROSSINGS_CAPTION = 'First observation in this corpus is not coinage or borrowing.';
/** §10.5 guardrail 1: lanes that share a word are not linked by it. */
export const COPRESENCE_NOTE = 'Rows that share a word are not linked by it: co-presence is not transmission.';
/** The header of every OpenAlex lane (contract 1.3.0, C3). */
export const SHARE_LANE_NOTE = 'share of the top-cited sample in each cell — not a trend';
export const ETYMOLOGY_NOTE = 'periods, not dates';
export const CLAIM_NOTE = 'external claim — never an occurrence';
export const BASELINE_NOTE = 'Google Books Ngram is a different corpus';
/** The virtual corpus of the Term trail (contract 1.3.0, C2). */
export const TRAIL_CORPUS = 'real';
/** First passages are looked up one lane at a time, so the Scroll's own tile requests keep the read pool. */
export const LOOKUP_CONCURRENCY = 1;

const DEFAULT_TOGGLES = Object.freeze({ tr: 0, ds: 0, ap: 0, dup: 0, nm: 0, est: 1, bp: 0 });
const PERIOD = new Map(LANGUAGE_PERIODS.map((p) => [p.lang, p]));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** 'Latin (Old → Medieval; …) — period of the language, not a date' → 'Latin'; PIE for ine-pro. */
export function languageName(lang) {
  if (lang === 'ine-pro') return 'PIE';
  return (PERIOD.get(lang)?.label ?? lang ?? '').split(/ \(| —/)[0];
}

/** '700 BCE–1500' for a language with a seeded period, else null. */
export function periodText(lang) {
  const p = PERIOD.get(lang);
  return p ? `${yearLabel(p.lo_year)}–${yearLabel(p.hi_year)}` : null;
}

// ── Lanes ────────────────────────────────────────────────────────────────────────────────────────────

/** The unit class of a lane: 'share' (OpenAlex cells), 'count' (works counted, never a rate), 'periods', 'titles', 'text' or 'other'. */
export function laneClass(lane) {
  if (lane?.unit === 'share_of_sampled_works') return 'share';
  if (lane?.unit === 'count_of_works') return 'count';
  if (lane?.unit === 'period_bands') return 'periods';
  if (lane?.rate_note && lane?.modality === 'abstracts') return 'share'; // an OpenAlex lane of a per-domain query (counts only, 1.2.0)
  if (lane?.unit === 'per_thousand_works' || lane?.modality === 'titles') return 'titles';
  if (lane?.unit === 'per_million_tokens' || lane?.modality === 'text') return 'text';
  return 'other';
}

/**
 * "first observed in this corpus 1906 (stated)" — the basis comes from the lane's `first`, else from the first
 * passage once it is known (`resolved.basis`).
 * @param {object} lane
 * @param {{basis?: string|null, label?: string|null}|null} [resolved]
 * @returns {string|null}
 */
export function firstText(lane, resolved = null) {
  const label = lane?.first?.label ?? resolved?.label ?? null;
  if (!label) return null;
  const basis = lane?.first?.basis ?? resolved?.basis ?? null;
  return `first observed in this corpus ${label}${basis ? ` (${basis})` : ''}`;
}

/**
 * One lane as a Crossings row, in the lane's own unit. A text lane's rate is matches over the lane's dated text
 * and is printed only when its coverage passes the lane's gate; an OpenAlex lane prints no rate (cells are
 * separate samples); a titles lane counts works.
 * @param {object} lane a TimelineQuery lane
 * @param {{basis?: string|null, label?: string|null, passage?: number|null, state?: string}|null} [resolved]
 * @returns {{key: string, kind: 'lane', laneKey: string, label: string, text: string, first: string|null, last: string|null,
 *   note: string|null, openable: boolean, passage: number|null, empty: boolean, pending: boolean}}
 */
export function laneRow(lane, resolved = null) {
  const cls = laneClass(lane);
  const cov = lane.coverage ?? {};
  const n = Number.isInteger(lane.n) ? lane.n : 0;
  const dated = Math.max(0, n - (lane.undated ?? 0) - (lane.scheduled ?? 0));
  const works = cov.works ?? cov.docs ?? 0;
  const pending = lane.state === 'pending';
  let text;
  if (pending) text = lane.note ?? 'indexing — not yet looked';
  else if (cls === 'periods') text = 'periods of languages, not dates';
  else if (!n) {
    const where = cls === 'text' ? `${formatTokens(cov.tokens ?? 0)} tokens` : `${formatCount(works)} ${cls === 'share' ? 'sampled works' : 'works'}`;
    text = `no matches in ${where} — 0 is an observation about this index`;
  } else if (cls === 'titles') {
    text = `titles: ${formatCount(n)} of ${formatCount(works)} works`;
  } else if (cls === 'count') {
    text = `${formatCount(n)} ${n === 1 ? 'work' : 'works'} in documented links (counted, never a rate)`;
  } else if (cls === 'share') {
    text = `${formatCount(n)} sampled ${n === 1 ? 'work mentions' : 'works mention'} it (title or abstract) · the lane's cells hold ${formatCount(works)} sampled works · no share across cells`;
  } else if (cls === 'text') {
    const gated = isNum(lane.gate) && (cov.tokens ?? 0) < lane.gate;
    const rate = !gated && cov.tokens > 0 && dated > 0 ? `${formatNumber((dated / cov.tokens) * 1e6)}/M tokens over the lane's dated text` : null;
    text = [`n = ${formatCount(n)} in ${formatCount(lane.docs ?? 0)} docs`, `${formatTokens(cov.tokens ?? 0)} tokens`,
      rate ?? (gated ? `rate not shown: coverage below the gate (${formatTokens(lane.gate)} tokens)` : null)].filter(Boolean).join(' · ');
  } else {
    text = `n = ${formatCount(n)} in ${formatCount(lane.docs ?? 0)} ${lane.modality === 'titles' ? 'works' : 'documents'}`;
  }
  const notes = [
    cls === 'share' ? SHARE_LANE_NOTE : null,
    lane.rate_note && cls !== 'share' ? lane.rate_note : null,
    lane.selection ?? null,
    lane.undated ? `${formatCount(lane.undated)} undated` : null,
    lane.undated_warning ?? null,
    lane.names_excluded ? `${formatCount(lane.names_excluded)} excluded as names` : null,
    lane.synthetic ? 'synthetic' : null,
  ].filter(Boolean);
  const passage = Number.isInteger(lane.first?.passage) ? lane.first.passage : Number.isInteger(resolved?.passage) ? resolved.passage : null;
  return {
    key: `lane:${lane.key}`, kind: 'lane', laneKey: lane.key, label: lane.label ?? lane.key, text,
    first: n && !pending ? firstText(lane, resolved) : null,
    last: n && !pending && lane.last?.label ? `last observed ${lane.last.label}` : null,
    note: notes.length ? [...new Set(notes)].join(' · ') : null,
    openable: n > 0 && !pending, passage, empty: !n, pending,
  };
}

// ── Etymology (contract 1.3.0, C5: each root once) ──────────────────────────────────────────────────────

/**
 * Etyma and their listed roots, each root once with the etyma that list it (the server's `roots` when it sends
 * them, else deduplicated here by key), so the same PIE root is never shown twice.
 * @param {object|null} etym GET /api/etymology
 * @returns {{available: boolean, reason: string|null, etyma: object[], roots: Array<object & {families: string[]}>, source: string|null}}
 */
export function etymologyModel(etym) {
  if (!isObj(etym)) return { available: false, reason: null, etyma: [], roots: [], source: null };
  if (etym.available === false) return { available: false, reason: etym.reason ?? null, etyma: [], roots: [], source: etym.source ?? null };
  const etyma = Array.isArray(etym.families) ? etym.families : [];
  const roots = new Map();
  const add = (r, family) => {
    if (!isObj(r) || !r.key) return;
    const cur = roots.get(r.key) ?? { ...r, families: [] };
    for (const f of Array.isArray(r.families) ? r.families : []) if (!cur.families.includes(f)) cur.families.push(f);
    if (family && !cur.families.includes(family)) cur.families.push(family);
    roots.set(r.key, cur);
  };
  for (const r of Array.isArray(etym.roots) ? etym.roots : []) add(r, null);
  for (const e of etyma) for (const p of Array.isArray(e.parents) ? e.parents : []) add(p, e.key);
  // a listed root that is itself one of the etyma (is_family) already has its own row: never shown twice
  const etymaKeys = new Set(etyma.map((e) => e.key));
  const once = [...roots.values()].filter((r) => r.is_family !== true && !etymaKeys.has(r.key));
  return { available: true, reason: etym.note ?? null, etyma, roots: once, source: etym.source ?? null };
}

/** "Latin virus 'venom'" (romanization when there is one). */
function formName(e) {
  const roman = e.roman && e.roman !== e.form && !/ablaut/i.test(e.roman) ? ` (${e.roman})` : '';
  return `${languageName(e.lang)} ${e.form}${roman}${e.gloss ? ` '${e.gloss}'` : ''}`;
}

/** Words of a multi-parent list (§1.7): never competing hypotheses, never one parent. */
export function listedRootsWords(semantics, n) {
  if (n < 2) return null;
  if (semantics === 'listed_chain') return 'a chain written flat (likely; not stated)';
  if (semantics === 'listed_variants') return 'variant reconstructions of one root';
  return `${n} roots listed; how they relate (components or alternatives) is not recorded`;
}

/**
 * Etymology rows: one per etymon with its language period, then the listed roots, each once.
 * @param {ReturnType<typeof etymologyModel>} m
 * @param {{laneLabel?: string|null}} [opts]
 * @returns {object[]}
 */
export function etymologyRows(m, { laneLabel = null } = {}) {
  const label = laneLabel ?? 'Etymology';
  const why = 'no passage: the roots data lists families, not texts';
  if (!m.available) {
    return [{ key: 'etymology', kind: 'etymology', label, text: m.reason ?? 'No etymology entry was returned for this expression.', note: ETYMOLOGY_NOTE, noPassage: why }];
  }
  if (!m.etyma.length) {
    return [{ key: 'etymology', kind: 'etymology', label, text: m.reason ?? "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)", note: ETYMOLOGY_NOTE, noPassage: why }];
  }
  const rows = m.etyma.map((e, i) => {
    const period = periodText(e.lang);
    const listed = listedRootsWords(e.parent_semantics, (e.parents ?? []).length);
    return { key: `etymology:${e.key}`, kind: 'etymology', label: i === 0 ? label : '',
      text: `${formName(e)}${period ? ` · ${languageName(e.lang)} ${period}, period of the language, not a date` : ' · period of the language, not a date'}`,
      note: [listed, i === 0 ? m.source : null].filter(Boolean).join(' · ') || null, noPassage: i === 0 ? why : null };
  });
  if (m.roots.length) {
    const etymonName = (key) => { const e = m.etyma.find((x) => x.key === key); return e ? `${languageName(e.lang)} ${e.form}` : key; };
    rows.push({ key: 'etymology:roots', kind: 'etymology', label: '',
      text: `listed roots (each once): ${m.roots.map((r) => `${r.form}${r.gloss ? ` '${r.gloss}'` : ''} (${languageName(r.lang)})`).join(' · ')}`,
      note: `${m.roots.some((r) => r.families.length > 1) ? `listed by ${[...new Set(m.roots.flatMap((r) => r.families))].map(etymonName).join(' and ')} · ` : ''}${ETYMOLOGY_NOTE}`,
      noPassage: null });
  }
  return rows;
}

// ── Claims and baseline ─────────────────────────────────────────────────────────────────────────────────

/**
 * Wiktionary claim rows (markers written on the expression, or the trail response's `claims`): labelled
 * "external claim", dimmed with their reasons when the display rule says so; the entry passage opens.
 * @param {object[]} claims
 * @returns {object[]}
 */
export function claimRows(claims) {
  return (Array.isArray(claims) ? claims : []).filter((c) => c && c.display !== 'never').map((c, i) => {
    const label = String(c.label ?? `Wiktionary: ${c.relation ?? 'claim'} ${c.date?.label ?? c.date_text ?? ''}`.trim());
    const text = /external claim/.test(label) ? label : `${label} (external claim)`;
    const dimmed = c.display === 'dimmed';
    const reasons = Array.isArray(c.reasons) ? c.reasons.filter(Boolean) : [];
    return { key: `claim:${i}`, kind: 'claim', label: i === 0 ? 'Claims' : '', text: `◇ ${text}`, dimmed,
      note: [dimmed ? `shown dimmed${reasons.length ? `: ${reasons.join('; ')}` : ''}` : null, CLAIM_NOTE, c.license ?? null].filter(Boolean).join(' · '),
      passage: Number.isInteger(c.highlight?.passage) ? c.highlight.passage : null, openable: Number.isInteger(c.highlight?.passage),
      openLabel: 'open the entry', noPassage: Number.isInteger(c.highlight?.passage) ? null : 'the entry text is not loaded' };
  });
}

/**
 * The baseline row: a sparkline of per-decade rates (thin decades are gaps) with the source named as a different
 * corpus, or why there is none.
 * @param {object|null} baseline GET /api/baseline
 * @returns {object|null}
 */
export function baselineRow(baseline) {
  if (!isObj(baseline)) return null;
  const decades = (baseline.decades ?? []).filter((d) => isNum(d.per_million));
  const spanText = decades.length ? `${decades[0].decade}s–${decades[decades.length - 1].decade}s, peak ${formatNumber(Math.max(...decades.map((d) => d.per_million)))}/M` : '';
  return { key: 'baseline', kind: 'baseline', label: 'Baseline',
    text: baseline.available ? `${baseline.label ?? BASELINE_NOTE}${spanText ? ` · ${spanText}` : ''}` : `No external baseline: ${baseline.reason ?? 'not available'}`,
    note: baseline.available ? [BASELINE_NOTE, baseline.attribution].filter(Boolean).join(' · ') : null,
    spark: baseline.available ? decades.map((d) => (d.thin ? null : d.per_million)) : null,
    noPassage: baseline.available ? 'no passages: an external corpus' : null };
}

/**
 * Every row of the card from the answers (any may be null when its request failed).
 * @param {{expression?: object|null, etymology?: object|null, timeline?: object|null, search?: object|null,
 *   baseline?: object|null, claims?: object[]|null, resolved?: Map<string, object>, trail?: boolean}} r
 * @returns {object[]}
 */
export function crossingsRows({ expression = null, etymology = null, timeline = null, search = null, baseline = null, claims = null,
  resolved = new Map(), trail = false }) {
  const rows = [];
  const lanes = timeline?.lanes ?? [];
  const etymLane = lanes.find((l) => /^trail:etymology$/.test(l.key));
  if (etymology) rows.push(...etymologyRows(etymologyModel(etymology), { laneLabel: etymLane?.label ?? null }));
  else {
    const etym = (search?.suggestions ?? []).find((s) => s.type === 'etymology' || s.type === 'etymon');
    rows.push({ key: 'etymology', kind: 'etymology', label: etymLane?.label ?? 'Etymology', text: etym ? etym.label : 'No etymology entry was returned for this expression.',
      note: ETYMOLOGY_NOTE, noPassage: 'no passage: the roots data lists families, not texts' });
  }
  if (!trail) {
    const variants = (expression?.variants ?? []).filter((v) => v.enabled !== false && Number.isInteger(v.n));
    const hits = search?.hits;
    const text = hits
      ? `${formatCount(hits.passages)} passages in ${formatCount(hits.documents)} documents${hits.undated ? ` (${formatCount(hits.undated)} undated)` : ''}`
        + `${hits.names_excluded ? ` · ${formatCount(hits.names_excluded)} name-guard hits excluded` : ''}${hits.preliminary ? ' · preliminary count' : ''}`
      : 'No passage count was returned.';
    rows.push({ key: 'text', kind: 'matches', label: 'Matches', text, note: variants.length ? `variants: ${variants.map((v) => `${v.form} ${formatCount(v.n)}`).join(' · ')}` : null });
  }
  for (const lane of lanes) {
    if (lane === etymLane) continue;
    rows.push(laneRow(lane, resolved.get(lane.key) ?? null));
  }
  if (!trail) {
    const titles = search?.titles ?? [];
    const titleLanes = lanes.some((l) => laneClass(l) === 'titles');
    // a failed search is not an observation: say so, or leave it to the titles lanes above
    if (!search) {
      if (!titleLanes) rows.push({ key: 'culture', kind: 'culture', label: 'Culture', text: 'The title search could not be loaded, so nothing is said about titles here.' });
    } else {
      rows.push({ key: 'culture', kind: 'culture', label: 'Culture', text: titles.length
        ? `titles listed by search: ${formatCount(titles.length)} · e.g. "${titles[0].title}" (${titles[0].kind}${titles[0].year ? `, ${titles[0].year}` : ''})`
        : search.empty_note ?? 'No titles contain this expression in the loaded corpus. 0 is an observation about this index, not about culture.' });
    }
  }
  // trail lanes the member corpora cannot show, with the server's reason (C2): said, not hidden
  for (const a of Array.isArray(timeline?.trail?.absent) ? timeline.trail.absent : []) {
    if (/^trail:etymology$/.test(a.key)) continue;
    rows.push({ key: `absent:${a.key}`, kind: 'absent', label: a.label ?? a.key, text: `not looked at: ${a.reason ?? 'no such source is loaded'}`, empty: true });
  }
  const claimList = claimRows(claims ?? expression?.claims ?? []);
  if (claimList.length) rows.push(...claimList);
  else {
    const adapters = (search?.suggestions ?? []).find((s) => s.type === 'adapter');
    if (adapters) rows.push({ key: 'claims', kind: 'claim', label: 'Claims', text: adapters.label, note: 'external claims (Wiktionary) are shown only once their source is loaded (Adapters)' });
  }
  const b = baselineRow(baseline);
  if (b) rows.push(b);
  return rows;
}

/**
 * A sparkline path for a series (gaps stay gaps: null values break the line).
 * @param {Array<number|null>} values
 * @param {{w?: number, h?: number}} [opts]
 * @returns {string}
 */
export function sparkPath(values, { w = 96, h: ht = 18 } = {}) {
  const vals = values ?? [];
  const max = Math.max(0, ...vals.filter((v) => Number.isFinite(v)));
  if (!vals.length || !(max > 0)) return '';
  const step = vals.length > 1 ? w / (vals.length - 1) : 0;
  let d = '', pen = false;
  vals.forEach((v, i) => {
    if (!Number.isFinite(v)) { pen = false; return; }
    const x = (i * step).toFixed(1), y = (ht - 1 - (v / max) * (ht - 2)).toFixed(1);
    d += `${pen ? 'L' : 'M'}${x} ${y} `;
    pen = true;
  });
  return d.trim();
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The POST /api/timeline/query body of the card: the Term trail in the virtual corpus 'real', or the per-domain
 * lanes of the expression's own corpus.
 * @param {number} exprId
 * @param {{trail: boolean, corpus: string, toggles?: object}} opts
 */
export function crossingsQuery(exprId, { trail, corpus, toggles = DEFAULT_TOGGLES, saved = null }) {
  const body = { strands: [{ type: 'expression', ref: exprId }], corpus: trail ? TRAIL_CORPUS : corpus,
    lanes: { facet: trail ? 'trail' : 'domain', order: 'first_observed', max: trail ? 40 : 10, run: null },
    f: '', toggles: { ...DEFAULT_TOGGLES, ...toggles }, timeBasis: 'publication' };
  // as saved (RF-2, D17): the counting runs pinned at the save (every member corpus's) and the view's import cutoff and
  // save time, as the Scroll's own query sends them
  if (saved?.asSaved) {
    const pinned = Object.fromEntries(Object.entries(saved.runIds?.materialize ?? {}).filter(([, r]) => Number.isInteger(Number(r)))
      .map(([e, r]) => [e, Number(r)]));
    if (Object.keys(pinned).length) body.runs = { materialize: pinned };
    const c = saved.cutoffs ?? {};
    const cutoffs = { ...(Number.isInteger(c.import_batch) ? { import_batch: c.import_batch } : {}), ...(typeof c.at === 'string' ? { at: c.at } : {}) };
    if (Object.keys(cutoffs).length) body.cutoffs = cutoffs;
  }
  return body;
}

/** '/api/baseline?word=virus' → ['/baseline', {word: 'virus'}]. */
export function splitHref(href) {
  const u = new URL(String(href), 'http://local');
  return [u.pathname.replace(/^\/api(?=\/)/, ''), Object.fromEntries(u.searchParams)];
}

/** Member corpora of the trail, from the response provenance (C2). */
function memberCorpora(timeline) {
  const p = timeline?.provenance ?? {};
  const list = p.corpora ?? p.member_corpora ?? p.members ?? null;
  return Array.isArray(list) ? list.map((c) => (typeof c === 'string' ? c : c?.slug ?? c?.name)).filter(Boolean) : [];
}

// ── The card ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A Crossings card for one expression (loads when created).
 * `onOpenSources` opens the Adapters page from a lane that is not looked at yet.
 * @param {{api: object, exprId: number, corpus: string, toggles?: object, onOpenPassage?: (passageId: number) => void,
 *   onOpenSources?: () => void,
 *   announce?: Function}} opts
 * @returns {{el: HTMLElement, ready: Promise<void>, destroy(): void}}
 */
export function createCrossings({ api, exprId, corpus, toggles = DEFAULT_TOGGLES, saved = null, onOpenPassage = null, onOpenSources = null,
  announce = () => {} }) {
  const el = h('section.crossings', { 'aria-label': 'Crossings' }, renderLoadingLine('Looking across the record…'));
  const st = { alive: true, data: null, resolved: new Map(), lookups: new Map(), stopJob: () => {}, progress: null, opening: null };

  async function load() {
    const expression = await api.get(`/expressions/${exprId}`, null, { key: `crossings-expr-${exprId}` });
    const e = expression?.expression ?? {};
    const surface = e.surface ?? null;
    const exprCorpus = e.corpus ?? corpus;
    const synthetic = e.synthetic === true || exprCorpus === 'demo';
    const single = e.kind ? e.kind === 'word' : Boolean(surface && !/\s/.test(surface));
    let timeline = null, trail = false, trailError = null;
    if (!synthetic) {
      try {
        timeline = await api.post('/timeline/query', crossingsQuery(exprId, { trail: true, corpus: exprCorpus, toggles, saved }), { key: `crossings-trail-${exprId}` });
        trail = true;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        trailError = err;
      }
    }
    if (!trail) {
      timeline = await api.post('/timeline/query', crossingsQuery(exprId, { trail: false, corpus: exprCorpus, toggles, saved }), { key: `crossings-domains-${exprId}` })
        .catch((err) => { if (err?.name === 'AbortError') throw err; return null; });
    }
    const baselineReq = (() => {
      if (trail && isObj(timeline?.baseline)) {
        if (timeline.baseline.available && timeline.baseline.href) { const [p, q] = splitHref(timeline.baseline.href); return api.get(p, q, { key: `crossings-baseline-${exprId}` }); }
        return Promise.resolve({ available: false, reason: timeline.baseline.reason ?? 'single words only' });
      }
      return surface ? api.get('/baseline', { word: surface }, { key: `crossings-baseline-${exprId}` }) : Promise.resolve(null);
    })();
    const [etymology, search, baseline] = await Promise.all([
      single ? api.get('/etymology', { expr: exprId }, { key: `crossings-etym-${exprId}` }).catch(() => null) : Promise.resolve({ available: false, reason: 'Etymology families are listed for single words only.' }),
      !trail && surface ? api.get('/search', { q: surface, corpus: exprCorpus, scope: 'all', limit: 20 }, { key: `crossings-search-${exprId}` }).catch(() => null) : null,
      baselineReq.catch(() => null),
    ]);
    st.data = { expression, surface, exprCorpus, synthetic, trail, trailError, timeline, etymology, search, baseline,
      claims: trail && Array.isArray(timeline?.claims) ? timeline.claims : null };
    if (timeline?.status === 'materializing' && Number.isInteger(timeline.job)) {
      st.progress = 0;
      st.stopJob();
      st.stopJob = followJob(api, timeline.job, {
        progress: (f) => { st.progress = f; if (st.alive) render(); },
        done: () => { st.progress = null; if (st.alive) start(); },
      });
    } else st.progress = null;
  }

  // The first passage of each observed lane: named by the server, else looked up (a few lanes at a time).
  function resolveFirsts() {
    const d = st.data;
    if (!d?.timeline?.queryKey || st.progress !== null) return;
    const todo = (d.timeline.lanes ?? []).filter((l) => l.n > 0 && l.state !== 'pending' && !/^trail:etymology$/.test(l.key)
      && !(Number.isInteger(l.first?.passage) && l.first?.basis) && !st.resolved.has(l.key) && !st.lookups.has(l.key));
    let active = 0;
    const next = () => {
      while (st.alive && active < LOOKUP_CONCURRENCY && todo.length) {
        const lane = todo.shift();
        active++;
        st.lookups.set(lane.key, true);
        lookupFirst(lane).finally(() => { active--; if (st.alive) { render(); next(); } });
      }
    };
    next();
  }

  async function lookupFirst(lane) {
    const d = st.data;
    try {
      let passage = Number.isInteger(lane.first?.passage) ? lane.first.passage : null;
      let label = null;
      if (passage === null) {
        const k = await api.get('/kwic', { q: d.timeline.queryKey, expr: exprId, lane: lane.key, sort: 'date', limit: 1 }, { key: `crossings-first-${exprId}-${lane.key}` });
        const row = (k?.rows ?? [])[0];
        if (!row) { st.resolved.set(lane.key, { state: 'none' }); return; }
        passage = row.passage; label = row.date?.label ?? null;
      }
      st.resolved.set(lane.key, { state: 'passage', passage, label });
      const p = await api.get(`/passages/${passage}`, null, { key: `crossings-firstp-${exprId}-${lane.key}` });
      st.resolved.set(lane.key, { state: 'ok', passage, label, basis: p?.document?.date_card?.basis ?? null });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const cur = st.resolved.get(lane.key);
      st.resolved.set(lane.key, { ...(cur ?? {}), state: cur?.passage ? 'passage' : 'error', error: err });
    }
  }

  async function open(row) {
    let passage = row.passage;
    if (!Number.isInteger(passage) && row.laneKey) {
      st.opening = row.key; render();
      await lookupFirst((st.data?.timeline?.lanes ?? []).find((l) => l.key === row.laneKey) ?? { key: row.laneKey });
      st.opening = null;
      passage = st.resolved.get(row.laneKey)?.passage ?? null;
      render();
    }
    if (Number.isInteger(passage)) { onOpenPassage?.(passage); announce(`Opening the first passage in ${row.label}`); }
  }

  function renderRow(r) {
    const res = r.laneKey ? st.resolved.get(r.laneKey) : null;
    const firstBtn = r.first && r.openable && onOpenPassage
      ? h('button.btn-link.cx-open', { type: 'button', dataset: { lane: r.laneKey ?? '' }, onClick: () => open(r),
        'aria-label': `${r.first} — open the first passage in ${r.label}` }, r.first, h('span.cx-arrow', { 'aria-hidden': 'true' }, ' →'))
      : r.first ? h('span.cx-first', null, r.first) : null;
    const claimBtn = r.kind === 'claim' && r.openable && onOpenPassage
      ? h('button.btn-link.cx-open', { type: 'button', onClick: () => { onOpenPassage(r.passage); announce('Opening the Wiktionary entry'); },
        'aria-label': `${r.text} — ${r.openLabel}` }, r.openLabel, h('span.cx-arrow', { 'aria-hidden': 'true' }, ' →')) : null;
    const status = res?.state === 'error' ? h('span.cx-status.meta', null, ` · the first passage could not be looked up (${res.error?.message ?? 'error'}); opening tries again`)
      : res?.state === 'none' ? h('span.cx-status.meta', null, ' · no passage listed for this lane')
        : st.opening === r.key ? h('span.cx-status.meta', null, ' · opening…') : null;
    return h('div.edge-row.cx-row', { dataset: { row: r.key, kind: r.kind }, class: { 'is-dimmed': r.dimmed === true, 'is-empty': r.empty === true } },
      h('dt', null, r.label),
      h('dd', null,
        r.spark && sparkPath(r.spark) ? h('svg', { class: 'crossings-spark', width: '96', height: '18', viewBox: '0 0 96 18', 'aria-hidden': 'true' },
          h('svg:path', { d: sparkPath(r.spark) })) : null,
        h('span.cx-text', null, r.text),
        firstBtn || r.last ? h('span.cx-dates', null, firstBtn, firstBtn && r.last ? ' · ' : null, r.last, status) : null,
        claimBtn ? h('span.cx-dates', null, claimBtn) : null,
        r.note ? h('span.crossings-row-note', null, r.note) : null,
        r.noPassage ? h('span.crossings-row-note', null, r.noPassage) : null,
        // a lane the member corpora cannot show yet: the Adapters page loads its staged source (fix pass, §8.8)
        r.kind === 'absent' && onOpenSources ? h('button.btn-link.cx-open.cx-sources', { type: 'button', onClick: () => onOpenSources(),
          'aria-label': `Load sources — ${r.label}` }, 'Load sources', h('span.cx-arrow', { 'aria-hidden': 'true' }, ' →')) : null));
  }

  function render() {
    const d = st.data;
    if (!d) return;
    const rows = crossingsRows({ expression: d.expression, etymology: d.etymology, timeline: d.timeline, search: d.search, baseline: d.baseline,
      claims: d.claims, resolved: st.resolved, trail: d.trail });
    const observed = rows.filter((r) => r.kind === 'lane' && !r.empty && !r.pending).length;
    const members = memberCorpora(d.timeline);
    const outside = Object.values(d.timeline?.trail?.outside ?? {}).reduce((sum, x) => sum + (Number.isInteger(x) ? x : 0), 0);
    // a refused trail (400/404: an older server, or an expression outside the virtual corpus) is "not available";
    // a timeout or another failure is said as such and can be asked again
    const refused = d.trailError && [400, 404].includes(d.trailError.status);
    const scope = d.trail
      ? `Term trail across ${members.length ? members.join(', ') : 'every non-synthetic corpus'} (the synthetic demo is never included). Each lane keeps its own unit; nothing is pooled across units or media.`
      : `Domains of the ${d.exprCorpus} corpus${d.synthetic ? ' (synthetic demonstration data)' : ''}.${d.trailError
        ? ` The Term trail ${refused ? 'is not available here' : 'could not be loaded'} (${d.trailError.message ?? 'error'}).` : ''}`;
    clear(el).append(...[
      h('h3.crossings-title', null, `Crossings: '${d.surface ?? `expression ${exprId}`}'`),
      h('p.meta.crossings-scope', null, scope),
      d.trailError && ![400, 404].includes(d.trailError.status)
        ? h('button.btn.cx-retry', { type: 'button', onClick: () => { clear(el).appendChild(renderLoadingLine('Looking across the record…')); st.resolved.clear(); st.lookups.clear(); start(); } },
          'Try the Term trail again') : null,
      st.progress !== null ? renderLoadingLine('Counting in every member corpus…', st.progress) : null,
      h('dl.crossings-rows', null, rows.map(renderRow)),
      d.timeline ? null : h('p.meta', null, 'The per-lane rows could not be loaded.'),
      outside > 0 ? h('p.meta', null, `${formatCount(outside)} counted ${outside === 1 ? 'match falls' : 'matches fall'} outside every trail lane (for example your own imports); the other lane views count them.`) : null,
      observed >= 2 ? h('p.meta.crossings-copresence', null, COPRESENCE_NOTE) : null,
      h('p.crossings-caption', null, CROSSINGS_CAPTION)].filter(Boolean));
  }

  function start() {
    const ready = (async () => {
      try {
        await load();
        if (!st.alive) return;
        render();
        resolveFirsts();
      } catch (err) {
        if (err?.name === 'AbortError' || !st.alive) return;
        clear(el).appendChild(renderErrorCard(err, { what: 'Crossings could not be loaded.', onRetry: () => { clear(el).appendChild(renderLoadingLine('Looking across the record…')); start(); } }));
      }
    })();
    return ready;
  }

  const ready = start();
  return { el, ready, destroy() { st.alive = false; st.stopJob(); } };
}

/**
 * Library module (the inspector embeds the card): nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
