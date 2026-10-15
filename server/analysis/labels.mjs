// OWNER: WP4
// labels.mjs — machine labels of context groups and the human labels that rename them (SPEC §4.8, §2.F,
// §13 rule 10).
//
// Machine label: the top 4 distinctive context words of a group by weighted log-odds with an informative
// Dirichlet prior (Monroe, Colaresi & Quinn 2008), group vs the rest, keeping words with z ≥ 1.96 and
// in-group frequency ≥ 3: "machine label: column · digit · place". The prior is the pooled context counts of
// every clustered occurrence (α_w = pooled count of w, α₀ = pooled total). These are context words, not
// meanings.
// Human label: an annotation of kind 'label' on the cluster (written through the notebook, WP5); its current
// revision renames the group in the UI while the machine label stays visible beside it.

/** Prefix of every machine label (§4.8). */
export const MACHINE_LABEL_PREFIX = 'machine label: ';
/** Label criteria (§4.8). */
export const LABEL_RULE = Object.freeze({ top: 4, zMin: 1.96, minF: 3 });
/** Label of a residual group (clusters smaller than max(10, 5% of n)). */
export const RESIDUAL_LABEL = `${MACHINE_LABEL_PREFIX}other contexts`;
/** Label of a group with no word passing the criteria. */
export const NO_TERMS_LABEL = `${MACHINE_LABEL_PREFIX}no distinctive context words`;

/**
 * Count words.
 * @param {Iterable<string[]>} contexts
 * @returns {Map<string, number>}
 */
export function countWords(contexts) {
  const out = new Map();
  for (const c of contexts) for (const t of c) out.set(t, (out.get(t) ?? 0) + 1);
  return out;
}

/**
 * Weighted log-odds with an informative Dirichlet prior for every word of the group.
 * δ_w = ln((y_w + α_w) / (n + α₀ − y_w − α_w)) − ln((r_w + α_w) / (m + α₀ − r_w − α_w)), σ² ≈ 1/(y_w + α_w) + 1/(r_w + α_w),
 * z = δ / σ.
 * @param {Map<string, number>} clusterCounts y
 * @param {Map<string, number>} restCounts r
 * @param {{prior?: Map<string, number>}} [opts] α (default: pooled y + r)
 * @returns {Array<{term: string, z: number, delta: number, f_in: number, f_out: number}>} sorted by z descending
 */
export function logOddsDirichlet(clusterCounts, restCounts, { prior = null } = {}) {
  const alpha = prior ?? new Map();
  if (!prior) {
    for (const [t, f] of clusterCounts) alpha.set(t, f);
    for (const [t, f] of restCounts) alpha.set(t, (alpha.get(t) ?? 0) + f);
  }
  let a0 = 0, n = 0, m = 0;
  for (const v of alpha.values()) a0 += v;
  for (const v of clusterCounts.values()) n += v;
  for (const v of restCounts.values()) m += v;
  const out = [];
  for (const [term, y] of clusterCounts) {
    const a = alpha.get(term) ?? 0;
    if (!(a > 0)) continue;
    const r = restCounts.get(term) ?? 0;
    const lIn = Math.log((y + a) / Math.max(1e-12, n + a0 - y - a));
    const lOut = Math.log((r + a) / Math.max(1e-12, m + a0 - r - a));
    const delta = lIn - lOut;
    const z = delta / Math.sqrt(1 / (y + a) + 1 / (r + a));
    out.push({ term, z, delta, f_in: y, f_out: r });
  }
  out.sort((x, y) => y.z - x.z || (x.term < y.term ? -1 : x.term > y.term ? 1 : 0));
  return out;
}

/**
 * Distinctive context words of a group: z ≥ 1.96 and in-group frequency ≥ 3, best first.
 * @param {Map<string, number>} clusterCounts
 * @param {Map<string, number>} restCounts
 * @param {{prior?: Map<string, number>, zMin?: number, minF?: number, keep?: number}} [opts]
 * @returns {Array<{term: string, z: number, f_in: number, f_out: number}>}
 */
export function distinctiveTerms(clusterCounts, restCounts, { prior = null, zMin = LABEL_RULE.zMin, minF = LABEL_RULE.minF, keep = 12 } = {}) {
  return logOddsDirichlet(clusterCounts, restCounts, { prior })
    .filter((x) => x.z >= zMin && x.f_in >= minF)
    .slice(0, keep)
    .map((x) => ({ term: x.term, z: Number(x.z.toFixed(2)), f_in: x.f_in, f_out: x.f_out }));
}

/**
 * The top words that make a machine label (§4.8: top 4).
 * @param {Map<string, number>} clusterCounts
 * @param {Map<string, number>} restCounts
 * @param {{top?: number, prior?: Map<string, number>}} [opts]
 * @returns {string[]}
 */
export function machineLabels(clusterCounts, restCounts, { top = LABEL_RULE.top, prior = null } = {}) {
  return distinctiveTerms(clusterCounts, restCounts, { prior, keep: top }).map((x) => x.term);
}

/**
 * "machine label: column · digit · place" (or the no-terms label).
 * @param {string[]} terms
 * @returns {string}
 */
export function machineLabelText(terms) {
  return terms.length ? `${MACHINE_LABEL_PREFIX}${terms.join(' · ')}` : NO_TERMS_LABEL;
}

/**
 * Current human labels of clusters: the newest active annotation of kind 'label' per cluster, with the
 * body of its current revision. Annotations made after a cut-off (a saved view's revision cut-off) are
 * left out when `revCutoff` is given.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} clusterIds
 * @param {{revCutoff?: number|null}} [opts]
 * @returns {Map<number, {label: string, by: string, at: string, annotation: number, rev: number}>}
 */
export function humanLabels(db, clusterIds, { revCutoff = null } = {}) {
  const out = new Map();
  if (!clusterIds.length) return out;
  const rows = db.prepare(`SELECT a.id, a.target_ref, a.author, r.body_md, r.rev, r.at, r.id AS rev_id
    FROM annotation a JOIN annotation_revision r ON r.annotation_id = a.id
    WHERE a.target_type = 'cluster' AND a.kind = 'label' AND a.status = 'active'
      AND a.target_ref IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      AND r.rev = (SELECT MAX(r2.rev) FROM annotation_revision r2 WHERE r2.annotation_id = a.id AND (? IS NULL OR r2.id <= ?))
    ORDER BY a.id`).all(JSON.stringify(clusterIds), revCutoff, revCutoff);
  for (const r of rows) {
    const label = String(r.body_md).trim();
    if (!label) continue;
    out.set(Number(r.target_ref), { label, by: r.author, at: r.at, annotation: r.id, rev: r.rev });
  }
  return out;
}
