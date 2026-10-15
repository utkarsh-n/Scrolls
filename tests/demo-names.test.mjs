// OWNER: WP2 — no synthetic demo name collides with a real one (SPEC §9.1, D19, §11 "demo material clearly
// labelled"): every person, group, institution, place and work title of the demo is checked, folded, against
// the culture-works titles/native titles/makers and the MusicBrainz artist names; with SCROLLS_TEST_CIPHER=1
// (npm run test:cipher) also against the 40.4M MusicBrainz recording titles. Absent sources are skipped with
// a message, never counted as a pass of that source.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { CIPHER } from '../server/config.mjs';
import { checkDemoNames, demoNames } from '../scripts/check-demo-names.mjs';

const FULL = process.env.SCROLLS_TEST_CIPHER === '1';

describe('demo name collisions (scripts/check-demo-names.mjs)', () => {
  test('the checked list covers authors, invented people, places and every work title', () => {
    const names = demoNames();
    const has = (n) => names.some((x) => x.name === n);
    for (const n of ['MC Ledgerline', 'Ada Brennock', 'Quellhaven', 'Kilnmark Crew', 'Zero Holds the Place', 'Margin Ghosts (Fantasma)',
      'Nothing Holds the Place', 'Lowmere General Hospital']) assert.ok(has(n), n);
    assert.ok(names.filter((n) => n.kind === 'title').length > 200, 'generated titles are checked too');
    assert.ok(!names.some((n) => /\(synthetic\)/.test(n.name)), 'the "(synthetic)" suffix is not part of the checked name');
  });

  test('no collision with culture-works titles, makers or MusicBrainz artists', {
    skip: !existsSync(CIPHER.cultureWorks) && 'culture-works.tsv absent: nothing to check against',
  }, async (t) => {
    const res = await checkDemoNames({ recordings: false });
    if (res.sources.musicbrainz_artist === 'absent') t.diagnostic('MusicBrainz artist table absent: that part was skipped');
    assert.deepEqual(res.collisions, []);
    assert.equal(res.sources.culture_works, 'checked');
  });

  test('no collision with the 40.4M MusicBrainz recording titles', {
    skip: (!FULL && 'set SCROLLS_TEST_CIPHER=1 (npm run test:cipher) for the 4.5 GB recording scan')
      || (!existsSync(path.join(CIPHER.musicbrainzTables, 'recording')) && 'MusicBrainz recording table absent'),
  }, async () => {
    const res = await checkDemoNames({ recordings: true });
    assert.deepEqual(res.collisions, []);
    assert.match(res.sources.musicbrainz_recording, /rows/);
  });
});
