// OWNER: WP4
// multiplicity.mjs — repeated-comparison disclosure (SPEC §2.E item 0, §4.9, compare_log): the notable
// threshold is the (100 − 5/k)th percentile after k comparisons of one expression in one session.
//
// The log is written on the main connection by routes/compare.mjs. A comparison is counted once per
// distinct request (same expressions, slices, filters, toggles and measures): reshuffling passages or
// re-opening the same comparison does not raise k. The write never waits on a job's write lock: when the
// lock is held it is kept in memory (and counted) and retried, like the job queue's write-behind.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/shared/ids.mjs';
import { log } from '../config.mjs';
import { isBusyError, nowIso, stmt } from '../db/open.mjs';

/**
 * Percentile a measure must reach to be called notable after k comparisons: 100 − 5/k (k = 1 → 95).
 * @param {number} k comparisons so far, including this one (≥ 1)
 * @returns {number}
 */
export function notableThreshold(k) {
  const kk = Math.max(1, Math.floor(Number(k) || 1));
  return 100 - 5 / kk;
}

/**
 * '95th', '97.5th', '99.3rd' (one decimal at most; the suffix follows the last digit, 11–13 → 'th').
 * @param {number} x
 * @returns {string}
 */
export function ordinal(x) {
  const s = String(Number(x.toFixed(1)));
  const last = Number(s.at(-1));
  const lastTwo = Number(s.replace('.', '').slice(-2));
  if (!s.includes('.') && lastTwo >= 11 && lastTwo <= 13) return `${s}th`;
  return `${s}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

/**
 * The multiplicity block of a Compare payload with its disclosure sentence.
 * @param {{k: number, notableSoFar?: number, label: string}} args
 * @returns {{k: number, notable_so_far: number, threshold_percentile: number, expected_by_chance: number, text: string}}
 */
export function multiplicityBlock({ k, notableSoFar = 0, label }) {
  const kk = Math.max(1, Math.floor(Number(k) || 1));
  const threshold = notableThreshold(kk);
  const expected = Number((kk * 0.05).toFixed(2));
  const text = kk === 1
    ? `Comparison #1 for '${label}' in this session; the notable threshold is the 95th percentile.`
    : `Comparison #${kk} for '${label}' in this session; ${notableSoFar} of ${kk} crossed the notable threshold; ` +
      `with ${kk} comparisons, ~${expected} are expected by chance at the 95th percentile. ` +
      `Notable threshold is adjusted to the ${ordinal(threshold)} percentile.`;
  return { k: kk, notable_so_far: notableSoFar, threshold_percentile: Number(threshold.toFixed(4)), expected_by_chance: expected, text };
}

/**
 * The key a comparison is logged under: its expressions, sorted.
 * @param {number[]} exprIds
 * @returns {string}
 */
export function expressionKey(exprIds) {
  return `expr:${[...new Set(exprIds)].sort((a, b) => a - b).join('+')}`;
}

/**
 * Hash of what makes two comparisons the same comparison (the passage seed and lane facet do not).
 * @param {object} request normalized compare request
 * @returns {string}
 */
export function comparisonHash(request) {
  const { expr, a, b, measures, toggles, corpus, override } = request;
  return createHash('sha256').update(canonicalJson({ expr: [...expr].sort((x, y) => x - y), a, b, measures, toggles,
    corpus: corpus ?? null, override: override ?? null })).digest('hex').slice(0, 32);
}

// per connection: rows not yet written because a job held the write lock, and the retry timer
const queues = new WeakMap();
const queueOf = (db) => {
  let q = queues.get(db);
  if (!q) queues.set(db, (q = { pending: [], timer: null }));
  return q;
};

function flushPending(db) {
  const { pending } = queueOf(db);
  if (!pending.length) return true;
  if (db.isTransaction) return false;
  db.exec('PRAGMA busy_timeout = 10');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const ins = stmt(db, `INSERT INTO compare_log (session_id, expression_key, request_hash, measures_json, notable_count, at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const r of pending) ins.run(r.session_id, r.expression_key, r.request_hash, r.measures_json, r.notable_count, r.at);
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
    pending.length = 0;
    return true;
  } catch (err) {
    if (!isBusyError(err)) {
      log('error', 'compare_log write failed', { error: String(err?.message ?? err) });
      pending.length = 0;
    }
    return false;
  } finally {
    db.exec('PRAGMA busy_timeout = 5000');
  }
}

function scheduleRetry(db) {
  const q = queueOf(db);
  if (q.timer) return;
  q.timer = setTimeout(() => {
    q.timer = null;
    try {
      if (db.isOpen && !flushPending(db)) scheduleRetry(db);
    } catch { /* the connection closed with the server */ }
  }, 250);
  q.timer.unref?.();
}

/**
 * Comparisons already logged for a session and expression key (written rows plus rows waiting for the
 * write lock), one entry per distinct request.
 * @param {import('node:sqlite').DatabaseSync} db main connection
 * @param {string} sessionId
 * @param {string} key expressionKey(…)
 * @returns {Map<string, number>} request_hash → notable_count
 */
export function priorComparisons(db, sessionId, key) {
  const out = new Map();
  for (const r of stmt(db, `SELECT request_hash, MAX(notable_count) AS notable FROM compare_log
    WHERE session_id = ? AND expression_key = ? GROUP BY request_hash`).all(sessionId, key)) out.set(r.request_hash, r.notable);
  for (const r of queueOf(db).pending) {
    if (r.session_id === sessionId && r.expression_key === key) out.set(r.request_hash, Math.max(out.get(r.request_hash) ?? 0, r.notable_count));
  }
  return out;
}

/**
 * Log one comparison (never blocks on a job's write lock; retried in the background when busy).
 * @param {import('node:sqlite').DatabaseSync} db main connection
 * @param {{sessionId: string, key: string, requestHash: string, measures: string[], notableCount?: number}} entry
 */
export function recordComparison(db, { sessionId, key, requestHash, measures, notableCount = 0 }) {
  queueOf(db).pending.push({ session_id: sessionId, expression_key: key, request_hash: requestHash,
    measures_json: JSON.stringify(measures ?? []), notable_count: notableCount, at: nowIso() });
  if (!flushPending(db)) scheduleRetry(db);
}
