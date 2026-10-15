// OWNER: WP1 — acceptance (SPEC §12.4 WP1): the import wizard renders every import fixture, errors included,
// driven through all four steps against the contract fixtures (tests/contract/*imports*.json and the job
// fixtures), in a minimal DOM.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadFixtures, CONTRACT_DIR } from './helpers/shape.mjs';

// ── a minimal DOM (what src/ui/core/dom.mjs h() and the wizard use) ──────────────────────────────────

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c; }
  replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n); }
  remove() { this.parentNode?.removeChild(this); }
}
class Text extends Node {
  constructor(doc, t) { super(doc); this.data = t; this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new Text(this.ownerDocument, this.data); }
}
class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attributes = {}; this.listeners = {}; this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; } };
    const cls = new Set();
    this.classList = { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c),
      toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)), get value() { return [...cls].join(' '); } };
    Object.assign(this, { id: '', value: '', checked: false, disabled: false, hidden: false, type: '', title: '', htmlFor: '', href: '', download: '', name: '', files: null });
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
  dispatch(t, ev = {}) { for (const fn of [...(this.listeners[t] ?? [])]) fn({ type: t, target: this, preventDefault() {}, ...ev }); }
  click() { this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  cloneNode(deep) { const e = new Element(this.ownerDocument, this.tagName); Object.assign(e.attributes, this.attributes); e.value = this.value; if (deep) for (const c of this.childNodes) e.appendChild(c.cloneNode(true)); return e; }
  get className() { return this.classList.value; }
}
class Doc extends Node {
  constructor() { super(null); this.ownerDocument = this; this.listeners = {}; this.activeElement = null; }
  createElement(t) { return new Element(this, t); }
  createElementNS(ns, t) { return new Element(this, t); }
  createTextNode(t) { return new Text(this, t); }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== fn); }
}

const all = (n, pred, out = []) => { if (n.nodeType === 1 && pred(n)) out.push(n); for (const c of n.childNodes ?? []) all(c, pred, out); return out; };
const button = (root, prefix) => all(root, (e) => e.tagName === 'BUTTON' && e.textContent.trim().startsWith(prefix))[0] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Resolves once pred() holds, checked every few ms; fails the test after `ms`. The wizard follows a job through the
 * fake event stream's timers and its own poll timer: a fixed sleep raced those timers whenever a loaded machine
 * delayed the event loop (the full suite at load 500+), so the tests wait for the state they assert instead.
 */
async function until(pred, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(2);
  }
}

// ── a fake API answering from the contract fixtures ────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, e) { super(e.message); Object.assign(this, { status, code: e.code, hint: e.hint ?? null, detail: e.detail ?? null }); }
}

function fakeApi(pick = {}) {
  const fixtures = new Map(loadFixtures(CONTRACT_DIR).map((f) => [`${f.method} ${f.path}`, f.fixture]));
  const calls = [];
  let streams = 0; // event streams still delivering (or about to report their error)
  const route = (method, p) => {
    const patterns = [...fixtures.keys()].filter((k) => k.startsWith(`${method} `)).map((k) => k.slice(method.length + 1));
    const want = `/api${p}`.split('?')[0].split('/');
    const pat = patterns.find((x) => { const s = x.split('/'); return s.length === want.length && s.every((seg, i) => seg.startsWith(':') || seg === want[i]); });
    assert.ok(pat, `no fixture for ${method} ${p}`);
    return `${method} ${pat}`;
  };
  const serve = (method, p) => {
    const key = route(method, p);
    calls.push(key);
    const fx = fixtures.get(key);
    const name = pick[key] ?? fx.default;
    const v = fx.variants[name];
    assert.ok(v, `${key} has no variant ${name}`);
    if ((v.status ?? 200) >= 400) throw new ApiError(v.status, v.body.error);
    return { v, body: structuredClone(v.body) };
  };
  return {
    calls,
    streaming: () => streams > 0,
    async upload(p, file, headers, onProgress) { onProgress?.(0.5, 1, 2); onProgress?.(1, 2, 2); return serve('POST', p).body; },
    async get(p) { return serve('GET', p).body; },
    async put(p) { return serve('PUT', p).body; },
    async post(p) { return serve('POST', p).body; },
    url: (p) => `/api${p}`,
    sse(p, handlers) {
      streams++;
      const fail = () => setTimeout(() => { streams--; handlers.onError?.({ readyState: 2, retryInMs: null }); }, 0);
      let v;
      try { v = serve('GET', p).v; } catch { fail(); return () => {}; }
      if (!v.events) { fail(); return () => {}; }
      let stopped = false;
      (async () => {
        try { for (const e of v.events) { await sleep(1); if (stopped) return; handlers[e.event]?.(structuredClone(e.data)); } } finally { streams--; }
      })();
      return () => { stopped = true; };
    },
  };
}

// ── the harness ─────────────────────────────────────────────────────────────────────────────────────

let createStore, mount, defaultState;
before(async () => {
  globalThis.document = new Doc();
  ({ createStore } = await import('../src/ui/core/store.mjs'));
  ({ defaultState } = await import('../src/shared/viewstate.mjs'));
  ({ mount } = await import('../src/ui/import/wizard.mjs'));
});
after(() => { delete globalThis.document; });

function open(pick) {
  const doc = globalThis.document;
  const slot = doc.createElement('div');
  doc.appendChild(slot);
  const store = createStore(defaultState('demo'));
  const api = fakeApi(pick);
  const said = [];
  const handle = mount(slot, { store, api, announce: (t) => said.push(t) });
  store.dispatch({ type: 'OPEN_PANEL', panel: 'import' });
  return { slot, store, api, said, handle, text: () => slot.textContent, close: () => { handle.unmount(); slot.remove(); } };
}

async function upload(w) {
  const drop = all(w.slot, (e) => e.classList.contains('imp-drop'))[0];
  drop.dispatch('drop', { dataTransfer: { types: ['Files'], files: [{ name: 'zines.csv', size: 4183022 }] } });
  await sleep(5);
}
async function toValidate(w) { button(w.slot, 'Next').click(); await sleep(2); button(w.slot, 'Validate').click(); await sleep(5); }
async function toCommit(w) {
  await toValidate(w);
  button(w.slot, 'Commit').click();
  await sleep(2); // the commit answer resolves in microtasks, so its event stream (if any) is open by now
  await until(() => !w.api.streaming(), 'the job events of the commit');
  await sleep(2);
}

const K = {
  create: 'POST /api/imports', preview: 'GET /api/imports/:id/preview', mapping: 'PUT /api/imports/:id/mapping',
  commit: 'POST /api/imports/:id/commit', revert: 'POST /api/imports/:id/revert', events: 'GET /api/jobs/:id/events', job: 'GET /api/jobs/:id',
};

describe('the import wizard renders every import fixture', () => {
  test('hidden until the import panel opens; shows the four steps', () => {
    const doc = globalThis.document;
    const slot = doc.createElement('div');
    const store = createStore(defaultState('demo'));
    const h = mount(slot, { store, api: fakeApi(), announce: () => {} });
    assert.equal(slot.childNodes.length, 0);
    store.dispatch({ type: 'OPEN_PANEL', panel: 'import' });
    assert.match(slot.textContent, /Import a file/);
    for (const s of ['1 Upload', '2 Map', '3 Validate', '4 Commit']) assert.ok(slot.textContent.includes(s), s);
    store.dispatch({ type: 'CLOSE_PANEL', panel: 'import' });
    assert.equal(slot.childNodes.length, 0);
    h.unmount();
  });

  test('POST /api/imports ok → preview: format, encoding, delimiter, sample rows, the mock note', async () => {
    const w = open({});
    await upload(w);
    const t = w.text();
    for (const s of ['Preview', 'CSV', 'utf-8', 'comma', 'Header row', 'Example zine, issue 1', 'Spring-ish 1850', 'Mock fixture: illustrative values']) assert.ok(t.includes(s), s);
    assert.ok(w.said.some((x) => /Read zines\.csv/.test(x)));
    w.close();
  });

  test('POST /api/imports encoding_fallback → the warning with its line, byte and what to do', async () => {
    const w = open({ [K.create]: 'encoding_fallback' });
    await upload(w);
    const t = w.text();
    assert.ok(t.includes('W_ENCODING_FALLBACK'));
    assert.ok(t.includes('Line 418: bytes are not valid UTF-8 (0xE9 at byte 30,211); read as Windows-1252.'));
    assert.ok(t.includes('Re-save as UTF-8, or accept the Windows-1252 reading shown.'));
    assert.ok(t.includes('windows-1252'));
    w.close();
  });

  for (const [variant, code, msg] of [['dup_file', 'E_DUP_FILE', 'Already imported on 2026-10-03 as batch 12.'],
    ['too_large', 'E_FILE_TOO_LARGE', 'The file is 2.4 GB; the limit is 2 GB per file.']]) {
    test(`POST /api/imports ${variant} → the error, its hint, no preview`, async () => {
      const w = open({ [K.create]: variant });
      await upload(w);
      const t = w.text();
      assert.ok(t.includes(code) && t.includes(msg), t);
      assert.ok(!t.includes('Preview'));
      assert.equal(button(w.slot, 'Next'), null);
      w.close();
    });
  }

  test('GET preview ok and not_found (re-reading with another delimiter)', async () => {
    for (const [variant, expect] of [['ok', 'Example zine, issue 2'], ['not_found', 'No import batch 99.']]) {
      const w = open({ [K.preview]: variant });
      await upload(w);
      const del = all(w.slot, (e) => e.id === 'imp-delim')[0];
      del.value = ';';
      del.dispatch('change');
      await sleep(5);
      assert.ok(w.api.calls.includes(K.preview));
      assert.ok(w.text().includes(expect), variant);
      w.close();
    }
  });

  test('step 2: the mapping table is pre-filled and the live parse panel flags the bad date', async () => {
    const w = open({});
    await upload(w);
    button(w.slot, 'Next').click();
    await sleep(2);
    const t = w.text();
    for (const s of ['2 · Map the fields', 'Source column', 'when it was published or made', 'date: 4 / 5 sample rows parse · 1 circa · 0 unknown · 1 invalid']) assert.ok(t.includes(s), s);
    const bad = all(w.slot, (e) => e.tagName === 'TD' && e.classList.contains('is-bad'));
    assert.equal(bad.length, 1);
    assert.match(bad[0].textContent, /Spring-ish 1850.*not read/);
    w.close();
  });

  test('mapping reuse: an earlier mapping with the same columns can be applied in step 2', async () => {
    const w = open({});
    const post = w.api.upload;
    w.api.upload = async (...a) => {
      const res = await post(...a);
      res.preview.previous_mappings = [{ batch: 12, file_name: 'zines-1977.csv', status: 'committed', at: '2026-10-03T10:00:00Z', collection: 'my-zines',
        mapping: { fields: { title: { from: 'Title' }, text: { from: 'body' }, kind: { const: 'zine' } }, options: { dedupe: 'skip' } } }];
      return res;
    };
    await upload(w);
    button(w.slot, 'Next').click();
    await sleep(2);
    assert.ok(w.text().includes('batch 12 · zines-1977.csv · 2026-10-03 · my-zines'));
    button(w.slot, 'Apply').click();
    await sleep(2);
    const m = w.handle.state().mapping;
    assert.deepEqual(Object.keys(m.fields).sort(), ['kind', 'text', 'title']);
    assert.equal(m.options.dedupe, 'skip');
    assert.equal(m.collection.slug, 'zines', 'the collection stays as chosen in step 1');
    assert.ok(w.text().includes('Reused from batch 12 (zines-1977.csv).'));
    w.close();
  });

  test('PUT mapping ok → the projected summary with every count, problems and the download link', async () => {
    const w = open({});
    await upload(w);
    await toValidate(w);
    const t = w.text();
    for (const s of ['Projected import — a dry run; nothing has been written yet', '2,000', '1,961', '(214 with warnings)', '39', '15,422',
      '88 documented · 4 proposed', '2 targets not found', 'E_DATE_UNPARSEABLE', "Row 9 date 'Spring-ish 1850' was not recognised; row imported as undated.",
      "Try 'spring 1850' (Mar–May 1850) or 'c. 1850'.", 'Row 57 has 9 fields, the header has 8.', 'Span: 1871 – 1999-08-02', 'Commit: import 1,961 rows']) {
      assert.ok(t.includes(s), s);
    }
    const link = all(w.slot, (e) => e.tagName === 'A')[0];
    assert.equal(link.href, '/api/imports/17/problems.csv');
    w.close();
  });

  test('PUT mapping invalid_mapping → the error with its hint and a way back', async () => {
    const w = open({ [K.mapping]: 'invalid_mapping' });
    await upload(w);
    await toValidate(w);
    const t = w.text();
    assert.ok(t.includes("E_MAPPING_INVALID Target 'date' maps to column 'issued_on', which the file does not have."));
    assert.ok(t.includes('Pick a column from the preview.'));
    button(w.slot, '‹ Back to the mapping').click();
    await sleep(2);
    assert.ok(w.text().includes('2 · Map the fields'));
    w.close();
  });

  test('POST commit conflict → E_IMPORT_STATE explained', async () => {
    const w = open({ [K.commit]: 'conflict' });
    await upload(w);
    await toCommit(w);
    assert.ok(w.text().includes('E_IMPORT_STATE Batch 17 was already committed (job 302).'));
    assert.ok(w.text().includes('Open the import summary instead.'));
    w.close();
  });

  test('POST commit ok + job events succeeded → finished; no summary in the mock job, so the projection is shown and says so', async () => {
    const w = open({});
    await upload(w);
    await toCommit(w);
    const t = w.text();
    assert.ok(t.includes('The job finished, but the server sent no import summary with it; the dry-run projection is shown instead.'));
    assert.ok(t.includes('Projected import'));
    assert.ok(button(w.slot, 'Open in timeline'));
    button(w.slot, 'Open in timeline').click();
    assert.equal(w.store.get().view.corpus, 'user');
    assert.deepEqual(w.store.get().view.f.coll, ['zines'], 'the collection named in step 1 (from the file name)');
    assert.equal(w.store.get().view.panels.right, null);
    w.close();
  });

  test('job events failed → the job error with its hint; cancelled → nothing kept', async () => {
    const w = open({ [K.events]: 'failed', [K.job]: 'failed' });
    await upload(w);
    await toCommit(w);
    assert.ok(w.text().includes('E_CSV_QUOTE An unclosed quote starts on line 77, column 14 and runs to the end of the file.'));
    assert.ok(w.text().includes(`Check for a stray " in 'notes'.`));
    w.close();
    const c = open({ [K.events]: 'cancelled' });
    await upload(c);
    await toCommit(c);
    assert.ok(c.text().includes('The import was cancelled; nothing from this file was kept.'));
    c.close();
  });

  test('job events not_found → falls back to polling GET /api/jobs/:id (running, then progress as a number)', async () => {
    const w = open({ [K.events]: 'not_found' });
    await upload(w);
    await toCommit(w);
    await until(() => w.api.calls.includes(K.job) && /Writing… 41%/.test(w.text()), 'the poll of GET /api/jobs/:id');
    assert.ok(w.api.calls.includes(K.job));
    assert.match(w.text(), /Writing… 41% — counting… 41%/);
    assert.ok(button(w.slot, 'Cancel the import'));
    w.close();
  });

  test('a committed summary (job result) renders as imported, and revert runs its job', async () => {
    const fixtures = new Map(loadFixtures(CONTRACT_DIR).map((f) => [`${f.method} ${f.path}`, f.fixture]));
    const summary = structuredClone(fixtures.get(K.mapping).variants.ok.body.validation);
    Object.assign(summary, { projected: false, status: 'committed', data_version: 48, run_id: 88 });
    const w = open({ [K.revert]: 'ok' });
    const api = w.api;
    const get = api.get;
    api.get = async (p, q, o) => (p === '/jobs/302' ? { id: 302, type: 'import', status: 'succeeded', progress: 1, result: summary, created_at: 'x' }
      : p === '/jobs/309' ? { id: 309, type: 'revert', status: 'succeeded', progress: 1, result: { documents: 1958, data_version: 49 }, created_at: 'x' } : get(p, q, o));
    await upload(w);
    await toCommit(w);
    assert.ok(w.text().includes('Imported into my-zines'));
    assert.ok(w.text().includes('data v48 · run 88'));
    button(w.slot, 'Undo this import').click();
    assert.ok(w.text().includes('Revert this import? Its 1,958 documents are hidden (soft-deleted'));
    button(w.slot, 'Revert').click();
    await until(() => w.text().includes('Reverted:'), 'the revert job to finish');
    assert.ok(w.api.calls.includes(K.revert));
    assert.ok(w.text().includes('Reverted: 1,958 documents hidden (data v49).'));
    w.close();
  });

  test('revert not_found → the error is shown', async () => {
    const w = open({ [K.revert]: 'not_found' });
    w.api.get = async () => ({ id: 302, type: 'import', status: 'succeeded', progress: 1, result: null, created_at: 'x' });
    await upload(w);
    await toCommit(w);
    button(w.slot, 'Undo this import').click();
    button(w.slot, 'Revert').click();
    await sleep(5);
    assert.ok(w.text().includes('E_NOT_FOUND No import batch 99.'));
    w.close();
  });

  test('every import fixture variant was rendered by these tests', () => {
    const fixtures = loadFixtures(CONTRACT_DIR).filter((f) => f.path.startsWith('/api/imports'));
    const covered = {
      'POST /api/imports': ['ok', 'encoding_fallback', 'dup_file', 'too_large'],
      'GET /api/imports/:id/preview': ['ok', 'not_found'],
      'PUT /api/imports/:id/mapping': ['ok', 'invalid_mapping'],
      'POST /api/imports/:id/commit': ['ok', 'conflict'],
      'POST /api/imports/:id/revert': ['ok', 'not_found'],
      // problems.csv is a download: the wizard renders its link (asserted above) and the browser fetches it
      'GET /api/imports/:id/problems.csv': ['ok', 'not_found'],
    };
    for (const f of fixtures) assert.deepEqual(Object.keys(f.fixture.variants).sort(), [...covered[`${f.method} ${f.path}`]].sort(), `${f.method} ${f.path}`);
  });
});
