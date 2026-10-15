// OWNER: WP7 — views menu (save, open, as-saved banner), export menu and jobs tray (SPEC §7.2–7.3, §8.2, §8.8,
// D17). Pure helpers directly; the DOM through the fake DOM against every fixture variant of the endpoints they
// call; request bodies and export links against the mock server over HTTP.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/ui/core/store.mjs';
import { createKeys } from '../src/ui/core/keys.mjs';
import { createApi } from '../src/ui/core/api.mjs';
import { decodeHash, defaultState, encode, stateHash } from '../src/shared/viewstate.mjs';
import { check } from '../src/shared/contracts.mjs';
import { bannerModel, defaultViewName, mount as mountViews, saveRequest, viewHash } from '../src/ui/panels/views-menu.mjs';
import { b64url, exportFileName, exportUrl, mount as mountExport } from '../src/ui/panels/export-menu.mjs';
import { activeCount, countsText, jobRowModel, mount as mountJobs, sortJobs } from '../src/ui/panels/jobs-tray.mjs';
import { byText, createFakeApi, fire, fixtureBody, installFakeDom, makeEvent, settle, visibleText } from './ui.panels.fakedom.mjs';
import { startServerInProcess } from './helpers/server.mjs';

process.env.SCROLLS_LOG_LEVEL ??= 'error';

const SAVED_STATE = () => fixtureBody('GET', '/api/views/:slug', 'ok').state;

// ── Views ────────────────────────────────────────────────────────────────────────────────────────────

describe('saved views: helpers', () => {
  test('save request: name, the full state, comparisons tried; a re-save names its parent', () => {
    const body = saveRequest(SAVED_STATE(), { name: '  carry the zero: four uses ', comparisonsTried: 2 });
    assert.deepEqual(check('ViewRequest', body), []);
    assert.equal(body.name, 'carry the zero: four uses');
    assert.equal(body.comparisons_tried, 2);
    assert.equal(body.parent_slug, undefined);
    assert.equal(saveRequest(SAVED_STATE(), { name: 'x', parentSlug: 'a-1' }).parent_slug, 'a-1');
    assert.equal(defaultViewName(SAVED_STATE(), new Date('2026-10-04T10:00:00Z')), 'demo · expression 12 · 2026-10-04');
    assert.equal(viewHash('carry-the-zero-four-uses-3f9a~2', true), '#view=carry-the-zero-four-uses-3f9a~2&as=1');
    assert.deepEqual(decodeHash(viewHash('a b', true)).view, { slug: 'a b', asSaved: true });
  });
  test('banner: drift offers "Show as saved"; as saved offers current data; edits are flagged', () => {
    const state = SAVED_STATE();
    const saved = { slug: 'carry-the-zero-four-uses-3f9a', asSaved: false, stateHash: stateHash(state) };
    const drift = bannerModel(saved, fixtureBody('GET', '/api/views/:slug', 'drift'), state);
    assert.match(drift.title, /^Saved view “carry the zero: four uses” · saved 2026-10-03 · data v44$/);
    assert.ok(drift.lines.some((l) => /Corpus changed since this view was saved/.test(l)));
    assert.deepEqual(drift.actions, [{ label: 'Show as saved', hash: '#view=carry-the-zero-four-uses-3f9a&as=1' }]);
    const asSaved = bannerModel({ ...saved, asSaved: true }, fixtureBody('GET', '/api/views/:slug', 'drift'), state);
    assert.deepEqual(asSaved.actions, [{ label: 'Show current data', hash: '#view=carry-the-zero-four-uses-3f9a' }]);
    assert.ok(asSaved.lines[0].startsWith('As saved'));
    const clean = bannerModel(saved, fixtureBody('GET', '/api/views/:slug', 'ok'), state);
    assert.deepEqual(clean.lines, []);
    assert.deepEqual(clean.actions, []);
    const edited = bannerModel(saved, fixtureBody('GET', '/api/views/:slug', 'ok'), { ...state, tier: 'L3' });
    assert.equal(edited.modified, true);
    assert.match(edited.lines.at(-1), /the saved view never changes/);
  });
});

describe('views menu rendering', () => {
  let dom;
  beforeEach(() => { dom = installFakeDom(); });
  afterEach(() => dom.restore());

  function setup({ variants = {}, state = SAVED_STATE(), keys = null, narrow = false } = {}) {
    dom.setNarrow(narrow);
    const toolbar = dom.document.createElement('header');
    const ribbon = dom.document.createElement('div');
    dom.document.body.append(ribbon, toolbar);
    const store = createStore(state);
    const api = createFakeApi({ variants });
    const announced = [];
    const handle = mountViews(toolbar, { store, api, keys, announce: (t) => announced.push(t), regions: { ribbon } });
    return { toolbar, ribbon, store, api, handle, announced };
  }

  test('open lists saved views (SYN marked); a click opens it through the URL', async () => {
    const { toolbar } = setup();
    byText(toolbar, 'Views').click();
    await settle();
    const item = dom.document.querySelector('.views-item');
    assert.match(visibleText(item), /carry the zero: four uses/);
    assert.match(visibleText(item), /saved 2026-10-03 · data v47/);
    assert.ok(item.querySelector('.badge-syn'));
    item.click();
    assert.equal(dom.window.location.hash, '#view=carry-the-zero-four-uses-3f9a');
    assert.equal(dom.document.querySelector('.menu-panel').hidden, true);
  });

  test('empty and error lists', async () => {
    // the panel is portalled out of the toolbar (fix pass: the toolbar clips and scrolls), so it is read from the menu
    const a = setup({ variants: { 'GET /api/views': 'empty' } });
    byText(a.toolbar, 'Views').click();
    await settle();
    assert.match(visibleText(a.handle.menu.panel), /No saved views yet\./);
    a.handle.unmount();
    a.toolbar.remove();
    const b = setup({ variants: { 'GET /api/views': 'error' } });
    byText(b.toolbar, 'Views').click();
    await settle();
    assert.match(visibleText(b.handle.menu.panel), /did not come from the Scrolls page/);
    assert.ok(byText(b.handle.menu.panel, 'Retry'));
  });

  test('save: POST /api/views with a valid body, the slug becomes the URL, the link can be copied', async () => {
    const { toolbar, store, api, announced, handle } = setup();
    const panel = handle.menu.panel;
    byText(toolbar, 'Views').click();
    await settle();
    assert.ok(!toolbar.contains(panel), 'the panel is not inside the toolbar');
    dom.document.querySelector('.views-name').value = 'carry the zero: four uses';
    byText(panel, 'Save view').click();
    await settle();
    const call = api.calls.find((c) => c.method === 'POST' && c.path === '/api/views');
    assert.deepEqual(check('ViewRequest', call.body), []);
    assert.equal(call.body.name, 'carry the zero: four uses');
    const sv = store.get().ui.savedView;
    assert.equal(sv.slug, 'carry-the-zero-four-uses-3f9a');
    assert.equal(sv.stateHash, stateHash(store.get().view));
    assert.match(visibleText(panel), /Saved as carry-the-zero-four-uses-3f9a \(data v47\)\./);
    assert.ok(announced.includes('View saved as carry-the-zero-four-uses-3f9a'));
    byText(panel, 'Copy link').click();
    await settle();
    assert.deepEqual(dom.window.navigator.clipboard.written, ['undefined/#view=carry-the-zero-four-uses-3f9a'.replace('undefined', '')]);
  });

  test('a re-save from a saved view sends parent_slug; a server refusal shows its message', async () => {
    const { toolbar, store, api, handle } = setup({ variants: { 'POST /api/views': 'invalid' } });
    const panel = handle.menu.panel;
    store.dispatch({ type: 'UI_SET', key: 'savedView', value: { slug: 'carry-the-zero-four-uses-3f9a', asSaved: false, stateHash: stateHash(store.get().view) } });
    byText(toolbar, 'Views').click();
    await settle();
    assert.match(visibleText(panel), /this saves a new view \(from carry-the-zero-four-uses-3f9a\)/);
    byText(panel, 'Save view').click();
    await settle();
    assert.equal(api.calls.find((c) => c.method === 'POST').body.parent_slug, 'carry-the-zero-four-uses-3f9a');
    assert.match(visibleText(panel), /A saved view needs a name\./);
  });

  test('as-saved banner: drift message and the switch; dismissable', async () => {
    const { ribbon, store } = setup({ variants: { 'GET /api/views/:slug': 'drift' } });
    const banner = ribbon.querySelector('.saved-banner');
    assert.equal(banner.hidden, true);
    store.dispatch({ type: 'UI_SET', key: 'savedView', value: { slug: 'carry-the-zero-four-uses-3f9a', asSaved: false, stateHash: stateHash(store.get().view) } });
    await settle();
    assert.equal(banner.hidden, false);
    assert.match(visibleText(banner), /Corpus changed since this view was saved\. 'As saved' restricts to imports ≤ #42/);
    byText(banner, 'Show as saved').click();
    assert.equal(dom.window.location.hash, '#view=carry-the-zero-four-uses-3f9a&as=1');
    store.dispatch({ type: 'SET_TIER', tier: 'L3' });
    assert.match(visibleText(banner), /Changed since you opened it/);
    assert.ok(banner.classList.contains('is-modified'));
    banner.querySelector('.saved-banner-close').click();
    assert.equal(banner.hidden, true);
  });

  test('S opens the menu with the name field focused; Esc closes it; nothing needs hover', async () => {
    const keys = createKeys();
    const { toolbar } = setup({ keys, narrow: true });
    assert.equal(keys.handle(makeEvent('keydown', { key: 's', target: dom.document.body })), true);
    await settle();
    const panel = dom.document.querySelector('.menu-panel');
    assert.equal(panel.hidden, false);
    assert.equal(dom.document.activeElement, dom.document.querySelector('.views-name'));
    fire(panel, 'keydown', { key: 'Escape' });
    assert.equal(panel.hidden, true);
    assert.equal(dom.document.activeElement, toolbar.querySelector('.menu-button'));
    assert.deepEqual(dom.hoverListenerTypes(), []);
  });
});

// ── Export ───────────────────────────────────────────────────────────────────────────────────────────

describe('export menu', () => {
  test('base64url of the URL hash round-trips, also for non-Latin text', () => {
    for (const s of ['#v=1&c=demo&s=e12', '#v=1&c=demo&f=lang:gu&x=શૂન્ય', '😀~+/=']) {
      const b = b64url(s);
      assert.match(b, /^[A-Za-z0-9_-]*$/);
      assert.equal(Buffer.from(b, 'base64url').toString('utf8'), s);
    }
  });
  test('a saved view shown unchanged exports by slug; anything else exports the state', () => {
    const view = SAVED_STATE();
    const sv = { slug: 'carry-the-zero-four-uses-3f9a', stateHash: stateHash(view) };
    const bySlug = new URL(exportUrl({ view, savedView: sv, what: 'occurrences', format: 'csv' }), 'http://x');
    assert.equal(bySlug.pathname, '/api/export');
    assert.equal(bySlug.searchParams.get('view'), sv.slug);
    assert.equal(bySlug.searchParams.get('state'), null);
    const edited = { ...view, tier: 'L3' };
    const byState = new URL(exportUrl({ view: edited, savedView: sv, what: 'aggregates', format: 'jsonl' }), 'http://x');
    assert.equal(Buffer.from(byState.searchParams.get('state'), 'base64url').toString('utf8'), encode(edited));
    assert.equal(byState.searchParams.get('what'), 'aggregates');
    assert.equal(byState.searchParams.get('format'), 'jsonl');
    assert.equal(exportFileName(view, 'occurrences', 'jsonl', new Date('2026-10-04T00:00:00Z')), 'scrolls-demo-occurrences-2026-10-04.jsonl');
  });

  describe('rendering', () => {
    let dom;
    beforeEach(() => { dom = installFakeDom(); });
    afterEach(() => dom.restore());

    test('choices update the download link in place; the menu states the manifest, licences and SYNTHETIC', () => {
      const toolbar = dom.document.createElement('header');
      dom.document.body.appendChild(toolbar);
      const store = createStore(defaultState('demo'));
      const keys = createKeys();
      mountExport(toolbar, { store, api: createFakeApi(), keys, announce: () => {} });
      keys.handle(makeEvent('keydown', { key: 'x', target: dom.document.body }));
      const link = dom.document.querySelector('.export-download');
      assert.match(link.getAttribute('href'), /^\/api\/export\?state=[A-Za-z0-9_-]+&what=occurrences&format=csv$/);
      assert.equal(link.textContent, 'Download occurrences (CSV)');
      const jsonl = dom.document.querySelectorAll('input[type="radio"]').find((r) => r.value === 'jsonl');
      jsonl.checked = true;
      fire(jsonl, 'change');
      assert.match(link.getAttribute('href'), /format=jsonl$/);
      assert.match(link.getAttribute('download'), /^scrolls-demo-occurrences-\d{4}-\d{2}-\d{2}\.jsonl$/);
      const text = visibleText(dom.document.querySelector('.menu-panel'));
      assert.match(text, /starts with its manifest/);
      assert.match(text, /ids, offsets and locators only/);
      assert.match(text, /Contains SYNTHETIC demonstration data/);
      assert.deepEqual(dom.hoverListenerTypes(), []);
    });
  });
});

// ── Jobs ─────────────────────────────────────────────────────────────────────────────────────────────

describe('jobs tray: helpers', () => {
  const JOBS = () => fixtureBody('GET', '/api/jobs', 'ok').items;
  test('rows: a number for progress, phase · message, counts, errors with hint, cancel only while active', () => {
    const [mat, imp, boot, clu] = JOBS().map(jobRowModel);
    assert.equal(mat.progressText, '41%');
    assert.equal(mat.detail, 'counting · counting… 41%');
    assert.equal(mat.counts, '79 of 188 documents');
    assert.equal(mat.canCancel, true);
    assert.equal(imp.error.hint, "Check for a stray \" in 'notes'.");
    assert.equal(imp.canCancel, false);
    assert.equal(boot.label, 'Cipher import');
    assert.equal(clu.statusWord, 'done');
    assert.equal(clu.run, 'run 14');
    assert.equal(countsText({ k: 4, occurrences: 340 }), 'k 4 · occurrences 340');
  });
  test('active jobs first, newest first', () => {
    const order = sortJobs(JOBS()).map((j) => j.id);
    assert.deepEqual(order, [301, 290, 295, 288]);
    assert.equal(activeCount(Object.fromEntries(JOBS().map((j) => [j.id, j]))), 2);
  });
});

describe('jobs tray rendering', () => {
  let dom;
  beforeEach(() => { dom = installFakeDom(); });
  afterEach(() => dom.restore());

  function setup({ variants = {}, sse = null } = {}) {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const store = createStore(defaultState('demo'));
    const api = createFakeApi({ variants });
    if (sse) api.sse = sse;
    const announced = [];
    const handle = mountJobs(host, { store, api, announce: (t) => announced.push(t) });
    return { host, store, api, handle, announced };
  }

  test('lists jobs with progress bars and numbers; failed jobs show message and hint', async () => {
    const { host } = setup({ sse: () => () => {} });
    await settle();
    assert.equal(host.querySelector('.jobs-tray-button').textContent, 'Jobs · 2 active');
    host.querySelector('.jobs-tray-button').click();
    await settle();
    const rows = host.querySelectorAll('.job-row');
    assert.deepEqual(rows.map((r) => r.getAttribute('data-job')), ['301', '290', '295', '288']);
    const bar = rows[0].querySelector('[role="progressbar"]');
    assert.equal(bar.getAttribute('aria-valuenow'), '41');
    assert.match(visibleText(rows[0]), /41%/);
    assert.match(visibleText(rows[2]), /An unclosed quote starts on line 77, column 14/);
    assert.match(visibleText(rows[2]), /Check for a stray/);
    assert.equal(rows[3].querySelector('.job-cancel'), null, 'finished jobs have no Cancel');
  });

  test('cancel: POST cancel → "cancelling…", then the job stream reports "cancelled"', async () => {
    const streams = new Map();
    const sse = (path, handlers) => { streams.set(path, handlers); return () => streams.delete(path); };
    const { host, store, api, announced } = setup({ sse });
    await settle();
    host.querySelector('.jobs-tray-button').click();
    await settle();
    assert.ok(streams.has('/jobs/301/events') && streams.has('/jobs/290/events'), 'running jobs are followed while the tray is open');
    host.querySelector('.job-row[data-job="301"] .job-cancel').click();
    await settle();
    assert.ok(api.calls.some((c) => c.method === 'POST' && c.path === '/api/jobs/301/cancel'));
    assert.equal(store.get().ui.jobs[301].status, 'cancelling');
    assert.match(visibleText(host.querySelector('.job-row[data-job="301"]')), /cancelling…/);
    assert.equal(host.querySelector('.job-row[data-job="301"] .job-cancel'), null, 'no second Cancel while cancelling');
    const h301 = streams.get('/jobs/301/events');
    h301.progress({ job: 301, type: 'materialize', phase: 'counting', fraction: 0.5, message: 'counting… 50%' });
    h301.done({ job: 301, status: 'cancelled', run_id: null });
    await settle();
    assert.equal(store.get().ui.jobs[301].status, 'cancelled');
    assert.ok(!streams.has('/jobs/301/events'), 'the stream is closed when the job ends');
    assert.ok(announced.some((t) => /Counting matches 301: cancelled/.test(t)));
    assert.match(visibleText(host.querySelector('.job-row[data-job="301"]')), /cancelled/);
    host.querySelector('.jobs-panel .menu-close').click();
    assert.equal(streams.size, 0, 'closing the tray closes the job streams');
  });

  test('the jobs chip can open the tray (ui.sheet = {kind: "jobs"} or "jobs"); closing clears it', async () => {
    const { host, store } = setup();
    store.dispatch({ type: 'UI_SHEET', sheet: { kind: 'jobs' } });
    await settle();
    assert.equal(host.querySelector('.jobs-panel').hidden, false);
    host.querySelector('.jobs-panel .menu-close').click();
    assert.equal(host.querySelector('.jobs-panel').hidden, true);
    assert.equal(store.get().ui.sheet, null);
    assert.deepEqual(dom.hoverListenerTypes(), []);
  });

  test('empty and error lists', async () => {
    const a = setup({ variants: { 'GET /api/jobs': 'empty' } });
    a.host.querySelector('.jobs-tray-button').click();
    await settle();
    assert.match(visibleText(a.host), /No jobs yet\./);
    a.host.remove();
    const b = setup({ variants: { 'GET /api/jobs': 'error' } });
    b.host.querySelector('.jobs-tray-button').click();
    await settle();
    assert.match(visibleText(b.host), /did not come from the Scrolls page/);
    assert.ok(byText(b.host, 'Retry'));
  });

  test('a finished job answers "finished" to cancel and is re-read', async () => {
    const { host, store, api } = setup({ variants: { 'POST /api/jobs/:id/cancel': 'finished', 'GET /api/jobs/:id': 'succeeded' } });
    await settle();
    host.querySelector('.jobs-tray-button').click();
    await settle();
    host.querySelector('.job-row[data-job="301"] .job-cancel').click();
    await settle();
    assert.ok(api.calls.some((c) => c.method === 'GET' && c.path === '/api/jobs/301'));
    assert.equal(store.get().ui.jobs[288].status, 'succeeded');
  });
});

// ── Over HTTP against SCROLLS_MOCK ───────────────────────────────────────────────────────────────────

describe('menus against SCROLLS_MOCK (over HTTP)', () => {
  let srv;
  let dom;
  beforeEach(async () => { srv = await startServerInProcess({ mock: true }); dom = installFakeDom(); });
  afterEach(async () => { dom.restore(); await srv.cleanup(); });

  test('the save body passes ViewRequest on the server; the export link answers with its manifest first', async () => {
    const origin = new URL(srv.url).origin;
    // Requests still in flight when the test ends would render into a DOM that is gone: count them and wait.
    let inflight = 0;
    const fetchImpl = async (u, init = {}) => {
      inflight++;
      try { return await fetch(new URL(u, srv.url), { ...init, headers: { ...(init.headers ?? {}), Origin: origin } }); } finally { inflight--; }
    };
    const api = createApi({ base: '/api', sessionId: 'test', fetchImpl });
    const toolbar = dom.document.createElement('header');
    dom.document.body.appendChild(toolbar);
    const store = createStore(SAVED_STATE());
    const handle = mountViews(toolbar, { store, api, keys: null, announce: () => {}, regions: {} });
    byText(toolbar, 'Views').click();
    for (let i = 0; i < 50 && !dom.document.querySelector('.views-item'); i++) await new Promise((r) => setTimeout(r, 20));
    byText(handle.menu.panel, 'Save view').click();
    for (let i = 0; i < 50 && !store.get().ui.savedView; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.get().ui.savedView?.slug, 'carry-the-zero-four-uses-3f9a', visibleText(handle.menu.panel));

    const href = exportUrl({ view: store.get().view, savedView: null, what: 'occurrences', format: 'jsonl' });
    const res = await fetch(new URL(href, srv.url));
    assert.equal(res.status, 200);
    const first = JSON.parse((await res.text()).split('\n')[0]);
    assert.ok(first.manifest, 'manifest first');
    for (let i = 0, idle = 0; i < 200 && idle < 3; i++) { await new Promise((r) => setTimeout(r, 10)); idle = inflight === 0 ? idle + 1 : 0; }
    handle.unmount();
  });
});
