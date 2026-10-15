// OWNER: WP7
// panels/edge-card.mjs — the relationship (edge) card and its review actions (SPEC §2.C edge card, §2.F,
// D7, §8.7, §13 rules 5–6). Type and direction; evidence status in words with its badge (DOC, DOC* "source
// not recorded", CALC, PROP, PROP · CUE); origin; method or annotator; run id; score with its kind ("not a
// probability"); the external locator labelled external; supporting spans side by side with an aligned diff;
// the quoted cue; revision history; Confirm / Reject / Dispute / Attach evidence, each with a note of at least
// 10 characters; and the fixed caution sentence. A review changes only the review layer: the evidence status
// and the line pattern never change.

import { h, clear } from '../core/dom.mjs';
import { edgeStyle, BADGES } from '../../shared/evidence-style.mjs';
import { formatNumber } from '../../shared/format.mjs';
import { EVIDENCE_ROLES, REL_TYPE_BY_CODE, SCORE_KIND_LABELS } from '../../shared/vocab.mjs';
import { renderErrorCard, renderLoadingLine } from './gate-card.mjs';
import { synBadge } from './passage-card.mjs';

export const CAUTION = 'Shared wording or similar contexts can come from a common source; they do not establish influence or intent.';
export const MIN_NOTE = 10;
export const REVIEW_ACTIONS = Object.freeze([
  Object.freeze({ action: 'confirm', label: 'Confirm', past: 'confirmed' }),
  Object.freeze({ action: 'reject', label: 'Reject', past: 'rejected' }),
  Object.freeze({ action: 'dispute', label: 'Dispute', past: 'disputed' }),
]);
/** Roles a person may attach (an external record comes only from a source dataset). */
export const ATTACH_ROLES = Object.freeze(EVIDENCE_ROLES.filter((r) => r !== 'external_record'));
const OVERLAY_GLYPH = { check: '✓', cross: '✕', scales: '⚖' };

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** 'Felmark Bulletin, June 1963 (1963)' or the ref. */
export function endpointLabel(end) {
  if (!isObj(end)) return '—';
  const name = typeof end.doc === 'string' ? end.doc : end.title ?? end.ref ?? '—';
  return Number.isInteger(end.y) ? `${name} (${end.y})` : name;
}

/** Who or what created the link, in words. */
export function originText(rel) {
  const who = String(rel.created_by ?? '').replace(/^human:/, '');
  switch (rel.origin) {
    case 'source_dataset': return `stated by a source dataset: ${rel.source_dataset ?? 'unnamed'}`;
    case 'algorithm': return `computed by an algorithm${Number.isInteger(rel.run_id) ? ` (run ${rel.run_id})` : ''}`;
    case 'machine_tagger': return `proposed by a machine tagger${rel.method ? ` (${rel.method})` : ''}`;
    case 'human': return `proposed by a person: ${who || 'unnamed'}`;
    default: return String(rel.origin ?? 'unknown origin');
  }
}

/**
 * The run of a computed link with its parameters: "run 5 · reuse-index@1.0.0 · k 8 · w 6 …".
 * @param {{run_id?: number|null, run?: {id: number, stage?: string, pipeline_version?: string, params?: object}|null}} rel
 * @returns {string|null}
 */
export function runText(rel) {
  const r = isObj(rel.run) ? rel.run : null;
  const id = r?.id ?? rel.run_id;
  if (!Number.isInteger(id)) return null;
  const params = isObj(r?.params) ? Object.entries(r.params).map(([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '';
  return [`run ${id}`, r?.pipeline_version ?? r?.stage ?? null, params || null, r?.status && r.status !== 'succeeded' ? r.status : null].filter(Boolean).join(' · ');
}

/**
 * Validate a review or evidence note (§2.C: each action needs a note ≥ 10 characters).
 * @param {string} note
 * @returns {string|null} the problem, or null
 */
export function noteProblem(note) {
  const n = String(note ?? '').trim().length;
  return n >= MIN_NOTE ? null : `A note needs at least ${MIN_NOTE} characters (${n} so far).`;
}

/**
 * Token alignment of two spans (LCS over case-folded words): shared tokens, substitutions, insertions and
 * deletions, in reading order.
 * @param {string} a source span
 * @param {string} b target span
 * @returns {Array<{op: 'same'|'sub'|'ins'|'del', a: string|null, b: string|null}>}
 */
export function alignTokens(a, b) {
  const A = String(a ?? '').split(/\s+/).filter(Boolean);
  const B = String(b ?? '').split(/\s+/).filter(Boolean);
  const fold = (t) => t.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = fold(A[i]) === fold(B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && fold(A[i]) === fold(B[j])) { ops.push({ op: 'same', a: A[i], b: B[j] }); i++; j++; }
    else if (i < n && j < m && L[i + 1][j + 1] === L[i][j]) { ops.push({ op: 'sub', a: A[i], b: B[j] }); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { ops.push({ op: 'ins', a: null, b: B[j] }); j++; }
    else { ops.push({ op: 'del', a: A[i], b: null }); i++; }
  }
  return ops;
}

/**
 * The model of an edge card (strings only).
 * @param {object} rel GET /api/relationships/:id
 */
export function edgeCardModel(rel) {
  const type = REL_TYPE_BY_CODE[rel.rel_type] ?? null;
  const cueRow = (rel.evidence ?? []).find((e) => e.role === 'citation_cue');
  const cue = rel.cue?.quote ?? cueRow?.quote ?? null;
  const style = edgeStyle({
    evidence_status: rel.evidence_status, review_status: rel.review_status ?? 'unreviewed',
    provenance_quality: rel.provenance_quality ?? 'complete', family: rel.family, cue: Boolean(cue),
    is_synthetic: rel.synthetic, date_conflict: rel.date_conflict, origin: rel.origin,
  });
  const badgeKey = style.badge.replace(' ⚠', '');
  const spans = (role) => (rel.evidence ?? []).filter((e) => e.role === role && e.quote);
  const source = spans('source_span')[0] ?? null;
  const target = spans('target_span')[0] ?? null;
  const locator = rel.source_locator ?? null;
  return {
    id: rel.id,
    glyph: rel.glyph ?? type?.glyph ?? '',
    typeLabel: rel.label ?? type?.label ?? String(rel.rel_type),
    typeDescription: type?.description ?? '',
    heading: `${endpointLabel(rel.src)} ${rel.label ?? type?.label ?? rel.rel_type} ${endpointLabel(rel.dst)}`,
    directed: rel.directed !== false,
    status: rel.evidence_status,
    statusWords: typeof rel.status_words === 'string' ? rel.status_words : null,
    badge: style.badge,
    badgeTitle: BADGES[badgeKey]?.title ?? rel.evidence_status,
    badgeDescription: BADGES[badgeKey]?.description ?? '',
    style,
    origin: originText(rel),
    method: rel.method ?? null,
    run: runText(rel),
    score: isObj(rel.score) && Number.isFinite(rel.score.value)
      ? `${formatNumber(rel.score.value)} — ${typeof rel.score_label === 'string' ? rel.score_label : SCORE_KIND_LABELS[rel.score.kind] ?? `${rel.score.kind} — not a probability`}`
      : null,
    locator: locator ? { text: locator, external: rel.locator_external === true || /^https?:\/\//.test(locator) } : null,
    provenanceNote: typeof rel.provenance_note === 'string' ? rel.provenance_note : null,
    sourceUnrecorded: rel.provenance_quality === 'source_unrecorded',
    source, target,
    alignment: source && target ? alignTokens(source.quote, target.quote) : null,
    otherEvidence: (rel.evidence ?? []).filter((e) => e !== source && e !== target && e.role !== 'citation_cue'),
    cue,
    review: rel.review_status ?? 'unreviewed',
    reviewGlyph: OVERLAY_GLYPH[style.overlay] ?? null,
    revisions: (rel.revisions ?? []).map((r) => [`rev ${r.rev}`, r.action, String(r.actor ?? '').replace(/^human:/, ''),
      r.at ? String(r.at).slice(0, 10) : null].filter(Boolean).join(' · ') + (r.reason ? ` — ${r.reason}` : '')),
    group: Number.isInteger(rel.hypothesis_group) ? rel.hypothesis_group : null,
    dateConflict: rel.date_conflict === true,
    license: rel.license ?? null,
    attribution: rel.attribution ?? null,
    caution: rel.caution ?? CAUTION,
    synthetic: rel.synthetic === true,
  };
}

/**
 * A small sample of the edge's line: pattern, width and endpoint from evidence-style (never colour alone).
 * @param {ReturnType<typeof edgeStyle>} style
 * @returns {SVGElement}
 */
export function lineSample(style) {
  const end = style.endpoint === 'dot' ? h('svg:circle', { cx: '52', cy: '6', r: '3.5', class: 'ev-end' })
    : style.endpoint === 'square' ? h('svg:rect', { x: '48.5', y: '2.5', width: '7', height: '7', class: 'ev-end hollow' })
      : h('svg:text', { x: '49', y: '10', class: 'ev-end-q' }, '?');
  return h('svg', { class: `ev-sample role-${style.hue}`, width: '60', height: '12', viewBox: '0 0 60 12', 'aria-hidden': 'true' },
    h('svg:line', { x1: '2', y1: '6', x2: '46', y2: '6', 'stroke-width': String(style.width), 'stroke-dasharray': style.dash.length ? style.dash.join(' ') : null,
      opacity: String(style.opacity) }), end);
}

/** Review overlay words (§8.7): the overlay glyph plus its word, never the glyph alone. */
export const REVIEW_WORDS = Object.freeze({ check: '✓ confirmed', cross: '✕ rejected', scales: '⚖ disputed' });

/**
 * Words and style of a link as the graph, list and inspector rows show it: type glyph and label (from the
 * server's row when it sends them, else the vocabulary), the evidence badge, the status word and the review
 * overlay. The line pattern comes only from the evidence status; review never changes it.
 * @param {{rel_type: string, evidence_status: string, review_status?: string, provenance_quality?: string, family?: string,
 *          cue?: boolean, synthetic?: boolean, date_conflict?: boolean, origin?: string, created_by?: string,
 *          glyph?: string, label?: string}} e
 */
export function linkWords(e) {
  const t = REL_TYPE_BY_CODE[e.rel_type];
  const style = edgeStyle({ evidence_status: e.evidence_status, review_status: e.review_status ?? 'unreviewed',
    provenance_quality: e.provenance_quality ?? 'complete', family: e.family ?? t?.family, cue: Boolean(e.cue),
    is_synthetic: e.synthetic, date_conflict: e.date_conflict,
    origin: String(e.created_by ?? '').startsWith('human:') ? 'human' : e.origin });
  const overlay = { check: ' ✓', cross: ' ✕', scales: ' ⚖' }[style.overlay] ?? '';
  return {
    glyph: e.glyph ?? t?.glyph ?? '',
    short: t?.short ?? e.label ?? e.rel_type,
    label: e.label ?? t?.label ?? e.rel_type,
    badge: style.badge,
    status: e.evidence_status,
    overlay,
    review: REVIEW_WORDS[style.overlay] ?? null,
    style,
  };
}

/**
 * One link as a readable line: the line sample (pattern + endpoint), the type glyph and label, the other end's
 * title and year, then the evidence badge and its word, and the review overlay in words. A button when
 * `onOpen` is given (opens the link card); every part is text, so it reads without colour or hover.
 * @param {object} e a lineage edge (or any object linkWords() accepts)
 * @param {{other?: {title?: string, label?: string, y?: number|null, id?: string}|null, direction?: 'earlier'|'later'|null,
 *          onOpen?: Function|null, pressed?: boolean|null}} [opts]
 * @returns {HTMLElement}
 */
export function renderLinkLine(e, { other = null, direction = null, onOpen = null, pressed = null } = {}) {
  const w = linkWords(e);
  const name = other ? (other.title ?? other.label ?? other.id ?? '—') : null;
  const year = other && Number.isInteger(other.y) ? ` (${other.y})` : other?.undated ? ' (undated)' : '';
  const verb = direction === 'later' ? `${w.label} this` : w.label;
  const parts = [
    lineSample(w.style),
    h('span.link-glyph', { 'aria-hidden': 'true' }, w.glyph),
    h('span.link-type', null, direction === 'later' ? `${name ?? '—'}${year} ${verb}` : `${verb} ${name ?? '—'}${year}`),
    h('span.link-ev', null, h('span.badge', null, w.badge), ` ${w.status}`),
    w.review ? h('span.link-review', null, w.review) : null,
    e.date_conflict ? h('span.link-conflict', null, '⚠ date conflict') : null,
  ];
  const props = { dataset: { rel: String(e.rel_id ?? ''), status: w.status }, class: `role-${w.style.hue}` };
  return onOpen
    ? h('button.link-line', { ...props, type: 'button', 'aria-pressed': pressed === null ? null : String(pressed), onClick: () => onOpen(e) }, parts)
    : h('span.link-line', props, parts);
}

function renderAlignment(m) {
  if (!m.alignment) return null;
  return h('section.edge-spans', { 'aria-label': 'Supporting spans' },
    h('h4.section-title', null, 'Supporting spans'),
    h('div.edge-span-cols', null,
      h('blockquote.edge-span', { dataset: { role: 'source' } }, h('span.meta', null, `later (passage ${m.source.passage ?? '—'}) `),
        m.alignment.filter((o) => o.a !== null).map((o) => h('span', { class: `tok tok-${o.op}` }, o.a, ' '))),
      h('blockquote.edge-span', { dataset: { role: 'target' } }, h('span.meta', null, `earlier (passage ${m.target.passage ?? '—'}) `),
        m.alignment.filter((o) => o.b !== null).map((o) => h('span', { class: `tok tok-${o.op}` }, o.b, ' ')))),
    h('p.meta', null, 'Shared words plain; substitutions underlined; insertions and omissions dotted.'));
}

/**
 * Render a loaded card. Review controls appear when `onReview` is given.
 * @param {ReturnType<typeof edgeCardModel>} m
 * @param {{onReview?: Function, onAttach?: Function, onOpenPassage?: (id: number) => void, controls?: Node|null}} [opts]
 */
export function renderEdgeCard(m, { onOpenPassage = null, controls = null } = {}) {
  const row = (label, value) => (value ? h('div.edge-row', null, h('dt', null, label), h('dd', null, value)) : null);
  const ev = (e) => h('li', null, `${e.role.replace(/_/g, ' ')}: `, e.quote ? h('q', null, e.quote) : 'no quote',
    Number.isInteger(e.passage) && onOpenPassage ? h('button.btn.btn-link', { type: 'button', onClick: () => onOpenPassage(e.passage) }, ` passage ${e.passage}`) : null);
  return h('article.edge-card', { class: { 'syn-frame': m.synthetic }, dataset: { status: m.status, review: m.review } },
    h('header.edge-head', null,
      lineSample(m.style),
      h('span.edge-glyph', { 'aria-hidden': 'true' }, m.glyph),
      h('span.badge.edge-badge', { title: m.badgeTitle }, m.badge),
      m.reviewGlyph ? h('span.edge-review-glyph', { title: m.review }, m.reviewGlyph) : null,
      m.synthetic ? synBadge() : null),
    h('h3.edge-heading', null, m.heading),
    m.typeDescription ? h('p.meta', null, m.typeDescription) : null,
    h('dl.edge-rows', null,
      row('Evidence', `${m.statusWords ?? m.status}${m.sourceUnrecorded ? ' — source not recorded (DOC*)' : ''}${m.statusWords ? '' : ` · ${m.badgeDescription}`}`),
      row('Origin', m.origin),
      row('Method', m.method),
      row('Run', m.run),
      row('Score', m.score),
      row('Review', `${m.review}${m.reviewGlyph ? ` ${m.reviewGlyph}` : ''} — a person's review; the evidence status never changes`),
      row('Hypothesis group', m.group !== null ? `#${m.group}` : null),
      row('Note', m.provenanceNote),
      row('Licence', m.license),
      row('Attribution', m.attribution),
      m.locator ? h('div.edge-row', null, h('dt', null, 'Locator'), h('dd', null,
        m.locator.external
          ? h('a', { href: m.locator.text, target: '_blank', rel: 'noopener noreferrer external' }, m.locator.text, ' (external, opens a new tab)')
          : m.locator.text)) : null),
    m.dateConflict ? h('p.edge-conflict', { role: 'note' }, '⚠ date conflict: the later item is dated before its source; never drawn as feedback.') : null,
    m.cue ? h('p.edge-cue', null, h('span.badge', null, 'CUE'), ' attribution cue in the text: ', h('q', null, m.cue), ' — its referent is inferred, not observed.') : null,
    renderAlignment(m),
    m.otherEvidence.length ? h('section', null, h('h4.section-title', null, 'Evidence'), h('ul.edge-evidence', { role: 'list' }, m.otherEvidence.map(ev))) : null,
    m.revisions.length ? h('section', null, h('h4.section-title', null, 'Revisions'), h('ol.edge-revisions', null, m.revisions.map((r) => h('li', null, r)))) : null,
    controls,
    h('p.edge-caution', { role: 'note' }, m.caution));
}

/**
 * A live edge card: loads GET /api/relationships/:id and offers the review actions and "Attach evidence".
 * @param {{api: object, relId: number, announce?: Function, onOpenPassage?: (id: number) => void, onChanged?: (review: object) => void}} opts
 * @returns {{el: HTMLElement, ready: Promise<void>, reload(): Promise<void>}}
 */
export function createEdgeCard({ api, relId, announce = () => {}, onOpenPassage = null, onChanged = null }) {
  const el = h('div.edge-card-host', { dataset: { rel: String(relId) } });
  const form = { mode: null, error: null, busy: false, done: null };

  // The form stays the same DOM while it is open (a typed note is never thrown away); only its status line
  // and the submit button change while a request runs.
  function controls() {
    const statusLine = () => h('div.edge-form-status', { role: 'status' },
      form.error ? renderErrorCard(form.error) : null,
      form.done ? h('p.edge-done', null, form.done) : null);
    if (form.mode === null) {
      return h('div.edge-actions', null,
        REVIEW_ACTIONS.map((a) => h('button.btn', { type: 'button', dataset: { action: a.action }, onClick: () => { form.mode = a.action; form.error = null; form.done = null; paint(); } }, a.label)),
        h('button.btn', { type: 'button', dataset: { action: 'attach' }, onClick: () => { form.mode = 'attach'; form.error = null; form.done = null; paint(); } }, 'Attach evidence'),
        statusLine());
    }
    const note = h('textarea.edge-note', { rows: '3', 'aria-label': 'Note (at least 10 characters)', placeholder: 'Say what you checked (at least 10 characters).' });
    const counter = h('span.meta.num', { 'aria-live': 'polite' }, `0 / ${MIN_NOTE}`);
    note.addEventListener('input', () => { counter.textContent = `${note.value.trim().length} / ${MIN_NOTE}`; });
    const fields = {};
    const attachFields = form.mode === 'attach' ? h('div.edge-attach', null,
      h('label', null, 'Passage ', fields.passage = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'Passage id' })),
      h('label', null, 'Start ', fields.start = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'Start offset' })),
      h('label', null, 'End ', fields.end = h('input', { type: 'number', inputmode: 'numeric', 'aria-label': 'End offset' })),
      h('label', null, 'Role ', fields.role = h('select', { 'aria-label': 'Evidence role' }, ATTACH_ROLES.map((r) => h('option', { value: r }, r.replace(/_/g, ' '))))),
      h('p.meta', null, 'Start and end are characters (UTF-16) into that passage’s text.'))
      : null;
    const status = statusLine();
    const showError = (err) => { form.error = err; clear(status).appendChild(renderErrorCard(err)); };
    const submitBtn = h('button.btn.btn-primary', { type: 'button', onClick: () => submit() }, 'Submit');
    async function submit() {
      const problem = noteProblem(note.value);
      if (problem) { showError({ message: problem }); return; }
      form.busy = true; form.error = null; clear(status);
      submitBtn.disabled = true; submitBtn.textContent = 'Saving…';
      try {
        if (form.mode === 'attach') {
          const body = { passage: Number.parseInt(fields.passage.value, 10), start: Number.parseInt(fields.start.value, 10),
            end: Number.parseInt(fields.end.value, 10), role: fields.role.value || ATTACH_ROLES[0], note: note.value.trim(), relative: true };
          if (![body.passage, body.start, body.end].every(Number.isInteger) || body.start >= body.end) {
            throw Object.assign(new Error('Give a passage id and a start offset before the end offset.'), { local: true });
          }
          const res = await api.post(`/relationships/${relId}/evidence`, body, { key: `edge-evidence-${relId}` });
          form.done = `Evidence #${res?.id ?? '—'} attached; the evidence status is unchanged.`;
        } else {
          const res = await api.post(`/relationships/${relId}/review`, { action: form.mode, note: note.value.trim() }, { key: `edge-review-${relId}` });
          form.done = `Review recorded (revision ${res?.revision ?? '—'}): review status ${res?.review_status ?? '—'}; the evidence status is unchanged.`;
          onChanged?.(res);
        }
        announce(form.done);
        form.mode = null;
        await load();
      } catch (err) {
        if (err?.name === 'AbortError') return;
        showError(err);
      } finally {
        form.busy = false;
        submitBtn.disabled = false; submitBtn.textContent = 'Submit';
      }
    }
    return h('div.edge-form', { role: 'group', 'aria-label': form.mode === 'attach' ? 'Attach evidence' : `Review: ${form.mode}` },
      h('p', null, form.mode === 'attach' ? 'Attach a span of text as evidence.' : `${REVIEW_ACTIONS.find((a) => a.action === form.mode)?.label} this link. Your note is kept as an annotation; the evidence status never changes.`),
      attachFields, note, counter,
      h('div.edge-actions', null,
        submitBtn,
        h('button.btn', { type: 'button', onClick: () => { form.mode = null; form.error = null; paint(); } }, 'Cancel')),
      status);
  }

  let rel = null;
  function paint() {
    clear(el);
    if (!rel) return;
    el.appendChild(renderEdgeCard(edgeCardModel(rel), { onOpenPassage, controls: controls() }));
  }

  async function load() {
    try {
      rel = await api.get(`/relationships/${relId}`, null, { key: `edge-${relId}` });
      paint();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      clear(el).appendChild(renderErrorCard(err, { what: `Relationship ${relId} could not be loaded.`, onRetry: load }));
    }
  }

  el.appendChild(renderLoadingLine(`Loading relationship ${relId}…`));
  const ready = load();
  return { el, ready, reload: load };
}

/**
 * Library module (Lineage and Genealogy embed edge cards): nothing to mount on its own.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  return { unmount() {} };
}
