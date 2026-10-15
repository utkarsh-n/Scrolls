// OWNER: WP0 — screen-reader announcements through live regions, at most one per second (SPEC §8.1, §1.9)
//
// Rapid updates (scrubbing, play steps) coalesce: inside the 1 s window only the latest message is kept
// and spoken when the window ends, so the listener hears the current state rather than a backlog.

export const MIN_INTERVAL_MS = 1000;
const MAX_LENGTH = 300;
const REGION_IDS = { polite: 'live-polite', assertive: 'live-assertive' };

/**
 * Create an announcer bound to a document (injectable clock and timers for tests).
 * @param {{ doc?: Document, now?: () => number, setTimer?: typeof setTimeout, minIntervalMs?: number }} [opts]
 * @returns {(text: string, opts?: { politeness?: 'polite'|'assertive' }) => void}
 */
export function createAnnouncer({ doc = globalThis.document, now = () => Date.now(), setTimer = setTimeout,
  minIntervalMs = MIN_INTERVAL_MS } = {}) {
  let last = -Infinity;
  let pending = null;
  let timer = null;

  function region(politeness) {
    const id = REGION_IDS[politeness];
    let el = doc.getElementById(id);
    if (!el) {
      el = doc.createElement('div');
      el.id = id;
      el.className = 'visually-hidden';
      el.setAttribute('aria-live', politeness);
      el.setAttribute('aria-atomic', 'true');
      if (politeness === 'assertive') el.setAttribute('role', 'alert');
      doc.body.appendChild(el);
    }
    return el;
  }

  function speak({ text, politeness }) {
    last = now();
    const el = region(politeness);
    // Clear first, then write on a later tick, so an identical message is announced again.
    el.textContent = '';
    setTimer(() => { el.textContent = text; }, 30);
  }

  function flush() {
    timer = null;
    if (!pending) return;
    const msg = pending;
    pending = null;
    speak(msg);
  }

  return function announce(text, { politeness = 'polite' } = {}) {
    if (!doc) return;
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH);
    if (!clean) return;
    const msg = { text: clean, politeness: politeness === 'assertive' ? 'assertive' : 'polite' };
    const wait = last + minIntervalMs - now();
    if (wait <= 0 && !timer) { speak(msg); return; }
    // An assertive message waiting in the window is not displaced by a polite one.
    if (!(pending?.politeness === 'assertive' && msg.politeness === 'polite')) pending = msg;
    if (!timer) timer = setTimer(flush, Math.max(0, wait));
  };
}

let defaultAnnouncer = null;

/**
 * Announce text to assistive technology through the page's live regions (#live-polite, #live-assertive;
 * created on demand). At most one announcement per second; within a window the latest message wins.
 * @param {string} text
 * @param {{ politeness?: 'polite'|'assertive' }} [opts]
 * @returns {void}
 */
export function announce(text, { politeness = 'polite' } = {}) {
  if (!globalThis.document) return;
  defaultAnnouncer ??= createAnnouncer();
  defaultAnnouncer(text, { politeness });
}
