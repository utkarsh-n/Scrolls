// OWNER: R — RF-3 (IOS-SPEC §2.1, ref-freeze-1): how a saved view opens, shared by main.mjs and the verify journey
// (scripts/verify-journey.mjs), so the journey sends exactly what the page sends. No imports: main.mjs loads it statically
// and the registry's package modules stay optional.

/**
 * The view state and ui.savedView of a saved view opened from GET /api/views/:slug (main.mjs openSavedView; the verify
 * journey sends the same, RF-3). As saved (D17, M1 gate): the counting runs pinned at the save, its cutoffs and its save
 * time (documents of a later-reverted import still count; they are only soft-deleted), and on context-group lanes the
 * clustering run pinned at the save, never a newer one (§13 rule 17).
 * @param {object} saved the View response
 * @param {boolean} asSaved
 * @returns {{state: object, savedView: {slug: string, asSaved: boolean, cutoffs: object|null, runIds: object|null}}}
 */
export function openedView(saved, asSaved) {
  const state = { ...saved.state, asSaved };
  let cutoffs = null;
  if (asSaved) {
    const pinned = saved.runIds?.materialize ?? {};
    state.runs = { ...(state.runs ?? {}), materialize: { ...(state.runs?.materialize ?? {}),
      ...Object.fromEntries(Object.entries(pinned).map(([e, r]) => [e, Number(r)])) } };
    cutoffs = saved.cutoffs ? { ...saved.cutoffs, ...(saved.savedAt ? { at: saved.savedAt } : {}) } : null;
    if (state.lanes?.facet === 'cluster' && Number.isInteger(saved.runIds?.cluster) && !Number.isInteger(state.lanes.run)) {
      state.lanes = { ...state.lanes, run: saved.runIds.cluster };
    }
  }
  return { state, savedView: { slug: saved.slug, asSaved, cutoffs, runIds: asSaved ? saved.runIds ?? null : null } };
}
