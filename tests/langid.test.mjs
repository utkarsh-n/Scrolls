// OWNER: WP0 — language identification: scripts, stop-word profiles, document majority, translations (SPEC §4.3, §5.6)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { foldToken, tokenize } from '../src/shared/tokenize.mjs';
import { detectLang, documentLang, PROFILE_LANGS, scriptOf, STOPWORD_LANGS, stopwords, TRANSLATION_MIN_TOKENS } from '../server/text/langid.mjs';
import { miniDocuments } from './helpers/tmpdata.mjs';

// Invented sample paragraphs (not quotations), one per profile language.
const SAMPLES = {
  en: 'When the ship came into the harbour there was no one on the quay to meet it, and the captain walked alone into the town where his brother had kept the books for the old company.',
  fr: "Quand nous sommes arrivés à la gare, le train était déjà parti, et il fallut attendre jusqu'au soir dans la petite salle où les voyageurs dormaient sur leurs valises.",
  es: 'Cuando llegamos a la estación el tren ya se había ido, y tuvimos que esperar hasta la noche en la pequeña sala donde los viajeros dormían sobre sus maletas.',
  de: 'Als wir am Bahnhof ankamen, war der Zug schon abgefahren, und wir mussten bis zum Abend in dem kleinen Saal warten, wo die Reisenden auf ihren Koffern schliefen.',
  la: 'In principio erat liber, et liber erat apud magistrum, et magister non erat in schola; sed pueri qui in schola erant numeros scribebant et cum eo de nihilo disputabant.',
  it: 'Quando siamo arrivati alla stazione il treno era già partito, e abbiamo dovuto aspettare fino alla sera nella piccola sala dove i viaggiatori dormivano sulle valigie.',
  pt: 'Quando chegamos à estação o comboio já tinha partido, e tivemos de esperar até à noite na pequena sala onde os viajantes dormiam sobre as suas malas.',
};

describe('stop-word lists', () => {
  test('nine folded lists of 100–200 words; the first 60 form the profile', () => {
    assert.deepEqual([...STOPWORD_LANGS].sort(), ['de', 'en', 'es', 'fr', 'gu', 'hi', 'it', 'la', 'pt']);
    for (const lang of STOPWORD_LANGS) {
      const file = JSON.parse(readFileSync(new URL(`../server/text/stopwords/${lang}.json`, import.meta.url), 'utf8'));
      assert.match(file['//'], /^OWNER: WP0/);
      assert.equal(file.lang, lang);
      const w = stopwords(lang);
      assert.ok(w.length >= 100 && w.length <= 200, `${lang}: ${w.length} words`);
      assert.equal(new Set(w).size, w.length, `${lang}: unique`);
      for (const x of w) {
        assert.equal(foldToken(x), x, `${lang}: '${x}' is folded`);
        assert.equal(tokenize(x).tokens.length, 1, `${lang}: '${x}' is one token`);
      }
    }
  });
});

describe('scriptOf', () => {
  test('dominant script of the letters', () => {
    assert.equal(scriptOf('carry the zero'), 'Latn');
    assert.equal(scriptOf('शून्य को साथ ले चल'), 'Deva');
    assert.equal(scriptOf('શૂન્ય ઉપાડો'), 'Gujr');
    assert.equal(scriptOf('Ноль'), 'Other');
    assert.equal(scriptOf('◉ 🎬 42'), 'Other');
    assert.equal(scriptOf('Zero Hour ◉ 🎬'), 'Latn');
  });
});

describe('detectLang', () => {
  test('each Latin-script profile language on a paragraph', () => {
    for (const [lang, text] of Object.entries(SAMPLES)) {
      const r = detectLang(text);
      assert.equal(r.lang, lang, `${lang}: ${JSON.stringify(r.scores)}`);
      assert.ok(r.confidence >= 0.6, `${lang} confidence ${r.confidence}`);
      assert.ok(r.scores[lang] >= 0.15);
      assert.deepEqual(Object.keys(r.scores).sort(), [...PROFILE_LANGS].sort());
    }
  });

  test('scripts decide Gujarati and Devanagari (0.6 when undeclared; declared sa/mr kept)', () => {
    assert.deepEqual(detectLang('ગુજરાતી નિશાળમાં આ પાઠ સૌથી પહેલો હતો.'), { lang: 'gu', confidence: 0.9, scores: {} });
    assert.equal(detectLang('शून्य सबसे पहले आता है।').confidence, 0.6);
    assert.equal(detectLang('शून्य सबसे पहले आता है।', { declared: 'hi' }).confidence, 0.9);
    assert.equal(detectLang('ॐ नमः शिवाय', { declared: 'sa' }).lang, 'sa');
    assert.equal(detectLang('माझे नाव', { declared: 'mr' }).lang, 'mr');
    assert.equal(detectLang('Привет мир, как дела сегодня у всех нас').lang, 'und');
  });

  test('short Latin text is und-Latn; long text without a clear winner is und', () => {
    assert.equal(detectLang('Zero Hour').lang, 'und-Latn');
    assert.equal(detectLang('Oru Viral Puratchi').lang, 'und-Latn');
    const r = detectLang('Shunya ka path bachchon ko yaad hai aur ginti wahi se chalti hai har roz subah');
    assert.equal(r.lang, 'und');
    assert.equal(r.confidence, 0);
  });

  test('the mini corpus bodies are identified as declared', () => {
    for (const d of miniDocuments().filter((x) => x.text)) {
      const r = detectLang(d.text.original, { declared: d.lang_declared });
      assert.equal(r.lang, d.lang_declared, `${d.ext_id}: ${JSON.stringify(r)}`);
    }
  });
});

describe('documentLang', () => {
  test('token-weighted majority; und passages do not win over a detected language', () => {
    const r = documentLang([{ lang: 'hi', tokens: 71, confidence: 0.9 }, { lang: 'sa', tokens: 29, confidence: 0.8 }], 'hi');
    assert.equal(r.lang_text, 'hi');
    assert.equal(r.is_translation, false);
    assert.deepEqual(r.by_lang, { hi: 0.71, sa: 0.29 });
    const u = documentLang([{ lang: 'und', tokens: 60, confidence: 0 }, { lang: 'en', tokens: 40, confidence: 0.9 }], 'en');
    assert.equal(u.lang_text, 'en');
    assert.equal(documentLang([{ lang: 'und-Latn', tokens: 4, confidence: 0 }], 'en').lang_text, 'und-Latn');
    assert.equal(documentLang([], 'en').lang_text, 'und');
  });

  test('is_translation needs a mismatch, ≥ 70% of tokens and confidence ≥ 0.6', () => {
    const t = (en, fr, conf = 0.9) => documentLang([{ lang: 'en', tokens: en, confidence: conf }, { lang: 'fr', tokens: fr, confidence: 0.9 }], 'fr');
    assert.equal(t(90, 10).is_translation, true);   // a "French" book whose text is English
    assert.equal(t(70, 30).is_translation, true);
    assert.equal(t(69, 31).is_translation, false);
    assert.equal(t(90, 10, 0.59).is_translation, false);
    assert.equal(documentLang([{ lang: 'en', tokens: 100, confidence: 0.9 }], 'en-GB').is_translation, false);
    assert.equal(documentLang([{ lang: 'en', tokens: 100, confidence: 0.9 }], null).is_translation, false);
  });

  test('a title of a few words never makes a translation claim (fix pass: Gujarati titles in Devanagari read as Hindi)', () => {
    // 'Akabar Charitra.pdf' (ws-gu, declared gu): 3 title tokens detected as hi at 0.6
    const title = documentLang([{ lang: 'hi', tokens: 3, confidence: 0.6 }], 'gu');
    assert.equal(title.lang_text, 'hi');
    assert.equal(title.is_translation, false);
    assert.equal(documentLang([{ lang: 'hi', tokens: TRANSLATION_MIN_TOKENS - 1, confidence: 0.9 }], 'gu').is_translation, false);
    assert.equal(documentLang([{ lang: 'hi', tokens: TRANSLATION_MIN_TOKENS, confidence: 0.9 }], 'gu').is_translation, true);
  });
});
