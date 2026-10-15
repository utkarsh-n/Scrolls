// OWNER: WP7
// panels/date-chip.mjs — the date chip of the Then column (SPEC §1.11, §2.D, §1.7): "17 May 1994 · stated · day",
// the date role beside it, "unverified" when the year comes from a Cipher list, "translation — dated by the
// original" for translations, and the card's notes (calendar conversions, placeholder warnings) in plain view —
// never only in a tooltip, so touch readers see them too.

import { h } from '../core/dom.mjs';

/** Glyph per date basis (§1.7 uncertain-date brackets); stated dates carry none. */
export const BASIS_GLYPHS = Object.freeze({ estimated: '≈', derived: '⇄', period: '▤', announced: '⟦', unknown: '?' });

export const TRANSLATION_FLAG = 'translation — dated by the original';
export const UNVERIFIED_FLAG = 'unverified';

/**
 * The model of a date chip.
 * @param {{label: string, precision: string, basis: string, role?: string|null, notes?: string[]}|null} card
 *   a Passage/Document `date_card`
 * @param {{isTranslation?: boolean}} [opts]
 * @returns {{text: string, label: string, basis: string, precision: string, role: string|null, roleLabel: string|null,
 *            glyph: string|null, flags: string[], notes: string[], ariaLabel: string}}
 */
export function dateChipModel(card, { isTranslation = false } = {}) {
  if (!card || !card.label) {
    return { text: 'undated', label: 'undated', basis: 'unknown', precision: 'unknown', role: null, roleLabel: null,
      glyph: null, flags: [], notes: [], ariaLabel: 'Undated: outside chronology' };
  }
  const notes = Array.isArray(card.notes) ? card.notes.filter((n) => typeof n === 'string' && n) : [];
  const flags = [];
  if (notes.some((n) => /\bunverified\b/i.test(n))) flags.push(UNVERIFIED_FLAG);
  if (isTranslation) flags.push(TRANSLATION_FLAG);
  const role = card.role ?? null;
  const roleLabel = role ? role.replace(/_/g, ' ') : null;
  const text = `${card.label} · ${card.basis} · ${card.precision}`;
  const aria = [`Date ${card.label}`, `basis ${card.basis}`, `precision ${card.precision}`, roleLabel ? `role ${roleLabel}` : null, ...flags]
    .filter(Boolean).join(', ');
  return {
    text, label: card.label, basis: card.basis, precision: card.precision, role, roleLabel,
    glyph: BASIS_GLYPHS[card.basis] ?? null, flags, notes, ariaLabel: aria,
  };
}

/**
 * Render the chip with its role, flags and notes.
 * @param {object|null} card
 * @param {{isTranslation?: boolean, compact?: boolean}} [opts] compact: the chip only (lists, KWIC rows)
 * @returns {HTMLElement}
 */
export function renderDateChip(card, { isTranslation = false, compact = false } = {}) {
  const m = dateChipModel(card, { isTranslation });
  const chip = h('span.date-chip', { dataset: { basis: m.basis, precision: m.precision }, 'aria-label': m.ariaLabel },
    m.glyph ? h('span.date-chip-glyph', { 'aria-hidden': 'true' }, m.glyph) : null,
    h('span.date-chip-main', null, m.text));
  if (compact) return chip;
  return h('span.date-chip-group', null,
    chip,
    m.roleLabel ? h('span.date-chip-role', null, m.roleLabel) : null,
    m.flags.map((f) => h('span.chip.date-flag', { dataset: { flag: f === UNVERIFIED_FLAG ? 'unverified' : 'translation' } }, f)),
    m.notes.length ? h('span.date-chip-notes', null, m.notes.map((n) => h('span.date-chip-note', null, n))) : null);
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
