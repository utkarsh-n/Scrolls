// OWNER: WP6
// timeline/clusters.mjs — context-group lanes on the Scroll (SPEC §1.3, §1.8, §4.8; contract 1.3.0 C1): lanes
// keyed `cluster:<run>:<group>` (plus `cluster:<run>:residual`) whose label is {machine, human|null}; the
// not-run and gated lane states with what the user can do about them; and the transition glyphs drawn from
// GET /api/clusters — ⑂ split and ⑃ merge as dashed S-curves, emergence and fading as dashed ticks — every one
// of them labelled as computed: a change in usage contexts, never a claim about speakers.

import { formatCount } from '../../shared/format.mjs';
import { dayFromYMD, ymdFromDay } from '../../shared/dates.mjs';
import { h } from '../core/dom.mjs';
import { renderGateCard } from '../panels/gate-card.mjs';

/** Middle day of a year: a year-precision transition is never drawn at 1 January (§13 rule 18). */
const midYearDay = (y) => Math.floor((dayFromYMD(y, 1, 1) + dayFromYMD(y + 1, 1, 1)) / 2);

/** The caveat every split carries (§1.8). */
export const SPLIT_CAVEAT = 'Computed: a split in usage contexts, not a claim about speakers.';
/** The caveat of a merge (⑃) of two groups of one expression. */
export const MERGE_CAVEAT = 'Computed: a merge in usage contexts, not a claim about speakers.';
/** The caveat of an emergence or a fading (no glyph of its own in §1.8; drawn as a dashed tick). */
export const CONTEXT_CAVEAT = 'Computed from usage contexts, not a claim about speakers.';
/** Lane-header words of a machine label (§1.3: cluster lanes say "machine label (editable)"). */
export const MACHINE_NOTE = 'machine label (editable)';

/**
 * A lane label as words: plain strings pass through; a context group's {machine, human} label reads as the
 * human label when one is set (the machine label stays visible beside it, §13 rule 10).
 * @param {string|{machine?: string|null, human?: string|null}|null|undefined} label
 * @param {string} [fallback]
 * @returns {{text: string, machine: string|null, human: string|null}}
 */
export function laneLabelOf(label, fallback = '') {
  if (label && typeof label === 'object') {
    const machine = typeof label.machine === 'string' && label.machine.trim() ? stripMachine(label.machine) : null;
    const human = typeof label.human === 'string' && label.human.trim() ? label.human.trim() : null;
    return { text: human ?? machine ?? fallback, machine, human };
  }
  const text = typeof label === 'string' && label ? label : fallback;
  return { text, machine: null, human: null };
}

/** 'machine label: hold · mic · verse' → 'hold · mic · verse' (the words are re-added where they are shown). */
export function stripMachine(s) {
  return String(s ?? '').replace(/^\s*machine label:\s*/i, '').trim();
}

/**
 * Parse a context-group lane key: 'cluster:24:3' → {run: 24, group: 3, residual: false} (the group is the run's
 * `ord`); 'cluster:24:residual' → {run: 24, group: null, residual: true}; a '~titles' / '~abstracts' sub-lane keeps
 * its unit class; anything else → null.
 * @param {string} key
 * @returns {{run: number, group: number|null, residual: boolean}|null}
 */
export function parseClusterLaneKey(key) {
  const m = /^cluster:(\d+):(\d+|residual)(?:~(titles|abstracts))?$/.exec(String(key ?? ''));
  if (!m) return null;
  return { run: Number(m[1]), group: m[2] === 'residual' ? null : Number(m[2]), residual: m[2] === 'residual', unitClass: m[3] ?? 'text' };
}

/**
 * The clustering run the lanes of a query belong to: the view's pinned run, else the run named in the lane keys.
 * @param {{lanes?: Array<{key: string}>, run?: number|null}|null} query
 * @param {number|null} [pinned]
 * @returns {number|null}
 */
export function clusterRunOf(query, pinned = null) {
  if (Number.isInteger(pinned)) return pinned;
  if (Number.isInteger(query?.cluster?.run)) return query.cluster.run;
  if (Number.isInteger(query?.run)) return query.run;
  for (const l of query?.lanes ?? []) {
    const k = parseClusterLaneKey(l.key);
    if (k) return k.run;
  }
  return null;
}

/**
 * Can the lanes menu offer context groups? Only for exactly one pinned expression (C1).
 * @param {Array<{type: string}>} strands
 * @returns {boolean}
 */
export function canClusterLanes(strands) {
  return (strands ?? []).filter((s) => s.type === 'expression').length === 1 && (strands ?? []).length === 1;
}

/**
 * What the Scroll shows for a cluster-facet query (C1): 'lanes' when groups are drawn, else a card.
 * @param {object|null} query TimelineQuery
 * @param {string} facet the view's lane facet
 * @returns {{kind: 'lanes'|'not_run'|'gated'|'none', gate?: object|null, run?: object|null, note?: string|null}}
 */
export function clusterLaneState(query, facet) {
  if (facet !== 'cluster' || !query) return { kind: 'none' };
  const state = query.lane_state ?? (query.lanes?.length ? 'ok' : null);
  if (state === 'not_run') {
    return { kind: 'not_run', run: query.suggestion?.run ?? query.lane_suggestion?.run ?? null, note: query.lane_note ?? null };
  }
  if (state === 'gated') {
    const gate = query.gate && typeof query.gate === 'object' ? query.gate : query.lane_gate ?? null;
    return { kind: 'gated', gate, run: gate?.suggestion?.run ?? null, note: gate?.note ?? null };
  }
  return query.lanes?.length ? { kind: 'lanes' } : { kind: 'none' };
}

/**
 * Words for the job of a clustering run: "clustering… 41% · counting contexts".
 * @param {{status?: string, progress?: number, message?: string|null}|null} job
 * @returns {string}
 */
export function clusterJobLine(job) {
  if (!job) return 'Starting the clustering run…';
  if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'interrupted') {
    return `The clustering run ${job.status}${job.error?.message ? `: ${job.error.message}` : '.'}`;
  }
  if (job.status === 'succeeded') return 'Clustering finished — drawing the context groups.';
  const pct = Number.isFinite(job.progress) ? ` ${Math.round(job.progress * 100)}%` : '';
  return `clustering…${pct}${job.message ? ` · ${job.message}` : ''}`;
}

/**
 * Find the (text) lane of a context group in the layout: lanes are keyed by the group's `ord` in its run (C1);
 * a lane may also carry `cluster_id`. Keys of contract ≤ 1.2 ('cluster:<group id>') are still understood.
 * @param {Array<{key: string}>} layoutLanes
 * @param {Array<{key: string, ord?: number|null, clusterId?: number|null}>} modelLanes
 * @param {number|null} id the group's cluster id
 * @param {number|null} ord the group's ord
 */
function laneOfGroup(layoutLanes, modelLanes, id, ord) {
  if (id === null && ord === null) return null;
  const textFirst = [...modelLanes].sort((a, b) => (parseClusterLaneKey(a.key)?.unitClass === 'text' ? 0 : 1) - (parseClusterLaneKey(b.key)?.unitClass === 'text' ? 0 : 1));
  let key = null;
  for (const l of textFirst) {
    const k = parseClusterLaneKey(l.key);
    if (!k || k.residual) continue;
    if ((ord !== null && k.group === ord) || (id !== null && Number.isInteger(l.clusterId) && l.clusterId === id)) { key = l.key; break; }
  }
  if (!key && id !== null) key = modelLanes.find((l) => l.key === `cluster:${id}`)?.key ?? null;
  return key ? layoutLanes.find((l) => l.key === key) ?? null : null;
}

const yearOf = (day) => ymdFromDay(Math.floor(day)).y;

/**
 * The tooltip of a transition (§1.8): the server's sentence, then run · k · stability · representation, then the
 * caveat — each said once.
 * @param {object} t transition
 * @param {object} clusters GET /api/clusters
 * @returns {string[]}
 */
export function transitionTip(t, clusters) {
  const child = (clusters?.clusters ?? []).find((c) => c.id === (t.to ?? t.from));
  const name = (c) => (c ? `'${stripMachine(c.machine_label ?? c.label)}'` : '');
  const first = t.text ?? (t.kind === 'split'
    ? `Context group ${t.to_ord ?? t.to} ${name(child)} emerges ${t.year}.${t.nearest?.cluster != null ? ` Nearest earlier group: ${t.nearest.cluster} (centroid cosine ${t.cosine ?? t.nearest.cosine}).` : ''}`
    : t.kind === 'merge' ? `Context groups ${t.from_ord ?? t.from} and ${t.to_ord ?? t.to} merge ${t.year}.`
      : t.kind === 'vanish' ? `Context group ${t.from_ord ?? t.from} ${name(child)} falls below 2% of uses after ${t.year}.`
        : `Context group ${t.to_ord ?? t.to} ${name(child)} emerges ${t.year}.`);
  const lines = [first];
  if (!/Run #\d/.test(first)) {
    const meta = [Number.isInteger(clusters?.run) ? `Run #${clusters.run}` : null, Number.isInteger(clusters?.k) ? `k=${clusters.k}` : null,
      Number.isFinite(child?.stability) ? `stability ${child.stability}` : null, clusters?.representation ? `representation ${clusters.representation}` : null].filter(Boolean);
    if (meta.length) lines.push(`${meta.join(', ')}.`);
  }
  const caveat = t.kind === 'split' ? SPLIT_CAVEAT : t.kind === 'merge' ? MERGE_CAVEAT : CONTEXT_CAVEAT;
  if (!lines.join(' ').includes('not a claim about speakers')) lines.push(caveat);
  return lines;
}

/**
 * Transition primitives between context-group lanes (§1.8, layer 'arcs', lane coordinates): ⑂ split and ⑃ merge
 * as 1.5 px dashed S-curves from the parent group's strand into the child's lane at the transition's year, an
 * emergence or a fading as a dashed tick in the group's own lane. Transitions whose lanes are not shown draw
 * nothing; 'unknown_gap' draws nothing (the lane's hatch already says "no sources").
 * @param {{run?: number, k?: number, representation?: string, transitions?: object[], clusters?: object[]}|null} clusters
 * @param {{layout: object, X: (day: number) => number, vantage?: {day: number, strict: boolean}|null, lanes?: object[]}} opts
 *   `lanes` = the model's lanes (keys and ords); defaults to the layout's keys
 * @returns {object[]}
 */
export function buildTransitions(clusters, { layout, X, vantage = null, lanes = null }) {
  const out = [];
  const modelLanes = lanes ?? layout.lanes;
  const vYear = vantage ? yearOf(vantage.day) : Infinity;
  for (const [i, t] of (clusters?.transitions ?? []).entries()) {
    if (!Number.isInteger(t.year) || !['split', 'merge', 'emerge', 'vanish'].includes(t.kind)) continue;
    if (t.year > vYear && vantage?.strict) continue;
    const ghost = t.year > vYear;
    const x = X(midYearDay(t.year));
    const tip = transitionTip(t, clusters);
    const ref = { type: 'transition', kind: t.kind, run: clusters?.run ?? null };
    if (t.kind === 'split' || t.kind === 'merge') {
      const a = laneOfGroup(layout.lanes, modelLanes, t.from ?? null, t.from_ord ?? null);
      const b = laneOfGroup(layout.lanes, modelLanes, t.to ?? null, t.to_ord ?? null);
      if (!a || !b) continue;
      const y0 = a.slots[0]?.mid ?? a.y + a.h / 2, y1 = b.slots[0]?.mid ?? b.y + b.h / 2;
      const points = [[x - 28, y0], [x - 6, y0], [x - 22, y1], [x, y1]];
      out.push({ id: `split:${i}:${t.from}>${t.to}`, kind: 'path', layer: 'arcs', style: 'split-curve', points, x0: x - 28, x1: x + 14, y0: Math.min(y0, y1) - 6, y1: Math.max(y0, y1) + 6,
        openable: false, ref, tip, ghost });
      out.push({ id: `split:${i}:g`, kind: 'text', layer: 'arcs', style: 'split-glyph', text: t.kind === 'split' ? '⑂' : '⑃', x0: x + 3, y0: y1 - 5, x1: x + 3, y1: y1 - 5,
        openable: false, ref: null, ghost });
      continue;
    }
    const lane = laneOfGroup(layout.lanes, modelLanes, t.kind === 'vanish' ? t.from ?? null : t.to ?? null, t.kind === 'vanish' ? t.from_ord ?? null : t.to_ord ?? null);
    if (!lane) continue;
    const slot = lane.slots[0] ?? { y: lane.y, h: lane.h, mid: lane.y + lane.h / 2 };
    out.push({ id: `trans:${i}:${t.kind}`, kind: 'path', layer: 'arcs', style: t.kind === 'emerge' ? 'transition-emerge' : 'transition-vanish',
      points: [[x, slot.y - 2], [x, slot.y + slot.h + 2]], x0: x - 4, x1: x + 4, y0: slot.y - 4, y1: slot.y + slot.h + 4, openable: false, ref, tip, ghost });
  }
  return out;
}

/**
 * The lane-header lines of a context-group lane: the label shown, and what to print beside it.
 * @param {{label: string, machineLabel?: string|null, humanLabel?: string|null, residual?: boolean}} lane
 * @returns {{title: string, machine: string|null, human: boolean}}
 */
export function clusterHeader(lane) {
  if (lane.residual) return { title: lane.label || 'residual', machine: null, human: false };
  const machine = lane.machineLabel ?? null;
  return { title: lane.humanLabel ?? (machine ? `machine label: ${machine}` : lane.label), machine: lane.humanLabel && machine ? `machine label: ${machine}` : null, human: Boolean(lane.humanLabel) };
}

/** Why a context-group lane set needs a run (shown under the server's own note). */
export const RUN_EXPLAINER = 'A clustering run groups the uses of this expression by their context words: computed hypotheses about contexts, with editable machine labels — not senses the writers declared.';

/**
 * The card of a cluster-facet query without lanes (C1): not run → the run to start (the server's `suggestion.run`)
 * and its job's progress; gated → the gate card (gate, needed, have, suggestion — never a value).
 * @param {{kind: 'not_run'|'gated', run?: object|null, gate?: object|null, note?: string|null}} st clusterLaneState()
 * @param {{label: string, job?: object|null, started?: boolean, error?: string|null, onRun: () => void, onBack: () => void}} opts
 * @returns {HTMLElement}
 */
export function renderClusterCard(st, { label, job = null, started = false, error = null, onRun, onBack }) {
  const failed = ['failed', 'cancelled', 'interrupted'].includes(job?.status);
  const running = started && !error && !failed;
  const back = h('button.btn', { type: 'button', onClick: onBack }, 'Lanes by language');
  const runBtn = st.run ? h('button.btn.btn-primary', { type: 'button', disabled: running, onClick: onRun }, running ? 'Clustering…' : failed ? 'Run clustering again' : 'Run clustering') : null;
  const progress = started ? h('p.state-hint.cluster-progress', { role: 'status' }, error ? `Could not start: ${error}` : clusterJobLine(job)) : null;
  if (st.kind === 'gated') {
    return h('div.cluster-card', null, renderGateCard(st.gate ?? { gate: 'not_run' }, { title: `No context groups for '${label}'`,
      extra: h('p.meta', null, 'A gated clustering has no groups and no shares: nothing is estimated without the evidence.') }),
    h('div.state-actions', null, runBtn, back), progress);
  }
  return h('div.cluster-card', null,
    h('p.state-title', null, `Context groups of '${label}' need a clustering run`),
    st.note ? h('p.state-hint', null, st.note) : null,
    h('p.state-hint', null, RUN_EXPLAINER),
    h('div.state-actions', null, runBtn, back), progress);
}

/** "4 context groups and a residual · run #24" for announcements. */
export function clusterLanesLine(query) {
  const lanes = (query?.lanes ?? []).map((l) => parseClusterLaneKey(l.key)).filter(Boolean);
  if (!lanes.length) return '';
  const groups = lanes.filter((k) => !k.residual).length;
  return `${formatCount(groups)} context ${groups === 1 ? 'group' : 'groups'}${lanes.some((k) => k.residual) ? ' and a residual' : ''} · run #${lanes[0].run}`;
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
