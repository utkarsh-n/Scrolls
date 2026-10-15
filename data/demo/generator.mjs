// OWNER: WP2
// data/demo/generator.mjs — deterministic background generator of the SYNTHETIC "carry the zero" demo
// (SPEC §9.5). mulberry32(1994): per (expression × sense) cell of the plan it emits documents of 4–12
// passages, each 40–90 tokens of 6–9 sentences built from per-community templates (subject · verb · object
// · setting) and neutral filler; a target-bearing passage carries the expression with 3–6 words from the
// sense pool within ±10 tokens. Everything here is invented; every document says so in its title
// ("(generated background) …"), its author ("… (synthetic)") and meta.generator.
//
// Two guards keep the invented text from producing invented lineage: no sentence (or verse line) may share
// 40% or more of its word 3-shingles with a sentence of another document, so the quotation detectors find
// only the planted runs (A11→A4, A20→A3), never template echoes.

import { mulberry32 } from '../../src/shared/ids.mjs';
import { tokenize } from '../../src/shared/tokenize.mjs';

export const GENERATOR_VERSION = 'demo-gen@1';
export const GENERATOR_TAG = (seed) => `${GENERATOR_VERSION} seed ${seed}`;
const S = ' (synthetic)';

/** Community lanes of the demo (document.community value → label). */
export const COMMUNITIES = Object.freeze({
  'classroom': 'Classroom', 'office-lab': 'Office & Lab', 'hiphop': 'Hip-hop', 'criticism': 'Criticism',
  'software': 'Software', 'gujarati': 'Gujarati verse & school', 'hindi': 'Hindi verse', 'hospital': 'Hospital',
  'literature': 'Literature', 'workshop-radio': 'Workshop & Radio',
});

/** The expressions planted in the demo and their sense pools (§9.5). */
export const EXPRESSIONS = Object.freeze({
  'carry the zero': {
    place: ['column', 'digit', 'place', 'tens', 'units', 'sum', 'slate', 'lesson', 'children', 'ones', 'write', 'add'],
    irony: ['auditors', 'forms', 'memo', 'triplicate', 'ledger', 'quota', 'department', 'file', 'clerk', 'budget', 'report'],
    honor: ['counted', 'ones', 'hold', 'block', 'verse', 'mic', 'names', 'nobody', 'crew', 'beat'],
    honor_late: ['uncredited', 'unpaid', 'credit', 'labor'],
    null: ['null', 'schema', 'column', 'pipeline', 'field', 'migrate', 'record', 'drop', 'table', 'join'],
  },
  'flux up': {
    metal: ['joint', 'seam', 'heat', 'bead', 'iron', 'solder', 'starve', 'weld'],
    electronics: ['pads', 'board', 'part', 'iron', 'tin', 'lead', 'bench'],
    crew: ['block', 'room', 'crew', 'hold', 'floor', 'together', 'heat'],
    teams: ['teams', 'launch', 'merge', 'org', 'roadmap', 'standup'],
  },
  'ghost in the margin': {
    ledgers: ['ledger', 'owed', 'clerk', 'ink', 'debt', 'account'],
    bitflips: ['bit', 'flips', 'pass', 'register', 'debug', 'core', 'tape'],
    ghostwriting: ['writer', 'credit', 'uncredited', 'unpaid', 'verse', 'name', 'labor'],
  },
  '◉': { mark: [] },
  'શૂન્ય ઉપાડ': { 'place (gu)': ['ગણિત', 'જગ્યા', 'ગણતું'] },
  'शून्य को साथ': { 'honor (hi)': ['गिनती', 'जगह', 'साथ'] },
});

// ── invented names (fixed list: renaming them is a deliberate edit, checked by scripts/check-demo-names.mjs) ──

const NAME_POOL = {
  classroom: ['Hester Valmoray', 'Orla Penhallow-Sneed', 'Miriam Tobbe-Arkwell', 'Jessamy Corriveau-Lind', 'Edith Faraday-Nunn',
    'Augusta Wrenfield-Pole', 'Clemency Harrowgate', 'Ivo Brackenreid', 'Leopold Asquane', 'Winifred Tulloch-Vane'],
  office: ['Gerhard Pellmore', 'Odile Ferrant-Vasko', 'Lionel Ashcombe-Rye', 'Margit Holloway-Sauer', 'Desmond Quarrie-Platt',
    'Ilka Brummond', 'Hollis Vanterpool-Grey', 'Rosamund Teague-Ferris'],
  hiphop: ['Juno Calderwick', 'Tavi Okonkwo-Brand', 'Ricky Malvane', 'Dez Arrowmere', 'Kofi Trellis-Vance', 'Saffa Delacroix-Mbeki',
    'Mo Quillfeather', 'Ade Ravensmoor', 'Nixie Tallowgate', 'Bruno Cask-Ellery'],
  software: ['Priyam Holtzbrand', 'Ada Kwesi-Lorne', 'Mateo Vinterberg-Sosa', 'Hana Ostrovsky-Pell', 'Rafe Okafor-Lindgren',
    'Sunniva Brask', 'Tomasz Quillon', 'Yetunde Marlowe-Feng', 'Elio Brannstrom-Diaz', 'Kasia Venn-Holloway'],
  workshop: ['Amos Hartnell-Crewe', 'Silas Bramwell-Oake', 'Ezra Tunstall-Pike', 'Morwenna Kestle'],
  radio: ['Cyril Abbington-Vosk', 'Thea Morrisfield', 'Lyle Penbury-Sax', 'Viggo Calloway-Strand'],
  literature: ['Cornelia Aspwith', 'Barnaby Thewlis-Grove', 'Honoria Pelcastle'],
  lab: ['Dagny Morrell-Asch', 'Fenwick Oduya', 'Ines Halvorsen-Crane', 'Ptolemy Garvock', 'Lisbet Arnaud-Kell'],
  ghost: ['Keziah Morvane', 'Lux Adeyemi-Thorne', 'Quill Saraswat-Boyd', 'Remy Okoro-Valdés', 'Tamsin Ellery-Novak', 'Viv Ashdown-Kaur',
    'Zeb Marchetti-Lowe'],
  gu: ['હંસા દેસાઈ-પારેખ (Hansa Desai-Parekh)', 'કાંતિ ભાવસાર-મોદી (Kanti Bhavsar-Modi)'],
  hi: ['सुशीला वर्मा-राही (Sushila Varma-Rahi)', 'इक़बाल राही-सेठ (Iqbal Rahi-Seth)'],
  kiln: ['Tamsin Rookwell-Adair'],
  background: ['Agnes Merriweather-Holt', 'Bertram Ovenden-Pryce', 'Cosima Faulke', 'Dorian Keswick-Mbatha', 'Eulalie Brightwater',
    'Fergal Quennell', 'Gisela Thornbury-Ash', 'Hamish Ollerenshaw', 'Isadora Penvenan', 'Jago Treharne-Moss', 'Kirsi Lindqvale',
    'Lorcan Abberley', 'Maud Silvermere-Kent', 'Nahum Corrigal', 'Ottilie Ravensworth-Ng', 'Piers Haldane-Wick', 'Rosalind Agbaje-Kerr',
    'Saul Weatherill-Dane', 'Tilda Marchbanks', 'Ulric Penhaligon-Ross', 'Verity Okeke-Hale', 'Wystan Blackmoor', 'Xanthe Caradoc',
    'Yorick Tellwright', 'Zinnia Abelard-Ruiz', 'Anouk Brettingham', 'Caspar Fenmore-Ilori', 'Delphine Rookhurst', 'Emrys Galbraith-Oyo',
    'Felicity Varden-Shaw', 'Gideon Arkwright-Sole', 'Henrike Moorcroft', 'Ignatius Pellew-Barr', 'Juniper Ashworth-Kole',
    'Kester Valcourt', 'Lavinia Strathmore-Ade', 'Magnus Feverell', 'Nerys Holloway-Quist', 'Osric Tamblyn-Reyes', 'Philippa Dunsmore-Oke'],
};
function newNames(pool, n) {
  return NAME_POOL[pool].slice(0, n);
}
/** Every invented person/body name the generator can emit (for the collision check). */
export function generatorNames() {
  return [...new Set(Object.values(NAME_POOL).flat())];
}

// ── the plan (generated documents only; anchors add to these, see data/demo/README.md) ───────────────

const PLAN = [
  { id: 'place', expr: 'carry the zero', sense: 'place', lane: 'classroom', years: [[1905, 1939], [1950, 1960]], occ: 88, docs: 22,
    authors: ['Ada Brennock', 'Quellhaven Board of Schools', ...newNames('classroom', 10)] },
  { id: 'irony', expr: 'carry the zero', sense: 'irony', lane: 'office-lab', years: [[1955, 1985]], occ: 69, docs: 17,
    authors: ['Felmark Bulletin staff', ...newNames('office', 8)] },
  { id: 'honor', expr: 'carry the zero', sense: 'honor', lane: 'hiphop', years: [[1994, 2026]], occ: 106, docs: 26, verse: true,
    authors: ['MC Ledgerline', 'Kestrel Nine', 'Lu Varga-Pinto', 'Sol Etxeberria-Lund', ...newNames('hiphop', 10)] },
  { id: 'null', expr: 'carry the zero', sense: 'null', lane: 'software', years: [[2012, 2026]], occ: 69, docs: 19,
    authors: ['Nell Ifeoma-Strand', ...newNames('software', 10)] },
  { id: 'metal', expr: 'flux up', sense: 'metal', lane: 'workshop-radio', years: [[1918, 1939]], occ: 30, docs: 8,
    authors: ['J. R. Ostlund', ...newNames('workshop', 4)] },
  { id: 'electronics', expr: 'flux up', sense: 'electronics', lane: 'workshop-radio', years: [[1955, 1980]], occ: 30, docs: 8,
    authors: ['Harlan Edevane', ...newNames('radio', 4)] },
  { id: 'ledgers', expr: 'ghost in the margin', sense: 'ledgers', lane: 'literature', years: [[1903, 1939]], occ: 20, docs: 6,
    authors: ['Tobias Wrexley', ...newNames('literature', 3)] },
  { id: 'bitflips', expr: 'ghost in the margin', sense: 'bitflips', lane: 'office-lab', years: [[1965, 1999]], occ: 35, docs: 10,
    authors: ['Wren Abernathy', ...newNames('lab', 5)] },
  { id: 'ghostwriting', expr: 'ghost in the margin', sense: 'ghostwriting', lane: ['hiphop', 'criticism'], years: [[2000, 2026]], occ: 35, docs: 11,
    authors: ['Sol Etxeberria-Lund', ...newNames('ghost', 7)] },
  { id: 'gu', expr: 'શૂન્ય ઉપાડ', sense: 'place (gu)', lane: 'gujarati', lang: 'gu', years: [[1932, 2015]], occ: 12, docs: 4,
    authors: ['રતિલાલ માંડવીવાળા (Ratilal Mandaviwala)', 'MC Taru Vyas', ...newNames('gu', 2)] },
  { id: 'hi', expr: 'शून्य को साथ', sense: 'honor (hi)', lane: 'hindi', lang: 'hi', years: [[1934, 2016]], occ: 7, docs: 3,
    authors: ['Rehan Qadri-Mehta', ...newNames('hi', 2)] },
];
// subsets: flux up · crew bonding inside Hip-hop "honor" documents, flux up · merging teams inside Software ones
const NESTED = [
  { id: 'crew', expr: 'flux up', sense: 'crew', host: 'honor', fromYear: 1995, occ: 30, docs: 9, authors: 6 },
  { id: 'teams', expr: 'flux up', sense: 'teams', host: 'null', fromYear: 2012, occ: 30, docs: 8, authors: 5 },
];
// ◉: three generated documents with two mentions each (anchors carry the other 20)
const KILN = [
  { lane: 'hospital', year: 1974, kind: 'memo', author: () => 'Lowmere General Hospital', n: 2 },
  { lane: 'hiphop', year: 1990, kind: 'zine', author: () => newNames('kiln', 1)[0], n: 2 },
  { lane: 'software', year: 2019, kind: 'blog', author: () => 'Nell Ifeoma-Strand', n: 2 },
];
// background-only documents (no targets): 60 documents by 40 authors; 10 of them are the Hip-hop zines and
// flyers of 1984–1993 (the "looked and found none" stretch)
const BACKGROUND = {
  docs: 60, authors: 40,
  fixed: [
    ...Array.from({ length: 10 }, (_, i) => ({ lane: 'hiphop', years: [1984, 1993], kind: i % 2 ? 'flyer' : 'zine', passages: [10, 12] })),
    { lane: 'gujarati', years: [1935, 1960] }, { lane: 'gujarati', years: [1961, 1990] }, { lane: 'gujarati', years: [1991, 2018] },
    { lane: 'hindi', years: [1935, 1965] }, { lane: 'hindi', years: [1966, 1995] }, { lane: 'hindi', years: [1996, 2018] },
    { lane: 'hospital', years: [1970, 1989] }, { lane: 'hospital', years: [1990, 2009] }, { lane: 'hospital', years: [2010, 2022] },
    { lane: 'literature', years: [1894, 1902] },
  ],
  // the rest go to the thinnest (lane, decade) cells inside each lane's active span
  spans: {
    'classroom': [[1900, 1939], [1950, 1960]], 'office-lab': [[1950, 1999]], 'hiphop': [[1994, 2026]],
    'criticism': [[1995, 2026]], 'software': [[2010, 2026]], 'literature': [[1894, 1939]], 'workshop-radio': [[1894, 1939], [1950, 1980]],
  },
};
export const NO_SOURCE_DECADE = 1940; // 1940–1949: no document in any lane ("lost in the 1951 flood", synthetic)

// ── vocabularies ────────────────────────────────────────────────────────────────────────────────────

const VOCAB = {
  'classroom': {
    S: ['the teacher', 'Miss Orlett', 'the head of the Brennock Room', 'a pupil in the second row', 'the inspector', 'the monitor', 'the infant class',
      'the older girls', 'the boys by the stove', 'the student teacher', 'the visiting master', 'the Board examiner', 'the caretaker', 'the new assistant'],
    V: ['copied', 'chalked', 'recited', 'checked', 'rubbed out', 'corrected', 'read aloud', 'drew', 'ruled', 'set out', 'marked', 'pinned up', 'collected', 'repeated'],
    O: ['the times table', 'a sum on the board', 'the reading primer', 'the attendance register', 'a map of the county', 'the spelling list',
      'the weekly test', 'a row of fractions', 'the copybook page', 'the lesson plan', 'the prize list', 'the drill sheet', 'the hymn number', 'the wall chart'],
    P: ['before the bell', 'after morning prayers', 'by the coal stove', 'from the front bench', 'under the clock', 'beside the globe',
      'at the long desk', 'near the window', 'on the new blackboard', 'in the cold hall', 'during the inspection', 'before the dinner hour',
      'while the rain came down', 'with the door open'],
    T: ['on Monday', 'that winter', 'in the spring term', 'every Friday', 'for the third time', 'at half past nine', 'before Easter', 'all week'],
    kinds: ['book', 'record', 'transcript', 'letter'], title: ['classroom record', 'lesson sheet', 'Brennock Room register', 'school log'],
  },
  'office-lab': {
    S: ['the section head', 'the senior clerk', 'a junior engineer', 'the accounts office', 'the night shift', 'the duty officer', 'the typing pool',
      'the stores keeper', 'the test crew', 'the deputy director', 'the visiting inspector', 'the planning committee', 'the draughtsman', 'the switchboard'],
    V: ['initialled', 'filed', 'returned', 'circulated', 'checked', 'stamped', 'retyped', 'queried', 'signed', 'logged', 'approved', 'mislaid', 'rerouted', 'countersigned'],
    O: ['the test schedule', 'a requisition', 'the overtime sheet', 'the wind tunnel log', 'the parts list', 'a travel claim', 'the minutes',
      'the drawing register', 'the safety notice', 'the instrument returns', 'the canteen rota', 'a revised estimate', 'the key ledger', 'the shift roster'],
    P: ['before the meeting', 'in the corridor', 'at the long table', 'behind the hangar', 'by the tea urn', 'in the drawing office', 'on the second floor',
      'after the run', 'during the fire drill', 'next to the teleprinter', 'in a brown envelope', 'under a paperweight', 'with a red pencil', 'by internal post'],
    T: ['on Tuesday', 'that quarter', 'last month', 'before the audit', 'twice', 'at the end of the shift', 'over the holiday', 'without comment'],
    kinds: ['memo', 'bulletin', 'notebook', 'record'], title: ['office memo', 'laboratory circular', 'section minutes', 'shift log'],
  },
  'hiphop': {
    S: ['the crew', 'my cousin', 'the kid from the depot', 'the DJ', 'the whole block', 'my mother', 'the night bus', 'the corner store man',
      'the girls on the stoop', 'the old head', 'the producer', 'the radio host', 'the cypher', 'the bouncer'],
    V: ['spun', 'wrote', 'painted', 'carried', 'remembered', 'sampled', 'shouted', 'rewound', 'traded', 'taped', 'chased', 'kept', 'burned', 'rapped'],
    O: ['the late show', 'a borrowed record', 'the wall by the tram', 'a cassette deck', 'the rent money', 'a second verse', 'the summer heat',
      'the last train', 'a dented speaker', 'the long walk home', 'the cheap headphones', 'a page of rhymes', 'the depot doors', 'the street lights'],
    P: ['on the Saltwharf Road', 'behind the depot', 'under the bridge', 'in the back room', 'on the roof', 'outside the chip shop', 'by the canal',
      'at the bus stop', 'in the basement', 'on the night tram', 'down Kiln Street', 'in the stairwell', 'at the block party', 'across the yard'],
    T: ['every summer', 'all night', 'since ninety', 'last winter', 'twice a week', 'before sunrise', 'for years', 'on the weekend'],
    kinds: ['song', 'zine', 'flyer', 'interview'], title: ['Saltwharf Road track', 'block party flyer', 'crew zine', 'mixtape side'],
  },
  'criticism': {
    S: ['the reviewer', 'a reader from the north side', 'the editor', 'the panel', 'one commenter', 'the essayist', 'the critic', 'a retired teacher',
      'the moderator', 'a student', 'the columnist', 'the jury', 'a longtime fan', 'the archivist'],
    V: ['praised', 'questioned', 'quoted', 'dismissed', 'revisited', 'compared', 'defended', 'ranked', 'reread', 'annotated', 'summarised', 'challenged', 'reprinted', 'cited'],
    O: ['the second side', 'the liner essay', 'the debut album', 'the live set', 'an old review', 'the reissue', 'the production notes',
      'the radio session', 'the cover art', 'the year-end list', 'the fan letters', 'a festival line-up', 'the long interview', 'the documentary'],
    P: ['in the Quarterly', 'on the forum', 'in the weekend paper', 'at the panel', 'in a footnote', 'on the radio', 'in the anthology',
      'in the comments', 'in the spring issue', 'at the launch', 'in a long thread', 'in the archive notes', 'on page twelve', 'in the back pages'],
    T: ['that year', 'at length', 'once more', 'in passing', 'with care', 'without irony', 'a decade later', 'for the reissue'],
    kinds: ['review', 'essay', 'post'], title: ['review column', 'forum thread', 'critical essay', 'reader letter'],
  },
  'software': {
    S: ['the data team', 'our on-call engineer', 'the platform group', 'the analytics lead', 'a new hire', 'the release manager', 'the vendor',
      'the integration test', 'the support desk', 'the product owner', 'the security review', 'the infra team', 'the intern', 'the architect'],
    V: ['shipped', 'reverted', 'reviewed', 'deployed', 'refactored', 'documented', 'flagged', 'patched', 'benchmarked', 'archived', 'rolled back', 'renamed', 'split', 'audited'],
    O: ['the nightly job', 'a hotfix', 'the API gateway', 'the billing service', 'the dashboard', 'a feature flag', 'the backlog', 'the error budget',
      'the staging cluster', 'the style guide', 'the incident report', 'the cache layer', 'the onboarding doc', 'the test suite'],
    P: ['before the freeze', 'in the retro', 'on the wiki', 'during the outage', 'in the sprint review', 'over the weekend', 'in the design doc',
      'in the release notes', 'at the offsite', 'in a pull request', 'on the status page', 'in the ops channel', 'at the demo', 'in the runbook'],
    T: ['on Thursday', 'this quarter', 'last sprint', 'after midnight', 'twice', 'before lunch', 'in March', 'again'],
    kinds: ['blog', 'post', 'memo', 'document'], title: ['engineering blog post', 'team wiki page', 'release note', 'ops review'],
  },
  'hospital': {
    S: ['the ward sister', 'the night porter', 'the pharmacy', 'the theatre staff', 'the infection team', 'a junior doctor', 'the matron',
      'the laundry', 'the outpatients desk', 'the chaplain', 'the catering staff', 'the records office', 'the physiotherapist', 'the switchboard'],
    V: ['checked', 'restocked', 'labelled', 'counted', 'cleaned', 'signed for', 'updated', 'sorted', 'returned', 'inspected', 'logged', 'collected', 'replaced', 'posted'],
    O: ['the linen trolleys', 'the drug cupboard', 'the visiting rota', 'the dressing packs', 'the fire doors', 'the patient lists', 'the oxygen stock',
      'the theatre lists', 'the notice board', 'the meal orders', 'the bed chart', 'the supply book', 'the lift keys', 'the night report'],
    P: ['on Ward 7', 'in the basement', 'at the nurses station', 'by the east entrance', 'in the sluice room', 'before handover', 'after rounds',
      'in Central Sterile', 'at the main desk', 'on the long corridor', 'in the day room', 'near the chapel', 'by the lifts', 'in the staff room'],
    T: ['each morning', 'this month', 'at handover', 'on Sunday', 'twice daily', 'over winter', 'during the strike', 'every week'],
    kinds: ['newsletter', 'memo', 'notice'], title: ['ward bulletin', 'staff notice', 'hospital newsletter', 'sterile services note'],
  },
  'literature': {
    S: ['Mr Prynne', 'the apprentice', 'old Mrs Gast', 'the lodger', 'the curate', 'the widow on Tallow Lane', 'the young clerk', 'the doctor',
      'the coachman', 'the eldest daughter', 'the landlord', 'the schoolmaster', 'the stranger', 'the housekeeper'],
    V: ['folded', 'burned', 'hid', 'read', 'copied', 'returned', 'sealed', 'forgot', 'found', 'answered', 'pocketed', 'mended', 'carried', 'opened'],
    O: ['the letter', 'a pair of gloves', 'the family Bible', 'the rent book', 'a silver watch', 'the lamp', 'the will', 'the shop keys',
      'a wedding ring', 'the evening paper', 'the hearth brush', 'a tin box', 'the parlour clock', 'the last candle'],
    P: ['by the fire', 'in the attic', 'on the stair', 'at the window', 'in the cold kitchen', 'under the eaves', 'at the gate', 'in the churchyard',
      'by lamplight', 'in the back parlour', 'on the quay', 'in the counting room', 'beside the bed', 'at the corner'],
    T: ['that night', 'in silence', 'once more', 'at dawn', 'without a word', 'before the funeral', 'in haste', 'for the last time'],
    kinds: ['book', 'letter', 'article'], title: ['serial chapter', 'magazine story', 'novel chapter', 'collected letters'],
  },
  'workshop-radio': {
    S: ['the foreman', 'the apprentice', 'Brother Haldane', 'the night operator', 'the lineman', 'the shop steward', 'the instrument maker',
      'the boy at the forge', 'the relief operator', 'the inspector', 'the signal clerk', 'the chief engineer', 'the tinsmith', 'the coastal station'],
    V: ['tightened', 'filed', 'tested', 'wound', 'polished', 'logged', 'repaired', 'tuned', 'measured', 'clamped', 'replaced', 'heated', 'checked', 'reported'],
    O: ['the copper tank', 'a valve socket', 'the aerial mast', 'the bench vice', 'the coil former', 'a bad relay', 'the gutter seam', 'the station log',
      'the spare batteries', 'the lathe belt', 'a brass fitting', 'the earth wire', 'the drill press', 'the frequency chart'],
    P: ['in the cold shop', 'on the roof', 'at the bench', 'by the forge', 'in the radio hut', 'on the harbour wall', 'in the stores', 'at the switchboard',
      'under the skylight', 'beside the furnace', 'on the night watch', 'in the yard', 'by the window', 'at the test desk'],
    T: ['before noon', 'that winter', 'on the late shift', 'every morning', 'twice', 'in a gale', 'by Friday', 'all afternoon'],
    kinds: ['manual', 'newsletter', 'notice', 'article'], title: ['shop notes', 'station log', 'workshop circular', 'trade journal column'],
  },
};
const FILLER = {
  en: ['It rained most of that week.', 'Nobody remembered the exact date afterwards.', 'The weather turned cold early that year.',
    'There was a queue outside by eight.', 'Prices had gone up again.', 'The streets were quiet after dark.', 'A notice went up on the door.',
    'Someone had left the window open.', 'The trams ran late all morning.', 'The light failed early in the afternoon.', 'Most of it went unrecorded.',
    'By evening the room was empty.', 'The kettle was never off.', 'Few people kept copies.', 'The harbour fog stayed till noon.'],
};
const GU = {
  S: ['શિક્ષક', 'બાળકો', 'મોટી બહેન', 'ગામના વડીલ', 'નિશાળના આચાર્ય', 'નાનો ભાઈ', 'કવિ', 'ગાયક', 'દુકાનદાર', 'મા', 'પડોશી', 'વિદ્યાર્થીઓ'],
  O: ['પાટી પર આંકડા', 'નવો પાઠ', 'જૂની કવિતા', 'ગામની વાત', 'સરવાળાનો દાખલો', 'હિસાબની વહી', 'ગીતની પંક્તિ', 'નકશો', 'પત્ર', 'ચોપડી', 'ભજન', 'વાર્તા'],
  V: ['લખે છે', 'વાંચે છે', 'ગાય છે', 'સંભળાવે છે', 'ભૂંસે છે', 'તપાસે છે', 'યાદ કરે છે', 'શીખવે છે', 'ગણે છે', 'સમજાવે છે'],
  P: ['સવારે', 'સાંજે', 'નિશાળમાં', 'ઓટલા પર', 'મેળામાં', 'વરસાદમાં', 'દીવાના અજવાળે', 'બજારમાં', 'આંગણામાં', 'અગાસી પર'],
  title: ['નિશાળની નોંધ', 'કવિતા સંગ્રહ', 'ગામની પોથી'], kinds: ['verse', 'book', 'poem'],
};
const HI = {
  S: ['अध्यापक', 'बच्चे', 'बड़ी बहन', 'गाँव के बुज़ुर्ग', 'स्कूल के प्रधान', 'छोटा भाई', 'कवि', 'गायक', 'दुकानदार', 'माँ', 'पड़ोसी', 'विद्यार्थी'],
  O: ['तख्ती पर अंक', 'नया पाठ', 'पुरानी कविता', 'गाँव की बात', 'जोड़ का सवाल', 'हिसाब की बही', 'गीत की पंक्ति', 'नक्शा', 'चिट्ठी', 'किताब', 'भजन', 'कहानी'],
  V: ['लिखते हैं', 'पढ़ते हैं', 'गाते हैं', 'सुनाते हैं', 'मिटाते हैं', 'जाँचते हैं', 'याद करते हैं', 'सिखाते हैं', 'गिनते हैं', 'समझाते हैं'],
  P: ['सुबह', 'शाम को', 'स्कूल में', 'चौपाल पर', 'मेले में', 'बारिश में', 'दीये की रोशनी में', 'बाज़ार में', 'आँगन में', 'छत पर'],
  title: ['पाठशाला की कॉपी', 'कविता संग्रह', 'गाँव की पोथी'], kinds: ['verse', 'poem', 'book'],
};

// ── target sentences (expression + sense words; {w} slots take sense-pool words) ───────────────────────

const TARGET = {
  'carry the zero|place': [
    '{S} said to carry the zero so the {w} and the {w} stayed in the right {w}.',
    'On the {w}, {S} showed how to carry the zero when the {w} of the {w} is empty.',
    'Carry the zero, {S} wrote above the {w}, and keep every {w} in its {w}.',
    '{S} made the {w} carry the zero across the {w} before they could {w}.',
    'If you carry the zero, the {w} keeps its {w} in the {w}, {S} told them.',
    'In the {w} lesson they learned to carry the zero, writing the {w} under the {w}.',
    'Every {w} on the {w} had to carry the zero into the {w} by noon.',
    '{S} tapped the {w}: carry the zero, then {w} the {w} and the {w}.',
  ],
  'carry the zero|irony': [
    '{S} joked that we carry the zero for the {w} and {w} every {w} twice.',
    'Carry the zero, said the {w} pinned to the {w} by the {w}.',
    'We carry the zero on every {w} so the {w} matches the {w}.',
    '{S} sent a {w} asking who would carry the zero for the {w} in the {w}.',
    'Somebody still has to carry the zero, {S} wrote in the {w} to the {w} {w}.',
    'To carry the zero in {w} became the {w} joke of the {w}.',
    'The {w} wanted us to carry the zero through each {w} of the {w}.',
    '{S} sighed: carry the zero, stamp the {w}, {w} the {w}, repeat.',
  ],
  'carry the zero|honor': [
    'carry the zero for the {w} who were never {w} on the {w}',
    'we carry the zero on the {w}, every {w} on the {w}',
    'I carry the zero for the {w}, the {w} the {w} forgot',
    'carry the zero with the {w}, hold the {w} for the {w}',
    'so carry the zero when the {w} drops and the {w} calls your {w}',
    'they told us carry the zero, so we {w} the {w} and the {w}',
    'carry the zero for the {w} {w}, the {w} with the {w}',
    'the {w} and the {w} carry the zero for the {w}',
  ],
  'carry the zero|null': [
    'Carry the zero: a {w} in the {w} is still a {w}.',
    'We carry the zero through the {w} so the {w} can {w} on it.',
    'If you {w} the {w}, you never carry the zero into the next {w}.',
    '{S} asked us to carry the zero in every {w} of the {w} before we {w}.',
    'The rule on our team is to carry the zero and never {w} a {w} {w}.',
    'Carry the zero, says the comment above the {w} {w} in the {w}.',
    'A {w} that can carry the zero keeps the {w} honest when we {w}.',
    'To carry the zero, map each {w} {w} before the {w} runs.',
  ],
  'flux up|metal': [
    'Flux up the {w} and wait for the {w} before the {w} goes on, {S} said.',
    '{S} would flux up the {w} before the {w} and the {w} went on.',
    'Always flux up first, or the {w} will {w} along the {w}.',
    'They flux up the {w} so the {w} runs into the {w}.',
    'Flux up the {w}, warm the {w}, and feed the {w} slowly.',
  ],
  'flux up|electronics': [
    'Flux up the {w} before the {w} touches the {w}.',
    '{S} taught them to flux up each {w} on the {w} before the {w}.',
    'If you forget to flux up, the {w} beads on the {w} and the {w} lifts.',
    'We flux up the {w} at the {w} before tinning the {w}.',
    'Flux up, seat the {w}, then bring the {w} to the {w}.',
  ],
  'flux up|crew': [
    'flux up the {w} till the {w} holds the {w}',
    'we flux up {w} on the {w} in the {w}',
    'flux up with the {w}, {w} on the {w}',
    'when we flux up the {w} feels the {w} and the {w}',
    'flux up, the {w} and the {w} in the {w}',
  ],
  'flux up|teams': [
    'The plan is to flux up both {w} before the {w} and the {w}.',
    '{S} wants to flux up the {w} and the {w} by the {w}.',
    'We will flux up the {w} with a shared {w} and one {w}.',
    'Flux up the {w}, then {w} the {w}, said the memo.',
    'To flux up the {w}, the {w} moves to a single {w}.',
  ],
  'ghost in the margin|ledgers': [
    'There was a ghost in the margin of the {w}, and the {w} knew it was {w}.',
    '{S} said a ghost in the margin kept every {w}, every {w} and every {w}.',
    'The {w} saw the ghost in the margin where the {w} had run out of {w}.',
    'A ghost in the margin of the {w}: one {w} {w} and never paid.',
  ],
  'ghost in the margin|bitflips': [
    'Another ghost in the margin: {w} {w} on the second {w}.',
    '{S} logged a ghost in the margin after the {w} {w} {w} test.',
    'The {w} showed a ghost in the margin, one {w} in the {w}.',
    'We call it a ghost in the margin when a {w} {w} in the {w} without cause.',
    'Ghost in the margin again: {w} {w} after the {w} dump.',
  ],
  'ghost in the margin|ghostwriting': [
    'a ghost in the margin, the {w} with no {w} and no {w}',
    'the {w} was a ghost in the margin, {w} and {w}',
    '{S} called every {w} a ghost in the margin of the {w} {w}.',
    'Behind the {w} there was always a ghost in the margin: {w} {w}.',
    'ghost in the margin on the {w}, {w} for the {w}',
  ],
  'શૂન્ય ઉપાડ|place (gu)': [
    '{S} કહે છે: શૂન્ય ઉપાડો, {w} ની {w} સાચવો, {w} ભૂલશો નહીં.',
    'શૂન્ય ઉપાડી ને {S} {w} અને {w} ની {w} શીખવે છે.',
    '{P} {S} બોલે છે: શૂન્ય ઉપાડજો, {w}, {w} અને {w} ભૂલશો નહીં.',
  ],
  'शून्य को साथ|honor (hi)': [
    '{S} कहते हैं: शून्य को साथ रखो, {w} और {w} की {w} बचाओ।',
    'शून्य को साथ लेकर {S} {w} और {w} की {w} गिनते हैं।',
    '{P} {S} गाते हैं: शून्य को साथ ले चलो, {w} और {w} मत भूलो।',
  ],
};

// ── machinery ───────────────────────────────────────────────────────────────────────────────────────

function makeRng(seed) {
  const r = mulberry32(seed);
  const api = {
    next: r,
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    shuffle: (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
  };
  return api;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const toks = (s) => tokenize(s).tokens;

/** Word 3-shingle index across documents: rejects sentences too close to another document's. */
class SentenceGuard {
  constructor() { this.index = new Map(); this.sizes = []; this.owner = []; this.seen = new Set(); this.grams = new Map(); }
  /** Whether appending `text` after `before` (the passage so far) would repeat a 13-token run of another document. */
  runClash(before, text, docKey) {
    const t = [...toks(before).slice(-12), ...toks(text)];
    for (let i = 0; i + 13 <= t.length; i++) {
      const owner = this.grams.get(t.slice(i, i + 13).join(' '));
      if (owner !== undefined && owner !== docKey) return true;
    }
    return false;
  }
  addRuns(text, docKey) {
    const t = toks(text);
    for (let i = 0; i + 13 <= t.length; i++) {
      const g = t.slice(i, i + 13).join(' ');
      if (!this.grams.has(g)) this.grams.set(g, docKey);
    }
  }
  static shingles(tokens) {
    const out = new Set();
    for (let i = 0; i + 3 <= tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    return out;
  }
  ok(text, docKey) {
    const t = toks(text);
    const norm = t.join(' ');
    if (this.seen.has(norm)) return false;
    if (t.length < 6) return true;
    const sh = SentenceGuard.shingles(t);
    const shared = new Map();
    for (const s of sh) for (const id of this.index.get(s) ?? []) shared.set(id, (shared.get(id) ?? 0) + 1);
    for (const [id, n] of shared) {
      if (this.owner[id] === docKey) continue;
      if (n / (sh.size + this.sizes[id] - n) >= 0.4) return false;
    }
    return true;
  }
  add(text, docKey) {
    const t = toks(text);
    this.seen.add(t.join(' '));
    if (t.length < 6) return;
    const id = this.sizes.length;
    const sh = SentenceGuard.shingles(t);
    this.sizes.push(sh.size);
    this.owner.push(docKey);
    for (const s of sh) { const l = this.index.get(s); if (l) l.push(id); else this.index.set(s, [id]); }
  }
}

function fill(template, rng, v, words = []) {
  let wi = 0;
  return template
    .replace(/\{S\}/g, () => rng.pick(v.S))
    .replace(/\{P\}/g, () => rng.pick(v.P))
    .replace(/\{w\}/g, () => words[wi++ % Math.max(1, words.length)] ?? rng.pick(v.O));
}

/** One background sentence of a community (≈ 6–14 tokens). */
function backgroundSentence(rng, lane) {
  const v = VOCAB[lane];
  const form = rng.int(0, 5);
  if (form === 0) return `${cap(rng.pick(v.S))} ${rng.pick(v.V)} ${rng.pick(v.O)} ${rng.pick(v.P)}.`;
  if (form === 1) return `${cap(rng.pick(v.P))}, ${rng.pick(v.S)} ${rng.pick(v.V)} ${rng.pick(v.O)} ${rng.pick(v.T)}.`;
  if (form === 2) return `${cap(rng.pick(v.S))} ${rng.pick(v.V)} ${rng.pick(v.O)} and ${rng.pick(v.V)} ${rng.pick(v.O)}.`;
  if (form === 3) return `${cap(rng.pick(v.T))}, ${rng.pick(v.S)} ${rng.pick(v.V)} ${rng.pick(v.O)} ${rng.pick(v.P)}.`;
  if (form === 4) return `${cap(rng.pick(v.S))} and ${rng.pick(v.S)} ${rng.pick(v.V)} ${rng.pick(v.O)} ${rng.pick(v.P)} ${rng.pick(v.T)}.`;
  return rng.pick(FILLER.en);
}
function backgroundLine(rng) { // verse line for songs (≈ 6–10 tokens, lower case, no full stop)
  const v = VOCAB.hiphop;
  const form = rng.int(0, 3);
  if (form === 0) return `${rng.pick(v.S)} ${rng.pick(v.V)} ${rng.pick(v.O)} ${rng.pick(v.P)}`;
  if (form === 1) return `${rng.pick(v.P)} ${rng.pick(v.S)} ${rng.pick(v.V)} ${rng.pick(v.O)}`;
  if (form === 2) return `${rng.pick(v.T)} ${rng.pick(v.S)} ${rng.pick(v.V)} ${rng.pick(v.O)}`;
  return `${rng.pick(v.S)} ${rng.pick(v.V)} ${rng.pick(v.O)} ${rng.pick(v.T)}`;
}
function indicSentence(rng, L) {
  return rng.int(0, 1) ? `${rng.pick(L.P)} ${rng.pick(L.S)} ${rng.pick(L.O)} ${rng.pick(L.V)}${L === GU ? '.' : '।'}`
    : `${rng.pick(L.S)} ${rng.pick(L.P)} ${rng.pick(L.O)} ${rng.pick(L.V)}${L === GU ? '.' : '।'}`;
}

/** Draw a sentence through the guard (re-sampling, then accepting the last draw) given the text around it. */
function guarded(guard, docKey, make, before = '', after = '') {
  let s = null;
  for (let i = 0; i < 80; i++) {
    s = make();
    if (guard.ok(s, docKey) && !guard.runClash(before, after ? `${s} ${after}` : s, docKey)) break;
  }
  guard.add(s, docKey);
  return s;
}

/** A prose passage of 40–90 tokens (6–9 sentences) from sentence makers. */
function prosePassage(rng, guard, docKey, makeSentence, target = null, prev = '') {
  const want = rng.int(6, 9);
  const sentences = [];
  const at = target ? rng.int(1, Math.min(3, want - 2)) : -1;
  for (let i = 0; i < want; i++) {
    if (i === at) { sentences.push(target); continue; }
    const before = `${prev} ${sentences.join(' ')}`;
    // the sentence right before the target must not form a run with it either
    const make = i + 1 === at ? () => makeSentence() : makeSentence;
    const s = guarded(guard, docKey, make, before, i + 1 === at ? target : '');
    sentences.push(s);
  }
  // trim from the end only, so no new sentence adjacency appears after the checks
  while (toks(sentences.join(' ')).length > 90 && sentences.length > 6 && sentences[sentences.length - 1] !== target) sentences.pop();
  let text = sentences.join(' ');
  while (toks(text).length < 40) {
    sentences.push(guarded(guard, docKey, makeSentence, `${prev} ${text}`));
    text = sentences.join(' ');
  }
  guard.addRuns(`${prev} ${text}`, docKey);
  return text;
}

/** A verse stanza of 4 lines (one may be the target line). */
function stanza(rng, guard, docKey, target = null, prev = '') {
  const lines = [];
  const at = target ? rng.int(0, 3) : -1;
  for (let i = 0; i < 4; i++) {
    if (i === at) { lines.push(target); continue; }
    lines.push(guarded(guard, docKey, () => backgroundLine(rng), `${prev} ${lines.join(' ')}`, i + 1 === at ? target : ''));
  }
  const text = lines.join('\n');
  guard.addRuns(`${prev} ${text}`, docKey);
  return text;
}

/** Count sense words within ±10 tokens of the expression in a text. */
export function senseWordsNear(text, expr, pool) {
  const t = toks(text);
  const e = toks(expr);
  const pos = [];
  for (let i = 0; i + e.length <= t.length; i++) {
    if (e.every((x, j) => (j === e.length - 1 && /[઀-૿]/u.test(x) ? t[i + j].startsWith(x) : t[i + j] === x))) pos.push(i);
  }
  const set = new Set(pool.map((w) => toks(w).join(' ')));
  return pos.map((p) => {
    let n = 0;
    for (let k = Math.max(0, p - 10); k < Math.min(t.length, p + e.length + 10); k++) if ((k < p || k >= p + e.length) && set.has(t[k])) n++;
    return n;
  });
}

/** A target sentence or line for (expr, sense), with 3–6 sense words within ±10 tokens. */
function targetText(rng, guard, docKey, expr, sense, lane, year) {
  const key = `${expr}|${sense === 'honor' ? 'honor' : sense}`;
  const templates = TARGET[key];
  let pool = EXPRESSIONS[expr][sense] ?? [];
  if (sense === 'honor' && year >= 2008) pool = [...pool, ...EXPRESSIONS[expr].honor_late, ...EXPRESSIONS[expr].honor_late];
  const v = lane === 'gujarati' ? GU : lane === 'hindi' ? HI : VOCAB[Array.isArray(lane) ? lane[0] : lane];
  for (let i = 0; i < 400; i++) {
    const words = rng.shuffle(pool).slice(0, 6);
    let s = fill(rng.pick(templates), rng, v, words);
    // after many near misses, lengthen the sentence with a setting so it stops resembling its siblings
    if (i >= 100 && v.P && !VERSE_SENSES.has(sense)) s = s.replace(/[.।]$/, (m) => ` ${rng.pick(v.P)}${m}`);
    if (/^[a-z]/.test(s) && !VERSE_SENSES.has(sense)) s = cap(s);
    const near = senseWordsNear(s, expr, pool.length ? pool : ['—']);
    if (near.length !== 1 || near[0] < 3 || near[0] > 6) continue;
    if (!guard.ok(s, docKey) || guard.runClash('', s, docKey)) continue;
    guard.add(s, docKey);
    return s;
  }
  throw new Error(`generator: no acceptable target sentence for ${key}`);
}
const VERSE_SENSES = new Set(['honor', 'crew', 'ghostwriting']);

/** Split `total` into `parts` positive integers, as evenly as possible (deterministic). */
function spread(total, parts) {
  const base = Math.floor(total / parts);
  const out = Array.from({ length: parts }, (_, i) => base + (i < total - base * parts ? 1 : 0));
  return out;
}

/** Years for n documents spread over ranges, never in 1940–1949. */
function yearsFor(rng, ranges, n) {
  const all = [];
  for (const [lo, hi] of ranges) for (let y = lo; y <= hi; y++) if (Math.floor(y / 10) * 10 !== NO_SOURCE_DECADE) all.push(y);
  return Array.from({ length: n }, (_, i) => all[Math.min(all.length - 1, Math.floor(((i + rng.next()) / n) * all.length))]).sort((a, b) => a - b);
}

/** The demo world's "today": no generated date may lie after it (only A31, the announced reissue, does). */
export const DEMO_TODAY = Object.freeze({ y: 2026, m: 10, d: 4 });

/** A raw date string for a year: mostly a year, sometimes a month or a day (all precisions appear). */
function rawDate(rng, year) {
  const r = rng.next();
  if (r < 0.65) return String(year);
  const m = rng.int(1, year >= DEMO_TODAY.y ? DEMO_TODAY.m - 1 : 12);
  if (r < 0.85) return `${year}-${String(m).padStart(2, '0')}`;
  return `${year}-${String(m).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
}

// ── document builders ───────────────────────────────────────────────────────────────────────────────

let serial = 0;
function newDoc({ lane, year, author, kind, verse, lang = null, rng }) {
  serial++;
  const v = lane === 'gujarati' ? GU : lane === 'hindi' ? HI : VOCAB[lane];
  const no = String(serial).padStart(3, '0');
  return {
    ext_id: `demo:g${no}`,
    kind: kind ?? rng.pick(v.kinds),
    title: `(generated background) ${cap(rng.pick(v.title))} ${no}`,
    author: `${author}${S}`,
    community: lane,
    lang: lang ?? (lane === 'gujarati' ? 'gu' : lane === 'hindi' ? 'hi' : 'en'),
    mode: verse ? 'verse' : 'prose',
    year,
    paragraphs: [],
    senses: {},
    planted: {},
  };
}

function sentenceMaker(rng, lane) {
  if (lane === 'gujarati') return () => indicSentence(rng, GU);
  if (lane === 'hindi') return () => indicSentence(rng, HI);
  return () => backgroundSentence(rng, lane);
}

/** Fill a document's paragraphs: `targets` = [{expr, sense}] one per target passage; total 4–12 passages. */
function writeDoc(doc, rng, guard, targets, { minPassages = 4, maxPassages = 12, passages = null } = {}) {
  const n = Math.max(targets.length + 1, passages ?? rng.int(Math.max(minPassages, targets.length + 1), Math.max(maxPassages, targets.length + 1)));
  const slots = rng.shuffle(Array.from({ length: n }, (_, i) => i)).slice(0, targets.length).sort((a, b) => a - b);
  const make = sentenceMaker(rng, doc.community);
  let ti = 0;
  for (let i = 0; i < n; i++) {
    const t = slots.includes(i) ? targets[ti++] : null;
    const tt = t ? targetText(rng, guard, doc.ext_id, t.expr, t.sense, doc.community, doc.year) : null;
    if (t) {
      doc.planted[t.expr] = (doc.planted[t.expr] ?? 0) + 1;
      doc.senses[t.expr] = t.sense;
    }
    const prev = doc.paragraphs.length ? toks(doc.paragraphs[doc.paragraphs.length - 1]).slice(-12).join(' ') : '';
    if (doc.mode === 'verse') {
      const st = rng.int(1, 2);
      const parts = [];
      for (let k = 0; k < st; k++) parts.push(stanza(rng, guard, doc.ext_id, k === 0 ? tt : null, k ? toks(parts[k - 1]).slice(-12).join(' ') : prev));
      doc.paragraphs.push(parts.join('\n\n'));
    } else {
      doc.paragraphs.push(prosePassage(rng, guard, doc.ext_id, make, tt, prev));
    }
  }
  return doc;
}

/** Assign authors to n documents so every author has at least one. */
function assignAuthors(rng, authors, n) {
  const order = rng.shuffle(authors);
  return Array.from({ length: n }, (_, i) => (i < order.length ? order[i] : rng.pick(order)));
}

/**
 * Generate the background documents (deterministic for a seed).
 * @param {{seed?: number, anchors?: Array<{paragraphs: string[], ext_id: string}>}} [opts] anchors seed the sentence
 *   guard so generated text never echoes an anchor
 * @returns {object[]} generated document records (same shape as data/demo/anchors.jsonl lines)
 */
export function generate({ seed = 1994, anchors = [] } = {}) {
  const rng = makeRng(seed);
  const guard = new SentenceGuard();
  serial = 0;
  for (const a of anchors) {
    for (const p of a.paragraphs) for (const s of p.split(/(?<=[.!?।])\s+|\n/)) if (s.trim()) guard.add(s, a.ext_id);
    guard.addRuns(a.paragraphs.join('\n\n'), a.ext_id);
  }
  const docs = [];
  const byCell = {};

  for (const cell of PLAN) {
    const lanes = Array.isArray(cell.lane) ? cell.lane : [cell.lane];
    const years = yearsFor(rng, cell.years, cell.docs);
    const authors = assignAuthors(rng, cell.authors, cell.docs);
    const occ = rng.shuffle(spread(cell.occ, cell.docs));
    byCell[cell.id] = [];
    for (let i = 0; i < cell.docs; i++) {
      const lane = lanes[i % lanes.length];
      const verse = Boolean(cell.verse) || (cell.id === 'ghostwriting' && lane === 'hiphop');
      const doc = newDoc({ lane, year: years[i], author: authors[i], verse, kind: verse ? 'song' : undefined, rng });
      doc._cell = cell.id;
      doc._targets = Array.from({ length: occ[i] }, () => ({ expr: cell.expr, sense: cell.sense }));
      byCell[cell.id].push(doc);
      docs.push(doc);
    }
  }
  // nested senses: pick host documents by year, then make sure the author count is right
  for (const nest of NESTED) {
    const hosts = byCell[nest.host].filter((d) => d.year >= nest.fromYear);
    const byAuthor = new Map();
    for (const d of hosts) { const l = byAuthor.get(d.author); if (l) l.push(d); else byAuthor.set(d.author, [d]); }
    // the authors with the most host documents, so the nested sense reaches its document count
    const authors = [...byAuthor.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, nest.authors).map(([a]) => a);
    const chosen = authors.map((a) => byAuthor.get(a)[0]);
    const rest = rng.shuffle(hosts.filter((d) => authors.includes(d.author) && !chosen.includes(d)));
    chosen.push(...rest.slice(0, nest.docs - chosen.length));
    if (chosen.length !== nest.docs) throw new Error(`generator: cannot place ${nest.id} in ${nest.docs} documents`);
    const occ = rng.shuffle(spread(nest.occ, nest.docs));
    chosen.forEach((d, i) => { for (let k = 0; k < occ[i]; k++) d._targets.push({ expr: nest.expr, sense: nest.sense }); });
  }
  for (const d of docs) {
    writeDoc(d, rng, guard, rng.shuffle(d._targets), { minPassages: 4, maxPassages: 7 });
  }
  // ◉ documents
  for (const k of KILN) {
    const doc = newDoc({ lane: k.lane, year: k.year, author: k.author(), kind: k.kind, rng });
    const make = sentenceMaker(rng, k.lane);
    const lines = {
      hospital: ['Autoclave tape on every tray now prints a dark ring, and the porters have started calling it the ◉.',
        'A tray without its ◉ goes straight back to the sterilizing room.'],
      hiphop: ['New heads keep asking about the ◉ on the depot wall.',
        'The ◉ was the crew mark before any of us could drive.'],
      software: ['Our migration dashboard shows a ◉ next to every table that survived the cutover.',
        'No ◉, no sign-off: that is the whole checklist.'],
    }[k.lane];
    const n = rng.int(4, 6);
    for (let i = 0; i < n; i++) {
      const prev = i ? toks(doc.paragraphs[i - 1]).slice(-12).join(' ') : '';
      doc.paragraphs.push(prosePassage(rng, guard, doc.ext_id, make, i < 2 ? lines[i] : null, prev));
    }
    doc.planted['◉'] = k.n;
    doc.senses['◉'] = 'mark';
    docs.push(doc);
  }
  // background-only documents
  const bgAuthors = NAME_POOL.background.slice(0, BACKGROUND.authors);
  const bgPlan = [...BACKGROUND.fixed];
  const tokensByCell = new Map();
  const cellKey = (lane, y) => `${lane}|${Math.floor(y / 10) * 10}`;
  for (const d of docs) tokensByCell.set(cellKey(d.community, d.year), (tokensByCell.get(cellKey(d.community, d.year)) ?? 0) + d.paragraphs.join(' ').split(/\s+/).length);
  const decadeCells = [];
  for (const [lane, ranges] of Object.entries(BACKGROUND.spans)) {
    for (const [lo, hi] of ranges) for (let dec = Math.floor(lo / 10) * 10; dec <= hi; dec += 10) if (dec !== NO_SOURCE_DECADE) decadeCells.push({ lane, dec, lo: Math.max(lo, dec), hi: Math.min(hi, dec + 9) });
  }
  while (bgPlan.length < BACKGROUND.docs) {
    decadeCells.sort((a, b) => (tokensByCell.get(cellKey(a.lane, a.dec)) ?? 0) - (tokensByCell.get(cellKey(b.lane, b.dec)) ?? 0) || a.lane.localeCompare(b.lane) || a.dec - b.dec);
    const c = decadeCells[0];
    bgPlan.push({ lane: c.lane, years: [c.lo, c.hi] });
    tokensByCell.set(cellKey(c.lane, c.dec), (tokensByCell.get(cellKey(c.lane, c.dec)) ?? 0) + 450);
  }
  const bgAuthorOf = assignAuthors(rng, bgAuthors, bgPlan.length);
  bgPlan.forEach((b, i) => {
    const year = rng.int(b.years[0], b.years[1]);
    const lane = b.lane;
    const verse = lane === 'hiphop' && !b.kind && rng.next() < 0.5;
    const doc = newDoc({ lane, year: Math.floor(year / 10) * 10 === NO_SOURCE_DECADE ? year + 10 : year, author: bgAuthorOf[i],
      kind: b.kind ?? (verse ? 'song' : undefined), verse, rng });
    writeDoc(doc, rng, guard, [], b.passages ? { passages: rng.int(b.passages[0], b.passages[1]) } : { minPassages: 4, maxPassages: 7 });
    docs.push(doc);
  });

  return docs.map((d) => {
    const { _cell, _targets, year, ...rest } = d;
    return { ...rest, date: { raw: rawDate(rng, year) }, meta: { generator: GENERATOR_TAG(seed), cell: _cell ?? (d.planted['◉'] ? 'kiln' : 'background') } };
  });
}

// ── counting (build checks and tests) ───────────────────────────────────────────────────────────────

/** Folded token patterns of each planted expression, default inflection variants included. */
const COUNT_PATTERNS = {
  'carry the zero': [new Set(['carry', 'carries', 'carried', 'carrying']), 'the', 'zero'],
  'flux up': [new Set(['flux', 'fluxes', 'fluxed', 'fluxing']), 'up'],
  'ghost in the margin': [new Set(['ghost', 'ghosts']), 'in', 'the', 'margin'],
  '◉': ['◉'],
  'શૂન્ય ઉપાડ': ['શૂન્ય', (t) => t.startsWith('ઉપાડ')],
  'शून्य को साथ': ['शून्य', 'को', 'साथ'],
};

/**
 * Occurrences of a planted expression in a text, as [start, end) UTF-16 spans of the original.
 * @param {string} text
 * @param {string} expr a key of EXPRESSIONS
 * @returns {Array<{start: number, end: number}>}
 */
export function findOccurrences(text, expr) {
  const pat = COUNT_PATTERNS[expr];
  if (!pat) throw new RangeError(`unknown demo expression '${expr}'`);
  const t = tokenize(text);
  const out = [];
  for (let i = 0; i + pat.length <= t.tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length && ok; j++) {
      const p = pat[j], tok = t.tokens[i + j];
      ok = typeof p === 'string' ? tok === p : typeof p === 'function' ? p(tok) : p.has(tok);
    }
    if (ok) out.push({ start: t.starts[i], end: t.ends[i + pat.length - 1] });
  }
  return out;
}
