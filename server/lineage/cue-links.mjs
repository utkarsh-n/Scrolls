// OWNER: WP5
// cue-links.mjs — attribution cues across a reuse-index scope (SPEC §4.7, D7): "as <Name> put it", "selon <Nom>",
// "<नाम> ने कहा" … followed (or preceded, within ±30 tokens) by words that a text by <Name> also holds. The cue is
// verifiable; its referent is inferred. So every link made here is an explicit_citation with evidence_status
// 'proposed', a 'citation_cue' evidence row quoting the cue, and the shared words as spans; only a person can confirm it.
// A name refers to a text by its author's surname or by its title (cues.nameMatches); a text certainly written after
// the citing one is never its referent. One cue naming an author with several texts holding the words gives a
// hypothesis group "Which text does “…” refer to?" with the competing referents side by side.

import { nowIso, stmt, tx } from '../db/open.mjs';
import { kgramSeeds, seedExtend } from './align.mjs';
import { insertAlgorithmRelationship } from './classify.mjs';
import { allCues, nameMatches, nameWords } from './cues.mjs';
import { contentTokens } from './filters.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';

/** Shortest shared run after a cue, and the content words it needs. */
export const CUE_RUN = Object.freeze({ minTokens: 4, minContent: 2, window: 30 });

const dated = (d) => d.chrono_status === 'dated' && d.lo_day !== null && d.hi_day !== null;
/** Whether document a was certainly written after document b. */
const certainlyAfter = (a, b) => dated(a) && dated(b) && a.lo_day > b.hi_day;

/**
 * Find cue citations in a loaded corpus and write them (each in its own transaction, as a run's rows).
 * @param {object} ctx TaskCtx (db, checkpoint)
 * @param {{corpus: import('./corpus.mjs').ScopeCorpus, runId: number, counts: object, minTokens?: number, window?: number,
 *   skip?: (srcPassage: number, dstPassage: number) => boolean}} opts `skip` drops pairs already linked elsewhere
 */
export function cueLinks(ctx, { corpus, runId, counts, minTokens = CUE_RUN.minTokens, window = CUE_RUN.window, skip = () => false }) {
  const db = ctx.db;
  const bySurname = new Map(), byTitleWord = new Map();
  const add = (map, key, i) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(i); };
  for (const [i, d] of corpus.docs.entries()) {
    const words = tokenize(String(d.author ?? '').replace(/\([^)]*\)/g, ' ')).tokens;
    if (words.length) add(bySurname, words[words.length - 1], i);
    for (const w of tokenize(String(d.title ?? '')).tokens) add(byTitleWord, w, i);
  }
  // documents whose author's surname is among the name's words, or whose title holds every word of the name
  const candidatesFor = (name) => {
    const words = nameWords(name);
    const out = new Set(words.flatMap((w) => [...(bySurname.get(w) ?? [])]));
    let inTitle = null;
    for (const w of words) {
      const set = byTitleWord.get(w) ?? new Set();
      inTitle = inTitle === null ? new Set(set) : new Set([...inTitle].filter((x) => set.has(x)));
    }
    for (const i of inTitle ?? []) out.add(i);
    return out;
  };
  counts.cue_not_a_name ??= 0;
  counts.cue_referent_later ??= 0;
  const made = new Set();
  for (let di = 0; di < corpus.docs.length; di++) {
    ctx.checkpoint();
    const doc = corpus.docs[di];
    const fields = [...new Set(corpus.passages.slice(corpus.docPassages[di], corpus.docPassages[di + 1]).map((x) => x.field))];
    for (const field of fields) {
      const t = corpus.text(doc.id, field);
      for (const cue of allCues(t.text)) {
        const g0 = corpus.tokenAtOffset(di, field, cue.start);
        if (g0 === null) continue; // not in an ok text passage (boilerplate, apparatus …)
        const cp = corpus.passageAt(g0);
        if (cp.field !== field || cp.start_off > cue.end || cp.end_off < cue.start) continue;
        counts.cue_matches++;
        if (!nameWords(cue.name).length) { counts.cue_not_a_name++; continue; }
        const g1 = corpus.tokenAtOffset(di, field, cue.end) ?? corpus.docStart[di + 1];
        const referents = [];
        for (const ai of candidatesFor(cue.name)) {
          const cited = corpus.docs[ai];
          if (ai === di || !nameMatches(cue.name, cited)) continue;
          if (certainlyAfter(cited, doc)) { counts.cue_referent_later++; continue; }
          const lo = Math.max(corpus.docStart[di], g0 - window), hi = Math.min(corpus.docStart[di + 1], g1 + window);
          const aIds = corpus.docIds(ai), oa = corpus.docStart[ai];
          const runs = seedExtend(corpus.ids, aIds, kgramSeeds(corpus.ids, aIds, { k: minTokens, aLo: lo, aHi: hi }), { minRun: minTokens, aLo: lo, aHi: hi })
            .filter((r) => (r.a1 <= g0 || r.a0 >= g1) && contentTokens(corpus.ids, r.a0, r.a1, corpus.classes) >= CUE_RUN.minContent);
          if (!runs.length) continue;
          const r = runs.sort((x, y) => y.len - x.len)[0];
          const sb = corpus.span(r.a0, r.a1), sa = corpus.span(oa + r.b0, oa + r.b1);
          const key = `${sb.passage}>${cited.id}`;
          if (made.has(key) || skip(sb.passage, sa.passage)) continue;
          made.add(key);
          const relId = tx(db, () => insertAlgorithmRelationship(db, { rel_type: 'explicit_citation', evidence_status: 'proposed',
            src: { passage: sb.passage, doc }, dst: { passage: sa.passage, doc: cited }, directed: 1, score: null,
            method: `attribution cue (${cue.lang}): "${cue.pattern}"`, runId,
            evidence: [
              { role: 'citation_cue', passage: cp.id, doc, field, start: cue.start, end: cue.end, text: t.text, sha: t.sha,
                detail: { quote: cue.quote, name: cue.name, referent: 'inferred' } },
              { role: 'source_span', ...sb, detail: { tokens: r.len } },
              { role: 'target_span', ...sa, detail: { tokens: r.len } },
            ] }));
          counts.cue_citations++;
          referents.push({ relId, src: sb.passage, synthetic: doc.is_synthetic || cited.is_synthetic });
        }
        // one cue, several texts by the named author holding the words: competing referents, kept side by side
        for (const [src, list] of Map.groupBy(referents, (x) => x.src)) {
          if (list.length < 2) continue;
          tx(db, () => {
            const gid = Number(stmt(db, `INSERT INTO hypothesis_group (target_type, target_ref, question, created_by, is_synthetic, created_at)
              VALUES ('passage', ?, ?, ?, ?, ?)`).run(String(src), `Which text does “${cue.quote}” refer to?`, `run:${runId}`,
              list.some((x) => x.synthetic) ? 1 : 0, nowIso()).lastInsertRowid);
            for (const x of list) stmt(db, 'UPDATE relationship SET hypothesis_group_id = ? WHERE id = ?').run(gid, x.relId);
          });
          counts.cue_groups = (counts.cue_groups ?? 0) + 1;
        }
      }
    }
  }
}
