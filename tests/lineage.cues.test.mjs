// OWNER: WP5 — attribution cues (SPEC §4.7) in all five languages, within ±30 tokens of the span; a cue names a
// source but never documents the link (it yields proposed + CUE only)

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allCues, CUE_PATTERNS, CUE_WINDOW, findCues, nameMatches } from '../server/lineage/cues.mjs';

const at = (text, quote) => {
  const s = text.indexOf(quote);
  assert.ok(s >= 0, quote);
  return [s, s + quote.length];
};

describe('attribution cues', () => {
  const cases = [
    ['en', 'Bit 7 flips on the third pass — as Wrexley put it, a ghost in the margin.', 'a ghost in the margin', 'Wrexley'],
    ['en', 'The clerks repeat it daily, as Ada Brennock wrote: carry the zero.', 'carry the zero', 'Ada Brennock'],
    ['en', "In Brennock's words, the zero holds the place.", 'the zero holds the place', 'Brennock'],
    ['en', "It was Wrexley's line — a ghost in the margin — that stuck.", 'a ghost in the margin', 'Wrexley'],
    ['fr', 'Comme l’a écrit Brennock, le zéro garde la place du rien.', 'le zéro garde la place', 'Brennock'],
    ['fr', 'Selon Wrexley, il y a un fantôme dans la marge.', 'un fantôme dans la marge', 'Wrexley'],
    ['es', 'Como dijo Brennock, el cero guarda el lugar.', 'el cero guarda el lugar', 'Brennock'],
    ['es', 'Según Wrexley, hay un fantasma en el margen.', 'un fantasma en el margen', 'Wrexley'],
    ['hi', 'मंडाविवाला ने कहा कि शून्य को साथ ले चल।', 'शून्य को साथ ले चल', 'मंडाविवाला'],
    ['hi', 'मंडाविवाला के शब्दों में, शून्य जगह रखता है।', 'शून्य जगह रखता है', 'मंडाविवाला'],
    ['gu', 'માંડવીવાલા એ કહ્યું કે શૂન્ય ઉપાડો.', 'શૂન્ય ઉપાડો', 'માંડવીવાલા'],
    ['gu', 'માંડવીવાલા ના શબ્દોમાં શૂન્ય જગ્યા સાચવે છે.', 'શૂન્ય જગ્યા સાચવે છે', 'માંડવીવાલા'],
  ];
  for (const [lang, text, span, name] of cases) {
    test(`${lang}: “${text.slice(0, 42)}…” names ${name}`, () => {
      const [s, e] = at(text, span);
      const found = findCues(text, s, e, { lang });
      assert.ok(found.length >= 1, JSON.stringify(allCues(text)));
      assert.equal(found[0].name, name);
      assert.equal(found[0].lang, lang);
      assert.ok(found[0].distance <= CUE_WINDOW);
      assert.ok(text.slice(found[0].start, found[0].end).includes(name));
    });
  }

  test('every language has its patterns; a cue farther than 30 tokens from the span is not near it', () => {
    assert.deepEqual(Object.keys(CUE_PATTERNS).sort(), ['en', 'es', 'fr', 'gu', 'hi']);
    const filler = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const text = `As Wrexley put it, ${filler} a ghost in the margin.`;
    const [s, e] = at(text, 'a ghost in the margin');
    assert.equal(findCues(text, s, e).filter((c) => c.name).length, 0);
    assert.equal(findCues(text, s, e, { window: 60 }).filter((c) => c.name).length, 1);
  });

  test('quotation marks around the span are a cue without a name (no referent, so no citation by themselves)', () => {
    const text = 'He wrote “a ghost in the margin” on the tape.';
    const [s, e] = at(text, 'a ghost in the margin');
    const q = findCues(text, s, e);
    assert.deepEqual(q.map((c) => [c.name, c.pattern]), [[null, 'quotation marks around the span']]);
  });

  test('names refer to an author surname or to title words, never to anyone with a capital letter', () => {
    assert.ok(nameMatches('Wrexley', { author: 'Tobias Wrexley (synthetic)' }));
    assert.ok(nameMatches('Mrs Brennock', { author: 'Ada Brennock (synthetic)' }));
    assert.ok(nameMatches('मंडाविवाला', { author: 'रतिलाल मंडाविवाला' }));
    assert.ok(nameMatches('Ledger House', { title: 'The Ledger House' }));
    assert.ok(!nameMatches('Wrexley', { author: 'Ada Brennock', title: 'The Ledger House' }));
    assert.ok(!nameMatches('The', { title: 'The Ledger House' }), 'stop words alone name nothing');
    assert.ok(!nameMatches(null, { author: 'Ada Brennock' }));
  });
});
