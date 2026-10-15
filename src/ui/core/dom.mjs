// OWNER: WP0 — DOM helpers: element builder, clearing, focus trap (SPEC §8.1, §8.6)
//
// h() never parses HTML: text always goes in as text nodes, so corpus text cannot inject markup. Styles are
// set through the CSSOM (el.style), never a style attribute, which keeps the page's CSP strict.

const SVG_NS = 'http://www.w3.org/2000/svg';
const BOOLEAN_PROPS = new Set(['hidden', 'disabled', 'checked', 'selected', 'readOnly', 'required', 'multiple', 'open',
  'inert', 'autofocus', 'draggable', 'spellcheck']);
const TAG_RE = /^([a-zA-Z][\w:-]*)?((?:[#.][\w-]+)*)$/;

/**
 * Build an element.
 *
 * `tag` may carry an id and classes: `h('button#play.btn.primary')`. `'svg'` and `'svg:<name>'` create
 * SVG-namespace elements (`h('svg:path', { d })`).
 *
 * `props`:
 *  - `class` / `className`: string, string[] or `{ name: boolean }`
 *  - `style`: object of CSS properties (custom properties allowed: `{ '--w': '4px' }`)
 *  - `dataset`: object; `text`: textContent; `ref`: callback receiving the element
 *  - `on<Event>` (`onClick`, `onKeyDown` …) or `on: { event: fn }`: event listeners
 *  - boolean properties (`hidden`, `disabled` …); `aria-*`, `data-*`, `role` and other attributes;
 *    `null`, `undefined` and `false` values are skipped
 *
 * `children`: strings and numbers become text nodes; Nodes are appended; arrays are flattened;
 * `null`, `undefined`, `false` and `true` are skipped.
 * @param {string} tag
 * @param {Record<string, unknown>|null} [props]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const m = TAG_RE.exec(tag);
  if (!m) throw new TypeError(`h: invalid tag '${tag}'`);
  let name = m[1] ?? 'div';
  const svg = name === 'svg' || name.startsWith('svg:');
  if (name.startsWith('svg:')) name = name.slice(4);
  const el = svg ? document.createElementNS(SVG_NS, name) : document.createElement(name);
  for (const part of m[2].match(/[#.][\w-]+/g) ?? []) {
    if (part[0] === '#') el.id = part.slice(1);
    else el.classList.add(part.slice(1));
  }
  if (props) applyProps(el, props, svg);
  append(el, children);
  return el;
}

function classNames(v) {
  if (Array.isArray(v)) return v.flatMap(classNames);
  if (v && typeof v === 'object') return Object.entries(v).filter(([, on]) => on).map(([k]) => k);
  return typeof v === 'string' ? v.split(/\s+/).filter(Boolean) : [];
}

function applyProps(el, props, svg) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') el.classList.add(...classNames(value));
    else if (key === 'style') {
      for (const [prop, v] of Object.entries(value)) {
        if (v === null || v === undefined || v === false) continue;
        if (prop.startsWith('--') || prop.includes('-')) el.style.setProperty(prop, String(v));
        else el.style[prop] = String(v);
      }
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'ref') value(el);
    else if (key === 'on') for (const [evt, fn] of Object.entries(value)) el.addEventListener(evt, fn);
    else if (/^on[A-Z]/.test(key) && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (BOOLEAN_PROPS.has(key)) {
      if (svg) el.setAttribute(key, '');
      else el[key] = Boolean(value);
    } else if (svg || key.includes('-') || key === 'role' || !(key in el)) el.setAttribute(key, value === true ? '' : String(value));
    else el[key] = value;
  }
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === 'object' && typeof c.nodeType === 'number') el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/**
 * Remove every child of an element.
 * @template {Element} T
 * @param {T} el
 * @returns {T}
 */
export function clear(el) {
  if (typeof el.replaceChildren === 'function') el.replaceChildren();
  else while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'audio[controls]', 'video[controls]', 'summary',
  '[contenteditable]:not([contenteditable="false"])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Visible, enabled, tabbable descendants of `root`, in document order.
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
}

const trapStack = [];

/**
 * Keep keyboard focus inside `el` (dialogs, sheets): Tab and Shift+Tab cycle through its focusables and
 * focus that escapes is pulled back. Traps nest; only the innermost one acts. Focus moves into `el` when
 * it is not already there, and returns to the previously focused element on release.
 * @param {HTMLElement} el
 * @returns {() => void} release
 */
export function trapFocus(el) {
  const doc = el.ownerDocument;
  const previous = doc.activeElement;
  const token = {};
  trapStack.push(token);
  const top = () => trapStack[trapStack.length - 1] === token;

  const onKey = (e) => {
    if (e.key !== 'Tab' || !top()) return;
    const list = focusables(el);
    if (!list.length) { e.preventDefault(); el.focus(); return; }
    const first = list[0], last = list[list.length - 1], active = doc.activeElement;
    if (e.shiftKey && (active === first || !el.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
  };
  const onFocusIn = (e) => {
    if (!top() || el.contains(e.target)) return;
    (focusables(el)[0] ?? el).focus({ preventScroll: true });
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('focusin', onFocusIn);

  if (!el.contains(doc.activeElement)) {
    const first = focusables(el)[0];
    if (!first && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    (first ?? el).focus({ preventScroll: true });
  }

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('focusin', onFocusIn);
    const i = trapStack.indexOf(token);
    if (i >= 0) trapStack.splice(i, 1);
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
  };
}
