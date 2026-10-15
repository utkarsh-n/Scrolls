#!/usr/bin/env node
// wiktionary-coinage — a STEMM-term + coinage layer with honestly dated etymologies, streamed from
// kaikki.org's raw Wiktextract dump of English Wiktionary (≈3 GB gz / ≈24 GB JSONL, never stored).
//
//   node tools/fetch/wiktionary-coinage.mjs                 stream the dump (resumable) + select
//   node tools/fetch/wiktionary-coinage.mjs --select-only   redo the selection from staged shards
//   node tools/fetch/wiktionary-coinage.mjs --input FILE [--limit N] [--shard-lines N] [--out DIR]
//                                                           test on a local JSONL(.gz) slice
//
// Two passes:
//   1. stream: every raw line is pre-filtered by a string test for the kept lang codes, parsed, and
//      a compact "candidate" record (word, pos, senses' glosses/topics/topic categories, etymology
//      text + the etymology templates that matter) is written for any en/fr/es/hi/gu entry that has
//      a topic, a topical category, a coinage-type template or category, or date words in its
//      etymology. Candidates go to numbered shards under cache/wiktionary-coinage-tmp/shards; a
//      finished shard is never rewritten, so an interrupted stream resumes after the last finished
//      shard (the bytes before it are re-downloaded but not re-parsed).
//   2. select: the shards are read back, the STEMM field mapping, coinage templates and the
//      date-statement regexes are applied, and terms.jsonl, stats.json, MANIFEST.json and FORMAT.md
//      are written to sources/wiktionary-coinage/. Re-running pass 2 costs seconds.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DATA, USER_AGENT, CONTACT, fetchCached, streamLines, writeManifest, log, sourceDir } from "./lib.mjs";

const SOURCE = "wiktionary-coinage";
const DUMP_URL = "https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz";
const INFO_URL = "https://kaikki.org/dictionary/rawdata.html";
const EXTRACTOR_VERSION = 2; // bump when pass-1 candidate selection or the compact record changes
const SELECTOR_VERSION = 2; // reported in outputs; bump when pass-2 rules change
const CURRENT_YEAR = new Date().getUTCFullYear();

// ---------------------------------------------------------------------------------------------
// CLI
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const INPUT = opt("--input") ? resolve(opt("--input")) : null;
const LIMIT = opt("--limit") ? Number(opt("--limit")) : null;
const SELECT_ONLY = flag("--select-only");
const TMP = join(DATA, "cache", `${SOURCE}-tmp`);
const TEST = Boolean(INPUT);
if (LIMIT && !INPUT) { console.error("--limit is only supported with --input (a remote stream cannot be cut cleanly)"); process.exit(2); }
const SHARD_LINES = Number(opt("--shard-lines")) || 500_000;
const SHARDS = TEST ? join(TMP, "test-shards") : join(TMP, "shards");
const OUT = opt("--out") ? resolve(opt("--out")) : TEST ? join(TMP, "test-out") : sourceDir(SOURCE);
const SCRIPT = "Scrolls/tools/fetch/wiktionary-coinage.mjs";

// ---------------------------------------------------------------------------------------------
// Languages kept. The raw line also carries lang_codes of translations/descendants, so the string
// test is only a pre-filter; the parsed entry's own lang_code decides.
const KEEP_LANGS = new Set(["en", "fr", "es", "hi", "gu"]);
const PREFILTER = /"lang_code": "(?:en|fr|es|hi|gu)"/;
const SAME_FAMILY = {
  en: /^(?:(?:Old|Middle|Early Modern|Modern|American|British|Australian|Canadian|Indian|Irish|Scottish|South African|New Zealand)\s+)?English$/,
  fr: /^(?:(?:Old|Middle|Modern|Canadian|Quebec|Belgian|Swiss)\s+)?French$/,
  es: /^(?:(?:Old|Mexican|Latin American|European)\s+)?Spanish$|^Castilian$/,
  hi: /^(?:Old\s+)?Hindi$|^Hindustani$/,
  gu: /^(?:(?:Old|Middle)\s+)?Gujarati$/,
};
const sameFamily = (lang, name) => Boolean(SAME_FAMILY[lang]?.test(name));

// ---------------------------------------------------------------------------------------------
// STEMM fields come from Wiktionary's topical categories ("en:Medicine", "fr:Computing"), which the
// label module assigns from a sense's context label. Wiktextract's sense `topics` are NOT used for
// mapping: they are an expanded closure of the label ("(logic)" → mathematics, "(technical)" →
// engineering, "(drugs, slang)" → pharmacology), so they over-assign fields; they are output as-is.
// Keys are category names slugified ("Organic chemistry" → "organic-chemistry").
const FIELD_TOPICS = {
  mathematics: ["mathematics", "math", "maths", "algebra", "linear-algebra", "abstract-algebra", "geometry", "differential-geometry", "algebraic-geometry",
    "trigonometry", "arithmetic", "calculus", "mathematical-analysis", "real-analysis", "complex-analysis", "functional-analysis", "numerical-analysis",
    "statistics", "probability", "probability-theory", "number-theory", "set-theory", "topology", "algebraic-topology", "combinatorics", "graph-theory",
    "category-theory", "group-theory", "ring-theory", "order-theory", "lattice-theory", "mathematical-logic", "model-theory", "proof-theory",
    "game-theory", "measure-theory", "applied-mathematics", "discrete-mathematics", "fractals", "matrices", "vectors", "tensors",
    "information-theory", "cellular-automata", "theory-of-computing", "numerical-analysis", "mathematical-analysis", "elementary-mathematics"],
  computing: ["computing", "computer-science", "computer-sciences", "programming", "software", "software-engineering", "software-architecture", "computer-hardware",
    "computer-graphics", "internet", "web-design", "web-development", "networking", "computer-networking", "computer-security", "cybersecurity", "databases",
    "operating-systems", "artificial-intelligence", "machine-learning", "cryptography", "cryptocurrency", "cryptocurrencies", "information-technology",
    "information-science", "data-science", "computational-linguistics", "algorithms", "data-structures", "object-oriented-programming", "functional-programming",
    "programming-languages", "computer-languages", "file-formats", "cloud-computing", "computer-games-development", "unix", "linux",
    "computing-theory", "theory-of-computing", "quantum-computing", "hacking", "video-compression", "data-compression", "data-processing",
    "graphical-user-interface", "information-theory", "cellular-automata", "computational-complexity-theory", "computer-security", "web-browsers",
    "markup-languages", "computer-programming", "software-development", "computer-graphics", "html", "css", "javascript", "sql", "xml"],
  physics: ["physics", "mechanics", "classical-mechanics", "quantum-mechanics", "quantum-physics", "quantum-field-theory", "quantum-computing", "thermodynamics",
    "statistical-mechanics", "optics", "acoustics", "electromagnetism", "magnetism", "electricity", "nuclear-physics", "particle-physics", "atomic-physics",
    "relativity", "fluid-dynamics", "fluid-mechanics", "solid-state-physics", "condensed-matter-physics", "plasma-physics", "astrophysics", "biophysics",
    "geophysics", "spectroscopy", "rheology", "metrology", "radiation", "quantum-chemistry", "string-theory", "cosmology", "nuclear-physics",
    "physical-quantities", "subatomic-particles", "radioactivity"],
  chemistry: ["chemistry", "organic-chemistry", "inorganic-chemistry", "physical-chemistry", "analytical-chemistry", "biochemistry", "electrochemistry",
    "geochemistry", "photochemistry", "polymer-chemistry", "stereochemistry", "chemical-engineering", "crystallography", "spectroscopy", "quantum-chemistry",
    "nuclear-chemistry", "radiochemistry", "pharmaceutical-chemistry", "medicinal-chemistry", "chemical-elements"],
  astronomy: ["astronomy", "astrophysics", "cosmology", "astrometry", "planetology", "planetary-science", "celestial-mechanics", "astronautics", "space-science",
    "astrobiology", "space", "astronomical-objects"],
  "earth-sciences": ["geology", "earth-sciences", "earth-science", "physical-geography", "meteorology", "climatology", "oceanography", "seismology", "volcanology",
    "vulcanology", "mineralogy", "petrology", "petrography", "paleontology", "palaeontology", "hydrology", "geophysics", "geomorphology", "glaciology",
    "soil-science", "sedimentology", "stratigraphy", "geochemistry", "limnology", "speleology", "atmospheric-sciences", "crystallography", "geodesy",
    "tectonics", "plate-tectonics", "climate-science", "paleogeography", "palaeogeography"],
  biology: ["biology", "genetics", "genomics", "molecular-biology", "cell-biology", "cytology", "biochemistry", "microbiology", "bacteriology", "virology",
    "mycology", "botany", "zoology", "ecology", "evolution", "evolutionary-biology", "evolutionary-theory", "embryology", "entomology", "ornithology",
    "ichthyology", "herpetology", "mammalogy", "malacology", "arachnology", "phycology", "protistology", "lichenology", "bryology", "histology",
    "physiology", "neuroscience", "neurobiology", "neurology", "immunology", "taxonomy", "systematics", "cladistics", "biotechnology", "bioinformatics",
    "paleontology", "palaeontology", "ethology", "marine-biology", "biogeography", "dendrology", "parasitology", "sociobiology", "biophysics",
    "anatomy", "biological-sciences", "life-sciences", "astrobiology", "epigenetics", "cytogenetics", "proteomics", "endocrinology",
    "plant-anatomy", "neuroanatomy", "zootomy", "acarology", "biochemistry", "molecular-biology", "cell-biology", "genetics", "phylogenetics"],
  medicine: ["medicine", "pathology", "anatomy", "pharmacology", "pharmacy", "pharmaceuticals", "physiology", "surgery", "dentistry", "odontology",
    "neurology", "cardiology", "oncology", "psychiatry", "immunology", "epidemiology", "ophthalmology", "optometry", "gynecology", "gynaecology",
    "obstetrics", "pediatrics", "paediatrics", "dermatology", "radiology", "nursing", "veterinary", "veterinary-medicine", "toxicology", "hematology",
    "haematology", "urology", "gastroenterology", "endocrinology", "nephrology", "orthopedics", "orthopaedics", "rheumatology", "otology",
    "otorhinolaryngology", "otolaryngology", "pulmonology", "emergency-medicine", "sports-medicine", "forensic-medicine", "medical-genetics", "serology",
    "histopathology", "anesthesiology", "anaesthesiology", "audiology", "physiotherapy", "diseases", "medical-signs-and-symptoms", "virology",
    "bacteriology", "parasitology", "neurosurgery", "cardiac-surgery", "plastic-surgery", "andrology", "hepatology", "proctology", "geriatrics",
    "neonatology", "obstetrics-and-gynecology", "pharmacokinetics", "biomedicine", "healthcare", "intensive-care", "traumatology",
    "neuroanatomy", "health-sciences", "medical-genetics", "psychopharmacology", "neuropsychology"],
  "engineering-technology": ["engineering", "electrical-engineering", "electronics", "mechanical-engineering", "civil-engineering", "chemical-engineering",
    "structural-engineering", "aerospace", "aerospace-engineering", "aeronautics", "astronautics", "spaceflight", "rocketry", "telecommunications",
    "telecommunication", "telegraphy", "telephony", "robotics", "nanotechnology", "materials-science", "metallurgy", "nuclear-engineering",
    "signal-processing", "control-theory", "systems-engineering", "semiconductors", "photonics", "lasers", "technology", "computer-hardware",
    "biotechnology", "electronic-engineering", "radio-technology", "automation", "engineering-drawing", "machining", "electricity",
    "mechanics", "surveying"],
};
const TOPIC_FIELDS = Object.create(null);
for (const [field, topics] of Object.entries(FIELD_TOPICS)) for (const topic of topics) (TOPIC_FIELDS[topic] ||= new Set()).add(field);
// Topical categories ("en:Medicine") map through the same table after "Medicine" → "medicine";
// these extra names are set-type categories that are still domain vocabulary.
const CATEGORY_EXTRA = {
  "chemical elements": ["chemistry"], "organic compounds": ["chemistry"], "inorganic compounds": ["chemistry"], "acids": ["chemistry"], "alkaloids": ["chemistry"],
  "functional groups": ["chemistry"], "isotopes": ["chemistry", "physics"], "alkanes": ["chemistry"], "alkenes": ["chemistry"], "salts": ["chemistry"],
  "amino acids": ["biology", "chemistry"], "enzymes": ["biology", "chemistry"], "proteins": ["biology", "chemistry"], "hormones": ["biology", "medicine"],
  "neurotransmitters": ["biology", "medicine"], "vitamins": ["biology", "medicine"], "carbohydrates": ["biology", "chemistry"], "lipids": ["biology", "chemistry"],
  "diseases": ["medicine"], "medical signs and symptoms": ["medicine"], "pharmaceutical drugs": ["medicine"], "pharmaceutical effects": ["medicine"],
  "medical equipment": ["medicine"], "medical specialties": ["medicine"], "surgery": ["medicine"], "mental disorders": ["medicine"], "infectious diseases": ["medicine"],
  "viral diseases": ["medicine"], "bacterial diseases": ["medicine"], "cancer": ["medicine"], "skin conditions": ["medicine"], "eye diseases": ["medicine"],
  "bacteria": ["biology"], "viruses": ["biology", "medicine"], "cell biology": ["biology"], "organelles": ["biology"], "cell biology": ["biology"],
  "subatomic particles": ["physics"], "physical quantities": ["physics"], "units of measure": ["physics", "engineering-technology"], "si units": ["physics"],
  "elementary particles": ["physics"], "electromagnetic radiation": ["physics"], "forces": ["physics"],
  "constellations": ["astronomy"], "planets": ["astronomy"], "dwarf planets": ["astronomy"], "stars": ["astronomy"], "celestial bodies": ["astronomy"],
  "galaxies": ["astronomy"], "comets": ["astronomy"], "asteroids": ["astronomy"], "planets of the solar system": ["astronomy"],
  "rocks": ["earth-sciences"], "minerals": ["earth-sciences"], "geological periods": ["earth-sciences"], "geologic time units": ["earth-sciences"],
  "landforms": ["earth-sciences"], "weather": [], "polyhedra": ["mathematics"], "polygons": ["mathematics"], "shapes": [], "numbers": [],
  "mathematical functions": ["mathematics"], "fractions": ["mathematics"], "programming languages": ["computing"], "file formats": ["computing"],
  "computer languages": ["computing"], "software": ["computing"], "operating systems": ["computing"], "computer hardware": ["computing", "engineering-technology"],
  "internet": ["computing"], "electronics": ["engineering-technology"], "electrical engineering": ["engineering-technology"],
  "metals": ["chemistry"], "transition metals": ["chemistry"], "post-transition metals": ["chemistry"], "alkali metals": ["chemistry"],
  "alkaline earth metals": ["chemistry"], "noble gases": ["chemistry"], "halogens": ["chemistry"], "lanthanides": ["chemistry"], "actinides": ["chemistry"],
  "metalloids": ["chemistry"], "s-block elements": ["chemistry"], "p-block elements": ["chemistry"], "d-block elements": ["chemistry"], "f-block elements": ["chemistry"],
  "functions": ["mathematics"], "acceleration": ["physics"], "skeleton": ["biology", "medicine"],
};
function categoryFields(topicName) {
  const lower = topicName.toLowerCase();
  if (own(CATEGORY_EXTRA, lower)) return CATEGORY_EXTRA[lower];
  const slug = lower.replace(/\s+/g, "-");
  return TOPIC_FIELDS[slug] ? [...TOPIC_FIELDS[slug]] : [];
}
const TOPICAL_CATEGORY = /^([a-z]{2,3}(?:-[a-z]{2,4})*):(.+)$/;

// ---------------------------------------------------------------------------------------------
// Etymology templates.
const COINAGE_KINDS = {
  coin: "coined", coinage: "coined", "coined": "coined",
  "named-after": "named-after",
  neologism: "neologism", neol: "neologism",
  univerbation: "univerbation", univ: "univerbation",
  blend: "blend", "blend of": "blend",
  "back-formation": "back-formation", "back-form": "back-formation", backform: "back-formation", backformation: "back-formation", bf: "back-formation",
  clipping: "clipping", clip: "clipping", "clipping of": "clipping", "clip of": "clipping", "clipped compound": "clipping", "clipcomp of": "clipping", clipcomp: "clipping",
  calque: "calque", cal: "calque", clq: "calque",
  "partial calque": "partial-calque", pcal: "partial-calque", pclq: "partial-calque",
};
const COINAGE_PRIORITY = ["coined", "named-after", "neologism", "univerbation", "blend", "back-formation", "clipping", "calque", "partial-calque"];
// Pass-1 retention is looser than the coinage table so a template the table misses is still staged.
const COIN_TEMPLATE_LOOSE = /coin|named-after|neolog|univ|blend|back-?f|^bf$|clip|calq|^cal$|clq|pcal|nonce|eponym/i;
const COIN_CATEGORY_LOOSE = /coin|eponym|named after|back-formation|blends|clippings|calque|neologism|univerbation|nonce|ex nihilo/i;
const COIN_CATEGORY = /^(English|French|Spanish|Hindi|Gujarati) (terms coined by (.+)|terms coined ex nihilo|words coined ex nihilo|coinages|eponyms|back-formations|blends|clippings|calques|partial calques|neologisms|univerbations|nonce words)$/;
const CATEGORY_KIND = {
  "coinages": "coined", "terms coined ex nihilo": "coined", "words coined ex nihilo": "coined", "eponyms": "named-after", "back-formations": "back-formation",
  "blends": "blend", "clippings": "clipping", "calques": "calque", "partial calques": "partial-calque", "neologisms": "neologism",
  "univerbations": "univerbation", "nonce words": "nonce",
};
// Cross-language link templates: {{name|target-lang|source-lang|term|…}}.
const LINK_TYPES = {
  inh: "inh", "inh+": "inh", "inh-lite": "inh", inherited: "inh",
  bor: "bor", "bor+": "bor", "bor-lite": "bor", borrowed: "bor",
  lbor: "lbor", "learned borrowing": "lbor", slbor: "slbor", "semi-learned borrowing": "slbor",
  obor: "obor", "orthographic borrowing": "obor", ubor: "ubor", "unadapted borrowing": "ubor",
  der: "der", "der+": "der", "der-lite": "der", derived: "der", uder: "uder",
  calque: "calque", cal: "calque", clq: "calque", "partial calque": "partial-calque", pcal: "partial-calque", pclq: "partial-calque",
  "semantic loan": "semantic-loan", sl: "semantic-loan", psm: "phono-semantic-matching", "phono-semantic matching": "phono-semantic-matching",
};
// Same-language morphology templates: {{name|lang|part1|part2|…}}.
const MORPH_TYPES = {
  affix: "affix", af: "affix", prefix: "prefix", pre: "prefix", suffix: "suffix", suf: "suffix", confix: "confix", con: "confix",
  compound: "compound", com: "compound", surf: "surface-analysis", blend: "blend", "blend of": "blend",
  clipping: "clipping", clip: "clipping", "clipping of": "clipping", "clip of": "clipping", "clipped compound": "clipping", "clipcomp of": "clipping", clipcomp: "clipping",
  "back-formation": "back-formation", "back-form": "back-formation", backform: "back-formation", backformation: "back-formation", bf: "back-formation",
  univerbation: "univerbation", univ: "univerbation",
};
const own = (obj, key) => Object.hasOwn(obj, key);
const KEEP_TEMPLATE = (name) => own(LINK_TYPES, name) || own(MORPH_TYPES, name) || own(COINAGE_KINDS, name) || name === "etydate" || name === "etymon" || COIN_TEMPLATE_LOOSE.test(name);

// ---------------------------------------------------------------------------------------------
// Date expressions. No `i` flag: era letters (BC, AD, CE) must be upper case and months capitalised;
// lower-case words get explicit [Xx] classes where a capital is plausible.
const cap = (word) => word.replace(/^([a-z])/, (c) => `[${c.toUpperCase()}${c}]`);
const ORD_WORDS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth",
  "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty-first"];
const ORD = `(?:\\d{1,2}(?:st|nd|rd|th)|${ORD_WORDS.map(cap).join("|")})`;
const ERA = `(?:B\\.?\\s?C\\.?(?:\\s?E\\.?)?|A\\.?\\s?D\\.?|C\\.?\\s?E\\.?)(?![A-Za-z])`;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";
const QUAL = [
  "c\\.", "ca\\.", "circa", "c(?=\\s?\\d)", "around", "about", "approximately", "approx\\.", "roughly", "some\\s?time\\s+(?:around|before|after|in|during)",
  "before", "prior\\s+to", "predating", "no\\s+later\\s+than", "not\\s+later\\s+than", "ante", "by", "after", "as\\s+early\\s+as", "at\\s+least",
].map(cap).join("|");
const PART = [
  "(?:[Vv]ery\\s+)?(?:[Ee]arly|[Ee]arlier|[Mm]id|[Mm]iddle|[Ll]ate|[Ll]ater)", "end\\s+of\\s+the", "beginning\\s+of\\s+the", "start\\s+of\\s+the", "turn\\s+of\\s+the",
  "(?:first|second|latter)\\s+half\\s+of\\s+the", "(?:first|last)\\s+quarter\\s+of\\s+the", "(?:early|latter|middle)\\s+part\\s+of\\s+the",
  "middle\\s+of\\s+the", "course\\s+of\\s+the",
].map(cap).join("|");
const CENT = "[Cc]entur(?:y|ies)";
// The second element of a range may carry its own period word: "late 15th–early 16th century",
// "the late 1980s and early 1990s", "mid-19th to early-20th century" (the full range is kept).
const PART2 = (name) => `(?:[Tt]he\\s+)?(?:(?<${name}>${PART})[\\s-]+)?`;
// "or" and "/" join alternatives ("1943 or 1944", "1841/1842", "1267/68", "the 1620s/1630s",
// "the 13th or 14th century", "c. 1630 or c. 1642"); "-", "to", "and" join a range.
const CORE = [
  `(?<cr1>${ORD})(?:[\\s-]+${CENT})?(?:\\s*(?<cr1Era>${ERA}))?\\s*(?<crSep>-|–|—|to|through|or|and|\\/)\\s*${PART2("cr2Part")}(?<cr2>${ORD})[\\s-]+${CENT}(?:\\s*(?<crEra>${ERA}))?`,
  `(?<c1>${ORD})(?:[\\s-]+${CENT}|\\s+c\\.(?!\\s?\\d))(?:\\s*(?<cEra>${ERA}))?`,
  `(?<dr1>\\d{2,3}0)'?s(?:\\s*(?<dr1Era>${ERA}))?\\s*(?<drSep>-|–|—|to|through|or|and|\\/)\\s*${PART2("dr2Part")}(?<dr2>\\d{1,3}0)'?s(?![a-z])(?:\\s*(?<drEra>${ERA}))?`,
  `(?<d1>\\d{2,3}0)'?s(?![a-z])(?:\\s*(?<dEra>${ERA}))?`,
  // a year running into a decade: "the 1440–1450s", "c. 1530–1540s"
  `(?<yd1>\\d{3,4})(?!\\d)\\s*(?:-|–|—|to|through)\\s*${PART2("yd2Part")}(?<yd2>\\d{1,3}0)'?s(?![a-z])(?:\\s*(?<ydEra>${ERA}))?`,
  `(?:(?<md>\\d{1,2})\\s+)?(?<mon>${MONTHS})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?(?<my>\\d{3,4})(?!\\d)(?:\\s*(?<myEra>${ERA}))?`,
  `[Bb]etween\\s+(?<b1>\\d{3,4})(?!\\d)(?:\\s*(?<b1Era>${ERA}))?\\s+and\\s+(?<b2>\\d{3,4})(?!\\d)(?:\\s*(?<b2Era>${ERA}))?`,
  `(?:(?<adPre>A\\.?\\s?D\\.?)\\s+)?(?<y1>\\d{3,4})(?!\\d)(?:\\s*(?<y1Era>${ERA}))?(?:\\s*(?<ySep>-|–|—|to|through|or|until|till|\\/)\\s*(?:(?:c\\.|ca\\.|circa)\\s*)?(?<y2>\\d{1,4})(?!\\d)(?:\\s*(?<y2Era>${ERA}))?)?`,
];
const DATE_SRC = `(?<![\\w.,/#§-])(?:(?<qual>${QUAL})\\s*)?(?:[Tt]he\\s+)?(?:(?<part>${PART})[\\s-]+)?(?:${CORE.join("|")})(?![\\w%°])(?!,\\d)(?!-[A-Za-z])`;
const DATE_RE = new RegExp(DATE_SRC, "g");
const DATE_STICKY = new RegExp(DATE_SRC, "y");

const ordValue = (s) => { const m = /^(\d{1,2})/.exec(s); if (m) return Number(m[1]); const i = ORD_WORDS.indexOf(s.toLowerCase()); return i >= 0 ? i + 1 : null; };
const eraSign = (era) => (era && /^B/.test(era) ? -1 : 1);
const signed = (y, sign) => (sign < 0 ? -y : y);
function centuryBounds(n, sign) {
  return sign > 0 ? [Math.max(1, (n - 1) * 100), n * 100 - 1] : [-(n * 100), -((n - 1) * 100 + 1)];
}
function normQualifier(q) {
  if (!q) return null;
  q = q.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^(?:c\.?|ca\.|circa|around|about|approximately|approx\.|roughly|some ?time around)$/.test(q)) return "circa";
  if (/before|prior to|predating|no later than|not later than|^ante$/.test(q)) return "before";
  if (q === "by") return "by";
  if (/after/.test(q)) return "after";
  if (/as early as|at least/.test(q)) return "at-least";
  return null; // "sometime in/during" adds nothing
}
function normPart(p) {
  if (!p) return null;
  p = p.toLowerCase().replace(/\s+/g, " ");
  if (/turn of/.test(p)) return "turn";
  if (/first half/.test(p)) return "first-half";
  if (/(?:second|latter) half/.test(p)) return "second-half";
  if (/first quarter/.test(p)) return "first-quarter";
  if (/last quarter/.test(p)) return "last-quarter";
  if (/end of/.test(p)) return "end";
  if (/(?:beginning|start) of/.test(p)) return "beginning";
  if (/early|earlier/.test(p)) return "early";
  if (/latter part|late|later/.test(p)) return "late";
  if (/mid|middle/.test(p)) return "mid";
  return null;
}

const isAlternative = (sep) => sep === "or" || sep === "/";
const decadeBounds = (D, sign) => (sign < 0 ? [-(D + 9), -D] : [D, D + 9]);
/** Widens a shortened second number from the first: ("1267", "68") → 1268; ("1940", "50") → 1950. */
function widen(first, second) {
  if (second.length >= first.length) return Number(second);
  let value = Number(first.slice(0, first.length - second.length) + second);
  if (value <= Number(first)) value += 10 ** second.length; // "1999/00" → 2000
  return value;
}
/** Two written alternatives → one record: year_lo/year_hi span both, `alternatives` lists each. */
function setAlternatives(d, list) {
  list.sort((a, b) => a.year_lo - b.year_lo);
  d.alternatives = list;
  d.year = null; d.year_lo = list[0].year_lo; d.year_hi = Math.max(...list.map((x) => x.year_hi)); d.precision = "alternatives";
}

/** Interprets one DATE_RE match. Never invents: `year` is set only when one year is written. */
function interpretDate(m) {
  const g = m.groups;
  const d = {
    start: m.index, end: m.index + m[0].length, date_text: m[0],
    year: null, year_lo: null, year_hi: null, precision: null, qualifier: normQualifier(g.qual), period_part: normPart(g.part),
    era: null, ambiguous: false, alternatives: null, threeDigitBare: false, rejectReason: null,
  };
  let sign = 1;
  if (g.cr1) {
    const s2 = eraSign(g.crEra), s1 = g.cr1Era ? eraSign(g.cr1Era) : s2;
    d.era = g.crEra || g.cr1Era ? (s1 < 0 ? "BCE" : "CE") : null;
    const a = ordValue(g.cr1), b = ordValue(g.cr2);
    if (!a || !b || a > 21 || b > 21) { d.rejectReason = "implausible-year"; return d; }
    const [lo1, hi1] = centuryBounds(a, s1), [lo2, hi2] = centuryBounds(b, s2);
    if (isAlternative(g.crSep)) setAlternatives(d, [{ year: null, year_lo: lo1, year_hi: hi1, precision: "century" }, { year: null, year_lo: lo2, year_hi: hi2, precision: "century" }]);
    else { d.year_lo = Math.min(lo1, lo2); d.year_hi = Math.max(hi1, hi2); d.precision = "range"; }
  } else if (g.c1) {
    sign = eraSign(g.cEra); d.era = g.cEra ? (sign < 0 ? "BCE" : "CE") : null;
    const n = ordValue(g.c1);
    if (!n || n > 21) { d.rejectReason = "implausible-year"; return d; }
    [d.year_lo, d.year_hi] = centuryBounds(n, sign); d.precision = "century";
  } else if (g.dr1) {
    sign = eraSign(g.drEra); d.era = g.drEra || g.dr1Era ? (sign < 0 ? "BCE" : "CE") : null;
    const A = Number(g.dr1), B = widen(g.dr1, g.dr2);
    if (B === A || Math.abs(B - A) > 1000) { d.rejectReason = "invalid-range"; return d; }
    if (isAlternative(g.drSep)) {
      setAlternatives(d, [A, B].map((D) => { const [lo, hi] = decadeBounds(D, sign); return { year: null, year_lo: lo, year_hi: hi, precision: "decade" }; }));
    } else {
      if (B <= A) { d.rejectReason = "invalid-range"; return d; }
      if (sign < 0) { d.year_lo = -(A + 9); d.year_hi = -B; } else { d.year_lo = A; d.year_hi = B + 9; }
      d.precision = "range";
    }
  } else if (g.yd1) {
    sign = eraSign(g.ydEra); d.era = g.ydEra ? (sign < 0 ? "BCE" : "CE") : null;
    const A = Number(g.yd1), D = widen(g.yd1, g.yd2);
    if (D + 9 <= A || D - A > 1000) { d.rejectReason = "invalid-range"; return d; }
    if (sign < 0) { d.year_lo = -(D + 9); d.year_hi = -A; } else { d.year_lo = A; d.year_hi = D + 9; }
    d.precision = "range";
  } else if (g.d1) {
    sign = eraSign(g.dEra); d.era = g.dEra ? (sign < 0 ? "BCE" : "CE") : null;
    const D = Number(g.d1);
    if (D % 100 === 0) { // "the 1500s": the century; the decade reading lies inside the range
      d.ambiguous = true; d.precision = "century";
      if (sign < 0) { d.year_lo = -(D + 99); d.year_hi = -D; } else { d.year_lo = D; d.year_hi = D + 99; }
    } else {
      d.precision = "decade";
      if (sign < 0) { d.year_lo = -(D + 9); d.year_hi = -D; } else { d.year_lo = D; d.year_hi = D + 9; }
    }
  } else if (g.my) {
    if (!/^[A-Z]/.test(g.mon)) { d.rejectReason = "not-a-year"; return d; }
    sign = eraSign(g.myEra); d.era = g.myEra ? (sign < 0 ? "BCE" : "CE") : null;
    d.year = signed(Number(g.my), sign); d.year_lo = d.year_hi = d.year; d.precision = "year";
  } else if (g.b1) {
    const s2 = eraSign(g.b2Era), s1 = g.b1Era ? eraSign(g.b1Era) : s2;
    d.era = g.b2Era || g.b1Era ? (s1 < 0 ? "BCE" : "CE") : null;
    const A = signed(Number(g.b1), s1), B = signed(Number(g.b2), s2);
    if (B <= A) { d.rejectReason = "invalid-range"; return d; }
    d.year_lo = A; d.year_hi = B; d.precision = "range";
  } else if (g.y1) {
    if (g.y2) {
      const s2 = eraSign(g.y2Era), s1 = g.y1Era ? eraSign(g.y1Era) : s2;
      d.era = g.y2Era || g.y1Era ? (s1 < 0 ? "BCE" : "CE") : null;
      const b = s2 > 0 ? widen(g.y1, g.y2) : Number(g.y2.length < g.y1.length ? g.y1.slice(0, g.y1.length - g.y2.length) + g.y2 : g.y2);
      const A = signed(Number(g.y1), s1), B = signed(b, s2);
      if (isAlternative(g.ySep)) {
        if (A === B || Math.abs(B - A) > 1000) { d.rejectReason = "invalid-range"; return d; }
        setAlternatives(d, [A, B].map((y) => ({ year: y, year_lo: y, year_hi: y, precision: "year" })));
      } else {
        if (B <= A || Math.abs(B - A) > 1000) { d.rejectReason = "invalid-range"; return d; }
        d.year_lo = A; d.year_hi = B; d.precision = "range";
      }
    } else {
      sign = g.adPre ? 1 : eraSign(g.y1Era);
      d.era = g.y1Era || g.adPre ? (sign < 0 ? "BCE" : "CE") : null;
      d.year = signed(Number(g.y1), sign); d.year_lo = d.year_hi = d.year; d.precision = "year";
      d.threeDigitBare = g.y1.length === 3 && !g.y1Era && !g.adPre && !g.qual;
    }
  }
  for (const value of [d.year, d.year_lo, d.year_hi, ...(d.alternatives || []).flatMap((x) => [x.year_lo, x.year_hi])]) {
    if (value !== null && (value > CURRENT_YEAR || value === 0)) d.rejectReason = "implausible-year";
  }
  if (d.period_part === "turn") d.rejectReason = "vague-turn-of-century";
  if (d.qualifier === "before" || d.qualifier === "by" || d.qualifier === "at-least") d.year_lo = null;
  if (d.qualifier === "after") d.year_hi = null;
  return d;
}

/** Parses a free-standing date string such as a template's in= argument. */
function parseDateString(raw) {
  if (!raw) return null;
  DATE_RE.lastIndex = 0;
  const m = DATE_RE.exec(String(raw));
  if (!m) return null;
  const d = interpretDate(m);
  return d.rejectReason ? null : d;
}

// ---------------------------------------------------------------------------------------------
// Date-statement triggers (case-insensitive). "window": the first acceptable date in the same
// clause (≤ 220 chars). "immediate": the date must follow directly (after an optional preposition).
const TRIGGERS = [
  { rule: "coined", relation: "coined", mode: "window", re: /\b(?:first\s+)?coined\b/gi },
  { rule: "coinage-attributed", relation: "coined", mode: "window", re: /\bcoinage\b(?=[^.;\n]{0,40}?\b(?:attributed|credited|ascribed)\b)/gi },
  { rule: "first-attested", relation: "first-attested", mode: "window", re: /\b(?:(?:first|earliest)\s+(?:known\s+|recorded\s+|written\s+|surviving\s+|extant\s+)?attest(?:ed|ations?)|attested\s+first)\b/gi },
  { rule: "attested-as-early-as", relation: "first-attested", mode: "immediate", re: /\battested(?=\s+(?:as\s+early\s+as|no\s+later\s+than)\b)/gi },
  { rule: "first-recorded", relation: "first-recorded", mode: "window", re: /\b(?:(?:first|earliest)\s+(?:known\s+)?record(?:ed|s|ings?)?|recorded\s+first)\b/gi },
  { rule: "first-used", relation: "first-used", mode: "window", re: /\b(?:(?:first|earliest)\s+(?:known\s+|recorded\s+|documented\s+|attested\s+|printed\s+|written\s+)?(?:use[ds]?|usages?|employed)|used\s+first)\b/gi },
  { rule: "attested-since", relation: "since", mode: "immediate", re: /\b(?:attested|recorded|documented|known|used|in\s+(?:common\s+|general\s+|English\s+|wide\s+|widespread\s+)?use|current)\s+(?:since|from)\b/gi },
  { rule: "attested-since-distant", relation: "since", mode: "immediate", re: /\battested\b[^.;:()\n]{1,60}?\b(?:since|from)\b/gi },
  { rule: "dates-from", relation: "other", mode: "immediate", re: /\b(?:dates?|dating)\s+(?:back\s+)?(?:from|to)\b/gi },
  { rule: "first-appeared", relation: "other", mode: "window", re: /\bfirst\s+(?:appear(?:s|ed|ing|ances?)?|surfaced|emerged|made\s+(?:its|an)\s+appearance)\b/gi },
  { rule: "first-documented", relation: "other", mode: "window", re: /\b(?:first|earliest)\s+(?:known\s+)?(?:documented|documentation|citations?|cited|printed|in\s+print|mentioned|mentions?|occurrences?|instances?|examples?|quotations?|evidence)\b/gi },
  { rule: "introduced", relation: "other", mode: "window", re: /\b(?:first\s+)?introduced\s+(?=(?:by|in|into|as|around|c\.|circa|about|during)\b)/gi },
  { rule: "attested-in", relation: "other", mode: "immediate", re: /\battested(?=\s+(?:in|around|about|c\.|ca\.|circa|before|during|on)\b)/gi },
  { rule: "recorded-in", relation: "other", mode: "immediate", re: /\brecorded(?=\s+(?:in|around|about|c\.|ca\.|circa|before|during)\b)/gi },
];
// Recorded on kept entries but never a reason to keep one: a date opening the etymology with no
// verb ("19th century: chromo- + -some", "Ca. 1800, from …"), a Wiktionary/TLFi convention whose
// relation to the word is not stated in the text.
const LEADING_DATE = { rule: "leading-date", relation: "other", mode: "leading" };
const IMMEDIATE_SKIP = /\s*,?\s*(?:(?:in|on|from|since|during|until|till)\s+)?/y;

const ABBREV_BEFORE_DOT = /(?:^|[\s(“"])(?:c|ca|cf|Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|viz|No|no|p|pp|vol|Vol|fl|b|d|r|Co|Inc|Ltd|e\.g|i\.e|approx|Prof|Gen|Col|Capt|Lt|Sgt|Rev|Hon|Mt|Ft|ed|eds|trans|[A-Z])$/;
function isSentenceEnd(text, i) {
  if (text[i] !== "." || !/^\s+[A-Z“"‘'(\[]/.test(text.slice(i + 1, i + 4))) return false;
  return !ABBREV_BEFORE_DOT.test(text.slice(Math.max(0, i - 8), i));
}
const CLAUSE_BREAK_AFTER = /^(?:,\s+(?:but|whereas|while|although|though|and|later)\b|\s+[—–]\s+)/;
/** Where the clause that contains `pos` starts (for the subject hint and the parenthesis test). */
function clauseStart(text, pos) {
  const floor = Math.max(0, pos - 400);
  for (let i = pos - 1; i >= floor; i--) {
    const c = text[i];
    if (c === "\n" || c === ";") return i + 1;
    if (c === "." && isSentenceEnd(text, i)) return i + 1;
    if (c === "," && CLAUSE_BREAK_AFTER.test(text.slice(i, i + 20))) return i + 1 + /^,\s+\w+/.exec(text.slice(i, i + 20))[0].length - 1;
  }
  return floor;
}
/** Where the sentence that contains `pos` starts (newline, ";" or a sentence-ending "."). */
function sentenceStart(text, pos) {
  const floor = Math.max(0, pos - 600);
  for (let i = pos - 1; i >= floor; i--) {
    const c = text[i];
    if (c === "\n" || c === ";") return i + 1;
    if (c === "." && isSentenceEnd(text, i)) return i + 1;
  }
  return floor;
}
/** Where the window that starts at `pos` ends. */
function clauseEnd(text, pos) {
  const ceiling = Math.min(text.length, pos + 220);
  for (let i = pos; i < ceiling; i++) {
    const c = text[i];
    if (c === "\n" || c === ";") return i;
    if (c === "." && isSentenceEnd(text, i)) return i;
    if ((c === "," || c === " ") && CLAUSE_BREAK_AFTER.test(text.slice(i, i + 20))) return i;
  }
  return ceiling;
}

// Language names (from the dump's own "lang" fields) for "in German …" and "From French x (…)".
let LANG_NAMES = new Set();
const LANG_STOP = new Set(["Even", "Are", "Ma", "Mo", "Pa", "Ha", "Ga", "Yes", "Bo", "Car", "Ali", "Hu", "Ewe", "Ido", "Day", "Mann", "Male", "Pal", "Lama", "Gun", "Ere",
  "Hun", "Para", "So", "Su", "Tu", "Ta", "La", "Le", "Mi", "Oc", "Au", "Ko", "Ba", "Doe", "Fe", "Gay", "Ham", "Iron", "Kim", "Lab", "Mal", "Mon", "Na", "Ni", "Nu",
  "Ra", "Rao", "Sam", "Sea", "Tai", "Tem", "Te", "Toto", "Wa", "Yao", "Yi", "Zou", "Bete", "Cuba", "Dido", "Kara", "Kaba", "Lele", "Mono", "Nama", "Ron", "Sara", "Sera",
  "Bit", "Mum", "Mal", "Ese", "Are", "Gold", "Busa", "Kol", "Abo", "Ani", "Assan", "Bena", "Boko", "Dime", "Dia", "Kala", "Manga", "Rama", "Tera", "Waja"]);
const CAP_RUN = /\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)*/gu;
function langMentions(str) {
  const found = [];
  for (const run of str.matchAll(CAP_RUN)) {
    const words = run[0].split(/\s+/);
    const offsets = []; let at = 0;
    for (const w of words) { at = run[0].indexOf(w, at); offsets.push(at); at += w.length; }
    for (let i = 0; i < words.length; i++) {
      for (let j = Math.min(words.length, i + 4); j > i; j--) {
        const name = words.slice(i, j).join(" ");
        if (LANG_NAMES.has(name) && !LANG_STOP.has(name)) {
          const index = run.index + offsets[i];
          found.push({ name, index, end: run.index + offsets[j - 1] + words[j - 1].length });
          i = j - 1; break;
        }
      }
    }
  }
  return found;
}

/** For a trigger inside "( … )": the language of the term written just before the "(". */
function parenContext(text, start, tStart) {
  let depth = 0, open = -1;
  const from = Math.max(start, tStart - 300);
  const opens = [];
  for (let i = from; i < tStart; i++) {
    if (text[i] === "(") opens.push(i);
    else if (text[i] === ")" && opens.length) opens.pop();
  }
  if (!opens.length) return null;
  open = opens[opens.length - 1];
  depth = opens.length;
  const close = text.indexOf(")", tStart);
  const inside = text.slice(open, close > 0 ? close : Math.min(text.length, tStart + 200));
  const mentionsInside = langMentions(inside).filter((x) => /\bin\s+(?:the\s+)?$/.test(inside.slice(0, x.index)));
  if (mentionsInside.length) {
    const last = mentionsInside[mentionsInside.length - 1];
    return { open, depth, lang: last.name, otherLanguage: false, insideNamesLanguage: true };
  }
  const before = text.slice(Math.max(0, open - 80), open);
  const mentions = langMentions(before);
  const last = mentions[mentions.length - 1];
  if (last) {
    const tail = before.slice(last.end).trim();
    const tokens = tail ? tail.split(/\s+/).length : 0;
    if (tokens <= 6 && !/[).;]/.test(tail)) return { open, depth, lang: last.name, otherLanguage: null };
  }
  return { open, depth, lang: null, otherLanguage: false };
}

// Life dates of a person ("Spenser (1552 or 1553 – 1599)", "Lichtheim (3 May 1914 – 27 March 2004)",
// "Fuller (1607/8–1661)", "Martin (baptized 1705; died 1782)", "Moondog (born Louis Thomas Hardin,
// 1916–1999)", "Tayac (1895-1978, the twenty-seventh hereditary chief …)") are never attestations.
const LIFE_KEYWORD = "(?:b\\.|d\\.|fl\\.|r\\.|bapt\\.|born|died|floruit|flourished|reigned|baptized|baptised|christened|buried|active|lived)";
const LIFE_YEAR = `(?:(?:c\\.|ca\\.|circa)\\s*)?(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?\\d{3,4}\\??(?:\\s*(?:\\/|or)\\s*(?:c\\.\\s*)?\\d{1,4}\\??)*(?:\\s*(?:B\\.?C\\.?(?:E\\.?)?|C\\.?E\\.?|A\\.?D\\.?))?`;
const LIFE_PAREN = new RegExp(`^\\s*(?:${LIFE_KEYWORD}\\s*)?${LIFE_YEAR}(?:\\s*(?:[-–—]|to)\\s*(?:${LIFE_KEYWORD}\\s*)?${LIFE_YEAR})?\\s*\\??\\s*$`);
const LIFE_KEYWORD_START = /^\s*(?:b\.|d\.|fl\.|r\.|bapt\.|born|died|floruit|flourished|reigned|baptized|baptised|christened|buried)(?![A-Za-z])/i;
const PERIOD_KEYWORD_START = /^\s*(?:active|operating|operated|in\s+operation|existed|existing|in\s+office|ruled|lived)(?![A-Za-z])/i;
const LIFE_KEYWORD_BEFORE = /\b(?:born|died|birth|death|b\.|d\.|fl\.|floruit|flourished|reigned|reign|baptized|baptised|bapt\.|christened|buried)\s*(?:in\s+|on\s+|c\.\s*|ca\.\s*|circa\s+|around\s+)?$/i;
function rejectReason(text, d, tStart, lang) {
  if (d.rejectReason) return d.rejectReason;
  const before = text.slice(Math.max(0, d.start - 30), d.start);
  const after = text.slice(d.end, d.end + 25);
  if (/(?:\bpp?\.|\b[Nn]o\.|\b[Vv]ol\.|\bpages?|\bISBN|#|§|\bchapter|\bverse|\bline|\bcol\.)\s*$/.test(before)) return "not-a-year";
  if (/^\s*(?:years?|yrs?|times|people|persons|words|pages|copies|km|kilomet|miles?|met(?:er|re)s?|feet|ft\b|kg\b|pounds|dollars|percent|per cent|%|°|degrees|editions?|members|species)\b/i.test(after)) return "not-a-year";
  if (d.threeDigitBare && !/\b(?:in|from|since|until|till|during|year|between|and|to)\s+$/i.test(before)) return "not-a-year";
  if (LIFE_KEYWORD_BEFORE.test(before)) return "person-dates-keyword";
  // Inside parentheses opened shortly before the date?
  const open = text.lastIndexOf("(", d.start);
  if (open >= 0 && d.start - open <= 80 && !text.slice(open + 1, d.start).includes(")")) {
    // "(born …", "(baptized …", "(fl. …", "(d. …": whatever follows is a person's dates.
    if (LIFE_KEYWORD_START.test(text.slice(open + 1, d.start))) return "person-dates-keyword";
    // "(operating 1759–1982)", "(in office 1801–1809)", "(active 1650s)": the run of an organisation, office or career.
    if (PERIOD_KEYWORD_START.test(text.slice(open + 1, d.start))) return "period-keyword";
    if (d.start - open <= 25) {
      // The parenthesis' first segment (up to ")" or ";", else up to ",") is a bare date expression.
      const rest = text.slice(d.start, d.start + 120);
      const ends = [/[);]/.exec(rest), /[),;]/.exec(rest)].filter(Boolean).map((x) => d.start + x.index);
      for (const end of [...new Set(ends)]) {
        const content = text.slice(open + 1, end);
        if (!LIFE_PAREN.test(content)) continue;
        const isRange = /\d\??\s*(?:[-–—]|\bto\b)\s*(?:\S+\s+)?(?:c\.\s*|ca\.\s*)?\d/.test(content);
        const wordBefore = /(\S+)\s*$/.exec(text.slice(Math.max(0, open - 40), open))?.[1] || "";
        if (isRange && /^\p{Lu}/u.test(wordBefore)) return "parenthetical-range-after-name";
        break;
      }
    }
  }
  const between = text.slice(tStart, d.start);
  const inLang = langMentions(between).filter((x) => /\bin\s+(?:the\s+)?$/.test(between.slice(0, x.index)));
  const last = inLang[inLang.length - 1];
  if (last && !sameFamily(lang, last.name)) return "other-language";
  return null;
}

const HEADWORD_WORDS = new Set(["it", "its", "it's", "this", "that", "the", "term", "word", "noun", "verb", "adjective", "adverb", "phrase", "expression",
  "name", "sense", "senses", "usage", "use", "form", "spelling", "current", "modern", "present", "was", "is", "has", "have", "been", "were", "being",
  "apparently", "probably", "possibly", "reportedly", "supposedly", "originally", "perhaps", "likely", "allegedly", "first", "also", "as", "a", "an",
  "initialism", "acronym", "abbreviation", "compound", "figurative", "literal", "meaning", "technical", "scientific", "now", "itself", "here", "plural",
  "singular", "verbal", "nominal", "adjectival", "earliest", "known", "recorded", "attested", "evidently", "seemingly", "said", "to", "be", "thought",
  "believed", "claimed", "according", "widely", "generally", "commonly", "often", "usually"]);
const SUBJECT_NOUN = /^(?:the|this|its)\s+(?:(?:modern|current|present|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+)?(?:word|term|noun|verb|adjective|adverb|sense|form|phrase|expression|usage|spelling|name|compound)\b/i;
/** A mechanical hint about what the dated statement is about: "headword" when the clause before the
 *  trigger is empty or generic ("the term was"), or the sentence opens with "The <same-language> word";
 *  "other-language-context" when the sentence before the trigger last names another language
 *  ("… from Arabic siqillāt, … first attested around the ninth century"); otherwise "unclear". */
function subjectHint(text, cStart, tStart, word, lang) {
  const prefix = text.slice(cStart, tStart).trim().replace(/^[,(“"'‘\s*#:•-]+/, "");
  const sStart = sentenceStart(text, tStart);
  const sentence = text.slice(sStart, tStart).trim().replace(/^[*#:•-]+\s*/, "");
  const mentions = langMentions(sentence);
  const context = mentions.length ? mentions[mentions.length - 1].name : null;
  const w = word.toLowerCase();
  const tokens = prefix.toLowerCase().split(/[\s,]+/).filter(Boolean).map((t) => t.replace(/^[“"'‘]+|[”"'’]+$/g, ""));
  if (!prefix || tokens.every((t) => HEADWORD_WORDS.has(t) || t === w)) return { hint: "headword", context };
  const opener = SUBJECT_NOUN.exec(sentence);
  if (opener) {
    const named = /^(?:the|this|its)\s+((?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)?)\s+/.exec(opener[0]);
    if (!named || sameFamily(lang, named[1]) || !LANG_NAMES.has(named[1])) return { hint: "headword", context };
  }
  if (context && !sameFamily(lang, context)) return { hint: "other-language-context", context };
  return { hint: "unclear", context };
}

/** Every date statement in a cleaned etymology text, with accepted and rejected candidates. */
function findAttestations(text, lang, word, templates) {
  const hits = [], rejected = new Map(), noDate = [];
  if (!text) return { accepted: [], rejected: [], noDate };
  const reject = (reason, rule, start, end, dateStart) => {
    const key = `${reason}|${dateStart}`;
    if (!rejected.has(key)) rejected.set(key, { reason, rule, span: text.slice(start, end) });
  };
  TRIGGERS.forEach((trigger, priority) => {
    trigger.re.lastIndex = 0;
    let m;
    while ((m = trigger.re.exec(text))) {
      const tStart = m.index, tEnd = m.index + m[0].length;
      const cStart = clauseStart(text, tStart);
      const paren = parenContext(text, cStart, tStart);
      let dates = [];
      if (trigger.mode === "window") {
        const end = clauseEnd(text, tEnd);
        DATE_RE.lastIndex = tEnd;
        let dm;
        while ((dm = DATE_RE.exec(text)) && dm.index < end) dates.push(interpretDate(dm));
      } else {
        IMMEDIATE_SKIP.lastIndex = tEnd;
        const skip = IMMEDIATE_SKIP.exec(text);
        DATE_STICKY.lastIndex = tEnd + (skip ? skip[0].length : 0);
        const dm = DATE_STICKY.exec(text);
        if (dm) dates.push(interpretDate(dm));
      }
      if (!dates.length) { noDate.push(trigger.rule); continue; }
      if (paren && paren.otherLanguage === null && paren.lang && !sameFamily(lang, paren.lang)) {
        for (const d of dates) reject("parenthetical-other-language-term", trigger.rule, tStart, d.end, d.start);
        continue;
      }
      let accepted = null;
      for (const d of dates) {
        const why = rejectReason(text, d, tStart, lang);
        if (why) { reject(why, trigger.rule, tStart, d.end, d.start); continue; }
        accepted = d; break;
      }
      if (!accepted) continue;
      let subject = paren ? { hint: paren.lang && !sameFamily(lang, paren.lang) ? "other-language-context" : "unclear", context: paren.lang } : subjectHint(text, cStart, tStart, word, lang);
      // "… in German in the early 1900s and in English in 1940": an explicit "in <entry's language>"
      // right before the accepted date says the statement is about the entry's own language.
      const between = text.slice(tStart, accepted.start);
      const inLang = langMentions(between).filter((x) => /\bin\s+(?:the\s+)?$/.test(between.slice(0, x.index)));
      if (inLang.length && sameFamily(lang, inLang[inLang.length - 1].name)) subject = { hint: "headword", context: inLang[inLang.length - 1].name };
      const senseSpecific = /\bsenses?\b|\bmeanings?\b/i.test(text.slice(cStart, accepted.end));
      hits.push({ trigger, priority, tStart, tEnd, d: accepted, inParens: Boolean(paren), subject: subject.hint, context: subject.context, senseSpecific });
    }
  });
  // One date, one statement: the nearest trigger before it governs; ties go to the more specific rule.
  const byDate = new Map();
  for (const h of hits) {
    const best = byDate.get(h.d.start);
    if (!best) { byDate.set(h.d.start, h); continue; }
    const overlap = h.tStart < best.tEnd && best.tStart < h.tEnd; // "First attested in" ⊃ "attested in"
    if (overlap ? h.priority < best.priority : h.tStart > best.tStart) byDate.set(h.d.start, h);
  }
  // A date some trigger accepted is not also reported as rejected.
  for (const [key, value] of rejected) if (byDate.has(Number(key.split("|")[1]))) rejected.delete(key);
  const accepted = [...byDate.values()].sort((a, b) => a.d.start - b.d.start).map((h) => attestationRecord(text, h, templates));
  // Leading date ("19th century: …", "Ca. 1800, from …"): only if nothing else dated the entry here.
  DATE_STICKY.lastIndex = 0;
  const lead = DATE_STICKY.exec(text);
  if (lead && /^\s*[:;,]/.test(text.slice(lead.index + lead[0].length, lead.index + lead[0].length + 3)) && !byDate.has(lead.index)) {
    const d = interpretDate(lead);
    const why = rejectReason(text, d, 0, lang);
    if (why) reject(why, LEADING_DATE.rule, 0, d.end, d.start);
    else accepted.unshift(attestationRecord(text, { trigger: LEADING_DATE, tStart: 0, d, inParens: false, subject: "unclear", context: null, senseSpecific: false }, templates));
  }
  return { accepted: accepted.slice(0, 8), rejected: [...rejected.values()], noDate };
}

function attestationRecord(text, h, templates) {
  const span = text.slice(h.tStart, h.d.end);
  const via = (templates || []).find((t) => t.x && span.length >= 8 && t.x.includes(span));
  return {
    relation: h.trigger.relation, rule: h.trigger.rule, basis: "stated",
    year: h.d.year, year_lo: h.d.year_lo, year_hi: h.d.year_hi, precision: h.d.precision, alternatives: h.d.alternatives,
    qualifier: h.d.qualifier, period_part: h.d.period_part, era: h.d.era, ambiguous: h.d.ambiguous,
    span, span_start: h.tStart, span_end: h.d.end, date_text: h.d.date_text,
    subject_hint: h.subject, context_language: h.context || null, sense_specific: Boolean(h.senseSpecific), in_parentheses: h.inParens, via_template: via ? via.n : null,
  };
}

/** The statement most plausibly dating the headword itself, or null. Statements whose sentence is
 *  about another language's term are never primary; a leading date only when nothing else is left. */
function primaryAttestation(list) {
  const usable = list.filter((a) => a.subject_hint !== "other-language-context");
  const explicit = usable.filter((a) => a.rule !== LEADING_DATE.rule);
  const pool = explicit.length ? explicit : usable;
  if (!pool.length) return null;
  const key = (a) => a.year_lo ?? a.year ?? a.year_hi;
  return [...pool].sort((a, b) => (a.subject_hint === "headword" ? 0 : 1) - (b.subject_hint === "headword" ? 0 : 1)
    || (a.sense_specific ? 1 : 0) - (b.sense_specific ? 1 : 0) || key(a) - key(b) || a.span_start - b.span_start)[0];
}

// ---------------------------------------------------------------------------------------------
// Etymology text cleaning: Wiktextract renders two boxes into the text ahead of the prose.
// A "PIE word" box is two lines ("PIE word", " *root"); several can follow each other, the later
// ones indented by a space, and they can also sit right after the "Etymology tree" listing.
const PIE_BOX = /^\s*PIE word\n[^\n]*(?:\n|$)/;
function cleanEtymology(raw, langName, word) {
  if (!raw) return { text: "", cleaning: [] };
  let text = raw;
  const cleaning = [];
  const stripPie = () => { while (PIE_BOX.test(text)) { text = text.replace(PIE_BOX, ""); cleaning.push("pie-word-box"); } };
  stripPie();
  if (text.startsWith("Etymology tree\n")) {
    const lines = text.split("\n");
    const target = `${langName} ${word}`;
    let idx = -1;
    for (let i = lines.length - 1; i >= 1; i--) if (lines[i] === target || lines[i].startsWith(target + " ")) { idx = i; break; }
    if (idx >= 0) {
      const rest = lines[idx].slice(target.length).trim();
      text = [rest, ...lines.slice(idx + 1)].filter((line, j) => j > 0 || line).join("\n");
      cleaning.push("etymology-tree");
      stripPie(); // the box often follows the tree listing (" PIE word\n *root")
    } else cleaning.push("etymology-tree-kept");
  }
  return { text: text.trim(), cleaning };
}

/** Cuts a string to at most n UTF-16 code units without splitting a surrogate pair. */
function cut(s, n) {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

// ---------------------------------------------------------------------------------------------
// Pass 1 — stream and stage candidates.
const catName = (c) => (typeof c === "string" ? c : c && c.name) || null;
const isFormOf = (e) => {
  const senses = e.senses || [];
  return senses.length > 0 && senses.every((s) => s.form_of || (s.tags || []).includes("form-of"));
};
const DATE_HINT = /coin|attest|record|first|earliest|introduc|since|dates? (?:back|from)|dating|centur|^\s*(?:ca?\.\s*)?\d{3,4}/i;

function compact(e) {
  const tm = [];
  for (const t of e.etymology_templates || []) {
    if (!t || !t.name || !KEEP_TEMPLATE(t.name)) continue;
    const a = {};
    for (const [k, v] of Object.entries(t.args || {})) if (!/^ref/.test(k)) a[k] = cut(String(v), 300);
    tm.push({ n: t.name, a, x: t.expansion ? cut(String(t.expansion), 500) : null });
  }
  const keepCat = (c) => TOPICAL_CATEGORY.test(c) || COIN_CATEGORY_LOOSE.test(c);
  const senses = (e.senses || []).map((s) => {
    const o = {};
    const g = (s.glosses || s.raw_glosses || []).slice(-2).map((x) => cut(String(x), 400));
    if (g.length) o.g = g;
    if (s.topics && s.topics.length) o.t = s.topics;
    const c = (s.categories || []).map(catName).filter((x) => x && keepCat(x));
    if (c.length) o.c = c;
    if (s.wikidata && s.wikidata.length) o.w = s.wikidata.slice(0, 5);
    if (s.form_of || (s.tags || []).includes("form-of")) o.f = 1;
    return o;
  });
  const c = (e.categories || []).map(catName).filter((x) => x && keepCat(x));
  return { w: e.word, l: e.lang_code, L: e.lang, p: e.pos || null, n: e.etymology_number ?? null, et: e.etymology_text || null, tm, s: senses, c };
}

function isCandidate(r) {
  if (r.s.some((s) => s.t || s.c)) return true;
  if (r.c.length) return true;
  if (r.tm.some((t) => t.n === "etydate" || COIN_TEMPLATE_LOOSE.test(t.n) || own(COINAGE_KINDS, t.n))) return true;
  if (r.et && DATE_HINT.test(r.et) && /\d{3}|centur/i.test(r.et)) return true;
  return false;
}

function newShardStats() {
  return { lines: 0, prefilter_skipped: 0, parse_errors: 0, non_entry_lines: 0, prefilter_false_positive: 0, entries: {}, form_of_skipped: {}, candidates: {}, lang_names: {} };
}

async function headDump() {
  if (INPUT) return { url: `file://${INPUT}`, last_modified: null, etag: null, content_length: null };
  const response = await fetch(DUMP_URL, { method: "HEAD", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HEAD ${DUMP_URL} → ${response.status}`);
  return {
    url: DUMP_URL, last_modified: response.headers.get("last-modified"), etag: response.headers.get("etag"),
    content_length: Number(response.headers.get("content-length")) || null,
  };
}

async function* localLines(path) {
  let input;
  let child = null;
  if (path.endsWith(".gz")) { child = spawn("gzip", ["-dc", path], { stdio: ["ignore", "pipe", "inherit"] }); input = child.stdout; }
  else input = createReadStream(path);
  for await (const line of createInterface({ input, crlfDelay: Infinity })) yield line;
}

async function pass1(meta) {
  mkdirSync(SHARDS, { recursive: true });
  const statePath = join(SHARDS, "state.json");
  const saveState = () => { writeFileSync(statePath + ".part", JSON.stringify(state, null, 1)); renameSync(statePath + ".part", statePath); };
  let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  const sourceId = INPUT ? `file://${INPUT}` : DUMP_URL;
  if (state && (state.source !== sourceId || state.shard_lines !== SHARD_LINES || state.extractor_version !== EXTRACTOR_VERSION || state.limit !== LIMIT
    || (!INPUT && meta.etag && (state.etag !== meta.etag || state.last_modified !== meta.last_modified)))) {
    log("staged shards belong to another dump, slice or extractor version — restarting the stream");
    rmSync(SHARDS, { recursive: true, force: true });
    mkdirSync(SHARDS, { recursive: true });
    state = null;
  }
  if (!state) {
    state = { source: sourceId, last_modified: meta.last_modified, etag: meta.etag, content_length: meta.content_length, shard_lines: SHARD_LINES,
      limit: LIMIT, extractor_version: EXTRACTOR_VERSION, started_at: new Date().toISOString(), attempts: [], shards: [], complete: false };
  }
  if (state.complete) { log(`pass 1 already complete (${state.total_lines.toLocaleString()} lines, ${state.shards.length} shards) — skipping the stream`); return state; }
  state.attempts.push({ started_at: new Date().toISOString(), resumed_after_shards: state.shards.length });
  saveState();
  const skip = state.shards.length * SHARD_LINES;
  if (skip) log(`resuming: ${state.shards.length} shards done; skipping the first ${skip.toLocaleString()} lines without parsing`);
  const source = INPUT ? localLines(INPUT) : streamLines(DUMP_URL);
  let lineNo = 0, shard = null;
  const t0 = Date.now();
  const openShard = () => {
    const index = state.shards.length;
    const file = join(SHARDS, `cand-${String(index).padStart(4, "0")}.jsonl`);
    const fd = openSync(file + ".part", "w");
    const buf = [];
    let size = 0;
    const flush = () => { if (buf.length) { writeSync(fd, buf.join("")); buf.length = 0; size = 0; } };
    return { index, file, stats: newShardStats(), first_line: lineNo, write(s) { buf.push(s); size += s.length; if (size > 4_000_000) flush(); }, close() { flush(); closeSync(fd); renameSync(file + ".part", file); } };
  };
  const finish = (sh) => {
    sh.close();
    state.shards.push({ index: sh.index, file: sh.file.split("/").pop(), first_line: sh.first_line, last_line: lineNo, stats: sh.stats, finished_at: new Date().toISOString() });
    saveState();
  };
  try {
    for await (const line of source) {
      lineNo++;
      if (lineNo <= skip) continue;
      if (!shard) shard = openShard();
      processLine(line, shard);
      if (lineNo % SHARD_LINES === 0) {
        finish(shard);
        const c = shard.stats.candidates;
        log(`shard ${shard.index} done at line ${lineNo.toLocaleString()} (${((Date.now() - t0) / 1000).toFixed(0)}s) — candidates ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ")}`);
        shard = null;
      } else if (lineNo % 100_000 === 0) log(`  line ${lineNo.toLocaleString()}`);
      if (LIMIT && lineNo >= LIMIT) break;
    }
  } catch (error) {
    state.attempts[state.attempts.length - 1].error = String(error && error.message || error);
    state.attempts[state.attempts.length - 1].failed_at_line = lineNo;
    saveState();
    throw error;
  }
  if (shard) finish(shard);
  state.complete = true;
  state.total_lines = lineNo;
  state.completed_at = new Date().toISOString();
  saveState();
  log(`pass 1 complete: ${lineNo.toLocaleString()} lines in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return state;
}

function processLine(line, sh) {
  const st = sh.stats;
  st.lines++;
  const li = line.lastIndexOf('"lang": "');
  if (li >= 0) { const end = line.indexOf('"', li + 9); const name = line.slice(li + 9, end); if (name.length < 60) st.lang_names[name] = (st.lang_names[name] || 0) + 1; }
  if (!PREFILTER.test(line)) { st.prefilter_skipped++; return; }
  let e;
  try { e = JSON.parse(line); } catch { st.parse_errors++; return; }
  if (!e || typeof e !== "object" || !e.word || !e.lang_code) { st.non_entry_lines++; return; }
  const lang = e.lang_code;
  if (!KEEP_LANGS.has(lang)) { st.prefilter_false_positive++; return; }
  st.entries[lang] = (st.entries[lang] || 0) + 1;
  if (isFormOf(e)) { st.form_of_skipped[lang] = (st.form_of_skipped[lang] || 0) + 1; return; }
  const record = compact(e);
  if (!isCandidate(record)) return;
  st.candidates[lang] = (st.candidates[lang] || 0) + 1;
  sh.write(JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------------------------------
// Pass 2 — select and write.
/** A template term argument without its inline modifiers: "foo<t:gloss><id:x>" → "foo". Modifiers
 *  can nest ("<ety:bor<fro:x>>", "<ref:<span …>>"), so everything from the first "<" goes. */
const stripModifiers = (value) => String(value ?? "").split("<")[0].trim();
const cleanTerm = (term) => {
  if (!term) return "";
  term = stripModifiers(term);
  if (term.startsWith("w:") || term.startsWith(":")) return "";
  term = term.normalize("NFC");
  return term.replace(/[-–*\s]/g, "") ? term : "";
};
// "la:foo", "la-new:foo", "mul-tax:Foo": an inline language prefix on a term argument.
const INLINE_LANG = /^([a-z]{2,3}(?:-[a-z]{2,4})*):(.*)$/;
/** Splits a term argument into {lang, term} AFTER stripping modifiers (whose own "x:y" would
 *  otherwise be read as a language prefix); no prefix = the given default language. */
function termArg(value, defaultLang) {
  const v = stripModifiers(value);
  const m = INLINE_LANG.exec(v);
  return m ? { lang: m[1], term: m[2] } : { lang: defaultLang, term: v };
}
// {{etymon}} relation markers (":af", ":bf<conj:and>", ":lbor<ref:…>"), normalised to the same
// vocabulary as the classic templates; markers not listed keep their own name.
const ETYMON_MARKERS = {
  afeq: "surface-analysis", surf: "surface-analysis", from: "from", influence: "influence", deverbal: "deverbal", abbr: "abbreviation",
  ellip: "ellipsis", ellipsis: "ellipsis", translit: "transliteration", transliteration: "transliteration", sylabbr: "syllabic-abbreviation", acro: "acronym",
};
function etymonMarker(raw) {
  const m = stripModifiers(raw).replace(/^:/, "").trim();
  if (!m) return null;
  if (own(LINK_TYPES, m)) return LINK_TYPES[m];
  if (own(MORPH_TYPES, m)) return MORPH_TYPES[m];
  if (own(ETYMON_MARKERS, m)) return ETYMON_MARKERS[m];
  return m.replace(/\s+/g, "-");
}

// Old-style etymology-only codes still found in templates.
const LEGACY_LANG = { "LL.": "la-lat", "ML.": "la-med", "NL.": "la-new", "VL.": "la-vul" };

function derivationOf(templates, lang) {
  const out = [], seen = new Set();
  const push = (type, template, rawLang, source_term) => {
    const term = cleanTerm(source_term);
    const source_lang = own(LEGACY_LANG, rawLang) ? LEGACY_LANG[rawLang] : rawLang;
    if (!term || !source_lang) return;
    const key = `${type}|${source_lang}|${term}`;
    if (seen.has(key) || out.length >= 16) return;
    seen.add(key);
    out.push({ type, template, source_lang, source_term: term });
  };
  for (const t of templates) {
    const a = t.a || {};
    if (own(LINK_TYPES, t.n)) push(LINK_TYPES[t.n], t.n, stripModifiers(a["2"]), a["3"]);
    else if (own(MORPH_TYPES, t.n)) {
      // {{surf|+suf|en|abduct|-ion}}: a leading "+type" argument shifts the language and parts by one.
      const shift = /^\+/.test(a["1"] || "") ? 1 : 0;
      const base = a[String(1 + shift)] || lang;
      for (let i = 2; i <= 9; i++) {
        const value = a[String(i + shift)];
        if (!value) continue;
        const part = termArg(value, a[`lang${i - 1}`] || base);
        push(MORPH_TYPES[t.n], t.n, part.lang, part.term);
      }
    } else if (t.n === "etymon") {
      const base = a["1"] || lang;
      let kind = "from"; // terms before any marker: relation not stated
      for (let i = 2; i <= 12; i++) {
        const value = a[String(i)];
        if (!value) continue;
        if (value.startsWith(":")) { kind = etymonMarker(value) || kind; continue; }
        const part = termArg(value, base);
        push(kind, "etymon", part.lang, part.term);
      }
    }
  }
  return out;
}

function coinageOf(templates, cats, langName) {
  const list = [], seen = new Set();
  for (const t of templates) {
    if (!own(COINAGE_KINDS, t.n)) continue;
    const kind = COINAGE_KINDS[t.n];
    const a = t.a || {};
    const o = {
      source: "template", template: t.n, kind, coiner: null, coiner_wikidata: null, honoree: null, honoree_wikidata: null,
      nationality: a.nat || null, occupation: ["occ", "occ2", "occ3", "occ4"].map((k) => a[k]).filter(Boolean).join(", ") || null,
      year: null, year_lo: null, year_hi: null, year_precision: null, year_alternatives: null, year_qualifier: null, year_raw: null, year_basis: null,
      ex_nihilo: a.exnihilo ? true : false, expansion: t.x || null, category: null,
    };
    const who = a["2"] && a["2"] !== "-" ? a["2"] : null;
    if (kind === "coined") { o.coiner = who; if (who && /^Q\d+$/.test(who)) o.coiner_wikidata = who; }
    if (kind === "named-after") { o.honoree = who; if (who && /^Q\d+$/.test(who)) o.honoree_wikidata = who; }
    const raw = a.in || a.date || a.year || null;
    if (raw) {
      o.year_raw = raw;
      const d = parseDateString(raw);
      if (d) { o.year = d.year; o.year_lo = d.year_lo; o.year_hi = d.year_hi; o.year_precision = d.precision; o.year_alternatives = d.alternatives; o.year_qualifier = d.qualifier; o.year_basis = "stated"; }
    }
    const key = JSON.stringify([o.template, o.coiner, o.honoree, o.year_raw, o.expansion]);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(o);
  }
  for (const c of cats) {
    const m = COIN_CATEGORY.exec(c);
    if (!m || m[1] !== langName) continue; // "English coinages" on a French entry belongs to another section
    const kind = m[3] ? "coined" : CATEGORY_KIND[m[2]];
    if (!kind || list.some((o) => o.kind === kind)) continue;
    list.push({ source: "category", template: null, kind, coiner: m[3] || null, coiner_wikidata: null, honoree: null, honoree_wikidata: null, nationality: null,
      occupation: null, year: null, year_lo: null, year_hi: null, year_precision: null, year_alternatives: null, year_qualifier: null, year_raw: null, year_basis: null,
      ex_nihilo: /ex nihilo/.test(c), expansion: null, category: c });
  }
  list.sort((a, b) => COINAGE_PRIORITY.indexOf(a.kind) - COINAGE_PRIORITY.indexOf(b.kind) || (a.source === "template" ? 0 : 1) - (b.source === "template" ? 0 : 1));
  return list;
}

const wikiUrl = (word, langName) => {
  const enc = (s) => encodeURIComponent(s.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":");
  return `https://en.wiktionary.org/wiki/${enc(word)}#${enc(langName)}`;
};
const clip = (s, n) => (s.length > n ? cut(s, n - 1) + "…" : s);
const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };

function newSelectStats() {
  return {
    candidates_read: {}, kept: 0, dropped_no_reason: 0, kept_per_reason: {}, kept_per_language: {}, kept_per_field: {}, kept_per_pos: {}, kept_with_fields: 0,
    kept_reason_combinations: {}, attestations: { entries_with_primary: 0, accepted_total: 0, per_relation: {}, per_rule: {}, per_precision: {}, primary_per_relation: {},
      primary_per_precision: {}, primary_per_century: {}, subject_hint: {}, via_template: {}, leading_date_only_entries: 0 },
    rejections: { per_reason: {}, per_rule: {}, samples: {} }, triggers_without_date: {}, coinage: { entries_with_coinage: 0, per_kind: {}, per_source: {},
      with_year: 0, year_raw_unparsed: 0, with_coiner_wikidata: 0, template_arg_keys: {} },
    etymology: { with_text: 0, truncated: 0, cleaning: {} }, topics_seen: {}, topical_categories_mapped: {}, topical_categories_unmapped: {},
    topic_only_stemm_senses: { note: "entries whose sense topics would map to a STEMM field but that carry no STEMM topical category (not counted as STEMM)", entries: 0, kept_for_other_reasons: 0, samples: [] },
    id_collisions: 0, unknown_templates_loose_match: {},
    kept_per_field_evidence_level: {},
    entry_level_fields_not_used: 0,
    other_language_categories_ignored: { note: "STEMM-mapped topical categories whose language prefix is not the entry's own code (e.g. es:Chemistry on an English entry); ignored for fields. Counted over all candidates.", entries: 0, entries_left_without_field: 0, entries_dropped: 0, per_prefix_pair: {} },
    rejections_all_candidates: { note: "date rejections over all candidates, kept or not (rejections.* counts kept entries only)", per_reason: {} },
  };
}

function select(rec, S, ids) {
  const lang = rec.l;
  bump(S.candidates_read, lang);
  const topics = new Set(), senseCats = new Set();
  // STEMM evidence: only topical categories whose language prefix is the entry's own code ("en:Medicine"
  // on an English entry); others ("es:Chemistry", "enm:Medicine" on an English entry) come from
  // other-language material on the page and are ignored (counted). Sense-level categories are preferred;
  // the entry-level ones (page-wide {{C}}/{{topics}} that Wiktextract cannot pin to a sense) are used
  // only when no sense carries one, and such entries are flagged field_evidence_level = "entry".
  const senseEvidence = new Map(), entryEvidence = new Map(), foreignCats = new Set();
  const addField = (map, f, ev) => { if (!map.has(f)) map.set(f, new Set()); map.get(f).add(ev); };
  /** Fields of a topical category of the entry's own language, else [] (foreign ones remembered). */
  const stemmFieldsOf = (c) => {
    const m = TOPICAL_CATEGORY.exec(c);
    if (!m) return [];
    const fields = categoryFields(m[2]);
    if (fields.length && m[1] !== lang) { foreignCats.add(c); return []; }
    return fields;
  };
  const senseIsStemm = [];
  let topicOnlyFields = false;
  for (const s of rec.s) {
    let stemm = false;
    for (const t of s.t || []) topics.add(t);
    for (const c of s.c || []) {
      senseCats.add(c);
      for (const f of stemmFieldsOf(c)) { addField(senseEvidence, f, `category:${c}`); stemm = true; }
    }
    senseIsStemm.push(stemm && !s.f);
    if (!stemm && (s.t || []).some((t) => TOPIC_FIELDS[t])) topicOnlyFields = true;
  }
  const entryCats = new Set(rec.c);
  for (const c of entryCats) for (const f of stemmFieldsOf(c)) addField(entryEvidence, f, `category:${c}`);
  const fieldLevel = senseEvidence.size ? "sense" : entryEvidence.size ? "entry" : null;
  const fieldEvidence = fieldLevel === "sense" ? senseEvidence : entryEvidence;
  const fieldCats = new Set([...fieldEvidence.values()].flatMap((ev) => [...ev].map((x) => x.slice("category:".length))));
  const allCats = new Set([...entryCats, ...senseCats]);
  for (const t of topics) bump(S.topics_seen, t);

  const coinages = coinageOf(rec.tm, allCats, rec.L);
  const { text, cleaning } = cleanEtymology(rec.et, rec.L, rec.w);
  const found = findAttestations(text, lang, rec.w, rec.tm);
  for (const r of found.noDate) bump(S.triggers_without_date, r);
  for (const r of found.rejected) bump(S.rejections_all_candidates.per_reason, r.reason);

  const reasons = [];
  if (fieldEvidence.size) reasons.push("stemm-category");
  if (coinages.some((c) => c.source === "template")) reasons.push("coinage-template");
  if (coinages.some((c) => c.source === "category")) reasons.push("coinage-category");
  if (found.accepted.some((a) => a.rule !== LEADING_DATE.rule && a.subject_hint !== "other-language-context")) reasons.push("dated-etymology");
  if (foreignCats.size) {
    const F = S.other_language_categories_ignored;
    F.entries++;
    if (!fieldEvidence.size) F.entries_left_without_field++;
    if (!reasons.length) F.entries_dropped++;
    for (const c of foreignCats) bump(F.per_prefix_pair, `${lang}<-${TOPICAL_CATEGORY.exec(c)[1]}`);
  }
  if (fieldLevel === "sense" && [...entryEvidence.keys()].some((f) => !senseEvidence.has(f))) S.entry_level_fields_not_used++;
  if (topicOnlyFields && !fieldEvidence.size) {
    S.topic_only_stemm_senses.entries++;
    if (reasons.length) S.topic_only_stemm_senses.kept_for_other_reasons++;
    else if (S.topic_only_stemm_senses.samples.length < 40) {
      const s = rec.s.find((x) => (x.t || []).some((t) => TOPIC_FIELDS[t]));
      S.topic_only_stemm_senses.samples.push({ word: rec.w, lang, topics: s.t, gloss: s.g ? clip(String(s.g[s.g.length - 1]), 120) : null });
    }
  }
  if (!reasons.length) { S.dropped_no_reason++; return null; }

  // Stats that only make sense for kept entries.
  for (const r of found.rejected) {
    bump(S.rejections.per_reason, r.reason); bump(S.rejections.per_rule, r.rule);
    const samples = (S.rejections.samples[r.reason] ||= []);
    if (samples.length < 25) samples.push({ word: rec.w, lang, rule: r.rule, span: clip(r.span, 240) });
  }
  for (const c of allCats) {
    const m = TOPICAL_CATEGORY.exec(c);
    if (m && m[1] === lang) bump(categoryFields(m[2]).length ? S.topical_categories_mapped : S.topical_categories_unmapped, m[2]);
  }

  const fields = [...fieldEvidence.keys()].sort();
  const glossOrder = rec.s.map((s, i) => ({ s, i, stemm: senseIsStemm[i] })).filter((x) => x.s.g && !x.s.f);
  glossOrder.sort((a, b) => (b.stemm ? 1 : 0) - (a.stemm ? 1 : 0) || a.i - b.i);
  const glosses = [];
  for (const { s } of glossOrder) {
    const g = clip(String(s.g[s.g.length - 1]).trim(), 200);
    if (g && !glosses.includes(g)) glosses.push(g);
    if (glosses.length >= 3) break;
  }
  const wikidata = [];
  for (const { s } of glossOrder) for (const q of s.w || []) if (!wikidata.includes(q) && wikidata.length < 5) wikidata.push(q);

  const keptCats = [...allCats].filter((c) => fieldCats.has(c) || (!TOPICAL_CATEGORY.test(c) && (COIN_CATEGORY.test(c) || COIN_CATEGORY_LOOSE.test(c)))).sort();
  const primary = primaryAttestation(found.accepted);
  const coinage = coinages[0] || null;

  let id = `${lang}:${rec.w}:${rec.p || "?"}:${rec.n ?? 1}`;
  if (ids.has(id)) { S.id_collisions++; let k = 2; while (ids.has(`${id}~${k}`)) k++; id = `${id}~${k}`; }
  ids.add(id);

  const out = {
    id, word: rec.w, lang, language: rec.L, pos: rec.p, etymology_number: rec.n,
    reasons, fields, field_evidence: Object.fromEntries([...fieldEvidence.entries()].sort().map(([f, ev]) => [f, [...ev].sort().slice(0, 6)])), field_evidence_level: fieldLevel,
    topics: [...topics].sort(), glosses, sense_count: rec.s.length, sense_wikidata: wikidata,
    etymology_text: text ? cut(text, 800) : null, etymology_text_length: text.length, etymology_text_truncated: text.length > 800,
    etymology_text_cleaning: cleaning,
    coinage, coinage_other: coinages.slice(1, 6),
    attestation: primary, attestations: found.accepted,
    date_basis: primary || (coinage && coinage.year_basis) ? "stated" : "unknown",
    derivation: derivationOf(rec.tm, lang),
    categories: keptCats.slice(0, 40), url: wikiUrl(rec.w, rec.L),
  };

  S.kept++;
  bump(S.kept_per_language, lang);
  for (const r of reasons) bump(S.kept_per_reason, r);
  bump(S.kept_reason_combinations, reasons.join("+"));
  for (const f of fields) bump(S.kept_per_field, f);
  if (fields.length) { S.kept_with_fields++; bump(S.kept_per_field_evidence_level, fieldLevel); }
  bump(S.kept_per_pos, rec.p || "?");
  if (text) S.etymology.with_text++;
  if (out.etymology_text_truncated) S.etymology.truncated++;
  for (const c of cleaning) bump(S.etymology.cleaning, c);
  for (const a of found.accepted) {
    S.attestations.accepted_total++;
    bump(S.attestations.per_relation, a.relation); bump(S.attestations.per_rule, a.rule); bump(S.attestations.per_precision, a.precision);
    bump(S.attestations.subject_hint, a.subject_hint); if (a.via_template) bump(S.attestations.via_template, a.via_template);
  }
  if (primary) {
    S.attestations.entries_with_primary++;
    bump(S.attestations.primary_per_relation, primary.relation); bump(S.attestations.primary_per_precision, primary.precision);
    const y = primary.year_lo ?? primary.year ?? primary.year_hi;
    bump(S.attestations.primary_per_century, y < 0 ? `BCE ${Math.ceil(-y / 100)}` : `${Math.floor((y - 1) / 100) + 1}`);
    if (primary.rule === LEADING_DATE.rule) S.attestations.leading_date_only_entries++;
  }
  if (coinage) {
    S.coinage.entries_with_coinage++;
    for (const c of coinages) { bump(S.coinage.per_kind, c.kind); bump(S.coinage.per_source, c.source); }
    if (coinages.some((c) => c.year_basis)) S.coinage.with_year++;
    if (coinages.some((c) => c.year_raw && !c.year_basis)) S.coinage.year_raw_unparsed++;
    if (coinages.some((c) => c.coiner_wikidata)) S.coinage.with_coiner_wikidata++;
  }
  for (const t of rec.tm) {
    if (t.n === "coin" || t.n === "coinage" || t.n === "named-after") for (const k of Object.keys(t.a || {})) bump(S.coinage.template_arg_keys, `${t.n}:${k}`);
    if (!own(COINAGE_KINDS, t.n) && !own(LINK_TYPES, t.n) && !own(MORPH_TYPES, t.n) && t.n !== "etydate" && t.n !== "etymon") bump(S.unknown_templates_loose_match, t.n);
  }
  return out;
}

const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));

async function pass2(state, meta, info) {
  // Language names seen anywhere in the dump (for "in German …" / "From French x (…)" tests).
  const names = {};
  for (const sh of state.shards) for (const [k, v] of Object.entries(sh.stats.lang_names || {})) names[k] = (names[k] || 0) + v;
  LANG_NAMES = new Set(Object.keys(names).filter((n) => /^\p{Lu}/u.test(n)));
  log(`pass 2: ${state.shards.length} shards, ${LANG_NAMES.size} language names`);
  mkdirSync(OUT, { recursive: true });
  const S = newSelectStats();
  const ids = new Set();
  const termsPath = join(OUT, "terms.jsonl");
  const fd = openSync(termsPath + ".part", "w");
  let buf = [], size = 0;
  const flush = () => { if (buf.length) { writeSync(fd, buf.join("")); buf = []; size = 0; } };
  for (const sh of state.shards) {
    const input = createReadStream(join(SHARDS, sh.file));
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line) continue;
      const out = select(JSON.parse(line), S, ids);
      if (out) { const s = JSON.stringify(out) + "\n"; buf.push(s); size += s.length; if (size > 4_000_000) flush(); }
    }
  }
  flush();
  closeSync(fd);
  renameSync(termsPath + ".part", termsPath);

  // Stream totals.
  const T = newShardStats();
  for (const sh of state.shards) {
    const s = sh.stats;
    for (const k of ["lines", "prefilter_skipped", "parse_errors", "non_entry_lines", "prefilter_false_positive"]) T[k] += s[k];
    for (const k of ["entries", "form_of_skipped", "candidates"]) for (const [lang, v] of Object.entries(s[k])) bump(T[k], lang, v);
  }
  delete T.lang_names;
  const stats = {
    generated_at: new Date().toISOString(), selector_version: SELECTOR_VERSION, extractor_version: EXTRACTOR_VERSION, test_slice: TEST ? { input: INPUT, limit: LIMIT } : null,
    stream: { ...T, total_lines: state.total_lines, shards: state.shards.length, language_names_seen: LANG_NAMES.size },
    entries_scanned: Object.values(T.entries).reduce((a, b) => a + b, 0),
    selection: {
      ...S,
      topics_seen: top(S.topics_seen, 300), topical_categories_mapped: top(S.topical_categories_mapped, 400),
      topical_categories_unmapped: top(S.topical_categories_unmapped, 400), kept_per_pos: top(S.kept_per_pos, 40),
      unknown_templates_loose_match: top(S.unknown_templates_loose_match, 60), coinage: { ...S.coinage, template_arg_keys: top(S.coinage.template_arg_keys, 80) },
    },
  };
  writeFileSync(join(OUT, "stats.json"), JSON.stringify(stats, null, 2) + "\n");
  writeFileSync(join(OUT, "FORMAT.md"), FORMAT_MD);

  const failures = [];
  for (const a of state.attempts) if (a.error) failures.push({ stage: "stream", started_at: a.started_at, error: a.error, failed_at_line: a.failed_at_line, resumed_after_shards: a.resumed_after_shards });
  if (!info.page_ok) failures.push({ stage: "kaikki-info-page", url: INFO_URL, error: "could not fetch or parse the dump-date statement" });
  writeManifest(OUT, {
    source: SOURCE,
    title: "Wiktionary STEMM terms and coinages with stated dates (en, fr, es, hi, gu)",
    urls: { dump: DUMP_URL, dump_info_page: INFO_URL, wiktionary: "https://en.wiktionary.org/", wiktextract: "https://github.com/tatuylonen/wiktextract", kaikki: "https://kaikki.org/" },
    license: "CC BY-SA 4.0 and GFDL (Wiktionary text); derived records inherit CC BY-SA 4.0 — attribute and share alike",
    attribution: "Wiktionary contributors; extracted with Wiktextract (Ylonen 2022) via kaikki.org",
    citation: "Tatu Ylonen. 2022. Wiktextract: Wiktionary as Machine-Readable Structured Data. In Proceedings of LREC 2022, pp. 1317–1325.",
    dump: {
      url: meta.url, http_last_modified: state.last_modified, http_etag: state.etag, http_content_length: state.content_length,
      kaikki_page_states_enwiktionary_dump_date: info.dump_date, kaikki_page_fetched_for: INFO_URL,
      streamed_started_at: state.started_at, streamed_completed_at: state.completed_at, stream_attempts: state.attempts.length, total_lines: state.total_lines,
    },
    script: SCRIPT,
    user_agent: USER_AGENT,
    contact: CONTACT,
    method: [
      "Pass 1 streams the gzip dump through curl | gzip -dc (lib.mjs streamLines); nothing of the dump is stored. Each line is pre-filtered by a string test for \"lang_code\": \"en|fr|es|hi|gu\", then parsed; the parsed entry's own lang_code decides (raw lines also contain translations' and descendants' lang_codes).",
      "Non-entry lines (redirect stubs without word/lang_code) and inflection-only entries (every sense form_of) are skipped and counted. Remaining entries with any topic, topical category, coinage-type template/category, etydate template, or date words in the etymology are staged as compact candidates in cache/wiktionary-coinage-tmp/shards (resumable checkpoints).",
      "Pass 2 keeps a candidate if ANY of: (a) a topical category of the entry's own language (prefix = entry lang code) maps to a STEMM field — sense-level categories preferred, entry-level ones used only when no sense has one (field_evidence_level); (b) an etymology template of coinage type (coin/coinage, named-after, neologism, univerbation, blend, back-formation, clipping, calque, partial calque) or a coinage category ('English terms coined by …', 'English coinages', 'English eponyms', …); (c) an explicit date statement in the etymology text (coined / first attested / first recorded / first used / attested since|from / earliest known use / first appeared / introduced / dates from / attested in …) whose year survives the rejection tests.",
      "Dates are only read from text that states them, by regex, and every accepted date carries the exact substring it came from (span) and its character offsets. Nothing is inferred: no midpoints, no narrowing by early/mid/late, no dates from life spans (named-after born/died args are ignored), no dates from etymons' attestations.",
      "The etymology text is cleaned of two Wiktextract-rendered boxes (\"PIE word\" and the \"Etymology tree\" listing) that precede the prose — PIE boxes before and after the tree; offsets refer to the cleaned text. Every cut (template args 300, expansions 500, glosses 400/200, etymology 800 UTF-16 units) stops before a split surrogate pair.",
      "Derivations: inline <…> modifiers are stripped from a template argument before an inline lang: prefix is split off; prefix-less etymon/morphology parts take the template's language; etymon relation markers are normalised to the classic template vocabulary.",
    ],
    selection_criteria: {
      languages: [...KEEP_LANGS],
      stemm_fields: Object.keys(FIELD_TOPICS),
      stemm_topic_map: Object.fromEntries(Object.entries(FIELD_TOPICS).map(([f, t]) => [f, t])),
      stemm_category_extra_map: CATEGORY_EXTRA,
      coinage_templates: COINAGE_KINDS,
      date_triggers: TRIGGERS.map((t) => ({ rule: t.rule, relation: t.relation, mode: t.mode, regex: String(t.re) })).concat([{ rule: LEADING_DATE.rule, relation: "other", mode: "leading", regex: "etymology starts with a date expression followed by : ; or , — recorded on kept entries, never a reason to keep" }]),
      skipped: ["inflection-only entries (all senses form_of)", "non-entry lines", "languages other than en/fr/es/hi/gu (incl. Translingual)", "generic parent topics such as sciences / natural-sciences alone"],
    },
    counts: {
      lines_streamed: state.total_lines, entries_scanned_in_kept_languages: stats.entries_scanned, entries_scanned_per_language: T.entries,
      inflection_entries_skipped: T.form_of_skipped, candidates_staged: T.candidates, terms_kept: S.kept, kept_per_language: S.kept_per_language,
      kept_per_reason: S.kept_per_reason, kept_per_field: S.kept_per_field, entries_with_stated_attestation: S.attestations.entries_with_primary,
      attestations_accepted: S.attestations.accepted_total, attestation_rejections: S.rejections.per_reason, attestation_rejections_all_candidates: S.rejections_all_candidates.per_reason,
      entries_with_coinage: S.coinage.entries_with_coinage, kept_per_field_evidence_level: S.kept_per_field_evidence_level,
      other_language_categories_ignored: { entries: S.other_language_categories_ignored.entries, left_without_field: S.other_language_categories_ignored.entries_left_without_field, dropped: S.other_language_categories_ignored.entries_dropped },
      attestations_per_precision: S.attestations.per_precision,
    },
    coverage: {
      note: "All of English Wiktionary's entries in the five languages as present in this Wiktextract dump; dating covers only entries whose etymology text states a date.",
      languages: S.kept_per_language,
      share_of_kept_with_stated_date: S.kept ? Number((S.attestations.entries_with_primary / S.kept).toFixed(4)) : 0,
      share_of_kept_with_stemm_field: S.kept ? Number((S.kept_with_fields / S.kept).toFixed(4)) : 0,
    },
    caveats: [
      "Wiktionary is crowd-edited; dates in etymology prose are Wiktionary's statements (often from the OED, Etymonline, TLFi or Merriam-Webster), not verified here. 'first attested' means first attestation known to the editor.",
      "A date is attached to the statement it appears in, not proven to be about the headword. subject_hint is 'headword' only when the clause before the trigger is empty or made of words like 'the term was'; 'other-language-context' when the sentence before the trigger last names another language ('Borrowed from German Genom, coined by … Hans Winkler in 1920' dates the German word) — such statements are listed but never become the primary attestation nor a reason to keep; otherwise 'unclear'.",
      "Rejected (and counted in stats.json with samples): years in parentheses after a name that look like life dates or a work's run (also '(1552 or 1553 – 1599)', '(1607/8–1661)', '(3 May 1914 – 27 March 2004)', '(1895-1978, …)'), years after or in a parenthesis opened by born/died/b./d./fl./floruit/baptized/baptised/christened/buried/reigned, operating/office periods ('(operating 1759–1982)'), statements inside parentheses after a term in another language ('From French abrasion (attested since 1611)'), dates qualified 'in German'/'in Latin' etc., implausible years (> current year), numbers followed by units, 'turn of the century'.",
      "Window matching takes the first acceptable date in the trigger's clause (≤220 characters); a clause that mentions another dated event before the relevant one can be mis-assigned — check 'span'.",
      "'the 1500s' is read as the century 1500–1599 (ambiguous=true; the decade reading lies inside the range). Centuries are given as e.g. 1600–1699 for the 17th century; BCE years are negative (historical numbering, no year 0; 1 BCE = -1).",
      "Alternatives joined by 'or' or '/' ('1943 or 1944', '1841/1842', 'the 1620s/1630s', 'the 13th or 14th century') have precision 'alternatives' with each listed in 'alternatives'; year_lo/year_hi span them. Ranges whose ends carry period words are read whole ('the late 15th to the early 17th centuries' → 1400–1699); 'ante YEAR' is qualifier 'before'.",
      "Qualifiers 'early/mid/late' are recorded in period_part but do not narrow year_lo/year_hi. 'before/by/at least X' set year_lo = null (unbounded) and year_hi = X; 'circa' leaves year_lo = year_hi = year.",
      "'leading-date' attestations (an etymology opening with a bare date, a TLFi-style convention common on French entries) are recorded but their relation is not stated in the text, so they never qualify an entry on their own and are used as the primary attestation only when nothing else is present.",
      "Coinage templates: 'coiner' is the template argument as given (it may be a Wikidata Q-id, then copied to coiner_wikidata); 'expansion' is Wiktionary's rendered sentence. Coinage years come only from an explicit in=/date=/year= argument.",
      "STEMM fields come only from Wiktionary topical categories of the entry's own language ('en:Medicine' on an English entry, 'fr:Computing' on a French one; other languages' categories that Wiktextract attaches from the same page are ignored and counted in stats.selection.other_language_categories_ignored). Sense-level categories (from a sense's context label) are preferred; an entry whose only STEMM evidence is entry-level (page-wide topic templates, which Wiktextract can repeat on sibling sections of the page) has field_evidence_level 'entry' — weaker evidence. Wiktextract's sense 'topics' are output but not used for fields: they are an expanded closure of the label ('(logic)' carries mathematics, '(technical)' engineering, '(drugs, slang)' pharmacology). stats.selection.topic_only_stemm_senses counts what topic-based mapping would have added. An entry is kept if ANY sense is STEMM, so polysemous everyday words appear (glosses list STEMM senses first). Internet slang is in computing because Wiktionary's 'Internet' category is.",
      "Glosses are cut at 200 UTF-16 units (ending with '…'); etymology_text at 800 (etymology_text_truncated); no cut splits a surrogate pair; span offsets refer to the full cleaned text.",
      "subject_hint 'headword' is mechanical: a sentence-initial trigger after a chain of etymons can date the etymon (e.g. a Medieval Latin source 'first recorded … (800 AD)' on an English entry). A coinage template can describe the source-language word (English genome dated 1920 by the template on German Genom): check coinage.expansion.",
      "The stream can lose a dump line that fails JSON.parse (stats.stream.parse_errors).",
      "The kaikki.org raw dump is regenerated weekly; MANIFEST.dump records the HTTP Last-Modified/ETag of the file streamed and the dump date stated on kaikki's page (they can differ).",
      "Hindi and Gujarati entries on English Wiktionary rarely carry topics or dated etymologies; their counts are small.",
    ],
    failures,
    revisions: REVISIONS,
    caches: { candidate_shards: SHARDS, note: "Derived compact candidates kept so pass 2 can be re-run without re-streaming; safe to delete." },
  });
  log(`kept ${S.kept.toLocaleString()} terms (${Object.entries(S.kept_per_language).map(([k, v]) => `${k} ${v}`).join(", ")}); ${S.attestations.entries_with_primary.toLocaleString()} with a stated date`);
}

async function kaikkiInfo() {
  try {
    const body = await fetchCached(INFO_URL, { cache: !TEST ? false : true, tries: 3 });
    if (!body) return { page_ok: false, dump_date: null };
    const text = body.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const m = /extracted from the\s+enwiktionary dump\s+dated\s+(\d{4}-\d{2}-\d{2})/i.exec(text);
    return { page_ok: Boolean(m), dump_date: m ? m[1] : null };
  } catch { return { page_ok: false, dump_date: null }; }
}

// ---------------------------------------------------------------------------------------------
// What changed between published builds, and why (copied into MANIFEST.revisions).
const REVISIONS = [
  {
    version: "selector v2 / extractor v2", date: "2026-10-04",
    why: "Fixes for the defects found by the 2026-10-04 data audits of the v1 build (201,085 records). The v2 build streams the same kaikki dump (ETag \"6aba85a7-b1aec2df\"); compare before_v1 with MANIFEST.counts.",
    before_v1: {
      terms_kept: 201085, entries_with_stated_attestation: 9386, attestations_accepted: 10133, kept_with_stemm_field: 155856, entries_with_coinage: 47513,
      entries_with_other_language_category_evidence: 878, entries_whose_only_stemm_evidence_was_another_language: 557, life_date_attestations_primary: 7, life_date_attestations_secondary: 2,
      records_starting_with_pie_box: 9, records_with_unpaired_surrogate: 3, derivation_items: 212995, derivation_items_malformed: "~1,371 items on 968 entries (audit count)",
      attestation_rejections_kept_entries: { "parenthetical-range-after-name": 224, "person-dates-keyword": 35, "parenthetical-other-language-term": 43, "other-language": 26, "not-a-year": 12, "implausible-year": 26, "vague-turn-of-century": 2 },
    },
    changes: [
      "Life dates no longer become attestations: baptized/baptised/bapt./christened/buried added to the person-date keywords; a parenthesis OPENING with born/died/b./d./fl./floruit/baptized/reigned … rejects any date in it ('(born Louis Thomas Hardin, 1916–1999)', '(baptized 1564; died 1616)'); the parenthesis' first segment is tested as a life span with 'YYYY or YYYY', 'YYYY/Y', day-month dates and a trailing ', …' allowed ('(1552 or 1553 – 1599)', '(1607/8–1661)', '(3 May 1914 – 27 March 2004)', '(1895-1978, the …)'); '(operating 1759–1982)'-type periods get the new reason period-keyword. v1 had 7 primary + 2 secondary life-date attestations (v1 lines 11552, 26902, 77869, 91846, 149664, 173000, 180174; 106958–106959) and 1 operating period (85370); none remain. Rejections over all candidates are now counted (stats.selection.rejections_all_candidates).",
      "Derivations: inline <…> modifiers are stripped BEFORE a lang: prefix is split (v1 split 'term<id:gloss>' at the modifier's colon); prefix-less etymon parts take the entry's language (v1 dropped them); etymon markers normalised (af → affix, afeq → surface-analysis, bf → back-formation, clip → clipping, …; <conj:…>, <unc>, <ref:…> dropped); inline lang: prefixes on affix/compound parts are honoured; {{surf|+suf|en|…}} argument shift handled; legacy LL./ML./NL./VL. mapped to la-lat/la-med/la-new/la-vul.",
      "STEMM fields: a topical category counts only when its language prefix equals the entry's lang (v1: 878 entries carried another language's category, 557 had no other STEMM evidence); sense-level categories preferred, entry-level ones used only when no sense has one; new field field_evidence_level ('sense' | 'entry'). categories[] no longer lets topical categories through the loose coinage regex (en:Coins). Coinage categories must name the entry's own language.",
      "Dates: 'ante YEAR' → qualifier 'before'; ranges whose ends carry period words read whole ('the late 15th to the early 17th centuries', 'late nineteenth through early twentieth centuries', 'the late 1980s and early 1990s'); 'the 1440–1450s' → 1440–1459; 'or' and '/' alternatives kept as precision 'alternatives' with an 'alternatives' list (v1 read '1943 or 1944' as a range and dropped the second of '1841/1842', 'the 1620s/1630s', 'c. 1630 or c. 1642'); 'through' accepted as a range separator; capitalised period words ('Mid 17th century; …') recognised. coinage objects gain year_alternatives.",
      "Truncation never splits a surrogate pair (v1: 3 records ended etymology_text in an unpaired \\ud800 that strict JSON decoders reject); pass-1 cuts too, hence extractor v2 and a fresh stream.",
      "'PIE word' boxes are stripped again after the 'Etymology tree' listing, and indented repeat boxes are recognised (v1: 9 records still began with a box).",
      "Coinage template aliases backformation, clip of, clipped compound, clipcomp (of) mapped to their kinds.",
      "FORMAT.md corrections carried over from the audit's hand edits: etymology_number is a string; lengths/offsets are UTF-16 code units; id uses '?' for a missing POS.",
    ],
  },
];

const FORMAT_MD = `# wiktionary-coinage — output format

Produced by \`${SCRIPT}\` (selector v${SELECTOR_VERSION}, extractor v${EXTRACTOR_VERSION}) from the kaikki.org raw
Wiktextract dump of English Wiktionary. Licence: CC BY-SA 4.0 / GFDL — attribute
"Wiktionary contributors; extracted with Wiktextract (Ylonen 2022) via kaikki.org" and share alike.

Files in this folder:

| file | what |
|---|---|
| \`terms.jsonl\` | one JSON object per kept Wiktionary entry (UTF-8, one per line, dump order) |
| \`stats.json\` | counts: stream totals, kept per reason/language/field/POS, attestations per relation/rule/precision, rejections per reason with samples, unmapped topics |
| \`MANIFEST.json\` | provenance: URLs, licence, attribution, dump Last-Modified/ETag, method, selection criteria (incl. the exact regexes), counts, coverage, caveats, failures |
| \`FORMAT.md\` | this file |
| \`fetch.log\` | log of the last run (not data; MANIFEST/stats are authoritative) |

An "entry" is one Wiktextract record: one (word, language, part of speech, etymology section).
The same word can therefore appear several times (noun and verb; two etymologies) — \`id\` keeps them apart.

## terms.jsonl fields

Every field is always present; "nullable" means the value can be \`null\`.

| field | type | meaning / provenance |
|---|---|---|
| \`id\` | string | \`<lang>:<word>:<pos or ?>:<etymology_number or 1>\`, with \`~2\`, \`~3\` appended on the rare collision (count in stats.selection.id_collisions). Stable for a given dump, not across dumps. A word could contain \`:\`, so prefer the \`word\`/\`pos\` fields over splitting the id. |
| \`word\` | string | headword as in Wiktionary (NFC as given; may contain spaces, capitals, diacritics). |
| \`lang\` | string | Wiktionary language code of the entry: \`en\`, \`fr\`, \`es\`, \`hi\`, \`gu\`. |
| \`language\` | string | language name (\`English\`, \`French\`, …). |
| \`pos\` | string, nullable | Wiktextract part of speech (\`noun\`, \`verb\`, \`adj\`, \`name\` = proper noun, \`phrase\`, \`prefix\`, …). |
| \`etymology_number\` | string, nullable | which "Etymology N" section on the page, as Wiktextract gives it: a STRING of digits (\`"1"\`, \`"2"\`, …), not a JSON integer; null when the page has one etymology. |
| \`reasons\` | string[] (≥1) | why kept: \`stemm-category\` (a Wiktionary topical category of the entry or a sense maps to a STEMM field), \`coinage-template\`, \`coinage-category\`, \`dated-etymology\` (≥1 accepted explicit date statement whose \`subject_hint\` is not \`other-language-context\`; \`leading-date\` alone does not count). |
| \`fields\` | string[] | STEMM fields from topical categories only, sorted, from: \`mathematics\`, \`computing\`, \`physics\`, \`chemistry\`, \`astronomy\`, \`earth-sciences\`, \`biology\`, \`medicine\`, \`engineering-technology\`. May be \`[]\` (kept only for coinage/date). Several when topics span fields. Only categories whose language prefix equals the entry's \`lang\` count (an \`es:Chemistry\` or \`enm:Medicine\` category on an English entry comes from other-language material on the page and is ignored). Sense-level categories are preferred: when any sense carries a STEMM category, \`fields\` come from sense-level categories only; entry-level categories are used only when no sense has one (see \`field_evidence_level\`). |
| \`field_evidence\` | object | field → up to 6 strings \`category:<lang>:<Name>\` (e.g. \`category:en:Organic chemistry\`) that produced it; \`<lang>\` always equals the entry's \`lang\`. The mapping (category name, slugified, → fields) is in MANIFEST.selection_criteria. |
| \`field_evidence_level\` | \`"sense"\` \\| \`"entry"\` \\| null | \`sense\`: the fields come from categories attached to individual senses (from the sense's context label). \`entry\`: no sense carries a STEMM category and the fields come from entry-level categories only — page-wide topic templates that Wiktextract could not pin to a sense and that it can repeat on sibling POS/etymology sections of the same page, so treat such fields as weaker evidence. null when \`fields\` is empty. |
| \`topics\` | string[] | union of the entry's sense topics exactly as Wiktextract gives them. INFORMATIONAL ONLY: Wiktextract expands a label into a closure (\`(logic)\` → \`logic, mathematics, philosophy, human-sciences, sciences\`; \`(technical)\` → \`engineering, …\`), so these are not used for \`fields\`. |
| \`glosses\` | string[] (0–3) | definitions, STEMM senses first, then the rest in page order; the most specific gloss of each sense; de-duplicated; cut to 200 chars (cut ones end with \`…\`). Inflection ("form of") senses are excluded. |
| \`sense_count\` | integer | number of senses on the entry (all, before the 3-gloss cap). |
| \`sense_wikidata\` | string[] | up to 5 Wikidata Q-ids attached to senses by Wiktionary (STEMM senses first). Often empty. |
| \`etymology_text\` | string, nullable | the entry's etymology prose, verbatim from Wiktextract after removing the rendered "PIE word" boxes and "Etymology tree" listing (see \`etymology_text_cleaning\`), cut to at most 800 UTF-16 code units (JavaScript string length). The cut never splits a surrogate pair (it stops one unit early instead), so the text is always well-formed UTF-16 / valid JSON for strict decoders. null when the entry has no etymology. |
| \`etymology_text_length\` | integer | length of the full cleaned text in UTF-16 code units (0 when none). |
| \`etymology_text_truncated\` | boolean | true when the full cleaned text is longer than 800 code units. |
| \`etymology_text_cleaning\` | string[] | what was removed, in order: \`pie-word-box\` (once per box; boxes before AND right after the tree are removed), \`etymology-tree\`; \`etymology-tree-kept\` means a tree was present but its end could not be found, so the text still starts with "Etymology tree". |
| \`coinage\` | object, nullable | the primary coinage-type statement (see below); null when none. |
| \`coinage_other\` | object[] | further coinage-type statements on the same entry (same shape), up to 5. |
| \`attestation\` | object, nullable | the primary date statement (see below); null when no date is stated. |
| \`attestations\` | object[] | every accepted date statement (same shape), in text order (a \`leading-date\` one first), up to 8. |
| \`date_basis\` | \`"stated"\` \\| \`"unknown"\` | \`stated\` if \`attestation\` is non-null or the coinage template gives a year; otherwise \`unknown\` (the entry carries no date — do not place it on a time axis). |
| \`derivation\` | object[] | compact etymology links from templates, up to 16, in template order: \`{type, template, source_lang, source_term}\` — see below. |
| \`categories\` | string[] | up to 40 of the entry's categories: non-topical coinage/eponym categories matched by a loose regex (e.g. \`English terms coined by Isaac Asimov\`, \`English eponyms\`, \`English back-formations\`; a few related names such as clipped-compound categories also pass), plus the topical categories that produced \`fields\` (e.g. \`en:Medicine\`). Topical categories never pass through the coinage regex (no \`en:Coins\`), and other languages' topical categories are not listed. Only \`reasons\`/\`coinage\` use the strict coinage-category pattern. |
| \`url\` | string | \`https://en.wiktionary.org/wiki/<word>#<Language>\` (spaces → \`_\`, percent-encoded). |

### attestation object (in \`attestation\` and \`attestations[]\`)

| field | type | meaning |
|---|---|---|
| \`relation\` | string | what the text says the date is: \`coined\`, \`first-attested\`, \`first-recorded\`, \`first-used\`, \`since\` ("attested since/from X"), \`other\` (first appeared, first documented/cited/mentioned, introduced, dates from, attested in, recorded in, leading date). |
| \`rule\` | string | which trigger matched: \`coined\`, \`coinage-attributed\`, \`first-attested\`, \`attested-as-early-as\`, \`first-recorded\`, \`first-used\`, \`attested-since\`, \`attested-since-distant\`, \`dates-from\`, \`first-appeared\`, \`first-documented\`, \`introduced\`, \`attested-in\`, \`recorded-in\`, \`leading-date\`. Regexes in MANIFEST.selection_criteria.date_triggers. |
| \`basis\` | \`"stated"\` | always "stated": the year is written in the text. Nothing is estimated. |
| \`year\` | integer, nullable | the single year written, when exactly one is (precision \`year\`); null for decades, centuries, ranges and alternatives. BCE negative. |
| \`year_lo\` | integer, nullable | earliest year the expression allows; null = unbounded (after \`before\`/\`by\`/\`at-least\` qualifiers). For alternatives: the earliest alternative's start. |
| \`year_hi\` | integer, nullable | latest year the expression allows; null = unbounded (after \`after\`). For alternatives: the latest alternative's end. |
| \`precision\` | string | \`year\`, \`decade\` ("the 1890s" → 1890–1899), \`century\` ("17th century" → 1600–1699; "the 1500s" → 1500–1599 with \`ambiguous\`), \`range\` ("1400–50", "between 1580 and 1590", "1940s–1950s", "16th–17th centuries", "the 1440–1450s" → 1440–1459; a range whose ends carry period words is read whole: "the late 15th to the early 17th centuries" → 1400–1699, "the late 1980s and early 1990s" → 1980–1999), \`alternatives\` (two written alternatives joined by "or" or "/": "1943 or 1944", "1841/1842", "1267/68", "c. 1630 or c. 1642", "the 1620s/1630s", "the 13th or 14th century" — see \`alternatives\`). |
| \`alternatives\` | object[], nullable | only for precision \`alternatives\`: each alternative as \`{year, year_lo, year_hi, precision}\` (precision \`year\`, \`decade\` or \`century\`), earliest first; null otherwise. The statement says it is ONE of these, not the whole span. |
| \`qualifier\` | string, nullable | \`circa\` (c./ca./circa/around/about/approximately), \`before\` (before/prior to/predating/no later than/ante), \`by\`, \`at-least\` (at least / as early as), \`after\`. |
| \`period_part\` | string, nullable | \`early\`, \`mid\`, \`late\`, \`end\`, \`beginning\`, \`first-half\`, \`second-half\`, \`first-quarter\`, \`last-quarter\` — recorded only; it does NOT narrow year_lo/year_hi. For a range it is the FIRST element's period word ("late" in "the late 1980s and early 1990s"). |
| \`era\` | \`"BCE"\` \\| \`"CE"\` \\| null | era if written (BC/BCE/AD/CE); null = none written (read as CE). |
| \`ambiguous\` | boolean | true for "the X00s" (century vs decade reading). |
| \`span\` | string | the EXACT substring of the cleaned etymology text from the start of the trigger to the end of the date, e.g. \`Coined by John Tukey in 1946\`. |
| \`span_start\`, \`span_end\` | integer | character offsets (UTF-16 code units, as JavaScript strings) of \`span\` in the full cleaned etymology text; \`etymology_text.slice(span_start, span_end) === span\` whenever \`span_end <= etymology_text.length\`. |
| \`date_text\` | string | the date expression alone, e.g. \`c. 1600\`, \`the mid 19th century\`. |
| \`subject_hint\` | \`"headword"\` \\| \`"unclear"\` \\| \`"other-language-context"\` | mechanical hint about what the statement dates. \`headword\`: the clause before the trigger is empty (sentence-initial "First attested in 1620") or only words like "the term was" / "it is" / the headword, or the sentence opens with "The (English) word/term/noun …". \`other-language-context\`: the sentence before the trigger last names a language outside the entry's family (e.g. "Borrowed from German Genom, coined by … Winkler in 1920" — the date is the German word's), or the trigger sits in parentheses after such a term. \`unclear\`: anything else (e.g. "From united + kingdom, first attested from 1706"). Not a judgement. |
| \`context_language\` | string, nullable | the last language name mentioned in the sentence before the trigger (any family; e.g. \`German\`, \`Middle English\`), or the language of the term before the parenthesis; null if none. |
| \`sense_specific\` | boolean | the clause mentions "sense"/"meaning" (e.g. "In the sense “unintended pregnancy”, first attested in 1932") — the date is for one sense, not the word. |
| \`in_parentheses\` | boolean | the trigger sits inside "( … )". (Parenthetical statements after a term in another language are rejected, not output.) |
| \`via_template\` | string, nullable | name of an etymology template whose rendered text contains the span (\`etydate\`, \`coin\`, \`coinage\`, …), i.e. the date was entered as structured data on Wiktionary; null = free prose. |

Primary choice (\`attestation\`): from accepted statements whose \`subject_hint\` is not \`other-language-context\`
(and excluding \`leading-date\` unless nothing else is left), prefer \`subject_hint = headword\`, then not \`sense_specific\`,
then the earliest \`year_lo\` (else \`year\`, else \`year_hi\`), then text order. If only other-language-context statements
exist, \`attestation\` is null (and \`date_basis\` is \`unknown\` unless the coinage template states a year) while
\`attestations\` still lists them. Consumers that want a different policy should use \`attestations\`.

Never an attestation (rejected and counted, see *Rejection reasons*): a person's life dates — after born/died/b./d./fl./
floruit/baptized/baptised/bapt./christened/buried/reigned, in a parenthesis that opens with one of those words
("(born Louis Thomas Hardin, 1916–1999)", "(baptized 1564; died 1616)", "(fl. c. 1200)"), or a parenthesised date range
right after a capitalised word ("Spenser (1552 or 1553 – 1599)", "Fuller (1607/8–1661)", "Lichtheim (3 May 1914 – 27 March
2004)", "Tayac (1895-1978, the twenty-seventh …)"); and the run of an organisation, office or career in a parenthesis
opening with active/operating/operated/existed/in office/ruled/lived ("(operating 1759–1982)").

Known limits: \`subject_hint = headword\` is mechanical — a sentence-initial trigger after a chain of etymons can date the
etymon (e.g. a Medieval Latin source "first recorded … (800 AD)" on an English entry); check \`context_language\` and the
span before placing a word on a time axis. Dates read as "the YYYY …" ("coined … in the 1920 science-fiction play") are
the year of a named work: usually right for coinages, but the relation is indirect.

### coinage object (in \`coinage\` and \`coinage_other[]\`)

| field | type | meaning |
|---|---|---|
| \`source\` | \`"template"\` \\| \`"category"\` | from an etymology template, or (only when no template of that kind) from a category name. |
| \`template\` | string, nullable | template name as in the dump (\`coin\`, \`coinage\`, \`named-after\`, \`blend\`, \`back-form\`, \`clipping\`, \`calque\`, \`cal\`, …); null for category-derived. |
| \`kind\` | string | \`coined\`, \`named-after\`, \`neologism\`, \`univerbation\`, \`blend\`, \`back-formation\`, \`clipping\`, \`calque\`, \`partial-calque\`, \`nonce\`. Primary = first by that order. |
| \`coiner\` | string, nullable | coin/coinage templates: the coiner argument exactly as given (a name, or a Wikidata Q-id); category-derived: the name in "… terms coined by NAME". |
| \`coiner_wikidata\` | string, nullable | Q-id when the coiner argument is one. |
| \`honoree\` | string, nullable | named-after: the person/thing argument as given (name or Q-id). Their life dates are deliberately not output. |
| \`honoree_wikidata\` | string, nullable | Q-id when the honoree argument is one. |
| \`nationality\`, \`occupation\` | string, nullable | the template's nat= / occ= arguments as given (occupations joined with ", "). |
| \`year\`, \`year_lo\`, \`year_hi\`, \`year_precision\`, \`year_qualifier\` | as in attestation, nullable | parsed ONLY from an explicit \`in=\`/\`date=\`/\`year=\` template argument. |
| \`year_alternatives\` | object[], nullable | as \`alternatives\` in attestation, when \`year_precision\` is \`alternatives\`. |
| \`year_raw\` | string, nullable | that argument verbatim (e.g. \`the early-to-mid 1980s\`). |
| \`year_basis\` | \`"stated"\`, nullable | "stated" when a year was parsed from that argument; null otherwise. |
| \`ex_nihilo\` | boolean | template has exnihilo=1, or category says ex nihilo. |
| \`expansion\` | string, nullable | Wiktionary's rendered text of the template, e.g. "Coined by American journalist and editor Sylvia Wright in 1954" (Q-id coiners are resolved here). |
| \`category\` | string, nullable | the category name, for category-derived objects. Only categories named for the entry's own language ("English coinages" on an English entry) are used. |

A coinage template can describe the SOURCE-language word ("Borrowed from German Genom, coined by … Hans Winkler in 1920"
on English *genome*): the prose date is then classed \`other-language-context\` and not used, but the template's in= year
still sets \`coinage.year\` and \`date_basis = "stated"\`. Check \`coinage.expansion\` before treating the year as the
headword's. \`coiner\` can carry life dates the editor typed into the argument (e.g. \`Edward Jenner (1749-1823)\`); they are
never parsed.

### derivation item

\`{ "type", "template", "source_lang", "source_term" }\`

- \`type\`: cross-language links \`inh\` (inherited), \`bor\` (borrowed), \`lbor\` (learned borrowing), \`slbor\`, \`obor\`, \`ubor\`,
  \`der\` (derived), \`uder\` (unspecified derivation), \`calque\`, \`partial-calque\`, \`semantic-loan\`, \`phono-semantic-matching\`;
  same-language morphology \`affix\`, \`prefix\`, \`suffix\`, \`confix\`, \`compound\`, \`surface-analysis\`, \`blend\`, \`clipping\`,
  \`back-formation\`, \`univerbation\`. From the newer \`etymon\` template the relation marker is normalised to the same
  vocabulary (\`:af\` → \`affix\`, \`:afeq\` → \`surface-analysis\`, \`:bf\` → \`back-formation\`, \`:clip\` → \`clipping\`,
  \`:pcal\` → \`partial-calque\`, …) and its inline modifiers (\`<conj:and>\`, \`<unc>\`, \`<ref:…>\`) are dropped; etymon-only
  relations are \`from\` (unspecified; also used for etymon terms written before any marker), \`influence\`, \`deverbal\`,
  \`abbreviation\`, \`acronym\`, \`ellipsis\`, \`transliteration\`, \`syllabic-abbreviation\`; an unknown marker keeps its own name.
- \`template\`: template name as in the dump.
- \`source_lang\`: Wiktionary language code of the source term (e.g. \`la\`, \`grc\`, \`fr\`, \`en\`, \`la-new\`, \`ine-pro\`,
  regional codes such as \`pt-BR\`). For morphology and etymon parts it is the part's inline prefix (\`la:foo\`, \`mul-tax:Foo\`)
  when written, else the template's language (the entry's language for prefix-less etymon parts); \`{{surf|+suf|en|…}}\`-style
  calls are read with their arguments shifted past the \`+type\` marker. Old etymology-only codes are mapped: \`LL.\` → \`la-lat\`,
  \`ML.\` → \`la-med\`, \`NL.\` → \`la-new\`, \`VL.\` → \`la-vul\`. A template naming several source languages keeps them
  comma-separated as written (\`es,pt\`).
- \`source_term\`: the term as written in the template, with everything from the first \`<\` (inline modifiers such as
  \`<t:…>\`, \`<id:…>\`, nested \`<ety:…<…>>\`) removed BEFORE any \`lang:\` prefix is split off; Wikipedia links (\`w:\`) and
  bare hyphens dropped.

Order follows the templates in the etymology text, which usually (not always) runs from nearest to deepest ancestor.

## stats.json (top level)

- \`stream\`: \`lines\`, \`prefilter_skipped\`, \`parse_errors\`, \`non_entry_lines\`, \`prefilter_false_positive\` (line mentioned a kept code but the entry is another language), \`entries\` / \`form_of_skipped\` / \`candidates\` per language, \`total_lines\`, \`shards\`.
- \`entries_scanned\`: entries parsed in the five languages.
- \`selection\`: \`kept\`, \`kept_per_reason\`, \`kept_reason_combinations\`, \`kept_per_language\`, \`kept_per_field\`, \`kept_per_pos\`,
  \`attestations\` (accepted per relation / rule / precision / subject_hint / via_template; primary per relation / precision / century),
  \`rejections\` (per reason, per rule, up to 25 samples each), \`triggers_without_date\` (trigger matched, no date in its clause — informational),
  \`rejections_all_candidates\` (the same per-reason counts over every candidate, kept or not), \`coinage\`, \`etymology\` (cleaning
  counts), \`topical_categories_mapped\` / \`topical_categories_unmapped\` (same-language category names on kept entries, for
  auditing the field map), \`topic_only_stemm_senses\` (entries whose Wiktextract topics alone would have looked STEMM),
  \`kept_per_field_evidence_level\`, \`entry_level_fields_not_used\` (entries whose entry-level categories named extra fields that
  were not used because senses carry their own), \`other_language_categories_ignored\` (entries carrying another language's
  STEMM category; how many were left without a field or dropped; per \`<lang><-<prefix>\` pair).

Rejection reasons: \`person-dates-keyword\` (born/died/b./d./fl./floruit/baptized/baptised/bapt./christened/buried/reigned right
before the date, or opening the parenthesis the date is in), \`parenthetical-range-after-name\` (e.g. "Huxley (1825–1895)",
"Spenser (1552 or 1553 – 1599)", "Fuller (1607/8–1661)", "Lichtheim (3 May 1914 – 27 March 2004)" — life dates or a work's run;
the parenthesis' first segment up to ")" ";" or "," is tested), \`period-keyword\` ("(operating 1759–1982)", "(in office …)",
"(active …)"), \`parenthetical-other-language-term\` ("From French abrasion (attested since 1611)"),
\`other-language\` ("first attested in German in …"), \`implausible-year\`, \`not-a-year\` (page/volume numbers, numbers with units, bare 3-digit numbers),
\`invalid-range\`, \`vague-turn-of-century\`.

## Revisions

${REVISIONS.map((r) => `### ${r.version} (${r.date})\n\n${r.why}\n\n${r.changes.map((c) => `- ${c}`).join("\n")}\n`).join("\n")}
Before/after counts for each build are in MANIFEST.json (\`revisions\`, \`counts\`).
`;

// ---------------------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  log(`${SOURCE}: ${TEST ? `TEST on ${INPUT}${LIMIT ? ` (first ${LIMIT} lines)` : ""}` : DUMP_URL} → ${OUT}`);
  mkdirSync(TMP, { recursive: true });
  let meta;
  try { meta = await headDump(); }
  catch (error) {
    const statePath = join(SHARDS, "state.json");
    if ((SELECT_ONLY || existsSync(statePath)) && existsSync(statePath)) { log(`HEAD failed (${error.message}); using staged state`); meta = null; }
    else throw error;
  }
  if (meta) log(`dump: Last-Modified ${meta.last_modified}, ETag ${meta.etag}, ${meta.content_length?.toLocaleString?.() ?? "?"} bytes`);
  let state;
  if (SELECT_ONLY) {
    state = JSON.parse(readFileSync(join(SHARDS, "state.json"), "utf8"));
    if (!state.complete) throw new Error("pass 1 is not complete; run without --select-only first");
    if (meta && meta.etag && state.etag && meta.etag !== state.etag) log(`note: the dump on kaikki.org has changed since it was streamed (${state.last_modified} → ${meta.last_modified}); selecting from the staged copy`);
  } else state = await pass1(meta || {});
  const info = TEST ? { page_ok: true, dump_date: null } : await kaikkiInfo();
  await pass2(state, meta || { url: state.source }, info);
  console.log(`DONE ${SOURCE} in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${OUT}`);
}

// Exported for tests; the CLI runs only when this file is executed directly.
export { interpretDate, parseDateString, findAttestations, primaryAttestation, cleanEtymology, categoryFields, DATE_RE };
export const setLanguageNames = (names) => { LANG_NAMES = new Set(names); };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error && error.stack || error);
    console.log(`FAILED ${SOURCE}: ${error && error.message || error}`);
    process.exit(1);
  });
}
