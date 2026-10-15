// OWNER: WP7
// panels/compare.mjs — Compare meanings (SPEC §2.E, §4.9, §4.11, §8.6, §13 rules 7–8).
//
// Slices A and B ({years, f}) come from the view (`A`/`B` on a Scroll range, or typed here); the pinned
// expression strands are compared. Panels run top to bottom with coverage first: multiplicity line,
// coverage & composition (with the composition, modality and prominence checks), frequency with exact CIs,
// representative passages (seed printed, reshuffle), neighbouring terms ("context words, not meanings"),
// context groups, estimated displacement, tone and stance, and "How coverage could affect this". Every gated
// object renders as a gate card — gate, needs, has, suggestion and [Apply] — and never as a numeral.
// Narrow viewports get a full-screen sheet with a back button; A stacks over B.

import { h, clear } from '../core/dom.mjs';
import { yearRangeLabel, ymdFromDay } from '../../shared/dates.mjs';
import { formatCI, formatCount, formatNumber, formatRate, formatShare, formatTokens, unitLabel } from '../../shared/format.mjs';
import { formatFilter } from '../../shared/viewstate.mjs';
import { isGated, renderEmptyCard, renderErrorCard, renderGateCard, renderLoadingLine, runStageWords } from './gate-card.mjs';
import { selectPassage } from './inspector.mjs';
import { renderKwicRow } from './passage-card.mjs';
import { createGroupBlock, GROUP_CAPTION, SERIES_CAPTION } from './context-group.mjs';
import { followJob, startSuggestedRun } from './runs.mjs';

/** Measures asked for on every request (§7.2 example). */
export const ALL_MEASURES = Object.freeze(['freq', 'collocates', 'clusters', 'sense_share_jsd', 'neighbor_overlap',
  'aligned_displacement', 'tone']);
export const MEASURE_LABELS = Object.freeze({
  rate_ratio: 'Rate ratio',
  sense_share_jsd: 'Context-share shift',
  neighbor_overlap: 'Neighbour overlap',
  aligned_displacement: 'Aligned displacement',
  convergence: 'Convergence',
});
/** The composition caveat threshold (§2.E): JSD(mixA, mixB) > 0.15. */
export const COMPOSITION_CAVEAT_JSD = 0.15;
export const CONTEXT_WORDS_LABEL = 'context words, not meanings';
export const SHIFT_LABEL = 'estimated shift in usage contexts';
export const TONE_LABEL = 'Apple NLTagger — modern reader model, fallible, anachronistic for historical text';
/** Beside every Spearman ρ against the external baseline (§10.2). */
export const BASELINE_RHO_LABEL = 'Google Books Ngram is a different corpus';
/** OpenAlex cells with fewer sampled works than this show k and n but no share (contract 1.3.0, C3). */
export const CELL_MIN_N = 20;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const SLICES = ['a', 'b'];

/**
 * Whole years of a Scroll range [loDay, hiDay].
 * @param {[number, number]|null} range
 * @returns {[number, number]|null}
 */
export function yearsFromRange(range) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) return null;
  const a = ymdFromDay(Math.min(...range)).y, b = ymdFromDay(Math.max(...range)).y;
  return [a, b];
}

/**
 * The pins and cutoffs of a saved view opened "as saved" for POST /api/compare (RF-2, D17), or null with current data:
 * the counting runs pinned at the save (of the compared expressions), the clustering run it showed, its import cutoff, its
 * save time and its annotation revision cutoff — what main.mjs stores in ui.savedView when it opens the view.
 * @param {number[]} expr the compared expressions
 * @param {{asSaved?: boolean, cutoffs?: object|null, runIds?: object|null}|null} saved ui.savedView
 * @returns {{runs?: object, cutoffs?: object}|null}
 */
export function compareAsSaved(expr, saved) {
  if (!saved?.asSaved) return null;
  const pinned = saved.runIds?.materialize ?? {};
  const materialize = Object.fromEntries(expr.filter((id) => Number.isInteger(Number(pinned[id]))).map((id) => [String(id), Number(pinned[id])]));
  const runs = { ...(Object.keys(materialize).length ? { materialize } : {}),
    ...(Number.isInteger(saved.runIds?.cluster) ? { cluster: saved.runIds.cluster } : {}) };
  const c = saved.cutoffs ?? {};
  const cutoffs = { ...(Number.isInteger(c.import_batch) ? { import_batch: c.import_batch } : {}), ...(typeof c.at === 'string' ? { at: c.at } : {}),
    ...(Number.isInteger(c.annotation_rev) ? { annotation_rev: c.annotation_rev } : {}) };
  const out = { ...(Object.keys(runs).length ? { runs } : {}), ...(Object.keys(cutoffs).length ? { cutoffs } : {}) };
  return Object.keys(out).length ? out : null;
}

/**
 * The POST /api/compare body for a view, or what is missing.
 * @param {object} view ViewState
 * @param {{seed?: number|null, descriptive?: boolean, saved?: object|null}} [opts] `saved`: ui.savedView (as saved → its pins and
 *   cutoffs, RF-2)
 * @returns {{ok: true, body: object} | {ok: false, missing: 'expression'|'slices'}}
 */
export function compareRequest(view, { seed = null, descriptive = false, saved = null } = {}) {
  const expr = (view.strands ?? []).filter((s) => s.type === 'expression').map((s) => s.id).slice(0, 2);
  if (!view.compare?.a || !view.compare?.b) return { ok: false, missing: 'slices' };
  if (!expr.length) return { ok: false, missing: 'expression' };
  const global = formatFilter(view.f);
  const slice = (s) => ({ years: [s.years[0], s.years[1]], f: s.f || global });
  const body = { expr, a: slice(view.compare.a), b: slice(view.compare.b), measures: [...ALL_MEASURES], toggles: { ...view.toggles } };
  if (Number.isInteger(seed)) body.seed = seed;
  if (descriptive) body.override = 'descriptive'; // WP4's request field (server/analysis/compare.mjs)
  const asSaved = compareAsSaved(expr, saved);
  if (asSaved) Object.assign(body, asSaved);
  return { ok: true, body };
}

/**
 * The multiplicity line (§2.E item 0): the server's text when it sends one, else computed from k.
 * @param {{k: number, notable_so_far: number, threshold_percentile: number, text?: string}} m
 * @param {string|null} [label]
 * @returns {string}
 */
export function multiplicityLine(m, label = null) {
  if (!m) return '';
  if (typeof m.text === 'string' && m.text) return m.text;
  const k = m.k;
  const what = label ? ` for '${label}'` : '';
  const expected = formatNumber(0.05 * k);
  const pct = formatNumber(m.threshold_percentile);
  return `Comparison #${k}${what} in this session; ${m.notable_so_far} of ${k} crossed the notable threshold; with ${k} `
    + `${k === 1 ? 'comparison' : 'comparisons'}, ~${expected} ${k === 1 ? 'is' : 'are'} expected by chance at the 95th percentile. `
    + `Notable threshold is the ${pct}th percentile.`;
}

/** 'memo 60%, bulletin 40%' from a share map. */
export function shareList(mix) {
  if (!isObj(mix)) return '—';
  const entries = Object.entries(mix).filter(([, v]) => isNum(v)).sort((x, y) => y[1] - x[1]);
  return entries.length ? entries.map(([k, v]) => `${k.replace(/_/g, ' ')} ${formatShare(v)}`).join(', ') : '—';
}

/**
 * Every caveat that fired, in words (§2.E item 8).
 * @param {object} p Compare payload
 * @returns {string[]}
 */
export function firedCaveats(p) {
  const out = [];
  const cov = p?.coverage ?? {};
  const caveats = Array.isArray(cov.caveats) ? cov.caveats : [];
  if (caveats.includes('composition') || (isNum(cov.composition_jsd) && cov.composition_jsd > COMPOSITION_CAVEAT_JSD)) {
    out.push(`The slices differ in composition (JSD ${formatNumber(cov.composition_jsd, 2)}): differences may reflect source mix.`);
  }
  if (cov.modality_gate && cov.modality_gate !== 'ok') out.push('The slices are different media; nothing is compared across media by default.');
  if (cov.prominence && cov.prominence.consistent === false) out.push('The result depends on the prominence stratum.');
  const m = p?.multiplicity;
  if (m && m.k > 1) out.push(`${m.k} comparisons in this session: the notable threshold is adjusted to the ${formatNumber(m.threshold_percentile)}th percentile.`);
  const gated = gatedParts(p);
  if (gated.length) out.push(`Not estimated (a gate failed): ${gated.join(', ')}.`);
  for (const s of SLICES) {
    const u = cov[s]?.undated_share;
    if (isNum(u) && u >= 0.2) out.push(`${s.toUpperCase()}: ${formatShare(u)} of matches are undated and outside every rate.`);
  }
  if (p?.provenance?.synthetic) out.push('The comparison includes SYNTHETIC demonstration data.');
  return out;
}

/** Names of the parts of a payload that are gated. */
export function gatedParts(p) {
  const out = [];
  if (isGated(p?.freq)) out.push('frequency');
  for (const k of SLICES) if (isGated(p?.freq?.[k])) out.push(`rate of ${k.toUpperCase()}`);
  if (isGated(p?.freq?.rate_ratio)) out.push('rate ratio');
  if (isGated(p?.collocates)) out.push('neighbouring terms');
  if (isGated(p?.clusters)) out.push('context groups');
  for (const m of Array.isArray(p?.measures) ? p.measures : []) if (isGated(m)) out.push((MEASURE_LABELS[m.metric] ?? m.metric).toLowerCase());
  if (isGated(p?.tone)) out.push('machine tone');
  if (isGated(p?.baseline_rho)) out.push('correlation with the external baseline');
  return out;
}

/**
 * Words for the Spearman ρ between our decade rates and the Ngram baseline (§10.2), or null when it is gated or
 * absent (a gated object renders as a gate card, never as a numeral).
 * @param {{value?: number|null, ci?: number[]|null, n_bins?: number, gate?: string, note?: string}|null|undefined} rho
 * @returns {string|null}
 */
export function baselineRhoText(rho) {
  if (!isObj(rho) || isGated(rho) || !isNum(rho.value)) return null;
  const ci = Array.isArray(rho.ci) && rho.ci.length === 2 && rho.ci.every(isNum) ? ` [${formatNumber(rho.ci[0], 2)}, ${formatNumber(rho.ci[1], 2)}]` : '';
  const bins = Number.isInteger(rho.n_bins) ? ` (${formatCount(rho.n_bins)} decades)` : '';
  return `Does our sample track a larger corpus? Spearman ρ = ${formatNumber(rho.value, 2)}${ci}${bins}`;
}

/**
 * One OpenAlex cell of a slice, descriptively (§10.4): k of n, and the share with its Wilson CI only when n ≥ 20.
 * @param {{field?: string, years?: number[], k: number, n: number, share?: number, ci?: number[], abstracts?: number, text?: string}} c
 * @returns {{label: string, text: string, low: boolean}}
 */
export function cellWords(c) {
  const label = `${c.field ?? 'field'} ${Array.isArray(c.years) ? yearRangeLabel(c.years[0], c.years[1]) : ''}`.trim();
  const low = !(Number.isInteger(c.n) && c.n >= CELL_MIN_N);
  const base = `${formatCount(c.k)} of ${formatCount(c.n)} sampled works`;
  const abstracts = Number.isInteger(c.abstracts) ? ` · abstracts for ${formatCount(c.abstracts)}` : '';
  if (low) return { label, text: `${base}${abstracts} · too few sampled works for a share (needs ${CELL_MIN_N})`, low };
  const ci = Array.isArray(c.ci) && c.ci.every(isNum) ? ` [${formatShare(c.ci[0])}, ${formatShare(c.ci[1])}]` : '';
  return { label, text: `${base} · ${formatShare(c.share)}${ci}${abstracts}`, low };
}

/**
 * Words for a measure that passed its gate. The server's `text` wins; otherwise value, CI, n and documents.
 * @param {{metric: string, value: number, ci?: number[]|null, n?: number[], docs?: number[], text?: string,
 *          percentile?: number, verdict?: string}} m
 * @returns {string}
 */
export function measureText(m) {
  if (typeof m.text === 'string' && m.text) return m.text;
  const name = MEASURE_LABELS[m.metric] ?? m.metric;
  const parts = [`${name} ${formatNumber(m.value, 2)}`];
  if (Array.isArray(m.ci) && m.ci.length === 2) parts[0] += ` [${formatNumber(m.ci[0], 2)}, ${formatNumber(m.ci[1], 2)}]`;
  if (Array.isArray(m.n)) parts.push(`n = ${m.n.map(formatCount).join(' / ')}`);
  if (Array.isArray(m.docs)) parts.push(`${m.docs.map(formatCount).join(' / ')} documents`);
  if (isNum(m.percentile)) parts.push(`${formatNumber(m.percentile)}th percentile of frequency-matched controls`);
  if (m.verdict) parts.push(m.verdict);
  return parts.join(' · ');
}

/** "A 1955–1985", "A 500 BCE–2 BCE" (astronomical years labelled historically, §13 rule 18) */
const sliceName = (k, slice) => `${k.toUpperCase()} ${yearRangeLabel(slice?.years?.[0], slice?.years?.[1])}`;

// ── Rendering (thin; every string comes from the payload or the helpers above) ─────────────────────────

function section(key, title, ...content) {
  return h('section.cmp-section', { dataset: { section: key }, 'aria-label': title },
    h('h3.cmp-title', null, title), ...content);
}

function caveatBox(text) {
  return h('p.cmp-caveat', { role: 'note' }, h('span.cmp-caveat-glyph', { 'aria-hidden': 'true' }, '⚠ '), text);
}

function mixBar(mix) {
  if (!isObj(mix)) return null;
  const entries = Object.entries(mix).filter(([, v]) => isNum(v) && v > 0).sort((x, y) => y[1] - x[1]);
  if (!entries.length) return null;
  return h('div.mix-bar', { role: 'img', 'aria-label': `mix: ${shareList(mix)}` },
    entries.map(([k, v], i) => h('span.mix-seg', { style: { width: `${(v * 100).toFixed(1)}%` }, dataset: { i: String(i % 4) } })));
}

function coverageTable(cov, compare) {
  const rows = [
    ['tokens', (c) => (isNum(c?.tokens) ? formatTokens(c.tokens) : isNum(c?.works) ? `${formatCount(c.works)} works` : '—')],
    ['documents', (c) => (isNum(c?.docs) ? formatCount(c.docs) : '—')],
    ['authors', (c) => (isNum(c?.authors) ? formatCount(c.authors) : '—')],
    ['translations', (c) => (isNum(c?.translations) ? formatCount(c.translations) : '—')],
    ['undated share', (c) => (isNum(c?.undated_share) ? formatShare(c.undated_share) : '—')],
    ['date basis', (c) => shareList(c?.basis)],
    ['modality', (c) => shareList(c?.modality)],
    ['kind mix', (c) => shareList(c?.mix)],
  ];
  return h('table.cmp-table', null,
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, ''), SLICES.map((s) => h('th', { scope: 'col' }, sliceName(s, compare?.[s]))))),
    h('tbody', null, rows.map(([label, get]) => h('tr', null, h('th', { scope: 'row' }, label), SLICES.map((s) => h('td.num', null, get(cov?.[s])))))),
    h('tfoot', null, h('tr', null, h('th', { scope: 'row' }, 'mix'), SLICES.map((s) => h('td', null, mixBar(cov?.[s]?.mix))))));
}

function freqRow(k, f, slice) {
  if (!isObj(f)) return h('li', null, `${sliceName(k, slice)}: no frequency reported`);
  return h('li.cmp-freq-row', null,
    h('strong', null, sliceName(k, slice)), ': ',
    h('span.num', null, `${formatCount(f.n)} matches · ${formatRate(f.rate, f.unit)} ${formatCI(f.ci, f.unit)}`),
    isNum(f.docs) ? ` · ${formatCount(f.docs)} documents` : null,
    isNum(f.dp) ? ` · dispersion (Gries' DP) ${formatNumber(f.dp, 2)}` : null);
}

/**
 * Mount the Compare view into #panel.
 * @param {HTMLElement} el
 * @param {{store: object, api: object, keys?: object, announce?: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api } = ctx;
  const announce = ctx.announce ?? (() => {});
  const local = { payload: null, error: null, loading: false, editing: false, seq: 0, seed: null, descriptive: false,
    labels: new Map(), lastKey: null, groups: null, running: null, stopRun: () => {}, runEnd: null, runError: null, alive: true };
  const root = h('div.compare', { hidden: true });
  el.appendChild(root);

  const view = () => store.get().view;
  const isOpen = () => view().panels.right === 'compare';

  function exprLabel() {
    const ids = (view().strands ?? []).filter((s) => s.type === 'expression').map((s) => s.id).slice(0, 2);
    return ids.map((id) => local.labels.get(id) ?? `expression ${id}`).join(' + ') || null;
  }
  async function loadLabels() {
    for (const s of view().strands ?? []) {
      if (s.type !== 'expression' || local.labels.has(s.id)) continue;
      try {
        const x = await api.get(`/expressions/${s.id}`, null, { key: `cmp-expr-${s.id}` });
        if (x?.expression?.surface) { local.labels.set(s.id, x.expression.surface); render(); }
      } catch { /* the label falls back to the id */ }
    }
  }

  async function run({ force = false } = {}) {
    if (!isOpen()) return;
    const req = compareRequest(view(), { seed: local.seed, descriptive: local.descriptive, saved: store.get().ui.savedView });
    if (!req.ok) { local.payload = null; local.error = null; local.loading = false; render(); return; }
    const key = JSON.stringify(req.body);
    if (!force && key === local.lastKey && (local.payload || local.loading)) { render(); return; }
    local.lastKey = key;
    const seq = ++local.seq;
    local.loading = true; local.error = null;
    render();
    try {
      const payload = await api.post('/compare', req.body, { key: 'compare' });
      if (seq !== local.seq) return;
      local.payload = payload; local.loading = false;
      if (Number.isInteger(payload?.multiplicity?.k)) store.dispatch({ type: 'UI_SET', key: 'comparisonsTried', value: payload.multiplicity.k });
      render();
      announce(`Comparison ready: ${sliceName('a', req.body.a)} with ${sliceName('b', req.body.b)}`);
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.error = err; local.loading = false; local.lastKey = null;
      render();
    }
  }

  const applySlices = (s) => {
    const cur = view().compare ?? {};
    const pick = (k) => (isObj(s?.[k]) && Array.isArray(s[k].years) ? { years: s[k].years, f: s[k].f ?? '' } : cur[k]);
    const next = { a: pick('a'), b: pick('b') };
    if (next.a && next.b) {
      local.descriptive = false;
      store.dispatch({ type: 'SET_COMPARE', compare: next });
      announce(`Slices set: ${sliceName('a', next.a)}, ${sliceName('b', next.b)}`);
    }
  };
  const close = () => store.dispatch({ type: 'CLOSE_PANEL', panel: 'compare' });

  /** Start the run a gate card suggests (a person pressed its button); Compare asks again when the job ends. */
  async function startRun(suggestion) {
    local.runError = null; local.runEnd = null;
    try {
      const started = await startSuggestedRun(api, suggestion);
      local.running = { job: started.job, stage: started.stage, fraction: 0 };
      if (Number.isInteger(started.job)) store.dispatch({ type: 'UI_JOB', job: { id: started.job, type: started.stage, status: 'queued', progress: 0 } });
      announce(`Started ${runStageWords(started.stage)}${Number.isInteger(started.job) ? ` (job ${started.job})` : ''}`);
      local.stopRun();
      local.stopRun = followJob(api, started.job, {
        progress: (f) => { if (local.running) { local.running = { ...local.running, fraction: f }; render(); } },
        done: (d) => { local.running = null; local.runEnd = { ...d, stage: started.stage }; run({ force: true }); },
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      local.runError = err;
    }
    render();
  }

  /** GET /api/clusters for the compared expression's run: labels with ids and the shares over time (one request). */
  async function loadGroups(cl, { force = false } = {}) {
    const expr = (view().strands ?? []).filter((s) => s.type === 'expression').map((s) => s.id);
    if (expr.length !== 1 || !Number.isInteger(cl?.run)) return;
    const key = `${expr[0]}:${cl.run}`;
    if (!force && local.groups?.key === key) return;
    local.groups = { key, state: 'loading', data: local.groups?.key === key ? local.groups.data : null, blocks: local.groups?.key === key ? local.groups.blocks : new Map() };
    try {
      const data = await api.get('/clusters', { expr: expr[0], run: cl.run }, { key: 'cmp-clusters' });
      if (!local.alive || local.groups?.key !== key) return;
      local.groups = { ...local.groups, state: 'ok', data };
    } catch (err) {
      if (err?.name === 'AbortError' || !local.alive || local.groups?.key !== key) return;
      local.groups = { ...local.groups, state: 'error', error: err };
    }
    render();
  }

  // ── sections ──
  function renderHeader() {
    const c = view().compare;
    const label = exprLabel();
    return h('header.cmp-head', null,
      h('button.btn.cmp-back', { type: 'button', onClick: close, 'aria-label': 'Close Compare' }, '← Back'),
      h('div.cmp-heading', null,
        h('h2.cmp-h', null, 'Compare'),
        h('p.cmp-sub', null, [label ? `'${label}'` : null, c ? `${sliceName('a', c.a)} · ${sliceName('b', c.b)}` : null].filter(Boolean).join(' · '))),
      h('button.btn', { type: 'button', 'aria-expanded': String(local.editing), onClick: () => { local.editing = !local.editing; render(); } },
        local.editing ? 'Done' : 'Edit slices'));
  }

  function renderEditor() {
    const v = view();
    const c = v.compare;
    const rangeYears = yearsFromRange(v.range);
    const inputs = {};
    const field = (slice, end, value) => {
      // years are astronomical: 0 is 1 BCE, -44 is 45 BCE (§13 rule 18); the hint under the fields says so
      const input = h('input.cmp-year', { type: 'number', inputmode: 'numeric', step: '1', value: value ?? '',
        'aria-label': `Slice ${slice.toUpperCase()} ${end === 0 ? 'from' : 'to'} (year; BCE as 0 = 1 BCE, -44 = 45 BCE)` });
      inputs[`${slice}${end}`] = input;
      return input;
    };
    const apply = () => {
      const yr = (k) => Number.parseInt(inputs[k].value, 10);
      const a = [yr('a0'), yr('a1')], b = [yr('b0'), yr('b1')];
      if (![...a, ...b].every(Number.isInteger)) { status.textContent = 'Each slice needs two whole years.'; return; }
      local.editing = false;
      applySlices({ a: { years: a, f: c?.a?.f ?? '' }, b: { years: b, f: c?.b?.f ?? '' } });
      render();
    };
    const status = h('p.meta', { role: 'status' });
    return h('div.cmp-editor', { role: 'group', 'aria-label': 'Slices' },
      SLICES.map((s) => h('div.cmp-slice-edit', null,
        h('span.cmp-slice-name', null, s.toUpperCase()),
        field(s, 0, c?.[s]?.years?.[0]), h('span', { 'aria-hidden': 'true' }, '–'), field(s, 1, c?.[s]?.years?.[1]),
        h('button.btn', { type: 'button', disabled: !rangeYears, onClick: () => {
          inputs[`${s}0`].value = String(rangeYears[0]); inputs[`${s}1`].value = String(rangeYears[1]);
        } }, 'Use the Scroll range'))),
      h('p.meta', null, 'Years before the common era are typed as astronomical years: 0 is 1 BCE, −44 is 45 BCE.'),
      h('div.cmp-editor-actions', null, h('button.btn.btn-primary', { type: 'button', onClick: apply }, 'Compare')),
      status);
  }

  function gate(gated, title) {
    return renderGateCard(gated, { title, onApply: applySlices, onRun: local.running ? null : startRun });
  }

  function renderCoverage(p) {
    const cov = p.coverage ?? {};
    const parts = [coverageTable(cov, view().compare)];
    if (isNum(cov.composition_jsd)) parts.push(h('p.num', null, `Composition divergence JSD ${formatNumber(cov.composition_jsd, 2)} (base 2)`));
    if ((cov.caveats ?? []).includes('composition') || (isNum(cov.composition_jsd) && cov.composition_jsd > COMPOSITION_CAVEAT_JSD)) {
      parts.push(caveatBox(`The slices differ in composition (JSD ${formatNumber(cov.composition_jsd, 2)}): A is ${shareList(cov.a?.mix)}; B is ${shareList(cov.b?.mix)}. Differences below may reflect source mix; standardized rates are shown beside raw rates.`));
    }
    if (cov.prominence && cov.prominence.consistent === false) parts.push(caveatBox('Result depends on prominence stratum: rate ratios per prominence tercile point in different directions.'));
    if (cov.modality_gate && cov.modality_gate !== 'ok') {
      const g = isGated(p.freq) && p.freq.gate === cov.modality_gate ? p.freq
        : { gate: cov.modality_gate, needed: 'the same dominant modality in both slices', have: { a: cov.a?.modality, b: cov.b?.modality }, suggestion: null };
      parts.push(renderGateCard(g, {
        title: 'Cross-media comparison refused', onApply: applySlices,
        extra: h('div.gate-actions', null, h('button.btn', { type: 'button', onClick: () => { local.descriptive = true; run({ force: true }); } },
          'Compare anyway (descriptive only)')),
      }));
    }
    return section('coverage', 'Coverage & composition', ...parts);
  }

  function renderFreq(p) {
    const f = p.freq;
    const c = view().compare;
    if (isGated(f)) return section('freq', 'Frequency', gate(f, 'Frequency not compared'));
    if (!isObj(f)) return section('freq', 'Frequency', renderEmptyCard('No frequency was reported for these slices.'));
    const sameUnit = f.a?.unit && f.a.unit === f.b?.unit;
    const rr = f.rate_ratio;
    let ratio = null;
    if (isGated(rr)) ratio = gate(rr, 'Rate ratio not estimated');
    else if (isObj(rr) && sameUnit && isNum(rr.value)) {
      ratio = h('p.num', null, `Rate ratio B / A ${formatNumber(rr.value, 3)}${Array.isArray(rr.ci) ? ` [${formatNumber(rr.ci[0], 3)}, ${formatNumber(rr.ci[1], 3)}]` : ''}`);
    } else if (!sameUnit) ratio = h('p.meta', null, 'No rate ratio: the slices are counted in different units.');
    // a withheld standardization (too little shared mix) shows its reason, never a 0 for a slice with matches (fix pass)
    const std = isObj(f.standardized) && sameUnit
      ? (isNum(f.standardized.a) && isNum(f.standardized.b)
        ? h('div', null, h('p.num', null, `Standardized to the pooled composition: A ${formatRate(f.standardized.a, f.a.unit)} · B ${formatRate(f.standardized.b, f.b.unit)}`),
          f.standardized.note ? h('p.meta', null, f.standardized.note) : null)
        : f.standardized.note ? h('p.meta', null, f.standardized.note) : null) : null;
    return section('freq', 'Frequency',
      // A slice whose rate is gated (e.g. insufficient_coverage) shows its count and the gate card, never a rate,
      // interval or dispersion (§13 rule 7; M1 gate: WP4 sends per-slice gated frequency)
      h('ul.cmp-freq', { role: 'list' }, SLICES.map((s) => (isGated(f[s])
        ? h('li.cmp-freq-row.is-gated', null, h('strong', null, sliceName(s, c?.[s])), ': ',
          h('span.num', null, `${formatCount(f[s].n)} matches`), isNum(f[s].docs) ? ` · ${formatCount(f[s].docs)} documents` : null,
          gate(f[s], `Rate for slice ${s.toUpperCase()} not estimated`))
        : freqRow(s, f[s], c?.[s])))),
      ratio, std,
      h('p.meta', null, [f.ci_method ?? '95% confidence intervals', sameUnit ? unitLabel(f.a.unit) : null].filter(Boolean).join(' · ')));
  }

  function renderPassages(p) {
    const ps = p.passages ?? {};
    const c = view().compare;
    const col = (s) => {
      const rows = Array.isArray(ps[s]) ? ps[s] : [];
      return h('div.cmp-col', null, h('h4.section-title', null, sliceName(s, c?.[s])),
        rows.length
          ? h('ul.kwic-list', { role: 'list' }, rows.map((r) => renderKwicRow(r, { onOpen: (id) => selectPassage(store, { passage: id }) })))
          : h('p.meta', null, 'No passages in this slice.'));
    };
    return section('passages', 'Representative passages',
      h('div.cmp-cols', null, col('a'), col('b')),
      h('p.meta.cmp-seed', null, `5 per slice at most, one per document · sampling seed ${ps.seed ?? '—'} `,
        h('button.btn', { type: 'button', onClick: () => { local.seed = Math.floor(Math.random() * 2 ** 31); run({ force: true }); } }, 'Reshuffle')));
  }

  function renderCollocates(p) {
    const col = p.collocates;
    if (isGated(col)) return section('collocates', 'Neighbouring terms', gate(col, 'Neighbouring terms not computed'));
    if (!isObj(col)) return section('collocates', 'Neighbouring terms', renderEmptyCard('No neighbouring terms were reported.'));
    const shared = Array.isArray(col.shared) ? col.shared : [];
    const sharedTerms = new Set(shared.map((x) => x.term));
    const only = (s) => (Array.isArray(col[s]) ? col[s] : []).filter((x) => !sharedTerms.has(x.term));
    const list = (items, fmt) => (items.length ? h('ul.term-list', { role: 'list' }, items.map((x) => h('li', null, h('span.term', null, x.term), ' ', h('span.num.meta', null, fmt(x)))))
      : h('p.meta', null, 'none'));
    const logDice = (x) => `logDice ${formatNumber(x.logDice, 3)} · f ${formatCount(x.f_xy)}`;
    const keyness = Array.isArray(col.keyness) ? col.keyness : [];
    return section('collocates', 'Neighbouring terms',
      h('p.cmp-label', null, `${col.label ?? CONTEXT_WORDS_LABEL}${col.window ? ` · window ${col.window}` : ''}`),
      h('div.cmp-cols.three', null,
        h('div.cmp-col', null, h('h4.section-title', null, 'Only around A'), list(only('a'), logDice)),
        h('div.cmp-col', null, h('h4.section-title', null, 'Around both'), list(shared, (x) => `A ${formatNumber(x.a?.logDice, 3)} · B ${formatNumber(x.b?.logDice, 3)}`)),
        h('div.cmp-col', null, h('h4.section-title', null, 'Only around B'), list(only('b'), logDice))),
      keyness.length ? h('div.cmp-keyness', null, h('h4.section-title', null, 'Keyness (log ratio, Benjamini–Hochberg q < .05)'),
        list(keyness, (x) => `${formatNumber(x.log_ratio, 2)} · more around ${String(x.side ?? '').toUpperCase()}`)) : null);
  }

  /**
   * Context groups (§2.E item 5): per group its machine label and any reader's label, its share in A and B with
   * the document-block CIs, its share over time from the run, and a rename control.
   */
  function renderClusters(p) {
    const cl = p.clusters;
    if (isGated(cl)) return section('clusters', 'Context groups', gate(cl, 'Context groups not available'));
    if (!isObj(cl)) return section('clusters', 'Context groups', renderEmptyCard('Context groups need a clustering run; none exists for this comparison.'));
    const shares = Array.isArray(cl.shares) ? cl.shares : [];
    const c = view().compare;
    const flag = (r) => {
      const a = r.a?.share, b = r.b?.share;
      if (isNum(a) && isNum(b) && a < 0.02 && b >= 0.10) return 'new use in B';
      if (isNum(a) && isNum(b) && b < 0.02 && a >= 0.10) return 'declining in B';
      return '';
    };
    loadGroups(cl);
    const g = local.groups;
    const fromRun = (id) => (g?.data?.clusters ?? []).find((x) => x.id === id) ?? null;
    const blocks = shares.map((r) => {
      const cluster = { ...r, id: r.cluster, ...(fromRun(r.cluster) ?? {}) };
      const slices = { a: r.a, b: r.b, names: { a: sliceName('a', c?.a), b: sliceName('b', c?.b) }, flag: flag(r) || null,
        totals: isObj(cl.n) ? { a: cl.n.a, b: cl.n.b } : null };
      const map = g?.blocks ?? new Map();
      let block = map.get(r.cluster);
      if (block) block.update({ cluster, data: g?.data ?? null, slices });
      else {
        block = createGroupBlock({ api, cluster, data: g?.data ?? null, slices, announce, compact: true, caption: false,
          onRenamed: () => loadGroups(cl, { force: true }) });
        map.set(r.cluster, block);
        if (g) g.blocks = map;
      }
      return h('li.cmp-group', null, block.el);
    });
    return section('clusters', 'Context groups',
      h('p.meta', null, [`run ${cl.run ?? '—'}`, cl.representation ? `representation ${cl.representation}` : null, 'shares with document-block bootstrap 95% CIs']
        .filter(Boolean).join(' · ')),
      g?.state === 'error' ? h('p.meta', null, `Shares over time could not be loaded: ${g.error?.message ?? 'error'}`) : null,
      g?.data ? h('p.meta', null, `Charts: ${SERIES_CAPTION}.`) : null,
      h('ul.cmp-groups', { role: 'list' }, blocks),
      h('p.meta', null, GROUP_CAPTION));
  }

  /** Spearman ρ of our decade rates against the Ngram baseline (§10.2): a gate card when gated, never a numeral. */
  function renderBaselineRho(p) {
    const rho = p.baseline_rho;
    if (rho === undefined) return null;
    if (!isObj(rho)) return section('baseline', 'External baseline', renderEmptyCard('No correlation with the external baseline was reported.'), h('p.meta', null, BASELINE_RHO_LABEL));
    if (isGated(rho)) return section('baseline', 'External baseline', gate(rho, 'Spearman ρ against the Ngram baseline not computed'), h('p.meta', null, BASELINE_RHO_LABEL));
    const text = baselineRhoText(rho);
    return section('baseline', 'External baseline',
      text ? h('p.num.cmp-rho', null, text) : renderEmptyCard(rho.note ?? 'No correlation with the external baseline was reported.'),
      h('p.cmp-label', null, `${BASELINE_RHO_LABEL}: a rank correlation of decade rates, not a check of any count${rho.note && text ? `. ${rho.note}` : ''}`));
  }

  /** OpenAlex within-cell shares (§10.4): each cell side by side, never a rate, ratio or trend across cells. */
  function renderWithinCell(p) {
    const wc = p.within_cell;
    if (!isObj(wc)) return null;
    const c = view().compare;
    const col = (s) => {
      const cells = Array.isArray(wc[s]) ? wc[s] : [];
      return h('div.cmp-col', null, h('h4.section-title', null, sliceName(s, c?.[s])),
        cells.length ? h('ul.cmp-cells', { role: 'list' }, cells.map((x) => {
          const w = cellWords(x);
          return h('li', { class: { 'is-low': w.low } }, h('span.cmp-cell-label', null, w.label), ' ', h('span.num', null, w.text));
        })) : h('p.meta', null, 'No OpenAlex cell fits this slice.'));
    };
    return section('within_cell', 'Within-cell shares (OpenAlex)',
      h('p.cmp-label', null, wc.note ?? 'Each cell is its own top-cited sample; shares are shown side by side, never as a rate, ratio or trend across cells.'),
      wc.method ? h('p.meta', null, wc.method) : null,
      h('div.cmp-cols', null, col('a'), col('b')));
  }

  function renderRunState() {
    if (local.running) {
      return renderLoadingLine(`Running ${runStageWords(local.running.stage)}${Number.isInteger(local.running.job) ? ` (job ${local.running.job})` : ''}; Compare asks again when it ends…`, local.running.fraction);
    }
    if (local.runError) return renderErrorCard(local.runError, { what: 'The run could not be started.' });
    if (local.runEnd && local.runEnd.status && local.runEnd.status !== 'succeeded') {
      return h('p.meta', { role: 'status' }, `${runStageWords(local.runEnd.stage)} ended ${local.runEnd.status}${local.runEnd.error?.message ? `: ${local.runEnd.error.message}` : ''}.`);
    }
    return null;
  }

  function renderMeasures(p) {
    const ms = Array.isArray(p.measures) ? p.measures : [];
    return section('measures', 'Estimated displacement',
      h('p.cmp-label', null, `An ${SHIFT_LABEL}, never a verdict about meaning.`),
      ms.length ? h('div.cmp-measures', null, ms.map((m) => (isGated(m)
        ? gate(m, `${MEASURE_LABELS[m.metric] ?? m.metric}: not estimated`)
        : h('p.cmp-measure.num', { dataset: { metric: m.metric } }, measureText(m)))))
        : renderEmptyCard('No displacement measure was requested.'));
  }

  function renderTone(p) {
    const t = p.tone;
    const human = p.human?.pragmatic_function;
    const counts = (o) => (isObj(o) && Object.keys(o).length
      ? Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${formatCount(v)}`).join(', ') : 'none');
    const toneBlock = isGated(t) ? gate(t, 'Machine tone not computed')
      : isObj(t) ? h('div.cmp-tone', null, h('p.meta', null, TONE_LABEL),
        h('ul.cmp-freq', { role: 'list' }, SLICES.map((s) => h('li.num', null, `${s.toUpperCase()}: mean ${formatNumber(t[s]?.mean, 2)} ${Array.isArray(t[s]?.ci) ? `[${formatNumber(t[s].ci[0], 2)}, ${formatNumber(t[s].ci[1], 2)}]` : ''} · ${formatCount(t[s]?.n)} paragraphs`))))
        : null;
    return section('tone', 'Tone and stance',
      toneBlock,
      h('div.cmp-human', null,
        h('h4.section-title', null, 'Pragmatic function (human annotations)'),
        isObj(human) ? h('p', null, `A: ${counts(human.a)} · B: ${counts(human.b)}`) : h('p.meta', null, 'No human annotations of pragmatic function in either slice.'),
        p.human?.note ? h('p.meta', null, p.human.note) : null));
  }

  function renderCaveats(p) {
    const fired = firedCaveats(p);
    return section('caveats', 'How coverage could affect this',
      p.coverage_note ? h('p', null, p.coverage_note) : null,
      fired.length ? h('ul.cmp-caveats', { role: 'list' }, fired.map((x) => h('li', null, x))) : h('p.meta', null, 'No caveat fired.'));
  }

  function render() {
    root.hidden = !isOpen();
    clear(root);
    if (!isOpen()) return;
    const v = view();
    root.classList.toggle('syn-frame', Boolean(local.payload?.provenance?.synthetic));
    root.appendChild(renderHeader());
    const req = compareRequest(v);
    if (local.editing || (!req.ok && req.missing === 'slices')) {
      root.appendChild(renderEditor());
      if (!req.ok && req.missing === 'slices') {
        root.appendChild(renderEmptyCard('Set two slices: select a range on the Scroll and press A, then another range and press B, or type the years above.'));
        return;
      }
    }
    if (!req.ok) {
      root.appendChild(renderEmptyCard('Pin an expression (P) to compare it across the two slices.'));
      return;
    }
    if (local.error) { root.appendChild(renderErrorCard(local.error, { what: 'The comparison could not be computed.', onRetry: () => run({ force: true }) })); return; }
    if (local.loading && !local.payload) { root.appendChild(renderLoadingLine(`Comparing ${sliceName('a', v.compare.a)} with ${sliceName('b', v.compare.b)}…`)); return; }
    const p = local.payload;
    if (!p) return;
    root.appendChild(h('div.cmp-body', { 'aria-busy': String(local.loading) },
      h('p.cmp-multiplicity', { role: 'note' }, multiplicityLine(p.multiplicity, exprLabel())),
      // RF-2: a comparison computed as saved says so (the server's sentence)
      p.as_saved?.note ? h('p.cmp-as-saved.meta', { role: 'note' }, p.as_saved.note) : null,
      renderRunState(),
      renderCoverage(p), renderFreq(p), renderWithinCell(p), renderBaselineRho(p), renderPassages(p), renderCollocates(p), renderClusters(p),
      renderMeasures(p), renderTone(p), renderCaveats(p)));
  }

  // A, B and C (§8.5) are bound by the timeline (timeline/viewport.mjs), which knows the visible range; they
  // dispatch SET_COMPARE / OPEN_PANEL, which this panel follows.

  const unsubs = [
    store.subscribe((s) => s.view.panels.right, () => { loadLabels(); run(); render(); }),
    store.subscribe((s) => s.view.compare, () => { local.seed = null; run(); }),
    store.subscribe((s) => s.view.strands, () => { loadLabels(); run(); }),
    store.subscribe((s) => s.view.f, () => run()),
    store.subscribe((s) => s.view.toggles, () => run()),
    // "Show as saved" ↔ "Show current data" (RF-2): the comparison follows the view's pins and cutoffs
    store.subscribe((s) => s.ui.savedView, () => run()),
  ];
  if (isOpen()) { loadLabels(); run(); }
  render();

  return {
    unmount() {
      for (const u of unsubs) u();
      local.stopRun();
      local.alive = false;
      local.seq++;
      root.remove();
    },
  };
}
