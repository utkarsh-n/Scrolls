// OWNER: WP3 — variants, matching, the proper-noun guard and KWIC windows (SPEC §4.4, §4.5) as pure functions.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normString, tokenize } from '../src/shared/tokenize.mjs';
import { matchTokens, strandLanguages } from '../server/aggregate/materialize.mjs';
import { kwic } from '../server/text/kwic.mjs';
import { authorTokens, nameFlag, nameIndex, splitMakerNames } from '../server/text/names.mjs';
import { generateVariants, kindOfTokens, variantsHash } from '../server/text/variants.mjs';

const forms = (s, lang) => generateVariants(s, { lang }).map((v) => v.norm);
const on = (s, lang) => generateVariants(s, { lang }).filter((v) => v.enabled).map((v) => v.norm);

describe('generated variants (§4.5)', () => {
  test('English: plural/singular, -ed, -ing with e-drop and doubling, -er/-ers, possessive; phrase heads', () => {
    assert.ok(forms('hacker', 'en').includes('hackers'));
    assert.ok(forms('hackers', 'en').includes('hacker'));
    assert.ok(!forms('hackers', 'en').some((f) => f.startsWith('hackerse')), 'a plural is inflected from its singular');
    assert.deepEqual(forms('stop', 'en').filter((f) => /stopp/.test(f)).sort(), ['stopped', 'stopper', 'stoppers', 'stopping']);
    assert.ok(forms('carry', 'en').includes('carries') && forms('carry', 'en').includes('carried'));
    assert.ok(forms('code', 'en').includes('coding') && forms('code', 'en').includes('coded'));
    assert.ok(forms('zero', 'en').includes('zeros') && forms('zero', 'en').includes('zeroes'));
    assert.ok(forms('virus', 'en').includes('viruses') && !forms('virus', 'en').includes('viru'));
    assert.ok(forms('hacker', 'en').includes('hacker s'), "the possessive is the token sequence of \"hacker's\"");
    assert.deepEqual(forms('carry the zero', 'en'), ['carries the zero', 'carried the zero', 'carrying the zero']);
    assert.deepEqual(forms('cold wire', 'en'), [], 'no verb reading without a function word after the head');
    assert.deepEqual(forms('cold-wire', 'en'), ['coldwire'], 'hyphenation joins');
  });

  test('French and Spanish: plurals on, feminine forms generated but off by default', () => {
    assert.deepEqual(on('zéro', 'fr'), ['zéros']);
    assert.ok(forms('zéro', 'fr').includes('zéroe'));
    assert.ok(on('journal', 'fr').includes('journaux'));
    assert.deepEqual(on('cero', 'es'), ['ceros']);
    assert.ok(forms('cero', 'es').includes('cera'), 'cero → cera ("wax") is listed for review, not counted');
    assert.ok(on('ceros', 'es').includes('cero'));
    assert.ok(on('luz', 'es').includes('luces'));
  });

  test('Hindi: oblique and plural forms; nukta fold both ways; chandrabindu ↔ anusvara', () => {
    assert.deepEqual(on('लड़का', 'hi').slice(0, 3), ['लड़के', 'लड़कों', 'लड़काओं']);
    assert.deepEqual(on('लड़की', 'hi').slice(0, 2), ['लड़कियाँ', 'लड़कियों']);
    assert.deepEqual(on('शून्य', 'hi').slice(0, 3), ['शून्यों', 'शून्यें', 'शून्याएँ']);
    assert.ok(on('क़लम', 'hi').includes(normString('कलम')), 'nukta fold');
    assert.ok(on('कलम', 'hi').includes(normString('क़लम')), 'and the reverse, so either spelling finds both');
    assert.ok(on('चाँद', 'hi').includes('चांद'));
    assert.ok(on('चांद', 'hi').includes('चाँद'));
    for (const v of generateVariants('क़लम', { lang: 'hi' })) assert.equal(v.norm, normString(v.form), 'norms are folded (NFC) forms');
  });

  test('Gujarati: plural and attached postpositions, also after the plural', () => {
    const v = on('શૂન્ય', 'gu');
    for (const f of ['શૂન્યો', 'શૂન્યમાં', 'શૂન્યનો', 'શૂન્યોમાં', 'શૂન્યથી', 'શૂન્યએ']) assert.ok(v.includes(f), f);
  });

  test('language defaults from the script; symbols get none; the identity is never a variant', () => {
    assert.ok(forms('शून्य', null).length > 0);
    assert.ok(forms('શૂન્ય', null).length > 0);
    assert.deepEqual(forms('◉', null), []);
    assert.equal(kindOfTokens(tokenize('◉').tokens), 'symbol');
    assert.equal(kindOfTokens(tokenize('carry the zero').tokens), 'phrase');
    for (const s of ['zero', 'शून्य', 'carry the zero']) assert.ok(!forms(s, null).includes(normString(s)));
    const all = generateVariants('zero', { lang: 'en' });
    assert.equal(new Set(all.map((v) => v.norm)).size, all.length, 'no duplicate norms');
    assert.ok(all.every((v) => v.status === 'computed' && v.rule === 'en-inflect@1'));
  });

  test("fix pass: -er/-ers forms are generated but off by default ('gene' → 'gener' is no word; 'hack' → 'hacker' is another)", () => {
    const gene = generateVariants('gene', { lang: 'en' });
    assert.equal(gene.find((v) => v.norm === 'gener')?.enabled, false);
    assert.equal(gene.find((v) => v.norm === 'geners')?.enabled, false);
    assert.equal(gene.find((v) => v.norm === 'genes')?.enabled, true, 'inflections stay on');
    assert.equal(generateVariants('hack', { lang: 'en' }).find((v) => v.norm === 'hacker')?.enabled, false);
  });

  test('the variants hash follows the enabled set only', () => {
    const a = [{ norm: 'zero', lang: 'en', enabled: 1 }, { norm: 'zeros', lang: 'en', enabled: 1 }, { norm: 'zeroer', lang: 'en', enabled: 0 }];
    assert.equal(variantsHash(a), variantsHash([...a].reverse()));
    assert.notEqual(variantsHash(a), variantsHash(a.map((v) => (v.norm === 'zeros' ? { ...v, enabled: 0 } : v))));
    assert.equal(variantsHash(a), variantsHash(a.map((v) => (v.norm === 'zeroer' ? { ...v, lang: 'fr' } : v))));
  });
});

describe('matching', () => {
  test('the longest variant wins at a start; overlapping starts both count', () => {
    const toks = tokenize("the hacker's zero zero zero").tokens;
    const m = matchTokens(toks, [{ id: 1, seq: ['hacker'] }, { id: 2, seq: ['hacker', 's'] }, { id: 3, seq: ['zero', 'zero'] }]);
    assert.deepEqual(m.map((x) => [x.i, x.len, x.variantId]), [[1, 2, 2], [3, 2, 3], [4, 2, 3]]);
  });

  test('strand languages: the variants\' languages plus the unidentified buckets of their script', () => {
    const v = [{ lang: 'en', enabled: 1, norm: 'zero' }, { lang: 'en', enabled: 0, norm: 'zeros' }];
    assert.deepEqual(strandLanguages({ lang: 'en' }, v), ['en', 'und', 'und-Latn']);
    // fix pass: Devanagari and Gujarati text is always identified by its script, so 'und' (Latin text no profile matched,
    // other scripts) is never their unidentified bucket — dividing by it made Spanish chapter headings coverage for a Gujarati word
    assert.deepEqual(strandLanguages({ lang: 'hi' }, [{ lang: 'hi', enabled: 1, norm: 'शून्य' }]), ['hi']);
    assert.deepEqual(strandLanguages({ lang: 'gu' }, [{ lang: 'gu', enabled: 1, norm: 'શૂન્ય' }]), ['gu']);
    assert.deepEqual(strandLanguages({ lang: 'ta' }, [{ lang: 'ta', enabled: 1, norm: 'பூஜ்யம்' }]), ['ta', 'und'], 'other scripts keep und');
    assert.equal(strandLanguages({ lang: null }, v), null, 'a symbol counts in every language');
  });
});

describe('proper-noun guard (§4.5)', () => {
  const at = (text, word, nth = 0) => {
    let i = -1;
    for (let k = 0; k <= nth; k++) i = text.indexOf(word, i + 1);
    return [i, i + word.length];
  };

  test('body text: capitalized mid-sentence next to another capitalized non-stop-word', () => {
    const t = 'Old Ostrand kept the books for Gene Halloran. The selfish gene of the account was interest.';
    assert.equal(nameFlag(t, ...at(t, 'Gene')), true);
    assert.equal(nameFlag(t, ...at(t, 'gene')), false);
    const s = 'Gene kept the books. I met Gene. Kelly arrived later.';
    assert.equal(nameFlag(s, ...at(s, 'Gene')), false, 'sentence-initial');
    assert.equal(nameFlag(s, ...at(s, 'Gene', 1)), false, 'the next capitalized word starts another sentence');
    const u = 'This is The Zero we saw.';
    assert.equal(nameFlag(u, ...at(u, 'Zero')), false, "a stop-word neighbour ('The') does not make a name");
  });

  test('author rule: the word is part of the document\'s maker — also in caseless scripts', () => {
    const t = 'Ton dévoué, Étienne.';
    assert.equal(nameFlag(t, ...at(t, 'Étienne'), { author: 'Étienne Fixture (synthetic)' }), true);
    const g = 'શૂન્ય ઉપાડો, બાળકો';
    assert.equal(nameFlag(g, ...at(g, 'શૂન્ય'), { author: 'શૂન્ય પાલનપુરી' }), true);
    assert.equal(nameFlag(g, ...at(g, 'શૂન્ય'), { author: 'રતિ ફિક્સચર' }), false);
    assert.deepEqual([...authorTokens('Gene Kelly (synthetic)')], ['gene', 'kelly', 'synthetic']);
  });

  test('title rule: a span shorter than the title that exactly equals a known maker name of ≥ 2 words, or a self-titled work', () => {
    const names = nameIndex(['Gene Kelly (synthetic)', 'Mickey Rourke', 'Kathryn Bigelow', 'Zero', 'Dark', 'Hour Glass Band']);
    const opts = { fieldClass: 'title', names };
    assert.equal(nameFlag('Gene Kelly Live', 0, 4, opts), true, "'Gene Kelly' is a maker's full name");
    assert.equal(nameFlag('Gene Kelly Live', 5, 10, opts), true);
    assert.equal(nameFlag('The Selfish Gene', ...at('The Selfish Gene', 'Gene'), opts), false);
    assert.equal(nameFlag('Mickey Zero', ...at('Mickey Zero', 'Zero'), opts), false, "a neighbour that is part of some name proves nothing");
    // fix pass: a one-word title that equals SOME maker's name is the word itself; only its own maker's name is a name
    assert.equal(nameFlag('Zero', 0, 4, opts), false, "the film 'Zero' is not the band Zero");
    assert.equal(nameFlag('Zero', 0, 4, { ...opts, author: 'Zero' }), true, 'a self-titled work: its title is its maker’s name');
    assert.equal(nameFlag('Zero!', 0, 4, { ...opts, author: 'Zero' }), true, 'punctuation is not a word');
    assert.equal(nameFlag('carry the zero', 6, 9, opts), false, 'lower case is never a name');
    assert.equal(nameFlag('gene kelly live', 0, 4, opts), false, 'a lower-case span is not written as a name');
    assert.equal(nameFlag('Gene Kelly Live', 0, 4, { fieldClass: 'title', names: null }), false, 'no name index: nothing is flagged');
  });

  test('M1 gate regression: Title Case in a title is not evidence of a name (Zero Dark Thirty, Ground Zero, Zero Hour, Below Zero)', () => {
    // every neighbour below is (part of) some maker name, and "Zero" itself is a one-word maker: none of them is flagged
    const names = nameIndex(['Kathryn Bigelow', 'Zero', 'Dark', 'Thirty Seconds to Mars', 'Ground Control', 'Hour Glass Band',
      'Below Deck', 'Deep Zero Band', 'Zero 7']);
    const opts = { fieldClass: 'title', names };
    for (const title of ['Zero Dark Thirty', 'Ground Zero', 'Zero Hour', 'Below Zero']) {
      assert.equal(nameFlag(title, ...at(title, 'Zero'), opts), false, title);
    }
    // the same words do flag where a span really is a maker's full name
    assert.equal(nameFlag('Zero 7 Live', 0, 4, opts), true, "'Zero 7' is a maker's full name");
    assert.equal(nameFlag('Live at Ground Zero', ...at('Live at Ground Zero', 'Zero'), { fieldClass: 'title', names: nameIndex(['Ground Zero']) }), true,
      'only an exact maker name makes a span a name');
    assert.equal(nameFlag('Ground Zero', ...at('Ground Zero', 'Zero'), { fieldClass: 'title', names: nameIndex(['Ground Zero']), author: 'Ground Zero' }), true,
      'a self-titled work');
  });

  test("fix pass: the title 'Virus' (1999) and 'War' (1970) count although bands are called Virus and War; 'Love Affair' too", () => {
    const names = nameIndex(['Virus', 'War', 'Love Affair', 'Iron Maiden', 'Edwin Starr']);
    const opts = { fieldClass: 'title', names };
    assert.equal(nameFlag('Virus', 0, 5, { ...opts, author: 'Chuck Russell' }), false);
    assert.equal(nameFlag('War', 0, 3, { ...opts, author: 'Edwin Starr' }), false);
    assert.equal(nameFlag('Love Affair', ...at('Love Affair', 'Affair'), { ...opts, author: 'Leo McCarey' }), false);
    assert.equal(nameFlag('Virus', 0, 5, { ...opts, author: 'Virus' }), true, 'the band’s own self-titled record');
  });

  test("fix pass: a clipped first name with an elision apostrophe is a name ('Gene); a quoted word is not", () => {
    const t = "If 'Gene heard, he did not say. Then 'Gene's mother came. The word 'Gene' in biology, or 'Gene,' as typed.";
    assert.equal(nameFlag(t, ...at(t, 'Gene')), true, "If 'Gene heard");
    assert.equal(nameFlag(t, ...at(t, 'Gene', 1)), true, "'Gene's mother");
    assert.equal(nameFlag(t, ...at(t, 'Gene', 2)), false, "a quoted 'Gene'");
    assert.equal(nameFlag(t, ...at(t, 'Gene', 3)), false, "a quoted 'Gene,'");
    const d = "d'Gene and o'Gene";
    assert.equal(nameFlag(d, ...at(d, 'Gene')), false, 'an apostrophe inside a word is not an elision');
  });

  test('maker strings: notes stripped, comma lists split only when every item is a full name', () => {
    assert.deepEqual(splitMakerNames('Gene Kelly (synthetic)'), ['Gene Kelly']);
    assert.deepEqual(splitMakerNames('Peter Thiel, Blake Masters'), ['Peter Thiel, Blake Masters', 'Peter Thiel', 'Blake Masters']);
    assert.deepEqual(splitMakerNames('Earth, Wind & Fire'), ['Earth, Wind & Fire']);
    assert.deepEqual(splitMakerNames('J. R. Ostlund (rev.) (synthetic)'), ['J. R. Ostlund']);
    const idx = nameIndex(['Earth, Wind & Fire', 'Peter Thiel, Blake Masters']);
    assert.ok(idx.set.has('peter thiel') && idx.set.has('blake masters') && idx.set.has('earth wind fire'));
    assert.ok(!idx.set.has('earth') && !idx.set.has('fire'), 'a one-word item of a band name is not a name');
    assert.equal(idx.maxTokens, 4);
  });

  test('phrases are never flagged', () => {
    const t = 'for Gene Halloran today';
    assert.equal(nameFlag(t, 4, 17), false);
  });
});

describe('KWIC windows (±12 tokens, clipped at the passage)', () => {
  test('window, clipping and surrogate pairs', () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const text = words.join(' ');
    const [s, e] = [text.indexOf('w15'), text.indexOf('w15') + 3];
    const k = kwic(text, s, e);
    assert.equal(tokenize(k.left).tokens.length, 12);
    assert.equal(tokenize(k.right).tokens.length, 12);
    assert.equal(k.left + k.match + k.right, text.slice(text.indexOf('w3 '), text.indexOf('w27') + 3));
    const clipped = kwic(text, s, e, { clipStart: text.indexOf('w13'), clipEnd: text.indexOf('w17') + 3 });
    assert.equal(clipped.left, 'w13 w14 ');
    assert.equal(clipped.right, ' w16 w17');
    const emoji = '👍🏽 zero 🎬 zero';
    const z = emoji.lastIndexOf('zero');
    const ke = kwic(emoji, z, z + 4);
    assert.equal(ke.left + ke.match + ke.right, emoji);
    const first = kwic('zero first', 0, 4);
    assert.equal(first.left, '');
  });
});

describe('transliteration keys (§4.5, off by default)', async () => {
  const { romanKey, translitMatch } = await import('../server/text/translit.mjs');
  test('Devanagari and Gujarati map to a loose Latin skeleton shared with romanized spellings', () => {
    for (const [latin, indic] of [['Shunya', 'शून्य'], ['shoonya', 'शून्य'], ['Sunya', 'શૂન્ય'], ['kalam', 'क़लम'], ['chaand', 'चाँद'],
      ['ladka', 'लड़का'], ['samajh', 'समझ'], ['kitab', 'किताब'], ['pothi', 'પોથી'], ['Ganit', 'ગણિત'], ['kshan', 'क्षण']]) {
      assert.ok(translitMatch(latin, indic), `${latin} ↔ ${indic} (${romanKey(latin)} / ${romanKey(indic)})`);
    }
    assert.equal(translitMatch('zid', 'ज़िद'), false, 'keys shorter than 4 never match');
    assert.equal(translitMatch('the', 'थे'), false);
    assert.equal(romanKey('कमल'), 'kamal', 'final schwa dropped, medial kept');
  });

  test('candidates come from the corpus vocabulary through one shared group per initial letter, built once and read again', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const { makeTmpData } = await import('./helpers/tmpdata.mjs');
    const { clearSharedArtifacts } = await import('../server/aggregate/cache.mjs');
    const { transliterationCandidates } = await import('../server/text/translit.mjs');
    const t = makeTmpData();
    try {
      const docs = (term) => t.db.prepare('SELECT doc FROM passage_vocab_row WHERE term = ?').get(term)?.doc ?? 0;
      const found = transliterationCandidates(t.db, 'Shunya');
      assert.deepEqual(found.map((c) => c.form).sort(), ['शून्य', 'શૂન્ય'].sort(), 'both Indic spellings in the mini corpus');
      for (const c of found) assert.equal(c.passages, docs(c.form), `${c.form}: passages = its FTS document count`);
      const dir = path.join(t.dir, 'cache');
      const files = readdirSync(dir).filter((f) => f.startsWith('translit1-indic-s-'));
      assert.equal(files.length, 1, 'the s-group of Indic terms is persisted');
      // another word of the same initial, in a fresh process state: read from the file, same answer as a scan would give
      clearSharedArtifacts();
      assert.deepEqual(transliterationCandidates(t.db, 'shoonya'), found);
      assert.ok(existsSync(path.join(dir, files[0])));
      assert.deepEqual(transliterationCandidates(t.db, 'zid'), [], 'keys shorter than 4 never match');
      assert.deepEqual(transliterationCandidates(t.db, 'carry the zero'), [], 'single words only');
      assert.deepEqual(transliterationCandidates(t.db, 'शून्य'), [], 'no romanized spelling in the mini corpus');
    } finally {
      t.cleanup();
    }
  });
});

describe('strand languages with an enabled transliteration', () => {
  test('a Latin transliteration of a Hindi word counts in Latin-script passages', () => {
    const langs = strandLanguages({ lang: 'hi' }, [{ lang: 'hi', enabled: 1, norm: 'शून्य', variant_type: 'identity' },
      { lang: null, enabled: 1, norm: 'shunya', variant_type: 'transliteration' }]);
    for (const l of ['hi', 'und', 'en', 'und-Latn']) assert.ok(langs.includes(l), l);
  });
});
