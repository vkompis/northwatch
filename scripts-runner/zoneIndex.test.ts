import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as turf from '@turf/turf';
import { makeZoneTest } from './zoneIndex';

// A square with a hole, and a separate second part
{
  const test = makeZoneTest({
    type: 'MultiPolygon',
    coordinates: [
      [
        [[0, 60], [10, 60], [10, 70], [0, 70], [0, 60]],
        [[4, 64], [6, 64], [6, 66], [4, 66], [4, 64]],
      ],
      [[[20, 60], [22, 60], [22, 62], [20, 62], [20, 60]]],
    ],
  })!;
  assert.equal(test(2, 62), true);
  assert.equal(test(5, 65), false, 'in the hole');
  assert.equal(test(21, 61), true, 'in the second part');
  assert.equal(test(15, 65), false, 'between the parts');
  assert.equal(test(2, 75), false, 'north of everything');
  assert.equal(test(-1, 65), false, 'west of everything');
}
assert.equal(makeZoneTest({ type: 'Point', coordinates: [0, 0] }), null);
assert.equal(makeZoneTest(null), null);

// Gives the same answer as turf on the real zones, also right next to their edges
for (const file of ['norway-eez', 'svalbard-fpz', 'janmayen-eez']) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/source/overlays', `${file}.geojson`), 'utf8'));
  const geom = j.features ? j.features[0].geometry : j.geometry || j;
  const test = makeZoneTest(geom)!;
  const feature = { type: 'Feature', properties: {}, geometry: geom } as any;
  const [w, s, e, n] = turf.bbox(feature);
  const vertices: number[][] = turf.coordAll(feature);
  let seed = 42;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const points: number[][] = [];
  for (let i = 0; i < 1500; i++) points.push([w + random() * (e - w), s + random() * (n - s)]);
  for (let i = 0; i < 1500; i++) {
    const v = vertices[Math.floor(random() * vertices.length)];
    points.push([v[0] + (random() - 0.5) * 0.01, v[1] + (random() - 0.5) * 0.01]);
  }
  for (const [lon, lat] of points) {
    assert.equal(test(lon, lat), turf.booleanPointInPolygon(turf.point([lon, lat]), feature), `${file} at ${lon},${lat}`);
  }
}

console.log('zoneIndex tests passed');
