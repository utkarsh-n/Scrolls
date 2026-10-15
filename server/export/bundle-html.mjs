// OWNER: WP3
// bundle-html.mjs — the portable bundle (SPEC §7.3): one self-contained .html file that opens offline with the
// view's SVG snapshot, the manifest, the data subset (aggregates, ≤ 5,000 occurrences with KWIC where text export
// is allowed, relationships, annotations) and a small inline script (< 8 KB) that renders sortable tables. No live
// re-query; no external resource. A synthetic export carries the SYNTHETIC banner.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
// "<" inside JSON becomes the JSON escape for U+003C, so no "</script>" can close the data block early
const JSON_LT = `${'\\'}u003c`;

/**
 * Strip active content from an SVG before inlining it: scripts, foreignObject, event handlers, javascript: URLs.
 * @param {string} svg
 * @returns {string}
 */
export function sanitizeSvg(svg) {
  return String(svg ?? '')
    .replace(/<\?xml[^>]*>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

/** The inline renderer: sortable tables from the embedded data (kept far below the 8 KB budget). */
export const BUNDLE_SCRIPT = `(function(){
var D=JSON.parse(document.getElementById('scrolls-data').textContent),T=document.getElementById('tables');
function el(t,a,c){var e=document.createElement(t);if(a)for(var k in a)e.setAttribute(k,a[k]);if(c!=null)e.textContent=c;return e}
Object.keys(D).forEach(function(name){var tb=D[name];if(!tb||!tb.rows)return;
var sec=el('section',{'class':'tbl'});sec.appendChild(el('h2',null,name+' — '+tb.rows.length+' rows'+(tb.note?' ('+tb.note+')':'')));
var table=el('table'),thead=el('thead'),tr=el('tr'),tbody=el('tbody'),st={col:null,dir:1};
tb.columns.forEach(function(c){var th=el('th',{tabindex:'0',scope:'col','aria-sort':'none'},c);
th.addEventListener('click',function(){sort(c,th)});th.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();sort(c,th)}});tr.appendChild(th)});
thead.appendChild(tr);table.appendChild(thead);table.appendChild(tbody);
function render(){tbody.textContent='';tb.rows.forEach(function(r){var row=el('tr');tb.columns.forEach(function(c){var v=r[c];
row.appendChild(el('td',null,v==null?'':typeof v==='object'?JSON.stringify(v):String(v)))});tbody.appendChild(row)})}
function sort(c,th){st.dir=st.col===c?-st.dir:1;st.col=c;Array.prototype.forEach.call(tr.children,function(h){h.setAttribute('aria-sort','none')});
th.setAttribute('aria-sort',st.dir>0?'ascending':'descending');
tb.rows.sort(function(a,b){var x=a[c],y=b[c];if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1;return(x<y?-1:x>y?1:0)*st.dir});render()}
render();var wrap=el('div',{'class':'scroll'});wrap.appendChild(table);sec.appendChild(wrap);T.appendChild(sec)})})();`;

const STYLE = `:root{color-scheme:dark;--bg:#101317;--fg:#e9e4d8;--mute:#9aa3ad;--line:#2a3038;--amber:#e0a84f}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px}p,dd{color:var(--mute)}
.syn{background:repeating-linear-gradient(45deg,#3a2c12,#3a2c12 8px,#2a2010 8px,#2a2010 16px);color:#f3d9a4;padding:8px 12px;font-weight:600;margin:-16px -16px 16px}
.snap{border:1px solid var(--line);padding:8px;overflow:auto;max-height:70vh}.snap svg{max-width:100%;height:auto}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dt{color:var(--fg)}dd{margin:0;word-break:break-word}
.scroll{overflow:auto;max-height:60vh;border:1px solid var(--line)}table{border-collapse:collapse;font:12px ui-monospace,Menlo,monospace}
th,td{border-bottom:1px solid var(--line);padding:3px 8px;text-align:left;white-space:nowrap}th{position:sticky;top:0;background:#161b21;cursor:pointer}
.legend li{margin:2px 0}`;

/**
 * A self-contained HTML document.
 * @param {{manifest: object, svg?: string|null, data: Record<string, {columns: string[], rows: object[], note?: string}>}} parts
 * @returns {string}
 */
export function bundleHtml({ manifest, svg = null, data }) {
  const synthetic = Boolean(manifest?.synthetic_included);
  const json = JSON.stringify(data).replace(/</g, JSON_LT);
  const prov = [
    ['Data version', manifest.data_version], ['Generated', manifest.generated_at], ['View', manifest.view ?? '(unsaved state)'],
    ['State', manifest.state], ['Filters', manifest.filters || '(none)'], ['Toggles', JSON.stringify(manifest.toggles)],
    ['Runs', JSON.stringify(manifest.run_ids)], ['Collections', (manifest.collections ?? []).join(', ')],
    ['Licences', (manifest.licenses ?? []).join('; ') || '(see collections)'], ['Attributions', (manifest.attributions ?? []).join('; ') || '(none required)'],
    ['Text policy', manifest.text_policy], ...(manifest.sampling_note ? [['Sampling', manifest.sampling_note]] : []),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scrolls export</title><style>${STYLE}</style></head><body>
${synthetic ? '<div class="syn" role="note">SYNTHETIC DEMONSTRATION CORPUS — invented people, texts, dates and links.</div>' : ''}
<header><h1>Scrolls · offline export</h1><p>${esc(manifest.what)} · data v${esc(manifest.data_version)} · generated ${esc(manifest.generated_at)}. A snapshot of the data, not a live view: nothing here re-queries the corpus.</p></header>
<section aria-label="Snapshot"><h2>Snapshot</h2>${svg ? `<div class="snap">${sanitizeSvg(svg)}</div>` : '<p>No snapshot was attached to this export.</p>'}</section>
<section aria-label="Legend" class="legend"><h2>Legend</h2><ul>
<li>Bins: observed (n ≥ 1) · absent (looked, found none) · low (coverage below the gate: no rate) · uncovered (no sources) · pending (not yet looked). Gaps are never bridged.</li>
<li>Washes: records dated too coarsely for the bin; never added to rates.</li>
<li>Evidence: documented (from a source record) · computed (by an algorithm, with its run) · proposed (a hypothesis). Review status is an overlay and never changes evidence.</li>
<li>Rates are per million tokens (text) or per 1,000 works (titles) of the same slice; every aggregate carries its denominator.</li></ul></section>
<section aria-label="Provenance and licences"><h2>Provenance and licences</h2><dl>${prov.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>
<div id="tables"></div>
<script type="application/json" id="scrolls-data">${json}</script>
<script>${BUNDLE_SCRIPT}</script>
</body></html>
`;
}
