import assert from 'node:assert/strict';
import { jumpReasons, noteReport, spoofingReasons, sweepSpoofing, trackReasons, valueReasons } from './aisSpoofing';

const T0 = Date.parse('2026-10-29T00:00:00Z');
const min = 60_000;

/** A ship sailing east along 70°N at `kn`, one fix every `stepMin` minutes. */
function steady(n: number, kn: number, stepMin: number, start = T0, lon0 = 10) {
  const degPerMin = (kn * 1.852) / 60 / (111.32 * Math.cos((70 * Math.PI) / 180));
  return Array.from({ length: n }, (_, i) => ({ t: start + i * stepMin * min, lon: lon0 + i * stepMin * degPerMin, lat: 70 }));
}

// Values AIS cannot carry, and speeds no slow ship reaches
{
  assert.equal(valueReasons({ course: 424 }).length, 1);
  assert.match(valueReasons({ course: 424 })[0], /course of 424°/);
  assert.deepEqual(valueReasons({ course: 360 }), []);
  assert.deepEqual(valueReasons({ course: 511 }), []);
  assert.deepEqual(valueReasons({ course: 359.9 }), []);
  assert.equal(valueReasons({ heading: 400 }).length, 1);
  assert.deepEqual(valueReasons({ heading: 511 }), []);
  assert.match(valueReasons({ speed: 41, shipType: 'Cargo' })[0], /41 kn, impossible for a cargo ship/);
  assert.match(valueReasons({ speed: 62, shipType: 'Fishing' })[0], /impossible for a fishing vessel$/);
  assert.match(valueReasons({ speed: 54, shipType: 'Tanker' })[0], /impossible for a tanker$/);
  assert.deepEqual(valueReasons({ speed: 39, shipType: 'Cargo' }), []);
  assert.deepEqual(valueReasons({ speed: 45, shipType: 'High speed craft' }), []);
  assert.deepEqual(valueReasons({ speed: 51, shipType: 'Not available' }), []);
  assert.deepEqual(valueReasons({ speed: 102.3, shipType: 'Tanker' }), []);
  assert.deepEqual(valueReasons({ speed: 63, shipType: 'Fishing' }), []);
  assert.deepEqual(valueReasons({ speed: null, course: null, heading: null }), []);
}

// A ship sailing normally, fast or slow, raises nothing
{
  assert.deepEqual(jumpReasons(steady(40, 14, 5)), []);
  assert.deepEqual(jumpReasons(steady(40, 45, 1)), []);
}

// A long gap is not a jump: 300 km in 10 hours is 16 kn
{
  const a = steady(5, 12, 5);
  const b = steady(5, 12, 5, T0 + 10 * 3600e3, 10 + 300 / (111.32 * Math.cos((70 * Math.PI) / 180)));
  assert.deepEqual(jumpReasons([...a, ...b]), []);
}

// One bad fix, out and back, is a glitch, not a pattern
{
  const fixes = steady(30, 12, 5);
  fixes[12] = { ...fixes[12], lon: fixes[12].lon + 4 };
  assert.deepEqual(jumpReasons(fixes), []);
  // Nor are two of them in six hours of fixes
  fixes[25] = { ...fixes[25], lat: 71.5 };
  assert.deepEqual(jumpReasons(fixes), []);
}

// Two transmitters on one MMSI: the position flips between two places
{
  const fixes = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * 2 * min, lon: i % 2 ? 18 : 10, lat: 70 }));
  const r = jumpReasons(fixes);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /jumped 9 times between places up to 30\d km apart/);
}

// A jump the ship keeps reporting from
{
  const a = steady(4, 10, 5);
  const b = steady(4, 10, 5, a[3].t + 10 * min, 16);
  const r = jumpReasons([...a, ...b]);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /^Jumped \d+ km in 10 min \(\d+ kn\) and kept reporting from the new place/);
  assert.equal(r[0].at, new Date(b[0].t).toISOString());
  // ...but not when only one fix came before it (the first fix may be the bad one)
  assert.deepEqual(jumpReasons([a[3], ...b]), []);
  // ...nor when the new place lasted under 10 minutes
  assert.deepEqual(jumpReasons([...a, ...b.slice(0, 2)]), []);
}

// SC 609's last 24 hours from BarentsWatch: course 424° etc., and a 187 km jump it stayed at
{
  const rows: [string, number, number, number, number][] = [
    ['2026-10-29T04:17:39Z', 16.843, 72.082, 3, 125],
    ['2026-10-29T04:27:48Z', 17.355, 72.265, 2, 493],
    ['2026-10-29T05:42:47Z', 17.875, 73.942, 2, 129],
    ['2026-10-29T05:51:47Z', 17.68, 74.16, 0, 474],
    ['2026-10-29T06:00:47Z', 17.617, 74.215, 1, 118],
    ['2026-10-29T09:45:47Z', 15.82, 73.668, 1, 393],
    ['2026-10-29T09:51:47Z', 15.74, 73.498, 1, 81],
    ['2026-10-29T11:21:46Z', 8.782, 71.543, 0, 4],
    ['2026-10-29T14:41:36Z', 10.652, 70.858, 37, 424],
  ];
  const r = trackReasons(rows.map(([t, lon, lat, speed, course]) => ({ t: Date.parse(t), lon, lat, speed, course, shipType: 'Cargo' })));
  assert.equal(r.filter((x) => x.kind === 'values').length, 1);
  assert.match(r[0].text, /course of 424°/);
  assert.equal(r[0].at, '2026-10-29T14:41:36.000Z');
  assert.ok(r.some((x) => x.kind === 'jumps' && /^Jumped 18\d km in 75 min/.test(x.text)));
}

// Live tracker: both feeds, out of order, sampled, kept six hours, ships only
{
  const now = T0 + 3 * 3600e3;
  const mmsi = '677049600';
  for (const f of steady(3, 10, 10, now - 90 * min)) noteReport(mmsi, f, now);
  for (const f of steady(4, 10, 10, now - 50 * min, 18)) noteReport(mmsi, f, now);
  const r = spoofingReasons(mmsi, now);
  assert.equal(r.length, 1);
  assert.match(r[0].text, /kept reporting from the new place/);
  // The same fix from the other feed a few seconds later changes nothing
  noteReport(mmsi, { t: now - 50 * min + 5000, lon: 18, lat: 70 }, now);
  assert.equal(spoofingReasons(mmsi, now).length, 1);
  // A bad value counts while a feed still shows the report, however old, and six hours after
  noteReport(mmsi, { t: now - 5 * min, lon: 18.2, lat: 70, course: 424 }, now);
  assert.equal(spoofingReasons(mmsi, now).length, 2);
  noteReport(mmsi, { t: now - 5 * min, lon: 18.2, lat: 70, course: 424 }, now + 10 * 3600e3);
  assert.deepEqual(spoofingReasons(mmsi, now + 10 * 3600e3).map((r) => r.at), [new Date(now - 5 * min).toISOString()]);
  assert.equal(spoofingReasons(mmsi, now + 17 * 3600e3).length, 0);
  sweepSpoofing(now + 17 * 3600e3);
  assert.equal(spoofingReasons(mmsi, now + 17 * 3600e3).length, 0);
  // Net buoys and aircraft are left alone
  noteReport('586706003', { t: now, lon: 10, lat: 70, course: 424 }, now);
  noteReport('111257514', { t: now, lon: 10, lat: 70, speed: 140, shipType: 'Cargo' }, now);
  assert.deepEqual(spoofingReasons('586706003', now), []);
  assert.deepEqual(spoofingReasons('111257514', now), []);
}

console.log('aisSpoofing tests passed');
