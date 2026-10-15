// OWNER: WP0 — statically imports every UI module of the §12.1 tree and mounts them into the shell regions
//
// Ownership stays disjoint (§12.1): a package adds behaviour by filling its own module, never by editing
// this file. Each module exports `mount(el, ctx) → { unmount() }`; `el` is a slot of its own inside its
// region (a `display: contents` <div data-module>), so several modules can share a region. A module may
// override its default region by exporting `region` (a mount-point id, an array of ids, or null for a
// library that is only imported by other modules). A module that throws while mounting is logged once and
// skipped; the rest of the shell still mounts.

import * as shellLayout from './shell/layout.mjs';
import * as shellToolbar from './shell/toolbar.mjs';
import * as shellSearch from './shell/search.mjs';
import * as shellFilters from './shell/filters.mjs';
import * as shellLanesMenu from './shell/lanes-menu.mjs';
import * as shellRibbon from './shell/ribbon.mjs';
import * as shellToasts from './shell/toasts.mjs';
import * as shellHelp from './shell/help.mjs';
import * as shellJobsChip from './shell/jobs-chip.mjs';
import * as tlViewport from './timeline/viewport.mjs';
import * as tlScale from './timeline/scale.mjs';
import * as tlFolded from './timeline/folded.mjs';
import * as tlTiers from './timeline/tiers.mjs';
import * as tlTilesClient from './timeline/tiles-client.mjs';
import * as tlModel from './timeline/model.mjs';
import * as tlDisplay from './timeline/display.mjs';
import * as tlPaint from './timeline/paint.mjs';
import * as tlSvg from './timeline/svg.mjs';
import * as tlHit from './timeline/hit.mjs';
import * as tlInput from './timeline/input.mjs';
import * as tlGestures from './timeline/gestures.mjs';
import * as tlPlayhead from './timeline/playhead.mjs';
import * as tlArcs from './timeline/arcs.mjs';
import * as tlShelves from './timeline/shelves.mjs';
import * as tlSeams from './timeline/seams.mjs';
import * as tlMinimap from './timeline/minimap.mjs';
import * as tlCoverage from './timeline/coverage.mjs';
import * as tlLegend from './timeline/legend.mjs';
import * as tlA11yTable from './timeline/a11y-table.mjs';
import * as tlDrawer from './timeline/drawer.mjs';
import * as tlSnapshot from './timeline/snapshot.mjs';
import * as tlPerf from './timeline/perf.mjs';
import * as tourTour from './tour/tour.mjs';
import * as tourCoachmarks from './tour/coachmarks.mjs';
import * as pInspector from './panels/inspector.mjs';
import * as pPassageCard from './panels/passage-card.mjs';
import * as pReader from './panels/reader.mjs';
import * as pDateChip from './panels/date-chip.mjs';
import * as pCrossings from './panels/crossings.mjs';
import * as pCompare from './panels/compare.mjs';
import * as pGateCard from './panels/gate-card.mjs';
import * as pLineage from './panels/lineage.mjs';
import * as pGenealogy from './panels/genealogy.mjs';
import * as pConstellation from './panels/constellation.mjs';
import * as pEdgeCard from './panels/edge-card.mjs';
import * as pNotebook from './panels/notebook.mjs';
import * as pAnnotationEditor from './panels/annotation-editor.mjs';
import * as pRevisions from './panels/revisions.mjs';
import * as pViewsMenu from './panels/views-menu.mjs';
import * as pExportMenu from './panels/export-menu.mjs';
import * as pJobsTray from './panels/jobs-tray.mjs';
import * as pAdapters from './panels/adapters.mjs';
import * as importWizard from './import/wizard.mjs';
import * as importMappingTable from './import/mapping-table.mjs';
import * as importSummary from './import/summary.mjs';
import * as selftest from './selftest.mjs';

/**
 * Mount points of public/index.html (SPEC §12.2), plus 'app' (the root element) and 'selftest' (a hidden
 * host that exists only when the page URL has ?selftest=…).
 */
export const MOUNT_POINTS = Object.freeze(['ribbon', 'toolbar', 'minimap', 'lanes', 'shelf-undated', 'scroll',
  'shelf-scheduled', 'legend', 'inspector', 'panel', 'sheet', 'toasts', 'a11y', 'tour', 'jobs']);

const M = (id, mod, region = null) => Object.freeze({ id, mod, region });

/**
 * Every UI module, in mount order, with its default region (null = library, imported but not mounted).
 * @type {ReadonlyArray<{id: string, mod: Record<string, any>, region: string|string[]|null}>}
 */
export const MODULES = Object.freeze([
  M('shell/layout.mjs', shellLayout, 'app'),
  M('shell/ribbon.mjs', shellRibbon, 'ribbon'),
  M('shell/toolbar.mjs', shellToolbar, 'toolbar'),
  M('shell/search.mjs', shellSearch, 'toolbar'),
  M('shell/filters.mjs', shellFilters, 'toolbar'),
  M('shell/lanes-menu.mjs', shellLanesMenu, 'lanes'),
  M('shell/toasts.mjs', shellToasts, 'toasts'),
  M('shell/help.mjs', shellHelp, 'sheet'),
  M('shell/jobs-chip.mjs', shellJobsChip, 'jobs'),
  M('timeline/viewport.mjs', tlViewport, 'scroll'),
  M('timeline/scale.mjs', tlScale),
  M('timeline/folded.mjs', tlFolded),
  M('timeline/tiers.mjs', tlTiers),
  M('timeline/tiles-client.mjs', tlTilesClient),
  M('timeline/model.mjs', tlModel),
  M('timeline/display.mjs', tlDisplay),
  M('timeline/paint.mjs', tlPaint),
  M('timeline/svg.mjs', tlSvg),
  M('timeline/hit.mjs', tlHit),
  M('timeline/input.mjs', tlInput),
  M('timeline/gestures.mjs', tlGestures),
  M('timeline/playhead.mjs', tlPlayhead),
  M('timeline/arcs.mjs', tlArcs),
  M('timeline/shelves.mjs', tlShelves, ['shelf-undated', 'shelf-scheduled']),
  M('timeline/seams.mjs', tlSeams),
  M('timeline/minimap.mjs', tlMinimap, 'minimap'),
  M('timeline/coverage.mjs', tlCoverage),
  M('timeline/legend.mjs', tlLegend, 'legend'),
  M('timeline/a11y-table.mjs', tlA11yTable, 'a11y'),
  M('timeline/drawer.mjs', tlDrawer, 'sheet'),
  M('timeline/snapshot.mjs', tlSnapshot),
  M('timeline/perf.mjs', tlPerf, 'app'),
  M('panels/inspector.mjs', pInspector, 'inspector'),
  M('panels/passage-card.mjs', pPassageCard),
  M('panels/reader.mjs', pReader),
  M('panels/date-chip.mjs', pDateChip),
  M('panels/crossings.mjs', pCrossings),
  M('panels/compare.mjs', pCompare, 'panel'),
  M('panels/gate-card.mjs', pGateCard),
  M('panels/lineage.mjs', pLineage, 'panel'),
  M('panels/genealogy.mjs', pGenealogy, 'panel'),
  M('panels/constellation.mjs', pConstellation, 'panel'),
  M('panels/edge-card.mjs', pEdgeCard),
  M('panels/notebook.mjs', pNotebook, 'panel'),
  M('panels/annotation-editor.mjs', pAnnotationEditor),
  M('panels/revisions.mjs', pRevisions),
  M('panels/views-menu.mjs', pViewsMenu, 'toolbar'),
  M('panels/export-menu.mjs', pExportMenu, 'toolbar'),
  M('panels/jobs-tray.mjs', pJobsTray, 'jobs'),
  M('panels/adapters.mjs', pAdapters, 'panel'),
  M('import/wizard.mjs', importWizard, 'panel'),
  M('import/mapping-table.mjs', importMappingTable),
  M('import/summary.mjs', importSummary),
  M('tour/tour.mjs', tourTour, 'tour'),
  M('tour/coachmarks.mjs', tourCoachmarks, 'tour'),
  M('selftest.mjs', selftest, 'selftest'),
]);

/**
 * Worker entry points of the tree. A worker script runs in its own global scope, so it is never imported
 * here; panels create it with `new Worker(WORKERS['panels/layout.worker.mjs'], { type: 'module' })`.
 */
export const WORKERS = Object.freeze({
  'panels/layout.worker.mjs': new URL('./panels/layout.worker.mjs', import.meta.url).href,
});

/**
 * Regions a module mounts into: its own `region` export when it has one, else the default above.
 * @param {{mod: Record<string, any>, region: string|string[]|null}} m
 * @returns {string[]}
 */
export function regionsOf(m) {
  const r = Object.prototype.hasOwnProperty.call(m.mod, 'region') ? m.mod.region : m.region;
  return r === null || r === undefined ? [] : Array.isArray(r) ? r : [r];
}

const reported = new Set();
function logOnce(key, err) {
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[scrolls] ${key}:`, err);
}

/** Remove the boot placeholders of a region as soon as a module has put something visible in its slot. */
function releaseBootWhenFilled(region, slot) {
  const release = () => { for (const n of region.querySelectorAll(':scope > [data-boot]')) n.remove(); };
  if (slot.childNodes.length) { release(); return; }
  if (typeof MutationObserver !== 'function') return;
  const mo = new MutationObserver(() => {
    if (!slot.childNodes.length) return;
    mo.disconnect();
    release();
  });
  mo.observe(slot, { childList: true });
}

function findRegions(root) {
  const doc = root.ownerDocument;
  const regions = { app: root };
  for (const id of MOUNT_POINTS) regions[id] = doc.getElementById(id);
  const params = new URLSearchParams(doc.defaultView?.location?.search ?? '');
  if (params.has('selftest')) {
    regions.selftest = doc.getElementById('selftest') ?? root.appendChild(Object.assign(doc.createElement('div'), { id: 'selftest', hidden: true }));
  }
  return regions;
}

/**
 * Mount every module that has a region into its slot(s). `ctx` is passed through with `regions` (mount
 * point id → element) added, so a module can reach a second region it draws into (e.g. lane headers).
 * @param {HTMLElement} root the app root (#app)
 * @param {{store: object, api: object, keys: object, announce: Function,
 *          onModuleError?: (moduleId: string, err: unknown) => void}} ctx
 * @returns {{ unmount(): void, failed: string[] }}   (§12.2 treats the result as void; both fields are additive)
 */
export function mountApp(root, ctx) {
  const doc = root.ownerDocument;
  const regions = findRegions(root);
  const moduleCtx = { ...ctx, regions };
  const handles = [];
  const failed = [];

  const fail = (m, err, slot) => {
    failed.push(m.id);
    slot.remove();
    logOnce(`module ${m.id} failed to mount`, err);
    try { ctx.onModuleError?.(m.id, err); } catch { /* reporting must not throw */ }
  };

  for (const m of MODULES) {
    const names = regionsOf(m);
    if (!names.length) continue;
    if (typeof m.mod.mount !== 'function') {
      logOnce(`module ${m.id} has no mount()`, new TypeError(`${m.id} must export mount(el, ctx)`));
      failed.push(m.id);
      continue;
    }
    for (const name of names) {
      const region = regions[name];
      if (!region) {
        if (name !== 'selftest') logOnce(`region '${name}' is missing from index.html`, new Error(`#${name} not found`));
        continue;
      }
      const slot = doc.createElement('div');
      slot.className = 'slot';
      slot.dataset.module = m.id;
      region.appendChild(slot);
      try {
        const out = m.mod.mount(slot, moduleCtx);
        if (out && typeof out.then === 'function') {
          out.then((h) => { handles.push(h); releaseBootWhenFilled(region, slot); }, (err) => fail(m, err, slot));
        } else {
          handles.push(out);
          releaseBootWhenFilled(region, slot);
        }
      } catch (err) {
        fail(m, err, slot);
      }
    }
  }

  return {
    failed,
    unmount() {
      for (const h of handles.splice(0).reverse()) {
        try { h?.unmount?.(); } catch (err) { logOnce('unmount', err); }
      }
    },
  };
}
