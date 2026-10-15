// OWNER: WP6
// timeline/deeptime.mjs — the Scroll's external and deep-time layers (SPEC §1.7): etymology period bands with
// the listed-roots bracket and the undated descent connector, Wiktionary claim diamonds and the external
// (Google Books Ngram) baseline track. None of these is an occurrence: they never enter bars, rates, caps or
// the conservation law, and each says what it is ("period of the language, not a date", "(external claim)",
// "a different corpus").
//
// Data: etymology from GET /api/etymology?expr= when the server offers it (families with their listed parents
// and parent_semantics), else the etymology suggestions of GET /api/search (the etymon itself, without parents —
// the bracket then needs the endpoint); claims from the Expression response's `claims` when present; the
// baseline from GET /api/baseline. A missing source draws nothing and invents nothing.

import { dayFromYMD } from '../../shared/dates.mjs';
import { formatNumber } from '../../shared/format.mjs';
import { LANGUAGE_PERIODS } from '../../shared/vocab.mjs';
import { isAbort } from '../core/api.mjs';

/** Row geometry (px): one band per etymon or root, a bracket label line, the 32 px baseline track (§1.7). */
export const DEEP = Object.freeze({ bandH: 14, bandGap: 4, bracketH: 16, pad: 6, baselineH: 32, maxEtymH: 168 });
/** Tiers at which the etymology lane appears (§1.7: L0–L2). */
export const ETYM_TIERS = Object.freeze(['L0', 'L1', 'L2']);
/** The statement when Cipher's roots data holds no family (§1.7 "No family → said so"). */
export const NO_FAMILY = "No etymology family in Cipher's roots data (Latin, Greek, Sanskrit, PIE only)";
export const DESCENT_LABEL = 'descends (Wiktionary via kaikki.org, undated)';
export const BASELINE_LABEL = 'Google Books Ngram, English, 2020 edition — a different corpus (CC BY 3.0)';
export const BASELINE_MULTIWORD = 'No external baseline: the Ngram store holds single words only.';

const PERIOD = new Map(LANGUAGE_PERIODS.map((p) => [p.lang, p]));
const yearDay = (y) => dayFromYMD(y, 1, 1);
/** 'Sanskrit (Vedic → Classical) — …' → 'Sanskrit'. */
export const languageName = (lang) => (PERIOD.get(lang)?.label ?? lang).split(/ \(| —/)[0];

/**
 * Words of the listed-roots bracket (§1.7, from etymon.parent_semantics). Never a claim that the roots compete.
 * @param {string|null} semantics 'listed_chain' | 'listed_variants' | 'listed_unresolved' | other
 * @param {Array<{lang: string}>} parents
 * @returns {string|null}
 */
export function bracketLabel(semantics, parents) {
  if (!parents || parents.length < 2) return null;
  if (semantics === 'listed_chain') {
    const [a, b] = parents.map((p) => (p.lang === 'ine-pro' ? 'PIE' : languageName(p.lang)));
    return `Wiktionary lists a ${a} root and a ${b} root (likely a chain; not stated)`;
  }
  if (semantics === 'listed_variants') return 'variant reconstructions of one root';
  return `Wiktionary lists ${parents.length} roots; how they relate (components or alternatives) is not recorded`;
}

/**
 * How a form is written in a label: its romanization only when the form is in another script (शून्य → śūnyá,
 * γενεά → geneá); a Latin-script form as it is (roots.tsv's `roman` of a PIE root can be a qualifier, not a reading).
 * @param {{form: string, roman?: string|null}} e
 * @returns {string}
 */
export function displayForm(e) {
  return /[\u0370-\u03FF\u1F00-\u1FFF\u0900-\u097F\u0A80-\u0AFF]/u.test(e.form ?? '') ? e.roman ?? e.form : e.form ?? e.roman ?? '';
}

/** Band label: "Sanskrit śūnyá 'blank' — period of the language, not a date". */
export function bandLabel(e) {
  const gloss = e.gloss ? ` '${e.gloss}'` : '';
  return `${languageName(e.lang)} ${displayForm(e)}${gloss} — period of the language, not a date`;
}

/** The short form a narrow band shows when its full label does not fit: "PIE *weys-", "Latin virus". */
export function bandShortLabel(e) {
  return `${e.lang === 'ine-pro' ? 'PIE' : languageName(e.lang)} ${displayForm(e)}`;
}

/**
 * Families from the search fallback: etymology suggestions `etymon:<lang>:<form>` with labels
 * "शून्य (sa) 'blank; deserted' — listed by Wiktionary (via kaikki.org)". Parents are unknown here.
 * @param {Array<{type: string, ref: string, label: string}>} suggestions
 */
export function familiesFromSuggestions(suggestions) {
  const out = [];
  for (const s of suggestions ?? []) {
    if (s.type !== 'etymology' || !/^etymon:/.test(s.ref ?? '') || s.ref === 'etymon:none') continue;
    const key = s.ref.slice('etymon:'.length);
    const i = key.indexOf(':');
    const lang = key.slice(0, i), form = key.slice(i + 1);
    if (!PERIOD.has(lang)) continue;
    const gloss = /'([^']+)'/.exec(s.label ?? '')?.[1] ?? null;
    out.push({ key, lang, form, roman: null, gloss, parents: [], parent_semantics: null });
  }
  return out;
}

/**
 * The rows of the etymology lane (contract 1.3.0 C5): every etymon and every listed root ONCE, however many etyma
 * (or pinned strands) list it, in reading order — an etymon, then the roots it lists that are not drawn yet — and
 * one bracket row per group of listed roots. Etyma that list the same roots with the same semantics share one
 * bracket; a root listed by several etyma says so in its tooltip.
 * @param {Array<object>} families GET /api/etymology families (parents may carry `families`: the etyma listing them)
 * @returns {{rows: Array<{type: 'band', item: object}|{type: 'bracket', group: object}>, items: Map<string, object>,
 *            groups: object[]}}
 */
export function etymLayout(families) {
  const keyOf = (e) => e.key ?? `${e.lang}:${e.form}`;
  const items = new Map();
  const rows = [];
  const groups = new Map();
  const addItem = (e, role) => {
    const key = keyOf(e);
    if (!items.has(key)) {
      const item = { ...e, key, role, listedBy: [] };
      items.set(key, item);
      rows.push({ type: 'band', item });
    }
    return items.get(key);
  };
  for (const f of families ?? []) {
    const fam = addItem(f, 'etymon');
    const parents = (f.parents ?? []).map((p) => {
      const it = addItem(p, 'root');
      for (const k of [fam.key, ...(Array.isArray(p.families) ? p.families : [])]) if (!it.listedBy.includes(k)) it.listedBy.push(k);
      return it;
    });
    if (parents.length > 1) {
      const sig = `${f.parent_semantics ?? ''}|${parents.map((p) => p.key).join('|')}`;
      if (groups.has(sig)) { if (!groups.get(sig).families.includes(fam.key)) groups.get(sig).families.push(fam.key); continue; }
      const group = { id: groups.size, families: [fam.key], parents, semantics: f.parent_semantics ?? null };
      groups.set(sig, group);
      rows.push({ type: 'bracket', group });
    }
  }
  return { rows, items, groups: [...groups.values()] };
}

/** Rows that fit under the lane's height cap (the rest are counted on a last line). */
function fitRows(rows) {
  let h = 2 * DEEP.pad;
  const out = [];
  for (const [i, r] of rows.entries()) {
    const rh = r.type === 'band' ? DEEP.bandH + DEEP.bandGap : DEEP.bracketH;
    if (h + rh > DEEP.maxEtymH - (i < rows.length - 1 ? DEEP.bracketH : 0)) return { rows: out, hidden: rows.length - out.length, h: h + DEEP.bracketH };
    out.push(r);
    h += rh;
  }
  return { rows: out, hidden: 0, h };
}

/** Height of the etymology row for these families (0 when none). */
export function etymRowHeight(families) {
  if (!families?.length) return 0;
  return Math.min(DEEP.maxEtymH, fitRows(etymLayout(families).rows).h);
}

/** What the etymology row says when its periods lie outside the view. */
export const ETYM_ELSEWHERE = 'The etymology periods lie earlier than this view — zoom out or press D (periods, not dates).';

/** Height of the etymology row when a Term trail shows it without any family (the "no family" statement). */
export const ETYM_EMPTY_H = 26;

/** First barrier (folded seam, modality seam) to the right of x, or Infinity. */
const barrierAfter = (barriers, x) => (barriers ?? []).reduce((m, b) => (b > x + 1 && b < m ? b : m), Infinity);
/** A label never starts on a seam (a folded seam is 10 px wide and drawn over the bands). */
const clearOfSeams = (barriers, x) => (barriers ?? []).reduce((v, b) => (v > b - 8 && v < b + 8 ? b + 8 : v), x);

/**
 * Primitives of the etymology row (lane coordinates; `row` = layout.extra.etym). Labels are "sticky": the painter
 * keeps them inside the visible part of their band, truncates them with an ellipsis (the band's tooltip holds the
 * whole label) and never lets one run past `maxX` — its band's end or the next seam, whichever comes first.
 * @param {Array<object>} families
 * @param {{row: {y: number, h: number}, X: (day: number) => number, firstObservation?: {x: number, y: number}|null,
 *          barriers?: number[], empty?: string|null}} opts
 *   `barriers`: content x of seams no label may cross; `empty`: the statement to print when there is no family
 */
export function etymPrims(families, { row, X, firstObservation = null, barriers = [], empty = null }) {
  const prims = [];
  if (!row) return prims;
  if (!families?.length) {
    if (empty) prims.push({ id: 'et:none', kind: 'text', layer: 'bg', style: 'etym-label', sticky: true, x0: -1e7, x1: 1e7, minX: -1e7, maxX: 1e7,
      y0: row.y + row.h / 2 + 4, y1: row.y + row.h / 2 + 4, text: empty, openable: false, ref: null });
    return prims;
  }
  const lay = etymLayout(families);
  const fit = fitRows(lay.rows);
  const drawn = new Map();
  let y = row.y + DEEP.pad;
  const famName = (k) => {
    const it = lay.items.get(k);
    return it ? bandShortLabel(it) : k;
  };
  for (const r of fit.rows) {
    if (r.type === 'band') {
      const e = r.item;
      const p = PERIOD.get(e.lang);
      if (!p) { y += DEEP.bandH + DEEP.bandGap; continue; }
      const x0 = X(yearDay(p.lo_year - p.fuzz_years)), x1 = X(yearDay(p.hi_year + p.fuzz_years + 1));
      const fz = (X(yearDay(p.lo_year)) - x0);
      const label = bandLabel(e);
      const tip = [label, `${p.note}; ends feathered by ±${p.fuzz_years} years`];
      if (e.listedBy.length > 1) tip.push(`listed as a root by ${e.listedBy.map(famName).join(' and ')} — drawn once`);
      tip.push('Wiktionary via kaikki.org (CC BY-SA) · Cipher roots data');
      const band = { id: `et:${e.key}`, kind: 'band', layer: 'bg', style: 'etym-band', x0, x1, y0: y, y1: y + DEEP.bandH, fuzz0: fz, fuzz1: fz,
        core: Number.isInteger(p.core_lo) ? [X(yearDay(p.core_lo)), X(yearDay(p.core_hi + 1))] : null, openable: false,
        ref: { type: 'etymon', key: e.key }, tip };
      prims.push(band);
      const minX = clearOfSeams(barriers, x0 + Math.max(0, fz) + 6);
      prims.push({ id: `et:${e.key}:l`, kind: 'text', layer: 'bg', style: 'etym-label', sticky: true, minX, maxX: Math.min(x1 - 4, barrierAfter(barriers, minX) - 4),
        x0: minX, y0: y + DEEP.bandH - 3.5, x1: x1, y1: y + DEEP.bandH, text: label, short: bandShortLabel(e), openable: false, ref: null });
      drawn.set(e.key, band);
      y += DEEP.bandH + DEEP.bandGap;
      continue;
    }
    // A listed-roots bracket: a comb whose teeth touch exactly the roots the etyma list (never competing hypotheses).
    const g = r.group;
    const bands = g.parents.map((p) => drawn.get(p.key)).filter(Boolean);
    const words = bracketLabel(g.semantics, g.parents);
    if (bands.length > 1 && words) {
      const x = Math.min(...bands.map((b) => b.x0)) - 4 - 5 * (g.id % 3);
      const ya = Math.min(...bands.map((b) => b.y0)), yb = Math.max(...bands.map((b) => b.y1));
      const tip = [words, `parent_semantics: ${g.semantics}`];
      if (g.families.length > 1) tip.push(`listed by ${g.families.map(famName).join(' and ')} — the roots are drawn once`);
      prims.push({ id: `etb:${g.id}`, kind: 'path', layer: 'bg', style: 'roots-bracket', points: [[x, ya], [x, yb]], x0: x - 1, x1: x + 6, y0: ya, y1: yb,
        openable: false, ref: { type: 'etymon', key: g.families[0] }, tip });
      for (const b of bands) {
        const ym = (b.y0 + b.y1) / 2;
        prims.push({ id: `etb:${g.id}:${b.ref.key}`, kind: 'path', layer: 'bg', style: 'roots-bracket', points: [[x, ym], [x + 5, ym]], x0: x, x1: x + 5, y0: ym - 1, y1: ym + 1,
          openable: false, ref: null });
      }
      const text = g.families.length > 1 ? `${words} — for ${g.families.map(famName).join(' and ')}` : words;
      const minX = clearOfSeams(barriers, x + 6);
      const maxX = barrierAfter(barriers, minX) - 4;
      prims.push({ id: `etb:${g.id}:l`, kind: 'text', layer: 'bg', style: 'bracket-label', sticky: true, minX, maxX,
        x0: minX, y0: y + DEEP.bracketH - 4, x1: Number.isFinite(maxX) ? maxX : 1e7, y1: y + DEEP.bracketH, text, openable: false, ref: null, tip });
    }
    y += DEEP.bracketH;
  }
  // When every band lies outside the view, the row says where they are instead of showing nothing.
  const spans = [...drawn.values()].map((b) => [b.x0, b.x1]);
  if (spans.length) {
    prims.push({ id: 'et:elsewhere', kind: 'text', layer: 'bg', style: 'etym-note', sticky: true, onlyIfNone: spans, minX: -1e7, maxX: 1e7, x0: -1e7, x1: 1e7,
      y0: row.y + DEEP.pad + DEEP.bandH - 3.5, y1: row.y + DEEP.pad + DEEP.bandH, text: ETYM_ELSEWHERE, openable: false, ref: null });
  }
  if (fit.hidden > 0) {
    prims.push({ id: 'et:more', kind: 'text', layer: 'bg', style: 'bracket-label', sticky: true, minX: -1e7, maxX: 1e7, x0: -1e7, x1: 1e7,
      y0: y + DEEP.bracketH - 4, y1: y + DEEP.bracketH, text: `+${fit.hidden} more etymology ${fit.hidden === 1 ? 'row' : 'rows'} (the etymology card lists them all)`, openable: false, ref: null });
  }
  if (firstObservation) {
    for (const [key, own] of drawn) {
      if (lay.items.get(key)?.role !== 'etymon') continue;
      // Descent (§1.7): a dotted amber connector from the band's right edge to the first corpus observation, never anchored to a year.
      const sx = own.x1, sy = (own.y0 + own.y1) / 2;
      const pts = [[sx, sy], [sx + 12, sy], [firstObservation.x - 6, firstObservation.y], [firstObservation.x, firstObservation.y]];
      prims.push({ id: `etd:${key}`, kind: 'path', layer: 'bg', style: 'descent', points: pts, x0: Math.min(sx, firstObservation.x), x1: Math.max(sx, firstObservation.x),
        y0: Math.min(sy, firstObservation.y), y1: Math.max(sy, firstObservation.y), openable: false, ref: { type: 'descent' }, tip: [DESCENT_LABEL] });
    }
  }
  return prims;
}

/**
 * Hollow amber diamonds for Wiktionary attestation claims (§1.7): "Wiktionary: first attested 1898 (external
 * claim)". Never an occurrence; never moves a bar's start.
 * @param {Array<{label: string, date?: {lo_year?: number, hi_year?: number, label?: string}}>} claims
 * @param {{X: (day: number) => number, slot: {y: number, h: number, mid: number}|null, room?: number}} opts
 */
export function claimPrims(claims, { X, slot, key = 'c' }) {
  const out = [];
  if (!slot) return out;
  for (const [i, c] of (claims ?? []).entries()) {
    // Expression claims carry `date {lo_year, hi_year}`; adapter claims (the trail's query) `year_lo/year_hi`.
    const lo = c.date?.lo_year ?? c.year_lo, hi = c.date?.hi_year ?? c.year_hi ?? lo;
    if (!Number.isInteger(lo)) continue;
    const x = (X(yearDay(lo)) + X(yearDay(hi + 1))) / 2;
    const r = 4;
    const label = /\(external claim\)/.test(c.label ?? '') ? c.label : `${c.label ?? 'Wiktionary claim'} (external claim)`;
    // §10.2: only a headword statement is shown by default; any other statement is drawn dimmed with its reasons
    const dim = c.display === 'dimmed';
    const tip = [label, 'A statement in a Wiktionary etymology, not an occurrence in this corpus.'];
    if (dim) tip.push(`Dimmed: ${(c.reasons?.length ? c.reasons : ['subject unclear']).join('; ')}.`);
    // the licence travels with the value (§13 rule 15, fix pass)
    tip.push([c.attribution ?? 'Wiktionary contributors, via kaikki.org', c.license ?? 'CC BY-SA'].filter(Boolean).join(' · '));
    out.push({ id: `claim:${key}:${i}`, kind: 'diamond', layer: 'data', style: 'claim', x0: x - r, x1: x + r, y0: slot.y + 2, y1: slot.y + 2 + 2 * r,
      dim, openable: false, ref: { type: 'claim' }, tip });
  }
  return out;
}

/**
 * The external baseline track (§1.7): one thin line per decade value, its own axis, its own label.
 * @param {object} baseline GET /api/baseline response
 * @param {{row: {y: number, h: number}, X: (day: number) => number, x0: number, x1: number, glyph?: string}} opts
 */
export function baselinePrims(baseline, { row, X, x0, x1, glyph = '●', id = 'bl' }) {
  const prims = [{ id: `${id}:g`, kind: 'band', layer: 'bg', style: 'baseline-ground', x0, x1, y0: row.y, y1: row.y + row.h, openable: false, ref: null }];
  if (!baseline) return prims;
  if (!baseline.available) {
    const r = String(baseline.reason ?? 'unavailable');
    const why = r === 'single words only' ? BASELINE_MULTIWORD : /^No external baseline/.test(r) ? r : `No external baseline: ${r.replace(/\.$/, '')}.`;
    prims.push({ id: `${id}:why`, kind: 'text', layer: 'bg', style: 'baseline-label', x0: x0 + 8, y0: row.y + row.h / 2 + 4, x1, y1: row.y + row.h, text: `${glyph} ${why}`, openable: false, ref: null });
    return prims;
  }
  const decades = (baseline.decades ?? []).filter((d) => Number.isFinite(d.per_million));
  const max = decades.reduce((m, d) => Math.max(m, d.per_million), 0);
  const top = row.y + 6, bottom = row.y + row.h - 4;
  const Y = (v) => (max > 0 ? bottom - (v / max) * (bottom - top) : bottom);
  let seg = [];
  let thin = null;
  const flush = () => {
    if (seg.length > 1) prims.push({ id: `${id}:s${prims.length}`, kind: 'path', layer: 'data', style: thin ? 'baseline-thin' : 'baseline-line', points: seg,
      x0: seg[0][0], x1: seg[seg.length - 1][0], y0: top, y1: bottom, openable: false, ref: null });
  };
  for (const d of decades) {
    const pt = [X(yearDay(d.decade + 5)), Y(d.per_million)];
    const isThin = Boolean(d.thin);
    if (thin !== null && isThin !== thin) { seg.push(pt); flush(); seg = [seg[seg.length - 1]]; }
    thin = isThin;
    seg.push(pt);
  }
  flush();
  const hits = decades.map((d) => {
    const x = X(yearDay(d.decade + 5));
    return { id: `${id}:d${d.decade}`, kind: 'band', layer: 'data', style: 'none', x0: x - 3, x1: x + 3, y0: top, y1: bottom, openable: false, ref: { type: 'baseline' },
      tip: [`${d.decade}s: ${formatNumber(d.per_million)} per million (Google Books eng)${d.thin ? ' · thin decade (few volumes)' : ''}`, BASELINE_LABEL] };
  });
  prims.push(...hits);
  prims.push({ id: `${id}:lab`, kind: 'text', layer: 'bg', style: 'baseline-label', x0: x0 + 8, y0: row.y + 13, x1, y1: row.y + 14,
    text: `${glyph} ${baseline.label ?? BASELINE_LABEL} · axis 0–${formatNumber(max)}/M`, openable: false, ref: null });
  return prims;
}

/**
 * '/api/baseline?word=virus&lang=en' → {path: '/baseline', query: {word: 'virus', lang: 'en'}} (the api client adds /api).
 * Only same-origin API paths are accepted.
 * @param {string} href
 * @returns {{path: string, query: Record<string, string>}|null}
 */
export function parseHref(href) {
  const m = /^\/api(\/[A-Za-z0-9/_-]+)(?:\?(.*))?$/.exec(href);
  if (!m) return null;
  return { path: m[1], query: Object.fromEntries(new URLSearchParams(m[2] ?? '')) };
}

/**
 * Loader of the external layers for the pinned strands, with caching per expression.
 * @param {{api: object, onChange: () => void}} io
 */
export function createDeepTimeData({ api, onChange, hasEtymologyEndpoint = () => false }) {
  const etym = new Map();      // expression id → families[] | []
  const base = new Map();      // expression id → Baseline response | null
  const pending = new Set();

  async function loadEtymology(id, surface, corpus) {
    const k = `e:${id}`;
    if (etym.has(id) || pending.has(k)) return;
    pending.add(k);
    let families = [];
    try {
      if (hasEtymologyEndpoint()) {
        const res = await api.get('/etymology', { expr: id }, { key: `etym-${id}` });
        families = res?.available ? res.families ?? [] : [];
      } else {
        // GET /api/etymology is a proposed addition (not in contract 1.1.0): until the server offers it, the
        // search's etymology suggestions give the etymon itself (its listed parents need the endpoint).
        const res = await api.get('/search', { q: surface, corpus, scope: 'etymology', limit: 5 }, { key: `etym-s-${id}` });
        families = familiesFromSuggestions(res?.suggestions);
      }
    } catch (err) {
      if (isAbort(err)) { pending.delete(k); return; }
      families = [];
    }
    etym.set(id, families);
    pending.delete(k);
    onChange();
  }

  async function loadBaseline(id, surface, hint = null) {
    const k = `b:${id}`;
    if (base.has(id) || pending.has(k)) return;
    // The query already says there is no baseline for this strand (C2): no request, the reason is shown.
    if (hint?.available === false) { base.set(id, hint); onChange(); return; }
    pending.add(k);
    try {
      const href = typeof hint?.href === 'string' ? parseHref(hint.href) : null;
      base.set(id, href ? await api.get(href.path, href.query, { key: `baseline-${id}` }) : await api.get('/baseline', { word: surface }, { key: `baseline-${id}` }));
    } catch (err) {
      if (isAbort(err)) { pending.delete(k); return; }
      base.set(id, { available: false, reason: err.message ?? 'unavailable' });
    }
    pending.delete(k);
    onChange();
  }

  return {
    /**
     * Ask for what the visible layers need for these expression strands ({id, surface}). `baselineOf(id)`: the
     * query's {available, href, reason} of a strand (C2), used instead of asking by word.
     */
    want({ strands, corpus, layers, baselineOf = () => null }) {
      for (const s of strands) {
        if (layers.etymology !== 0) loadEtymology(s.id, s.surface, corpus);
        if (layers.baseline === 1) loadBaseline(s.id, s.surface, baselineOf(s.id));
      }
    },
    families: (id) => etym.get(id) ?? null,
    baseline: (id) => base.get(id) ?? null,
    clear() { etym.clear(); base.clear(); },
  };
}

/** UI module contract (§8): a library imported by the Scroll; the registry mounts nothing for it. */
export function mount() { return { unmount() {} }; }
