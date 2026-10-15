// OWNER: N0
// Writes the probe's sample books into the app (IOS-SPEC §1.7, §8.4.10 item 4): three books whose sentence boundaries
// the device probe hashes and compares with the reference's (DV-3: iOS's ICU must agree with Node's Intl.Segmenter,
// which the Mac goldens cannot show). Text and boundaries come from the private golden family g1.sentences-books
// (Node's own starts, not Swift's), so a PASS on the phone means "iOS = the reference", not "iOS = this Mac".
//   node Golden/probe-samples.mjs [--golden ~/Developer/scrolls-golden/<ref>] [--out Native/Scrolls/Resources/Probe]
// Output: <name>.txt (UTF-8, no BOM), <name>.sentences.sha256 (sha256 of the JSON array of UTF-16 sentence starts,
// what `Probe.sentenceDigest` computes) and MANIFEST.json (sources, licences, attribution, counts). Only collections
// with export_text_allowed = 1 are used: a Gutenberg book in the US public domain and two Wikisource books (CC BY-SA).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAMILY = 'g1.sentences-books';

/** The three samples: one book per script the segmenter must get right (Latin, Devanagari, Gujarati). */
const SAMPLES = [
  { name: 'en-third-class-in-indian-railways', source: 'm5r:cipher-gutenberg:pg:24461', title: 'Third Class in Indian Railways',
    author: 'Mahatma Gandhi', year: 1917, licence: 'Public domain (US)',
    attribution: 'Project Gutenberg eBook #24461 (Cipher collection cipher-gutenberg)' },
  { name: 'hi-kavitavali', source: 'm5r:cipher-wikisource-hi:ws-hi:कवितावली.pdf', title: 'कवितावली', author: 'तुलसीदास',
    year: 1933, licence: 'CC BY-SA (Wikisource)',
    attribution: 'Hindi Wikisource contributors, "कवितावली" (Index:कवितावली.pdf), CC BY-SA' },
  { name: 'gu-mameru', source: 'm5r:cipher-wikisource-gu:ws-gu:Mameru.pdf', title: 'મામેરૂં', author: 'પ્રેમાનંદ', year: 1683,
    licence: 'CC BY-SA (Wikisource)', attribution: 'Gujarati Wikisource contributors, "મામેરૂં" (Index:Mameru.pdf), CC BY-SA' },
];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

/** The newest golden directory that holds the private family (committed MANIFEST's reference first). */
function goldenDir(explicit) {
  if (explicit) return resolve(explicit.replace(/^~/, homedir()));
  const manifest = JSON.parse(readFileSync(join(HERE, '../ScrollsKit/Tests/DifferentialTests/Golden/MANIFEST.json'), 'utf8'));
  return join(homedir(), 'Developer/scrolls-golden', manifest.reference_commit);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const golden = goldenDir(args.golden);
  const famDir = join(golden, 'private', FAMILY);
  if (!existsSync(famDir)) throw new Error(`${famDir} is missing: run Tools/golden.sh g1.core on this Mac first`);
  const out = resolve(args.out ?? join(HERE, '../Scrolls/Resources/Probe'));
  const cases = new Map();
  for (const f of readdirSync(famDir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(famDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      const c = JSON.parse(line);
      cases.set(c.source, c);
    }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const written = [];
  for (const s of SAMPLES) {
    const c = cases.get(s.source);
    if (!c) throw new Error(`${s.source} is not in ${FAMILY}`);
    if (sha256(c.text) !== c.text_sha256) throw new Error(`${s.source}: text sha256 differs from the family's`);
    if (c.text.charCodeAt(0) === 0xfeff) throw new Error(`${s.source}: starts with a BOM, which a UTF-8 reader would drop`);
    let at = 0;
    const starts = c.starts_delta.map((d) => (at += d));
    if (starts.length !== c.count || c.text.length !== c.len) throw new Error(`${s.source}: counts differ from the family's`);
    const startsJSON = JSON.stringify(starts);
    writeFileSync(join(out, `${s.name}.txt`), c.text);
    writeFileSync(join(out, `${s.name}.sentences.sha256`), `${sha256(startsJSON)}\n`);
    written.push({ ...s, lang: c.lang, utf16_length: c.len, sentences: c.count, text_sha256: c.text_sha256,
      starts_sha256: sha256(startsJSON) });
  }
  const famManifest = JSON.parse(readFileSync(join(golden, 'MANIFEST.json'), 'utf8')).families?.[FAMILY] ?? {};
  writeFileSync(join(out, 'MANIFEST.json'), `${JSON.stringify({
    '//': 'OWNER: N0 — probe sample books (IOS-SPEC §8.4.10 item 4). Written by Native/Golden/probe-samples.mjs; never edit by hand.',
    family: FAMILY, reference_commit: famManifest.reference_commit ?? null, family_sha256: famManifest.sha256 ?? null,
    digest: 'sha256 of JSON.stringify(sentence starts in UTF-16 units) = Probe.sentenceDigest',
    samples: written,
  }, null, 2)}\n`);
  for (const w of written) console.log(`${w.name.padEnd(36)} ${w.lang} ${w.utf16_length} units, ${w.sentences} sentences`);
  console.log(`wrote ${out}`);
}

main();
