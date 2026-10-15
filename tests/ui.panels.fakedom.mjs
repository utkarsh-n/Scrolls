// OWNER: WP7 — a small in-memory DOM for the panels tests (node has no DOM and we never run a browser here)
//
// It implements the subset the panels and src/ui/core/dom.mjs use: elements, text nodes, fragments, attributes,
// classList, dataset, style, events with capture and bubbling, focus, a simple selector engine (tag, #id,
// .class, [attr], [attr=value], :not(…), descendant combinator, comma lists) and a window with matchMedia,
// location and history. Every addEventListener call is recorded so tests can prove that nothing depends on
// hover (§8.6: the main flow works without hover).

const HOVER_EVENTS = new Set(['mouseover', 'mouseenter', 'mouseleave', 'mouseout', 'pointerover', 'pointerenter',
  'pointerleave', 'pointerout']);
const BOOLEAN_PROPS = ['hidden', 'disabled', 'checked', 'selected', 'readOnly', 'required', 'multiple', 'open', 'inert',
  'autofocus', 'draggable', 'spellcheck'];

class FakeNode {
  constructor(doc, nodeType) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = [];
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
  get previousSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null;
  }
  get isConnected() {
    let n = this;
    while (n) { if (n === this.ownerDocument) return true; n = n.parentNode; }
    return false;
  }
  _adopt(child) {
    if (child.nodeType === 11) return [...child.childNodes].map((c) => { child.removeChild(c); return c; });
    if (child.parentNode) child.parentNode.removeChild(child);
    return [child];
  }
  appendChild(child) {
    for (const c of this._adopt(child)) { c.parentNode = this; this.childNodes.push(c); }
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
  }
  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) this.insertBefore(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n, first);
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    const list = this._adopt(child);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('insertBefore: reference is not a child');
    for (const c of list) c.parentNode = this;
    this.childNodes.splice(i, 0, ...list);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  replaceChild(next, old) { this.insertBefore(next, old); this.removeChild(old); return old; }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  get textContent() {
    if (this.nodeType === 3) return this.data;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== '' && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  addEventListener(type, fn, opts) {
    const capture = opts === true || Boolean(opts?.capture);
    this._listeners.push({ type, fn, capture, once: Boolean(opts?.once) });
    this.ownerDocument?._recordListener?.(type, this);
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || Boolean(opts?.capture);
    const i = this._listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) this._listeners.splice(i, 1);
  }
  dispatchEvent(evt) { return dispatch(this, evt); }
}

class FakeText extends FakeNode {
  constructor(doc, data) { super(doc, 3); this.data = String(data); }
  get nodeValue() { return this.data; }
  get nodeName() { return '#text'; }
}

class FakeFragment extends FakeNode {
  constructor(doc) { super(doc, 11); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  querySelector(sel) { return querySelectorAll(this, sel)[0] ?? null; }
  querySelectorAll(sel) { return querySelectorAll(this, sel); }
}

function makeClassList(el) {
  const get = () => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const set = (list) => el.setAttribute('class', [...new Set(list)].join(' '));
  return {
    add: (...c) => set([...get(), ...c.filter(Boolean)]),
    remove: (...c) => set(get().filter((x) => !c.includes(x))),
    toggle: (c, force) => {
      const has = get().includes(c);
      const want = force === undefined ? !has : Boolean(force);
      if (want && !has) set([...get(), c]);
      if (!want && has) set(get().filter((x) => x !== c));
      return want;
    },
    contains: (c) => get().includes(c),
    get length() { return get().length; },
    toString: () => get().join(' '),
    [Symbol.iterator]: () => get()[Symbol.iterator](),
  };
}

const camelToData = (k) => `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const dataToCamel = (k) => k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class FakeElement extends FakeNode {
  constructor(doc, tag, ns = null) {
    super(doc, 1);
    this.localName = ns ? tag : tag.toLowerCase();
    this.tagName = ns ? tag : tag.toUpperCase();
    this.namespaceURI = ns;
    this._attrs = new Map();
    this.classList = makeClassList(this);
    const styleMap = new Map();
    this.style = new Proxy({
      setProperty: (k, v) => styleMap.set(k, String(v)),
      getPropertyValue: (k) => styleMap.get(k) ?? '',
      removeProperty: (k) => { styleMap.delete(k); },
    }, {
      get: (t, k) => (k in t ? t[k] : styleMap.get(k) ?? ''),
      set: (t, k, v) => { styleMap.set(k, String(v)); return true; },
    });
    this.dataset = new Proxy({}, {
      get: (_, k) => (typeof k === 'string' ? this.getAttribute(camelToData(k)) ?? undefined : undefined),
      set: (_, k, v) => { this.setAttribute(camelToData(k), String(v)); return true; },
      deleteProperty: (_, k) => { this.removeAttribute(camelToData(k)); return true; },
      has: (_, k) => this.hasAttribute(camelToData(k)),
      ownKeys: () => [...this._attrs.keys()].filter((a) => a.startsWith('data-')).map(dataToCamel),
      getOwnPropertyDescriptor: (_, k) => (this.hasAttribute(camelToData(k))
        ? { enumerable: true, configurable: true, value: this.getAttribute(camelToData(k)) } : undefined),
    });
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.clientWidth = 0;
    this._value = null;
  }
  get nodeName() { return this.tagName; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get value() {
    if (this.localName === 'select') {
      const opts = querySelectorAll(this, 'option');
      const sel = opts.find((o) => o.selected) ?? opts[0];
      return sel ? sel.value : '';
    }
    if (this.localName === 'option') return this._value ?? this.getAttribute('value') ?? this.textContent;
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(v) {
    if (this.localName === 'select') {
      for (const o of querySelectorAll(this, 'option')) o.selected = o.value === String(v);
      return;
    }
    this._value = String(v);
  }
  get tabIndex() { const t = this.getAttribute('tabindex'); return t === null ? -1 : Number(t); }
  set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
  get type() { return this.getAttribute('type') ?? (this.localName === 'button' ? 'submit' : this.localName === 'input' ? 'text' : ''); }
  set type(v) { this.setAttribute('type', v); }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  removeAttribute(k) { this._attrs.delete(k); }
  hasAttribute(k) { return this._attrs.has(k); }
  toggleAttribute(k, force) {
    const want = force === undefined ? !this.hasAttribute(k) : Boolean(force);
    if (want) this.setAttribute(k, ''); else this.removeAttribute(k);
    return want;
  }
  matches(sel) { return parseList(sel).some((chain) => matchChain(this, chain)); }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) { return querySelectorAll(this, sel)[0] ?? null; }
  querySelectorAll(sel) { return querySelectorAll(this, sel); }
  getClientRects() {
    let n = this;
    while (n && n.nodeType === 1) { if (n.hidden) return []; n = n.parentNode; }
    return [{ x: 0, y: 0, width: 1, height: 1 }];
  }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollIntoView() { this.ownerDocument._scrolledIntoView = this; }
  scrollTo(opts) { if (opts && typeof opts.top === 'number') this.scrollTop = opts.top; }
  focus() {
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    doc.activeElement = this;
    dispatch(this, makeEvent('focus', { bubbles: false }));
    dispatch(this, makeEvent('focusin', { bubbles: true }));
  }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { if (!this.disabled) dispatch(this, makeEvent('click', { bubbles: true })); }
}
for (const p of BOOLEAN_PROPS) {
  const attr = p.toLowerCase();
  Object.defineProperty(FakeElement.prototype, p, {
    get() { return this.hasAttribute(attr); },
    set(v) { if (v) this.setAttribute(attr, ''); else this.removeAttribute(attr); },
    configurable: true,
  });
}

// ── Selectors ────────────────────────────────────────────────────────────────────────────────────────

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (const c of s) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseCompound(s) {
  const c = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let i = 0;
  const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(s);
  if (tag) { c.tag = tag[1] === '*' ? null : tag[1].toLowerCase(); i = tag[1].length; }
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) c.ids.push(m[1]);
    else if ((m = /^\.([\w-]+)/.exec(rest))) c.classes.push(m[1]);
    else if ((m = /^\[([\w:-]+)(?:([~^$*|]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) {
      c.attrs.push({ name: m[1], op: m[2] ?? null, value: m[3] ?? m[4] ?? m[5] ?? null });
    } else if ((m = /^:not\(/.exec(rest))) {
      let depth = 1, j = m[0].length;
      while (j < rest.length && depth) { if (rest[j] === '(') depth++; if (rest[j] === ')') depth--; j++; }
      c.nots.push(parseList(rest.slice(m[0].length, j - 1)));
      m = [rest.slice(0, j)];
    } else throw new Error(`fakedom: unsupported selector part '${rest}' in '${s}'`);
    i += m[0].length;
  }
  return c;
}

const listCache = new Map();
function parseList(sel) {
  if (listCache.has(sel)) return listCache.get(sel);
  const out = splitTopLevel(sel, ',').map((part) => splitTopLevel(part, ' ').map(parseCompound));
  listCache.set(sel, out);
  return out;
}

function matchCompound(el, c) {
  if (el.nodeType !== 1) return false;
  if (c.tag && el.localName.toLowerCase() !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    const v = el.getAttribute(a.name);
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
  }
  for (const not of c.nots) if (not.some((chain) => matchChain(el, chain))) return false;
  return true;
}

function matchChain(el, chain) {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let k = chain.length - 2;
  let n = el.parentNode;
  while (k >= 0 && n) {
    if (n.nodeType === 1 && matchCompound(n, chain[k])) k--;
    n = n.parentNode;
  }
  return k < 0;
}

function descendants(root) {
  const out = [];
  const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1) { out.push(c); walk(c); } else if (c.nodeType === 11) walk(c); } };
  walk(root);
  return out;
}

function querySelectorAll(root, sel) {
  const chains = parseList(sel);
  return descendants(root).filter((el) => chains.some((chain) => matchChain(el, chain)));
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A plain event object (Node's Event has a read-only `target`, so the fake DOM dispatches its own).
 * @param {string} type
 * @param {Record<string, unknown>} [init]
 */
export function makeEvent(type, init = {}) {
  return {
    type, bubbles: init.bubbles ?? true, defaultPrevented: false, target: null, currentTarget: null,
    key: undefined, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false,
    ...init,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopped = true; },
    stopImmediatePropagation() { this._stopped = true; this._stoppedNow = true; },
  };
}

function dispatch(target, evt) {
  evt.target ??= target;
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  const doc = target.ownerDocument ?? target;
  if (doc.defaultView && path[path.length - 1] === doc) path.push(doc.defaultView);
  const run = (node, capture) => {
    evt.currentTarget = node;
    for (const l of [...(node._listeners ?? [])]) {
      if (l.type !== evt.type || l.capture !== capture) continue;
      if (l.once) node.removeEventListener(l.type, l.fn, l.capture);
      l.fn.call(node, evt);
      if (evt._stoppedNow) return;
    }
  };
  for (let i = path.length - 1; i > 0 && !evt._stopped; i--) run(path[i], true);
  if (!evt._stopped) { run(target, true); run(target, false); }
  if (evt.bubbles) for (let i = 1; i < path.length && !evt._stopped; i++) run(path[i], false);
  return !evt.defaultPrevented;
}

/**
 * Fire an event of `type` at `el` (bubbling by default).
 * @param {FakeNode} el
 * @param {string} type
 * @param {Record<string, unknown>} [init]
 */
export function fire(el, type, init = {}) {
  const evt = makeEvent(type, init);
  dispatch(el, evt);
  return evt;
}

// ── Document and window ──────────────────────────────────────────────────────────────────────────────

class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.listenerTypes = new Set();
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.visibilityState = 'visible';
    this.defaultView = null;
  }
  _recordListener(type) { this.listenerTypes.add(type); }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(ns, tag) { return new FakeElement(this, tag, ns); }
  createTextNode(text) { return new FakeText(this, text); }
  createDocumentFragment() { return new FakeFragment(this); }
  getElementById(id) { return descendants(this).find((el) => el.id === id) ?? null; }
  querySelector(sel) { return querySelectorAll(this, sel)[0] ?? null; }
  querySelectorAll(sel) { return querySelectorAll(this, sel); }
}

/**
 * Create a document with a window: `matchMedia(query)` answers `narrow` for max-width queries,
 * `location.hash` is writable (hashchange fires), timers are the real ones.
 * @param {{ narrow?: boolean, hash?: string }} [opts]
 * @returns {{ document: FakeDocument, window: object, setNarrow(v: boolean): void, hoverListenerTypes(): string[] }}
 */
export function createFakeDom({ narrow = false, hash = '' } = {}) {
  const document = new FakeDocument();
  const mediaLists = [];
  const state = { narrow };
  const win = {
    document,
    _listeners: [],
    addEventListener: FakeNode.prototype.addEventListener,
    removeEventListener: FakeNode.prototype.removeEventListener,
    dispatchEvent(evt) { return dispatch(this, evt); },
    matchMedia(query) {
      const mql = {
        media: query,
        get matches() { return /max-width/.test(query) ? state.narrow : /prefers-reduced-motion/.test(query) ? false : !state.narrow; },
        _l: [],
        addEventListener(type, fn) { this._l.push(fn); },
        removeEventListener(type, fn) { this._l = this._l.filter((f) => f !== fn); },
      };
      mediaLists.push(mql);
      return mql;
    },
    location: {
      pathname: '/', search: '',
      _hash: hash,
      get hash() { return this._hash; },
      set hash(v) {
        const next = v && !String(v).startsWith('#') ? `#${v}` : String(v ?? '');
        if (next === this._hash) return;
        this._hash = next;
        dispatch(win, makeEvent('hashchange', { bubbles: false }));
      },
    },
    history: { state: null, pushState() {}, replaceState() {} },
    navigator: { clipboard: { written: [], async writeText(t) { this.written.push(t); } } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  win.window = win;
  document.defaultView = win;
  document.ownerDocument = document;
  return {
    document,
    window: win,
    setNarrow(v) {
      state.narrow = v;
      for (const m of mediaLists) for (const fn of m._l) fn({ matches: m.matches, media: m.media });
    },
    hoverListenerTypes: () => [...document.listenerTypes].filter((t) => HOVER_EVENTS.has(t)),
  };
}

/**
 * Install a fake DOM as the globals that src/ui/core/dom.mjs reads (document, window) and return it.
 * Call the returned `restore()` when the test ends.
 * @param {{ narrow?: boolean, hash?: string }} [opts]
 */
export function installFakeDom(opts = {}) {
  const dom = createFakeDom(opts);
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  dom.restore = () => {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
  };
  return dom;
}

/**
 * Visible text of an element: hidden subtrees are skipped; block-ish boundaries become spaces.
 * @param {FakeNode} node
 * @returns {string}
 */
export function visibleText(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType === 1 && node.hidden) return '';
  return node.childNodes.map(visibleText).join(node.nodeType === 1 && /^(DIV|P|LI|SECTION|TD|TH|TR|H\d|BUTTON|DT|DD)$/.test(node.tagName) ? ' ' : '');
}

/**
 * Find a button (or any element) by its visible text.
 * @param {FakeNode} root
 * @param {string|RegExp} text
 * @param {string} [selector='button']
 */
export function byText(root, text, selector = 'button') {
  const test = (s) => (text instanceof RegExp ? text.test(s) : s.replace(/\s+/g, ' ').trim() === text);
  return root.querySelectorAll(selector).find((el) => test(el.textContent)) ?? null;
}

// ── A fake API client over the contract fixtures ─────────────────────────────────────────────────────

import { loadFixtures, selectVariant } from '../server/http/mock.mjs';
import { ApiError } from '../src/ui/core/api.mjs';

const FIXTURES = loadFixtures(new URL('./contract/', import.meta.url));

function matchFixture(method, pathname) {
  const want = pathname.split('/');
  const hits = [];
  for (const f of FIXTURES) {
    if (f.method !== method) continue;
    const segs = f.path.split('/');
    if (segs.length !== want.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) params[segs[i].slice(1)] = decodeURIComponent(want[i]);
      else if (segs[i] !== want[i]) { ok = false; break; }
    }
    if (ok) hits.push({ f, params, dyn: segs.filter((s) => s.startsWith(':')).length });
  }
  hits.sort((a, b) => a.dyn - b.dyn);
  return hits[0] ?? null;
}

/**
 * A client with the shape of src/ui/core/api.mjs that answers from tests/contract fixtures, choosing variants
 * like mock mode does (`variants['METHOD /api/path']` forces one, else `when`, else the default). Every call is
 * recorded in `calls`. Responses are deep copies; status ≥ 400 throws ApiError.
 * @param {{variants?: Record<string, string>, delayMs?: number}} [opts]
 */
export function createFakeApi({ variants = {}, delayMs = 0 } = {}) {
  const calls = [];
  const streams = [];
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  async function request(method, path, { query = null, body = null } = {}) {
    const pathname = `/api${path.startsWith('/') ? path : `/${path}`}`;
    const q = {};
    for (const [k, v] of Object.entries(query ?? {})) if (v !== null && v !== undefined) q[k] = Array.isArray(v) ? v.join(',') : String(v);
    calls.push({ method, path: pathname, query: q, body });
    await wait();
    const hit = matchFixture(method, pathname);
    if (!hit) throw new ApiError({ status: 404, code: 'E_NOT_FOUND', message: `No fixture for ${method} ${pathname}` });
    const forced = variants[`${method} ${hit.f.path}`];
    const headers = forced ? { 'x-scrolls-mock': forced } : {};
    const { variant } = selectVariant(hit.f.fixture, { query: q, params: hit.params, headers, body });
    const status = variant.status ?? 200;
    if (status >= 400) {
      const e = variant.body?.error ?? {};
      throw new ApiError({ status, code: e.code ?? `HTTP_${status}`, message: e.message ?? 'error', hint: e.hint ?? null, detail: e.detail ?? null, path: pathname });
    }
    if (status === 204) return null;
    if (variant.text !== undefined) return variant.text;
    return structuredClone(variant.body ?? null);
  }
  return {
    calls,
    streams,
    get: (path, query = null) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
    del: (path) => request('DELETE', path),
    url: (path, query = null) => {
      const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null && v !== undefined)).toString()}` : '';
      return `/api${path.startsWith('/') ? path : `/${path}`}${qs}`;
    },
    abort() {},
    /** Plays the fixture's events for the stream (variant `variants['SSE /api/…']` or the default), one per tick. */
    sse(path, handlers) {
      const pathname = `/api${path}`;
      const hit = matchFixture('GET', pathname);
      const rec = { path: pathname, closed: false };
      streams.push(rec);
      if (hit) {
        const forced = variants[`SSE ${hit.f.path}`];
        const { variant } = selectVariant(hit.f.fixture, { query: {}, params: hit.params, headers: forced ? { 'x-scrolls-mock': forced } : {} });
        let i = 0;
        const next = () => {
          if (rec.closed || i >= (variant.events ?? []).length) return;
          const e = variant.events[i++];
          handlers[e.event]?.(structuredClone(e.data), {});
          setTimeout(next, 0);
        };
        setTimeout(next, 0);
      }
      return () => { rec.closed = true; };
    },
  };
}

/** Let pending promises and zero-delay timers run. */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A fixture variant's body, by endpoint and variant name. */
export function fixtureBody(method, path, name) {
  const f = FIXTURES.find((x) => x.method === method && x.path === path);
  if (!f) throw new Error(`no fixture ${method} ${path}`);
  const v = f.fixture.variants[name ?? f.fixture.default];
  if (!v) throw new Error(`no variant ${name} in ${method} ${path}`);
  return structuredClone(v.body);
}

/** Every variant of a fixture: [{name, status, body}]. */
export function fixtureVariantsOf(method, path) {
  const f = FIXTURES.find((x) => x.method === method && x.path === path);
  if (!f) throw new Error(`no fixture ${method} ${path}`);
  return Object.entries(f.fixture.variants).map(([name, v]) => ({ name, status: v.status ?? 200, body: structuredClone(v.body ?? null), variant: v }));
}
