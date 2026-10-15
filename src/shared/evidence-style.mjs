// OWNER: WP0 — the ONLY evidence → style mapping (SPEC §8.7, D7, §13 rules 3 and 5)
//
// Timeline, lineage, genealogy, constellation, legend, SVG and PNG all import this module. Evidence status
// is encoded by line pattern + endpoint + badge word, never by colour alone; review status is an overlay
// that never changes the line; hue encodes role (family) and is always backed by the rel_type glyph/label.

import { CELL_FLAGS, CELL_STATES, EVIDENCE_STATUS, FAMILY_HUE, LANE_ORDER_NOTE, REVIEW_STATUS } from './vocab.mjs';

/** Line pattern, endpoint and badge per evidence status (§8.7 table). */
const STATUS_STYLE = Object.freeze({
  documented: Object.freeze({ dash: [], endpoint: 'dot', badge: 'DOC' }),
  computed: Object.freeze({ dash: [6, 4], endpoint: 'square', badge: 'CALC' }),
  proposed: Object.freeze({ dash: [1, 3], endpoint: 'question', badge: 'PROP' }),
});
const LINE_WIDTH = 1.5;
const REJECTED_OPACITY = 0.3;

/**
 * Style of a relationship edge or arc.
 * @param {{evidence_status:string, review_status?:string, provenance_quality?:string, family?:string,
 *          cue?:boolean, is_synthetic?:boolean|0|1, date_conflict?:boolean|0|1, origin?:string}} rel
 * @returns {{dash:number[], width:number, endpoint:'dot'|'square'|'question', badge:string,
 *            hue:'amber'|'violet'|'ivory2'|'danger', opacity:number, strike:boolean,
 *            overlay:null|'check'|'cross'|'scales', synthetic:boolean, conflict:boolean, human:boolean}}
 *   `badge` is the evidence word (+ ' ⚠' on a date conflict); `human` asks for the ✎ badge.
 * @throws {TypeError} on an unknown evidence or review status — never guess a style
 */
export function edgeStyle({ evidence_status, review_status = 'unreviewed', provenance_quality = 'complete', family,
  cue = false, is_synthetic = false, date_conflict = false, origin } = {}) {
  if (!EVIDENCE_STATUS.includes(evidence_status)) throw new TypeError(`edgeStyle: unknown evidence_status '${evidence_status}'`);
  if (!REVIEW_STATUS.includes(review_status)) throw new TypeError(`edgeStyle: unknown review_status '${review_status}'`);
  const base = STATUS_STYLE[evidence_status];
  let badge = base.badge;
  if (evidence_status === 'documented' && provenance_quality === 'source_unrecorded') badge = 'DOC*';
  if (evidence_status === 'proposed' && cue) badge = 'PROP · CUE';
  const conflict = Boolean(date_conflict);
  if (conflict) badge += ' ⚠';
  const rejected = review_status === 'rejected';
  return {
    dash: [...base.dash],
    width: LINE_WIDTH,
    endpoint: base.endpoint,
    badge,
    hue: conflict ? 'danger' : FAMILY_HUE[family] ?? 'ivory2',
    opacity: rejected ? REJECTED_OPACITY : 1,
    strike: rejected,
    overlay: { unreviewed: null, confirmed: 'check', rejected: 'cross', disputed: 'scales' }[review_status],
    synthetic: Boolean(is_synthetic),
    conflict,
    human: origin === 'human',
  };
}

const flagSet = (flags, name) => (Number(flags) & CELL_FLAGS[name]) !== 0;

/**
 * Style of a timeline bin cell (§1.2 states, §7.2 flags). Colours are token names from tokens.css
 * (without '--'). `mark` says what to draw in the strand: a rect (observed), a 1 px dotted baseline
 * (absent), a hollow tick of raw n (low), or nothing (uncovered, pending — only the lane underlay).
 * @param {{state: number|string, flags?: number}} cell
 * @returns {{fill:string|null, outline:string|null, pattern:null|'hatch'|'stripes'|'dots'|'syn', superscript:null|'¹',
 *            opacity:number, mark:'rect'|'baseline'|'tick'|'none', glyph:null|'≈', synthetic:boolean}}
 * @throws {TypeError} on an unknown state
 */
export function binStyle({ state, flags = 0 } = {}) {
  const name = typeof state === 'number' ? CELL_STATES[state] : state;
  const synthetic = flagSet(flags, 'synthetic');
  switch (name) {
    case 'observed': {
      const sparse = flagSet(flags, 'sparse');
      const estimated = flagSet(flags, 'estimated_majority');
      return {
        fill: 'ink', outline: sparse ? 'ink' : null,
        pattern: estimated ? 'stripes' : synthetic ? 'syn' : null,
        superscript: flagSet(flags, 'single_source') ? '¹' : null,
        opacity: sparse ? 0.25 : 0.88, mark: 'rect', glyph: estimated ? '≈' : null, synthetic,
      };
    }
    case 'absent':
      return { fill: null, outline: 'ink-3', pattern: null, superscript: null, opacity: 1, mark: 'baseline', glyph: null, synthetic };
    case 'low':
      return { fill: null, outline: 'ink-2', pattern: 'hatch', superscript: null, opacity: 0.5, mark: 'tick', glyph: null, synthetic };
    case 'uncovered':
      return { fill: null, outline: null, pattern: 'hatch', superscript: null, opacity: 1, mark: 'none', glyph: null, synthetic };
    case 'pending':
      return { fill: null, outline: null, pattern: 'dots', superscript: null, opacity: 1, mark: 'none', glyph: null, synthetic };
    default:
      throw new TypeError(`binStyle: unknown state '${state}'`);
  }
}

/** Badge words with their meaning (cards, legend, SVG). */
export const BADGES = Object.freeze({
  'DOC': Object.freeze({ text: 'DOC', title: 'documented', description: 'An external record states this link (source and locator shown).' }),
  'DOC*': Object.freeze({ text: 'DOC*', title: 'documented — source not recorded', description: 'Documented upstream; source not recorded by Cipher.' }),
  'CALC': Object.freeze({ text: 'CALC', title: 'computed', description: 'An algorithmic estimate with a run, method and score.' }),
  'PROP': Object.freeze({ text: 'PROP', title: 'proposed', description: 'A hypothesis; shown with who proposed it.' }),
  'PROP · CUE': Object.freeze({ text: 'PROP · CUE', title: 'proposed — attribution cue', description: 'An in-text attribution cue (quoted); its referent is inferred. Only a person can confirm it.' }),
  'SYN': Object.freeze({ text: 'SYN', title: 'synthetic', description: 'Invented demonstration material.' }),
  '✎': Object.freeze({ text: '✎', title: 'human-created', description: 'Proposed by a person.' }),
  '✓': Object.freeze({ text: '✓', title: 'confirmed', description: 'Reviewed and confirmed by a person; the evidence status is unchanged.' }),
  '✕': Object.freeze({ text: '✕', title: 'rejected', description: 'Reviewed and rejected by a person; hidden by default.' }),
  '⚖': Object.freeze({ text: '⚖', title: 'disputed', description: 'Reviewers disagree.' }),
  '⚠': Object.freeze({ text: '⚠', title: 'date conflict', description: 'The later item is dated before its source; never drawn as feedback.' }),
});

const edgeRow = (key, label, description, rel) => Object.freeze({ group: 'evidence', key, label, description, style: edgeStyle(rel) });
const overlayRow = (key, label, description, rel) => Object.freeze({ group: 'overlay', key, label, description, style: edgeStyle(rel) });
const binRow = (key, label, description, cell) => Object.freeze({ group: 'bins', key, label, description, style: binStyle(cell) });
const hueRow = (key, label, description) => Object.freeze({ group: 'role', key, label, description, style: Object.freeze({ hue: key }) });

/**
 * Legend rows, in display order: every evidence status, every overlay, every bin state and flag, every
 * role hue, and the lane-order note. Renderers draw each row's `style` with the same code as the marks.
 */
export const LEGEND_ROWS = Object.freeze([
  edgeRow('documented', 'documented', 'solid line, filled dot — an external record states the link', { evidence_status: 'documented', family: 'citation' }),
  edgeRow('documented_unrecorded', 'documented (source not recorded)', 'DOC* — documented upstream; source not recorded', { evidence_status: 'documented', provenance_quality: 'source_unrecorded', family: 'citation' }),
  edgeRow('computed', 'computed', 'dashed line, hollow square — an algorithmic estimate', { evidence_status: 'computed', family: 'quotation' }),
  edgeRow('proposed', 'proposed', 'dotted line, ? — a hypothesis', { evidence_status: 'proposed', family: 'allusion' }),
  edgeRow('proposed_cue', 'proposed with attribution cue', 'PROP · CUE — the cue is quoted; the referent is inferred', { evidence_status: 'proposed', cue: true, family: 'citation' }),
  overlayRow('confirmed', 'confirmed by a reviewer', '✓ at the midpoint; the line pattern never changes', { evidence_status: 'proposed', review_status: 'confirmed', family: 'allusion' }),
  overlayRow('rejected', 'rejected by a reviewer', '✕ and struck through; hidden by default', { evidence_status: 'proposed', review_status: 'rejected', family: 'allusion' }),
  overlayRow('disputed', 'disputed', '⚖ — reviewers disagree', { evidence_status: 'proposed', review_status: 'disputed', family: 'allusion' }),
  overlayRow('human', 'proposed by a person', '✎ badge', { evidence_status: 'proposed', origin: 'human', family: 'allusion' }),
  overlayRow('date_conflict', 'date conflict', '⚠ — the later item is dated before its source', { evidence_status: 'documented', date_conflict: true, family: 'citation' }),
  overlayRow('synthetic', 'synthetic', 'striped overlay + SYN — invented demonstration material', { evidence_status: 'documented', is_synthetic: true, family: 'citation' }),
  binRow('observed', 'observed', 'bar: rate in the lane unit (n ≥ 5)', { state: 'observed', flags: 0 }),
  binRow('sparse', 'observed, sparse', 'outlined bar: 1–4 matches', { state: 'observed', flags: CELL_FLAGS.sparse }),
  binRow('single_source', 'single-source burst', '¹ — ≥ 60% of the bin from one document', { state: 'observed', flags: CELL_FLAGS.single_source }),
  binRow('estimated', 'mostly estimated dates', 'stripes + ≈ — > 50% of the bin from estimated dates', { state: 'observed', flags: CELL_FLAGS.estimated_majority }),
  binRow('absent', 'looked, found none', 'dotted baseline — 0 matches with enough coverage', { state: 'absent' }),
  binRow('low', 'low coverage', 'hollow tick of raw n; rate suppressed', { state: 'low' }),
  binRow('uncovered', 'no sources', 'hatched — nothing to look at', { state: 'uncovered' }),
  binRow('pending', 'indexing — not yet looked', 'sparse dots', { state: 'pending' }),
  hueRow('amber', 'reference to earlier material', 'quotation, citation, sample, adaptation, descent'),
  hueRow('violet', 'reinterpretation', 'parody, recontextualization, answer, reframes, hypotheses'),
  hueRow('ivory2', 'similarity', 'shared wording, similar contexts, kindred, counterpart'),
  hueRow('cyan', 'current selection', 'selection and navigation only'),
  Object.freeze({ group: 'note', key: 'lane_order', label: LANE_ORDER_NOTE, description: '', style: null }),
]);
