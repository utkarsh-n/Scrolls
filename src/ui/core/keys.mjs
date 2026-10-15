// OWNER: WP0 — scoped keyboard registry (SPEC §8.5): modules register bindings at runtime
//
// Bindings are written as descriptors: a printable key as typed ('/', '?', '[', '{', '+', '1'), a letter in
// lower case ('e' — also fires with Shift held, so 'E' works under Caps Lock or Shift), or a named key with
// modifiers ('Space', 'Escape', 'Enter', 'Shift+ArrowLeft', 'Mod+s'). 'Mod' is Ctrl or ⌘. A plain binding
// never fires while Ctrl, ⌘ or Alt is held, so browser shortcuts stay intact.

export const GLOBAL_SCOPE = 'global';

const NAMED = {
  ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp',
  Down: 'ArrowDown', Del: 'Delete', OS: 'Meta',
};
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'Hyper', 'Super']);
const isLetter = (k) => k.length === 1 && /\p{L}/u.test(k);

/**
 * Canonical form of a binding descriptor: modifiers in the order Mod, Alt, Shift; letters lower-cased;
 * named keys in their KeyboardEvent.key spelling.
 * @param {string} desc e.g. 'shift+arrowleft', 'E', 'ctrl+S', 'space'
 * @returns {string} e.g. 'Shift+ArrowLeft', 'e', 'Mod+s', 'Space'
 */
export function normalizeBinding(desc) {
  const s = String(desc);
  // A lone '+' (zoom in) or a descriptor ending in '+' ('Shift++') keeps that '+' as its key.
  const parts = s === '+' ? ['+'] : s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  let key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const named = Object.keys(NAMED).find((k) => k.toLowerCase() === key.toLowerCase() && k.length > 1);
  if (named) key = NAMED[named];
  else if (key.length > 1) {
    const known = ['Space', 'Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Insert', 'ContextMenu'];
    key = known.find((k) => k.toLowerCase() === key.toLowerCase()) ?? key;
  } else if (isLetter(key)) key = key.toLowerCase();
  let out = '';
  if (mods.has('mod') || mods.has('ctrl') || mods.has('control') || mods.has('meta') || mods.has('cmd')) out += 'Mod+';
  if (mods.has('alt') || mods.has('option')) out += 'Alt+';
  if (mods.has('shift') && (key.length > 1 || isLetter(key))) out += 'Shift+';
  return out + key;
}

/**
 * Descriptor of a keydown event, or null for modifier-only presses and IME composition.
 * Shift is part of the descriptor for named keys ('Shift+Tab') and letters ('Shift+e'); for other
 * printable keys it is already in the character ('?', '{', '+').
 * @param {KeyboardEvent} evt
 * @returns {string|null}
 */
export function keyOf(evt) {
  if (!evt || evt.isComposing || typeof evt.key !== 'string') return null;
  const raw = evt.key;
  if (raw === 'Dead' || raw === 'Unidentified' || raw === 'Process' || MODIFIER_KEYS.has(raw)) return null;
  let key = NAMED[raw] ?? raw;
  const letter = isLetter(key);
  if (letter) key = key.toLowerCase();
  let out = '';
  if (evt.ctrlKey || evt.metaKey) out += 'Mod+';
  if (evt.altKey) out += 'Alt+';
  if (evt.shiftKey && (key.length > 1 || letter)) out += 'Shift+';
  return out + key;
}

/**
 * True when the event target is a text-entry control, where only bindings with `allowInInput` fire.
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName ?? '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  const type = String(target.type ?? 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
}

/**
 * @typedef {(evt: KeyboardEvent) => (boolean|void)} KeyHandler   return false to decline (the key falls through)
 * @typedef {{ run: KeyHandler, label?: string, allowInInput?: boolean }} KeyEntry
 * @typedef {{
 *   register(scope: string, map: Record<string, KeyHandler|KeyEntry>, opts?: { exclusive?: boolean }): () => void,
 *   setScope(scope: string): void,
 *   getScope(): string,
 *   handle(evt: KeyboardEvent): boolean,
 *   list(): Array<{ scope: string, key: string, label: string }>
 * }} Keys
 */

/**
 * Create the key registry. Lookup order: the active scope, then 'global' — unless the active scope was
 * registered `exclusive` (a modal sheet), in which case only it is consulted. Within a scope the most
 * recent registration of a key wins; unregistering restores the previous one.
 * @param {{ isTyping?: (target: EventTarget|null) => boolean }} [opts]
 * @returns {Keys}
 */
export function createKeys({ isTyping = isTypingTarget } = {}) {
  /** @type {Map<string, Map<string, Array<{id: number, entry: KeyEntry}>>>} */
  const scopes = new Map();
  const exclusive = new Set();
  let active = GLOBAL_SCOPE;
  let nextId = 1;

  function stackFor(scope, key) {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const keys = scopes.get(scope);
    if (!keys.has(key)) keys.set(key, []);
    return keys.get(key);
  }

  function lookup(scope, key) {
    const stack = scopes.get(scope)?.get(key);
    return stack && stack.length ? stack[stack.length - 1].entry : null;
  }

  return {
    register(scope, map, { exclusive: excl = false } = {}) {
      if (typeof scope !== 'string' || !scope) throw new TypeError('keys.register: scope must be a non-empty string');
      if (excl) exclusive.add(scope);
      const added = [];
      for (const [desc, value] of Object.entries(map ?? {})) {
        const entry = typeof value === 'function' ? { run: value } : value;
        if (!entry || typeof entry.run !== 'function') throw new TypeError(`keys.register: binding '${desc}' has no handler`);
        const key = normalizeBinding(desc);
        const id = nextId++;
        stackFor(scope, key).push({ id, entry });
        added.push([key, id]);
      }
      return () => {
        for (const [key, id] of added) {
          const stack = scopes.get(scope)?.get(key);
          const i = stack ? stack.findIndex((x) => x.id === id) : -1;
          if (i >= 0) stack.splice(i, 1);
        }
      };
    },

    setScope(scope) { active = typeof scope === 'string' && scope ? scope : GLOBAL_SCOPE; },

    getScope() { return active; },

    handle(evt) {
      const desc = keyOf(evt);
      if (!desc) return false;
      const typing = isTyping(evt.target ?? null);
      const order = exclusive.has(active) || active === GLOBAL_SCOPE ? [active] : [active, GLOBAL_SCOPE];
      // 'Shift+e' falls back to 'e' so letter bindings work with Shift or Caps Lock.
      const candidates = /^(?:Mod\+)?(?:Alt\+)?Shift\+\p{L}$/u.test(desc) ? [desc, desc.replace('Shift+', '')] : [desc];
      for (const scope of order) {
        for (const key of candidates) {
          const entry = lookup(scope, key);
          if (!entry || (typing && !entry.allowInInput)) continue;
          if (entry.run(evt) !== false) return true;
        }
      }
      return false;
    },

    list() {
      const out = [];
      for (const [scope, keys] of scopes) {
        for (const [key, stack] of keys) {
          const top = stack[stack.length - 1];
          if (top?.entry.label) out.push({ scope, key, label: top.entry.label });
        }
      }
      return out;
    },
  };
}
