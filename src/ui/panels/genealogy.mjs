// OWNER: WP7
// panels/genealogy.mjs — Genealogy, the sampling family tree (SPEC §2.C2, D16): works as marks on a linear time
// scale, one row per work, grouped by generation from the seed (0 = seed, +1 = works that sample, cover,
// interpolate, remix or version it, −1 = what it took from), sorted by date inside a generation. Each work is a
// 6 px diamond at its date (a bracketed span when it spans years); the row label is "title — maker (year ·
// precision)"; a density strip on top counts works per decade per generation. Elbow connectors run from the
// parent row to the child row at the child's date, with the type glyph, the evidence pattern and a ⚠ for a date
// conflict (never drawn as feedback). Every link keeps its locator. Defaults: the five sampling types, documented
// only, depth ≤ 3, ≤ 150 rows, paged. The honesty note travels with every view: absence of a link is not evidence
// of no sampling. A maker seed (`maker:<name>`) opens all of that maker's works.

import { h, clear } from '../core/dom.mjs';
import { edgeStyle } from '../../shared/evidence-style.mjs';
import { formatCount } from '../../shared/format.mjs';
import { EVIDENCE_STATUS, REL_TYPE_BY_CODE } from '../../shared/vocab.mjs';
import { createEdgeCard, lineSample, renderLinkLine } from './edge-card.mjs';
import { renderEmptyCard, renderErrorCard, renderLoadingLine } from './gate-card.mjs';
import { cardYears, selectPassage } from './inspector.mjs';
import { niceTicks } from './lineage.mjs';
import { synBadge } from './passage-card.mjs';

export const DEFAULT_TYPES = Object.freeze(['samples', 'interpolates', 'cover_of', 'remix_of', 'version_of']);
export const DEFAULT_DEPTH = 3;
export const MAX_ROWS = 150;
export const HONESTY_NOTE = 'Absence of a link is not evidence of no sampling.';
const W = 700;
const LABEL_W = 270;
const ROW_H = 24;
const HEAD_H = 22;

/**
 * GET /api/genealogy query for a seed work (`document:<id>`) or maker (`maker:<name>`).
 * @param {object} view
 * @param {{work: string, cursor?: string|null}} opts
 */
export function genealogyQuery(view, { work, cursor = null }) {
  const status = view.lineage?.status?.length ? view.lineage.status : ['documented'];
  const maker = /^maker:(.+)$/.exec(work ?? '')?.[1] ?? null;
  return {
    ...(maker ? { maker } : { work }), dir: 'both', depth: DEFAULT_DEPTH,
    types: (view.lineage?.types?.length ? view.lineage.types : DEFAULT_TYPES).join(','),
    max: MAX_ROWS,
    status: status.length === EVIDENCE_STATUS.length ? null : status.join(','),
    cursor,
  };
}

/** "title — maker (1988 · year)" */
export function rowLabel(row) {
  const date = row.date?.label ? ` (${row.date.label}${row.date.precision ? ` · ${row.date.precision}` : ''})` : ' (undated)';
  return `${row.title}${row.maker ? ` — ${row.maker}` : ''}${date}`;
}

/**
 * Rows in display order: generations ascending (−n … −1, then +1 … +n), date order inside each (undated last);
 * each with its year interval.
 * @param {object} data GET /api/genealogy
 * @returns {Array<{gen: number, row: object, years: {lo: number, hi: number}|null}>}
 */
export function orderedRows(data) {
  const out = [];
  const gens = [...(data.generations ?? [])].sort((a, b) => a.gen - b.gen);
  for (const g of gens) {
    const rows = (g.rows ?? []).map((row) => ({ gen: g.gen, row,
      years: row.undated ? null : cardYears({ label: row.date?.label, lo_year: row.date?.lo_year, hi_year: row.date?.hi_year }) }));
    rows.sort((a, b) => (a.years?.lo ?? Infinity) - (b.years?.lo ?? Infinity));
    out.push(...rows);
  }
  return out;
}

/**
 * "+n more" per generation (§2.C2: "+214 more samplers — 1990s: 88"): the hidden count and the decade with the
 * most works.
 * @param {{gen: number, total: number, returned: number, by_decade?: Record<string, number>}} g
 * @returns {string|null}
 */
export function moreText(g) {
  const hidden = (g.total ?? 0) - (g.returned ?? 0);
  if (hidden <= 0) return null;
  const top = Object.entries(g.by_decade ?? {}).sort((a, b) => b[1] - a[1])[0];
  const who = g.gen > 0 ? 'later works' : 'earlier works';
  return `+${formatCount(hidden)} more ${who}${top ? ` — ${top[0]}s: ${formatCount(top[1])}` : ''}`;
}

/**
 * The density strip: decades (shared across generations) and per-generation counts, from `by_decade` (which
 * counts every work of the generation, listed or not).
 * @param {object} data
 * @returns {{decades: number[], rows: Array<{gen: number, total: number, counts: number[]}>, max: number}}
 */
export function densityStrip(data) {
  const gens = [...(data.generations ?? [])].filter((g) => Object.keys(g.by_decade ?? {}).length).sort((a, b) => a.gen - b.gen);
  const decades = [...new Set(gens.flatMap((g) => Object.keys(g.by_decade).map(Number)))].sort((a, b) => a - b);
  const rows = gens.map((g) => ({ gen: g.gen, total: g.total ?? 0, counts: decades.map((d) => g.by_decade[String(d)] ?? 0) }));
  return { decades, rows, max: Math.max(0, ...rows.flatMap((r) => r.counts)) };
}

/**
 * The parent of a row's link: the seed for ±1, else the row whose work the link's `parent` names.
 * @param {{gen: number, row: object}} r
 * @param {Map<number, object>} byDoc display rows keyed by document id
 */
function parentOf(r, byDoc) {
  const e = r.row.edges?.[0];
  if (Math.abs(r.gen) === 1) return 'seed';
  return Number.isInteger(e?.parent) ? byDoc.get(e.parent) ?? null : null;
}

/**
 * Mount Genealogy into #panel. The seed is view.lineage.root when it names a document (or a maker).
 * @param {HTMLElement} el
 * @param {{store: object, api: object, keys?: object, announce?: Function}} ctx
 * @returns {{unmount(): void}}
 */
export function mount(el, ctx) {
  const { store, api } = ctx;
  const announce = ctx.announce ?? (() => {});
  const local = { data: null, error: null, loading: false, seq: 0, lastKey: null, detail: null };
  const root = h('div.genealogy', { hidden: true });
  el.appendChild(root);
  const view = () => store.get().view;
  const isOpen = () => view().panels.right === 'genealogy';
  const seed = () => (/^(document:\d+|maker:.+)$/.test(view().lineage.root ?? '') ? view().lineage.root : null);

  async function load({ force = false, cursor = null } = {}) {
    if (!isOpen() || !seed()) { render(); return; }
    const q = genealogyQuery(view(), { work: seed(), cursor });
    const key = JSON.stringify(q);
    if (!force && !cursor && key === local.lastKey && (local.data || local.loading)) { render(); return; }
    if (!cursor) local.lastKey = key;
    const seq = ++local.seq;
    local.loading = true; local.error = null;
    render();
    try {
      const data = await api.get('/genealogy', q, { key: 'genealogy' });
      if (seq !== local.seq) return;
      if (cursor && local.data) {
        const byGen = new Map(local.data.generations.map((g) => [g.gen, g]));
        for (const g of data.generations ?? []) {
          const have = byGen.get(g.gen);
          if (have) { have.rows = [...have.rows, ...g.rows]; have.returned += g.returned; } else local.data.generations.push(g);
        }
        local.data.truncated = data.truncated;
      } else local.data = data;
      local.loading = false;
      render();
      announce(`Genealogy of ${data.seed?.title ?? seed()}: ${orderedRows(local.data).length} works`);
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== local.seq) return;
      local.error = err; local.loading = false; local.lastKey = null;
      render();
    }
  }

  function openEdge(relId) {
    local.detail = createEdgeCard({ api, relId, announce, onOpenPassage: (id) => selectPassage(store, { passage: id }) });
    render();
    root.querySelector('.lin-detail')?.scrollIntoView?.({ block: 'nearest' });
  }

  function renderDensity(data) {
    const d = densityStrip(data);
    if (!d.decades.length) return null;
    const cell = Math.max(14, Math.min(40, Math.floor((W - 60) / d.decades.length)));
    const height = 14 + d.rows.length * 20;
    return h('figure.gen-density', null,
      h('figcaption.meta', null, 'Works per decade per generation (all of them, listed or not)'),
      h('svg', { class: 'gen-density-svg', width: String(60 + cell * d.decades.length), height: String(height + 14), role: 'img',
        'aria-label': d.rows.map((r) => `generation ${r.gen > 0 ? '+' : ''}${r.gen}: ${d.decades.map((dec, i) => (r.counts[i] ? `${dec}s ${r.counts[i]}` : null)).filter(Boolean).join(', ')}`).join('; ') },
      d.rows.map((r, j) => h('svg:g', null,
        h('svg:text', { x: '0', y: String(14 + j * 20 + 10), class: 'gen-density-gen' }, `${r.gen > 0 ? '+' : ''}${r.gen} · ${formatCount(r.total)}`),
        r.counts.map((n, i) => (n ? h('svg:rect', { x: String(60 + i * cell + 1), y: String(14 + j * 20 + 14 - Math.max(2, (14 * n) / d.max)),
          width: String(cell - 2), height: String(Math.max(2, (14 * n) / d.max)), class: 'gen-density-bar' }, h('svg:title', null, `${d.decades[i]}s: ${n}`)) : null)))),
      d.decades.map((dec, i) => (i % Math.ceil(d.decades.length / 8) === 0
        ? h('svg:text', { x: String(60 + i * cell), y: String(height + 12), class: 'gen-density-axis' }, `${dec}s`) : null))));
  }

  function renderChart(data) {
    const rows = orderedRows(data);
    const before = rows.filter((r) => r.gen < 0), after = rows.filter((r) => r.gen > 0);
    const seedYear = Number.isInteger(data.seed?.year) ? data.seed.year : null;
    const years = rows.flatMap((r) => (r.years ? [r.years.lo, r.years.hi] : []));
    if (seedYear !== null) years.push(seedYear);
    const lo = years.length ? Math.min(...years) : 0, hi = years.length ? Math.max(...years) : 1;
    const x0 = LABEL_W + 14, x1 = W - 14;
    const xOf = (y) => (hi === lo ? (x0 + x1) / 2 : x0 + ((y - lo) / (hi - lo)) * (x1 - x0));
    // Layout: generation headers, rows; −n … −1 above the seed, +1 … +n below.
    const items = [];
    let y = 8;
    const place = (list) => {
      let gen = null;
      for (const r of list) {
        if (r.gen !== gen) { gen = r.gen; y += HEAD_H; items.push({ head: gen, y: y - 6 }); }
        y += ROW_H;
        items.push({ r, y: y - ROW_H / 2 });
      }
    };
    place(before);
    y += ROW_H;
    const seedY = y - ROW_H / 2;
    place(after);
    const height = y + 34;
    const byDoc = new Map(items.filter((i) => i.r).map((i) => [i.r.row.doc, i]));
    const seedX = seedYear !== null ? xOf(seedYear) : x0;
    // An undated work has no place on the time axis: it sits in the gutter just left of it, drawn hollow.
    const xOfRow = (r) => (r.years ? xOf((r.years.lo + r.years.hi) / 2) : LABEL_W + 6);
    const diamond = (x, yy, s = 4) => `M ${x} ${yy - s} L ${x + s} ${yy} L ${x} ${yy + s} L ${x - s} ${yy} Z`;
    const ticks = years.length ? niceTicks(lo, hi) : [];
    const rowEls = items.filter((i) => i.r).map((i) => {
      const { r } = i;
      const e = r.row.edges?.[0];
      const t = e ? REL_TYPE_BY_CODE[e.rel_type] : null;
      const st = e ? edgeStyle({ evidence_status: e.evidence_status, review_status: e.review_status ?? 'unreviewed', family: t?.family,
        provenance_quality: e.provenance_quality ?? 'complete', date_conflict: e.date_conflict }) : null;
      const x = xOfRow(r);
      const parent = parentOf(r, byDoc);
      const px = parent === 'seed' ? seedX : parent ? xOfRow(parent.r) : null;
      const py = parent === 'seed' ? seedY : parent ? parent.y : null;
      const elbow = st && px !== null ? h('svg:path', { d: `M ${px} ${py} H ${x} V ${i.y}`, fill: 'none', class: `gen-elbow role-${st.hue}`,
        'stroke-dasharray': st.dash.length ? st.dash.join(' ') : null }) : null;
      const span = r.years && r.years.hi > r.years.lo
        ? h('svg:path', { d: `M ${xOf(r.years.lo)} ${i.y - 5} v 10 M ${xOf(r.years.lo)} ${i.y} H ${xOf(r.years.hi)} M ${xOf(r.years.hi)} ${i.y - 5} v 10`, class: 'gen-span' }) : null;
      return h('svg:g', { class: `gen-row${e?.date_conflict ? ' is-conflict' : ''}`, tabindex: '0', role: 'button', dataset: { doc: String(r.row.doc), gen: String(r.gen) },
        'aria-label': `${rowLabel(r.row)}, generation ${r.gen > 0 ? '+' : ''}${r.gen}${e ? `, ${t?.label ?? e.rel_type}, ${e.evidence_status}${e.date_conflict ? ', date conflict' : ''}` : ''}`,
        onClick: () => { if (e) openEdge(e.rel_id); },
        onKeyDown: (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && e) { ev.preventDefault(); openEdge(e.rel_id); } } },
      h('svg:rect', { x: '0', y: String(i.y - ROW_H / 2), width: String(W), height: String(ROW_H), class: 'gen-row-bg' }),
      elbow,
      h('svg:text', { x: '6', y: String(i.y + 4), class: 'gen-label' }, truncate(rowLabel(r.row), 40)),
      span,
      h('svg:path', { d: diamond(x, i.y), class: r.years ? 'gen-diamond' : 'gen-diamond is-undated' }),
      e ? h('svg:text', { x: String(x + 8), y: String(i.y + 4), class: `gen-edge-label role-${st.hue}` }, `${t?.glyph ?? ''} ${st.badge}`) : null);
    });
    return h('div.gen-chart', null, h('svg', { class: 'gen-svg', width: String(W), height: String(height), viewBox: `0 0 ${W} ${height}`, role: 'group',
      'aria-label': `Genealogy: ${rows.length} works on a linear time scale; earlier generations above the seed, later below` },
    h('svg:line', { x1: String(LABEL_W), y1: '0', x2: String(LABEL_W), y2: String(height - 30), class: 'lin-gutter-rule' }),
    ticks.map((tk) => h('svg:g', { class: 'lin-tick' },
      h('svg:line', { x1: String(xOf(tk)), y1: '4', x2: String(xOf(tk)), y2: String(height - 30), class: 'gen-grid' }),
      h('svg:text', { x: String(xOf(tk)), y: String(height - 12), 'text-anchor': 'middle' }, String(tk)))),
    items.filter((i) => i.head !== undefined).map((i) => h('svg:text', { x: '6', y: String(i.y), class: 'gen-head' },
      i.head > 0 ? `+${i.head} · ${i.head === 1 ? 'works that sample, cover, remix or version it' : `${i.head} steps later`}` : `${i.head} · ${i.head === -1 ? 'what it took from' : `${-i.head} steps earlier`}`)),
    rowEls,
    h('svg:g', { class: 'gen-row is-seed' },
      h('svg:rect', { x: '0', y: String(seedY - ROW_H / 2), width: String(W), height: String(ROW_H), class: 'gen-seed-bg' }),
      h('svg:text', { x: '6', y: String(seedY + 4), class: 'gen-label gen-seed-label' }, truncate(`seed · ${data.seed?.title ?? '—'}${data.seed?.maker ? ` — ${data.seed.maker}` : ''} (${data.seed?.year ?? 'undated'})`, 44)),
      h('svg:path', { d: diamond(seedX, seedY, 5), class: 'gen-diamond seed' }))));
  }

  function renderList(data) {
    const rows = orderedRows(data);
    const byDoc = new Map(rows.map((r) => [r.row.doc, r]));
    const seedNode = { title: data.seed?.title ?? 'the seed', y: data.seed?.year ?? null };
    // The other end of a row's link: the seed for ±1, else the row named by the link's parent.
    const otherOf = (r, e) => {
      if (Math.abs(r.gen) === 1) return seedNode;
      const p = byDoc.get(e.parent);
      return p ? { title: p.row.title, y: p.years?.lo ?? null } : { title: Number.isInteger(e.parent) ? `document ${e.parent}` : '—' };
    };
    return h('section.gen-links', { 'aria-label': 'Works and their links' },
      h('h4.section-title', null, 'Works and their links'),
      h('ul.gen-list', { role: 'list' }, rows.map((r) => h('li.gen-item', null,
        h('p.gen-item-head', null, h('span.gen-gen', null, `${r.gen > 0 ? '+' : ''}${r.gen}`), ` ${rowLabel(r.row)}`, r.row.synthetic ? synBadge() : null),
        (r.row.edges ?? []).map((e) => h('div.gen-edge', null,
          renderLinkLine({ ...e, synthetic: r.row.synthetic }, { other: otherOf(r, e), direction: r.gen > 0 ? 'earlier' : 'later', onOpen: (x) => openEdge(x.rel_id) }),
          h('span.meta', null, [e.source_dataset ? `source: ${e.source_dataset}` : null].filter(Boolean).join(' · ')),
          e.locator ? (/^https?:\/\//.test(e.locator)
            ? h('a.gen-locator', { href: e.locator, target: '_blank', rel: 'noopener noreferrer external' }, `${e.locator.replace(/^https?:\/\//, '').slice(0, 48)}… (external)`)
            : h('span.meta', null, ` ${e.locator}`)) : h('span.meta', null, ' no locator recorded')))))));
  }

  function render() {
    root.hidden = !isOpen();
    clear(root);
    if (!isOpen()) return;
    root.appendChild(h('header.cmp-head', null,
      h('button.btn.cmp-back', { type: 'button', onClick: () => store.dispatch({ type: 'CLOSE_PANEL', panel: 'genealogy' }), 'aria-label': 'Close Genealogy' }, '← Back'),
      h('div.cmp-heading', null, h('h2.cmp-h', null, 'Genealogy — who sampled, covered, interpolated, remixed or versioned whom'),
        h('p.cmp-sub', null, local.data?.seed ? `seed: ${local.data.seed.title}${local.data.seed.year ? ` (${local.data.seed.year})` : ''}` : seed() ?? 'no seed work'))));
    if (!seed()) { root.appendChild(renderEmptyCard('Select a work (a title on the Scroll or a work suggestion in search) to see its documented sampling family.')); return; }
    if (local.error) { root.appendChild(renderErrorCard(local.error, { what: 'The genealogy could not be loaded.', onRetry: () => load({ force: true }) })); return; }
    if (local.loading && !local.data) { root.appendChild(renderLoadingLine('Loading the genealogy…')); return; }
    const data = local.data;
    if (!data) return;
    root.classList.toggle('syn-frame', data.synthetic === true);
    const v = view();
    root.appendChild(h('p.gen-defaults.meta', null,
      `types: ${(v.lineage.types.length ? v.lineage.types : DEFAULT_TYPES).map((t) => `${REL_TYPE_BY_CODE[t]?.glyph ?? ''} ${REL_TYPE_BY_CODE[t]?.short ?? t}`).join(', ')} · `
      + `${v.lineage.status.length ? `evidence: ${v.lineage.status.join(', ')}` : 'documented only'} · depth ≤ ${DEFAULT_DEPTH} · ≤ ${MAX_ROWS} rows`,
      data.synthetic ? ' · ' : null, data.synthetic ? synBadge() : null));
    root.appendChild(h('p.gen-note', { role: 'note' }, data.note ?? HONESTY_NOTE, data.note && !data.note.includes(HONESTY_NOTE) ? ` ${HONESTY_NOTE}` : ''));
    if (!(data.generations ?? []).some((g) => g.rows?.length)) {
      root.appendChild(renderEmptyCard('No documented links of these types for this work.'));
    } else {
      const density = renderDensity(data);
      if (density) root.appendChild(density);
      root.appendChild(renderChart(data));
      root.appendChild(h('p.meta', null, 'x = the Scroll’s linear time scale; one row per work; ◆ a work at its date; ⊢—⊣ a work that spans years. '
        + 'Elbows run from the parent row to the child at the child’s date; the line pattern is the evidence status; ⚠ marks a date conflict; ◇ in the gutter = undated.'));
      if (local.detail) root.appendChild(h('div.lin-detail', null, h('div.lin-detail-bar', null, h('span.meta', null, 'Link card'),
        h('button.btn.lin-detail-close', { type: 'button', onClick: () => { local.detail = null; render(); } }, 'Close')), local.detail.el));
      const more = (data.generations ?? []).map(moreText).filter(Boolean);
      if (more.length) root.appendChild(h('ul.gen-more', { role: 'list' }, more.map((m) => h('li.meta', null, m))));
      if (data.truncated?.cursor) {
        root.appendChild(h('button.btn', { type: 'button', onClick: () => load({ cursor: data.truncated.cursor }) }, `Load ${formatCount(data.truncated.rows)} more rows`));
      }
      root.appendChild(renderList(data));
      const legend = ['documented', 'computed', 'proposed'].map((s) => { const st = edgeStyle({ evidence_status: s, family: 'quotation' }); return h('span.lin-legend-item', null, lineSample(st), ` ${st.badge} ${s}`); });
      root.appendChild(h('div.lin-legend', null, legend));
    }
  }

  const unsubs = [
    store.subscribe((s) => s.view.panels.right, () => { load(); render(); }),
    store.subscribe((s) => s.view.lineage, () => load()),
  ];
  if (isOpen()) load();
  render();
  return { unmount() { for (const u of unsubs) u(); local.seq++; root.remove(); } };
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
