// OWNER: WP2 — which gutenberg-stemm rows are translations or later adaptations of their first author's work (§6.3, D8)

/** An author whose life dates end before this year cannot have written an English, French or Spanish text as it reads. */
export const MODERN_TEXT_FROM = 1450;

/**
 * Why a gutenberg-stemm catalogue row is a translation (or a later adaptation) of its first author's work, or null.
 * Such a text is dated by the original work and kept out of text-language chronology by default (D8): the English of
 * Bostock's Pliny was not written in 44–79 CE. Language identification cannot see this, because the text really is in
 * the declared language; the catalogue's translator credit and the first author's life dates can.
 * @param {{authors?: Array<{name: string, role?: string|null}>, date_basis?: string, year_hi?: number|null,
 *          year?: number|null}} row a catalogue row (catalog.jsonl, or a document's original_meta)
 * @returns {string|null}
 */
export function translationReason(row) {
  const translator = (row.authors ?? []).find((a) => a.role === 'Translator');
  if (translator) return `the catalogue credits a translator (${translator.name})`;
  const hi = row.year_hi ?? row.year;
  if (row.date_basis === 'author-lifetime-estimate' && Number.isFinite(hi) && hi < MODERN_TEXT_FROM) {
    return `its first author's life ended before ${MODERN_TEXT_FROM}, so this text is a later translation or adaptation`;
  }
  return null;
}
