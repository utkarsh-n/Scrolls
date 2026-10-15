// OWNER: WP6 — the table alternative reads the SAME typed arrays the painter uses (SPEC §8.6, §11 row 4):
// identity check, one row per cell, suppressed numbers print "—", the segment list names every gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayFromYMD } from '../src/shared/dates.mjs';
import { buildModel } from '../src/ui/timeline/model.mjs';
import { buildDisplay, layoutLanes } from '../src/ui/timeline/display.mjs';
import { flagWords, segmentList, strandRows, tableModel } from '../src/ui/timeline/a11y-table.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./contract/${name}`, import.meta.url), 'utf8'));
const QUERY = fixture('POST__api_timeline_query.json').variants.ready.body;
const TILES = fixture('GET__api_timeline_tiles.json').variants.ok.body;
const RANGE = [dayFromYMD(1880), dayFromYMD(2040, 12, 31)];
const model = buildModel({ query: QUERY, tier: 'L2', tiles: new Map(TILES.tiles.map((t) => [t.tile, t])), range: RANGE,
  strands: [{ type: 'expression', id: 12, glyph: 'circle' }], strandLabels: new Map([['12', 'carry the zero']]) });

test('the table and the painter read the same typed-array object (identity)', () => {
  const tables = tableModel(model);
  assert.equal(tables.length, model.lanes.length);
  model.lanes.forEach((l, i) => assert.equal(tables[i].source, l.strands[0].cols, `${l.key}: same object`));
  // The display list is drawn from those columns too: every bar's bin is a row of the table.
  const layout = layoutLanes(model.lanes, 1);
  const display = buildDisplay(model, { originDay: RANGE[0], daysPerPx: 30, width: (RANGE[1] - RANGE[0]) / 30, layout });
  const classroom = tables.find((t) => t.laneKey === 'community:classroom');
  const barBins = display.lanes.filter((p) => p.style?.startsWith('bar') && p.ref.lane === 'community:classroom').map((p) => p.ref.bin);
  for (const b of barBins) assert.ok([...classroom.source.bin].includes(b));
});

test('one row per cell; low, uncovered and pending cells print "—" for rate and CI, never 0', () => {
  const classroom = model.lanes.find((l) => l.key === 'community:classroom');
  const rows = strandRows(classroom.strands[0], classroom, 'L2');
  assert.equal(rows.length, classroom.strands[0].cols.length);
  const low = rows.find((r) => r.bin === '1890–1899');
  assert.deepEqual([low.n, low.rate, low.ci, low.state], ['0', '—', '—', 'low coverage (rate not shown)']);
  const obs = rows.find((r) => r.bin === '1910–1919');
  assert.deepEqual([obs.n, obs.rate, obs.ci, obs.coverage, obs.state], ['22', '8,148/M tokens', '[5,106, 12,336]', '2.7k tokens', 'observed']);
  const absent = rows.find((r) => r.bin === '1960–1969');
  assert.equal(absent.state, 'looked, found none');
  assert.equal(absent.rate, '0/M tokens', 'absent: a measured zero with its upper bound');
  assert.equal(flagWords(18), 'single source ¹, synthetic');
});

test('the segment list names bars, absences, low coverage, gaps and washes in time order', () => {
  const classroom = model.lanes.find((l) => l.key === 'community:classroom');
  const segs = segmentList(classroom.strands[0], classroom, 'L2');
  const text = segs.join('\n');
  assert.match(text, /observed 1900–1939: 4 bins, n = 70; first 1905, last in 1930–1939/);
  assert.match(text, /1940–1949: no sources/);
  assert.match(text, /1960–1969: looked, found none \(0 in 2.4k tokens\)/);
  assert.match(text, /1890–1899: low coverage, n = 0 in 600 tokens/);
  assert.match(text, /wash early 20th century: 1 match not counted in bars or rates/);
  const starts = segs.map((s) => s.match(/(\d{4})/)?.[1]).filter(Boolean).map(Number);
  assert.ok(starts.indexOf(1940) > starts.indexOf(1900), 'sorted by time');
});
