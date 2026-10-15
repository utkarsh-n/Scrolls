// OWNER: WP7
// panels/gate-card.mjs — cards that say why a value is not shown (SPEC §2.E, §4.11, §8.8, §13 rule 7):
// gate cards {gate, needed, have, suggestion} with [Apply], plus the error, empty and loading cards the
// other panels share. A gated measure has no value, so nothing here ever reads `value` or `ci` of a gated
// object: the card prints the gate, what is needed, what the slice has, and the computed suggestion.

import { yearRangeLabel } from '../../shared/dates.mjs';
import { h } from '../core/dom.mjs';
import { formatCount, formatNumber, formatShare } from '../../shared/format.mjs';
import { runRequestOf } from './runs.mjs';

/** Plain words for every gate code of vocab.GATE_CODES (except 'ok'). */
export const GATE_WORDS = Object.freeze({
  insufficient_occurrences: 'too few occurrences',
  insufficient_documents: 'too few documents',
  insufficient_authors: 'too few authors',
  insufficient_coverage: 'too little coverage',
  single_source: 'one document dominates the slice',
  unaligned: 'the two spaces are not aligned',
  slice_too_small: 'a slice is too small',
  composition_mismatch: 'the slices differ too much in composition',
  modality_mismatch: 'the slices are different media',
  sampling_design: 'the sample design does not allow this comparison',
  no_cluster_structure: 'no stable context groups',
  not_run: 'not run',
});

/** Shown whenever a gate's suggestion is null (§4.11). */
export const NO_WIDENING = 'No widening inside this corpus reaches the gate.';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * True for an object that carries a gate other than 'ok' (a gated measure, collocates, clusters, tone, freq).
 * @param {unknown} x
 * @returns {boolean}
 */
export function isGated(x) {
  return isObj(x) && typeof x.gate === 'string' && x.gate !== 'ok';
}

/** 'tokens_per_slice' → 'tokens per slice'. */
export function humanKey(key) {
  return String(key).replace(/_/g, ' ').trim();
}

/** A count or a measure in the house number style. */
function num(v) {
  return Number.isInteger(v) ? formatCount(v) : formatNumber(v);
}

/** Values in [0, 1] that sum to 1: a mix of shares (modality, kinds). */
function isShareMap(o) {
  const vals = Object.values(o);
  if (!vals.length || !vals.every((v) => isNum(v) && v >= 0 && v <= 1)) return false;
  const sum = vals.reduce((a, b) => a + b, 0);
  return sum > 0.98 && sum < 1.02;
}

/** The unit a `needed` object implies for bare numbers in `have` ('tokens_per_slice' → 'tokens'). */
export function impliedUnit(needed) {
  if (!isObj(needed)) return '';
  const keys = Object.keys(needed);
  if (keys.length !== 1) return '';
  return humanKey(keys[0].replace(/_per_slice$/, ''));
}

/**
 * Words for a `needed` value: {tokens_per_slice: 3000000} → '≥ 3,000,000 tokens per slice';
 * {occurrences_per_slice: 50, documents_per_slice: 5} → '≥ 50 occurrences per slice, ≥ 5 documents per slice';
 * a string is returned as is.
 * @param {unknown} needed
 * @returns {string}
 */
export function describeNeeded(needed) {
  if (needed === null || needed === undefined) return '';
  if (typeof needed === 'string') return needed;
  if (isNum(needed)) return `≥ ${num(needed)}`;
  if (!isObj(needed)) return String(needed);
  return Object.entries(needed).map(([k, v]) => {
    if (isNum(v)) return `≥ ${num(v)} ${humanKey(k)}`;
    if (typeof v === 'string') return k === 'modality' ? v : `${humanKey(k)}: ${v}`;
    if (v === null) return `${humanKey(k)}: none`;
    return `${humanKey(k)}: ${describeNeeded(v)}`;
  }).join(', ');
}

/** One side of `have`: a number (with the implied unit), a string, a share map or a counts map. */
function describeSide(v, unit) {
  if (v === null || v === undefined) return 'none';
  if (isNum(v)) return unit ? `${num(v)} ${unit}` : num(v);
  if (typeof v === 'string') return v;
  if (isObj(v)) {
    if (isShareMap(v)) return Object.entries(v).map(([k, x]) => `${humanKey(k)} ${formatShare(x)}`).join(', ');
    return Object.entries(v).map(([k, x]) => (isNum(x) ? `${num(x)} ${humanKey(k)}` : `${humanKey(k)}: ${describeSide(x, '')}`)).join(', ');
  }
  return String(v);
}

/**
 * Words for a `have` value. Slices a/b are named A and B: {a: 21400, b: 30100} with needed tokens_per_slice →
 * 'A 21,400 tokens · B 30,100 tokens'; {a: {occurrences: 7, documents: 2}, …} → 'A 7 occurrences, 2 documents · …'.
 * @param {unknown} have
 * @param {unknown} [needed]
 * @returns {string}
 */
export function describeHave(have, needed = null) {
  const unit = impliedUnit(needed);
  if (have === null || have === undefined) return 'none';
  if (!isObj(have)) return describeSide(have, unit);
  const keys = Object.keys(have);
  if (keys.length && keys.every((k) => k === 'a' || k === 'b')) {
    return keys.map((k) => `${k.toUpperCase()} ${describeSide(have[k], unit)}`).join(' · ');
  }
  return describeSide(have, unit);
}

/** 'A 1840–1899 · B 1990–2026' from a suggestion's slices. */
function slicesText(s) {
  const part = (k) => (isObj(s[k]) && Array.isArray(s[k].years) ? `${k.toUpperCase()} ${yearRangeLabel(s[k].years[0], s[k].years[1])}` : null);
  return [part('a'), part('b')].filter(Boolean).join(' · ');
}

/**
 * The suggestion line: its label, or the widened slices and what they would have; null → NO_WIDENING.
 * @param {unknown} suggestion
 * @returns {{text: string, applicable: boolean}}
 */
export function describeSuggestion(suggestion) {
  if (suggestion === null || suggestion === undefined) return { text: NO_WIDENING, applicable: false };
  if (typeof suggestion === 'string') return { text: suggestion, applicable: false };
  if (!isObj(suggestion)) return { text: String(suggestion), applicable: false };
  const slices = slicesText(suggestion);
  const would = suggestion.would_have ?? suggestion.have ?? null;
  const parts = [];
  if (suggestion.label) parts.push(suggestion.label);
  else if (slices) parts.push(`Widen to ${slices}`);
  if (slices && suggestion.label) parts.push(`(${slices})`);
  if (would !== null) parts.push(`would give ${describeHave(would)}`);
  const run = runRequestOf(suggestion);
  if (!parts.length && run) parts.push(`Run ${runStageWords(run.body.stage)} first`);
  return { text: parts.join(' ') || 'A wider slice', applicable: Boolean(slices) };
}

/**
 * The model of a gate card — strings only, built from gate, needed, have, suggestion and note/reason. It never
 * reads `value` or `ci`.
 * @param {{gate: string, needed?: unknown, have?: unknown, suggestion?: unknown, note?: string, reason?: string}} gated
 * @param {{title?: string}} [opts]
 * @returns {{title: string, gate: string, gateWords: string, needed: string, have: string,
 *            suggestion: {text: string, applicable: boolean}, note: string|null}}
 */
export function gateCardModel(gated, { title = 'Not estimated' } = {}) {
  const gate = String(gated?.gate ?? 'not_run');
  return {
    title,
    gate,
    gateWords: GATE_WORDS[gate] ?? humanKey(gate),
    needed: describeNeeded(gated?.needed),
    have: describeHave(gated?.have, gated?.needed),
    suggestion: describeSuggestion(gated?.suggestion),
    note: gated?.note ?? gated?.reason ?? null,
  };
}

/**
 * Render a gate card. `onApply(suggestion)` is offered only when the suggestion names slices to apply;
 * `onRun(suggestion)` only when it names an analysis run to start (suggestion.run or suggestion.request, see
 * runs.mjs) — a person starts it, the card never does.
 * @param {object} gated
 * @param {{title?: string, onApply?: (suggestion: object) => void, onRun?: (suggestion: object) => void, extra?: Node|null}} [opts]
 * @returns {HTMLElement}
 */
export function renderGateCard(gated, { title, onApply = null, onRun = null, extra = null } = {}) {
  const m = gateCardModel(gated, { title });
  const runnable = Boolean(onRun && runRequestOf(gated?.suggestion));
  const rows = [
    m.needed ? h('div.gate-row', null, h('dt', null, 'Needs'), h('dd', null, m.needed)) : null,
    h('div.gate-row', null, h('dt', null, 'Has'), h('dd', null, m.have)),
    h('div.gate-row', null, h('dt', null, 'Suggestion'), h('dd', null, m.suggestion.text)),
    // the machine code only in a details line (fix pass: the header showed 'too few occurrences · insufficient_occurrences')
    h('div.gate-row.gate-detail', null, h('dt', null, 'Gate'), h('dd', null, h('code', null, m.gate))),
  ];
  return h('section.gate-card', { role: 'group', 'aria-label': `${m.title}: ${m.gateWords}`, dataset: { gate: m.gate } },
    h('header.gate-head', null,
      h('span.gate-glyph', { 'aria-hidden': 'true' }, '⊘'),
      h('strong.gate-title', null, m.title),
      h('span.gate-code', null, m.gateWords)),
    h('dl.gate-rows', null, rows),
    m.note ? h('p.gate-note', null, m.note) : null,
    extra,
    m.suggestion.applicable && onApply
      ? h('div.gate-actions', null, h('button.btn.gate-apply', { type: 'button', onClick: () => onApply(gated.suggestion) },
        isObj(gated.suggestion) && gated.suggestion.label ? gated.suggestion.label : 'Apply'))
      : null,
    runnable
      ? h('div.gate-actions', null, h('button.btn.gate-run', { type: 'button', onClick: (e) => { e.currentTarget.disabled = true; onRun(gated.suggestion); } },
        `Start: ${runStageWords(runRequestOf(gated.suggestion).body.stage)}`))
      : null);
}

/** Words for the stage a gate suggests running. */
export function runStageWords(stage) {
  return { cluster: 'a clustering run', drift: 'a drift run', tokstream: 'a token-stream run', collocations: 'a collocations run',
    vectors: 'a vector-space run', tone: 'a tone run', layout: 'a layout run' }[stage] ?? `a ${humanKey(stage)} run`;
}

/**
 * An error card: the server's message and hint (§8.8) and a Retry button.
 * @param {{message?: string, hint?: string|null, code?: string}|Error} err
 * @param {{onRetry?: () => void, what?: string}} [opts]
 * @returns {HTMLElement}
 */
export function renderErrorCard(err, { onRetry = null, what = null } = {}) {
  const message = err?.message ?? String(err);
  return h('div.state-card.is-error', { role: 'alert' },
    what ? h('strong', null, what) : null,
    h('p', null, message),
    err?.hint ? h('p.state-hint', null, err.hint) : null,
    err?.code ? h('p.meta', null, err.code) : null,
    onRetry ? h('button.btn', { type: 'button', onClick: onRetry }, 'Retry') : null);
}

/**
 * An empty-state card (the text is computed by the caller from the payload).
 * @param {string} text
 * @param {Node|null} [extra]
 * @returns {HTMLElement}
 */
export function renderEmptyCard(text, extra = null) {
  return h('div.state-card.is-empty', { role: 'status' }, h('p', null, text), extra);
}

/**
 * A loading line: words, plus a percentage when one is known (never a spinner without a number, §8.8).
 * @param {string} text
 * @param {number|null} [fraction]
 * @returns {HTMLElement}
 */
export function renderLoadingLine(text, fraction = null) {
  const pct = isNum(fraction) ? ` ${Math.round(fraction * 100)}%` : '';
  return h('p.state-loading', { role: 'status' }, `${text}${pct}`);
}

/**
 * Library module: nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
