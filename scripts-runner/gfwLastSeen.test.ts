import assert from 'node:assert/strict';
import { identitiesForMmsi, latestDatedPosition, recentEnoughForMap } from './gfwLastSeen';

const MMSI = '273546520';

// Only recent positions are drawn on the map
{
  const now = Date.parse('2026-10-30T00:00:00Z');
  assert.equal(recentEnoughForMap('2026-10-26T21:59:00Z', now), true);
  assert.equal(recentEnoughForMap('2026-08-02T00:00:00Z', now), true);
  assert.equal(recentEnoughForMap('2026-07-31T00:00:00Z', now), false);
  assert.equal(recentEnoughForMap('2025-01-16T16:59:42Z', now), false);
  assert.equal(recentEnoughForMap('not a date', now), false);
}

// Yantar has three named ids over the years; the newest message date is kept
{
  const got = identitiesForMmsi(
    [
      { selfReportedInfo: [{ id: 'a', ssvid: MMSI, shipname: 'YANTAR`', transmissionDateTo: '2015-08-15T11:04:46Z' }] },
      { selfReportedInfo: [{ id: 'b', ssvid: MMSI, shipname: "YANTAR'", transmissionDateTo: '2025-11-02T13:10:38Z' }] },
      { selfReportedInfo: [{ id: 'c', ssvid: MMSI, shipname: "YANTAR'", transmissionDateTo: '2020-08-24T11:36:22Z' }] },
    ],
    MMSI
  );
  assert.deepEqual(got.ids, ['a', 'b', 'c']);
  assert.equal(got.lastTransmission, '2025-11-02T13:10:38.000Z');
}

// Stray nameless ids on the same MMSI, and other ships the search also returned, are left out
{
  const got = identitiesForMmsi(
    [
      { selfReportedInfo: [{ id: 'ship', ssvid: MMSI, shipname: 'YANTAR', transmissionDateTo: '2026-01-01T00:00:00Z' }] },
      { selfReportedInfo: [{ id: 'stray', ssvid: MMSI, shipname: null, transmissionDateTo: '2026-06-01T00:00:00Z' }] },
      { selfReportedInfo: [{ id: 'blank', ssvid: MMSI, shipname: '  ', transmissionDateTo: '2026-06-01T00:00:00Z' }] },
      { selfReportedInfo: [{ id: 'other', ssvid: '273445310', shipname: 'YANTAR', transmissionDateTo: '2026-10-27T00:00:00Z' }] },
    ],
    MMSI
  );
  assert.deepEqual(got.ids, ['ship']);
  assert.equal(got.lastTransmission, '2026-01-01T00:00:00.000Z');
}

// Nothing known
{
  assert.deepEqual(identitiesForMmsi([], MMSI), { ids: [], lastTransmission: null });
  assert.equal(latestDatedPosition([]), null);
}

// The newest event wins, dated by its end
{
  const r = latestDatedPosition([
    { type: 'port_visit', start: '2025-01-14T01:52:13Z', end: '2025-01-14T16:15:20Z', position: { lat: 36.8, lon: 3.1 }, port_visit: { endAnchorage: { name: 'ALGIERS' } } },
    { type: 'loitering', start: '2025-01-16T09:49:25Z', end: '2025-01-16T16:59:42Z', position: { lat: 36.4554, lon: -0.8877 } },
    { type: 'encounter', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z', position: { lat: 1, lon: 2 } },
  ]);
  assert.deepEqual(r, { kind: 'loitering', label: 'Loitering', time: '2025-01-16T16:59:42.000Z', lon: -0.8877, lat: 36.4554 });
}

// A port visit names its port; coordinates may come as strings
{
  const r = latestDatedPosition([
    { type: 'port_visit', start: '2026-10-16T00:56:37Z', end: '2026-10-16T05:16:33Z', position: { lat: '59.9077', lon: '30.2224' }, port_visit: { startAnchorage: { name: 'A' }, endAnchorage: { name: 'SAINT PETERSBURG' } } },
  ]);
  assert.equal(r?.label, 'Port visit, SAINT PETERSBURG');
  assert.equal(r?.lat, 59.9077);
  assert.equal(r?.time, '2026-10-16T05:16:33.000Z');
}

// A closed gap places the ship where AIS came back, not at the midpoint nobody saw
{
  const r = latestDatedPosition([
    { type: 'gap', start: '2022-09-09T08:30:06Z', end: '2022-10-02T22:08:21Z', position: { lat: 77.7, lon: 122.7 }, gap: { offPosition: { lat: 77.8, lon: 128.6 }, onPosition: { lat: 77.5, lon: 116.7 } } },
  ]);
  assert.equal(r?.kind, 'ais_back_on');
  assert.equal(r?.time, '2022-10-02T22:08:21.000Z');
  assert.equal(r?.lon, 116.7);
}

// A gap still open places it where AIS went off, when it went off
{
  const r = latestDatedPosition([
    { type: 'gap', start: '2026-10-01T08:00:00Z', end: null, position: { lat: 70, lon: 20 }, gap: { offPosition: { lat: 71, lon: 21 }, onPosition: null } },
  ]);
  assert.equal(r?.kind, 'ais_off');
  assert.equal(r?.time, '2026-10-01T08:00:00.000Z');
  assert.equal(r?.lat, 71);
}

// An open gap counts from when AIS went off, so an older event that ended later beats it
{
  const r = latestDatedPosition([
    { type: 'gap', start: '2026-10-01T00:00:00Z', end: null, gap: { offPosition: { lat: 71, lon: 21 } } },
    { type: 'loitering', start: '2026-09-30T00:00:00Z', end: '2026-10-02T00:00:00Z', position: { lat: 70, lon: 20 } },
  ]);
  assert.equal(r?.kind, 'loitering');
}

// Events with no usable place or date, or of a kind not asked for, are skipped
{
  assert.equal(latestDatedPosition([{ type: 'loitering', end: '2026-10-02T00:00:00Z', position: {} }]), null);
  assert.equal(latestDatedPosition([{ type: 'loitering', position: { lat: 1, lon: 2 } }]), null);
  assert.equal(latestDatedPosition([{ type: 'gap', gap: {} }]), null);
  assert.equal(latestDatedPosition([{ type: 'fishing', end: '2026-10-02T00:00:00Z', position: { lat: 1, lon: 2 } }]), null);
}

console.log('gfwLastSeen tests passed');
