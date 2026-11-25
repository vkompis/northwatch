import assert from 'node:assert/strict';
import { gridDisk, latLngToCell } from 'h3-js';
import { interferenceAreas, interferenceLevel, latestDay } from './gpsJam';

// GPSJam's share: 100 × (bad − 1) / (good + bad); over 10 % high, 2–10 % medium
assert.equal(interferenceLevel(10, 0), null);
assert.equal(interferenceLevel(0, 1), null); // one lone aircraft is not counted
assert.equal(interferenceLevel(90, 4), 'medium'); // 3.2 %
assert.equal(interferenceLevel(50, 10), 'high'); // 15 %
assert.equal(interferenceLevel(0, 0), null);

assert.equal(latestDay('date,suspect,num_bad_aircraft_hexes,source\n2026-11-23,false,541,merged\n2026-11-24,true,473,merged\n'), '2026-11-23');
assert.equal(latestDay('date,suspect\n'), null);

// Neighbouring hexes of one level become one area; hexes outside the watched area are left out
{
  const gulf = latLngToCell(59.9, 27.5, 4);
  const nextTo = gridDisk(gulf, 1).find((c) => c !== gulf)!;
  const sahara = latLngToCell(25, 10, 4);
  const csv = ['hex,count_good_aircraft,count_bad_aircraft', `${gulf},10,20`, `${nextTo},20,30`, `${sahara},1,50`].join('\n');
  const gj = interferenceAreas(csv, '2026-11-24');
  assert.deepEqual(gj.meta, { date: '2026-11-24', source: 'GPSJam.org', high: 2, medium: 0 });
  assert.equal(gj.features.length, 1);
  assert.equal(gj.features[0].properties.level, 'high');
  // Two touching hexes join into one polygon with a single outer ring
  assert.equal(gj.features[0].geometry.coordinates.length, 1);
  const ring = gj.features[0].geometry.coordinates[0][0];
  assert.ok(ring.every(([lon, lat]: number[]) => lon > 26 && lon < 30 && lat > 59 && lat < 61));
}

console.log('gpsJam.test.ts: ok');
