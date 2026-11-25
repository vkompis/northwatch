import assert from 'node:assert/strict';
import { digitrafficEta, digitrafficVessel } from './digitrafficClient';

// ETA packed as AIS bits: 770944 = 24 November 14:00 UTC
assert.equal(digitrafficEta(770944), '11241400');
assert.equal(digitrafficEta(0), null);
// Month 0 / hour 24 / minute 60 mean "not available"
assert.equal(digitrafficEta((11 << 16) | (24 << 11) | (24 << 6)), null);

// A location with its metadata, AIS "not available" values dropped
{
  const v = digitrafficVessel(
    {
      mmsi: 273127330,
      geometry: { type: 'Point', coordinates: [25.99, 59.84] },
      properties: { sog: 102.3, cog: 360, heading: 511, navStat: 1, timestampExternal: Date.parse('2026-11-25T22:36:04Z') },
    },
    { name: 'SPESSARTIN ', imo: 9332834, destination: 'FORORDER', shipType: 80, eta: 770944, referencePointA: 200, referencePointB: 44 }
  );
  assert.deepEqual(v, {
    mmsi: '273127330',
    lon: 25.99,
    lat: 59.84,
    speed: null,
    course: null,
    heading: null,
    status: 1,
    timestamp: '2026-11-25T22:36:04.000Z',
    vessel_name: 'SPESSARTIN',
    imo: '9332834',
    destination: 'FORORDER',
    shipTypeCode: 80,
    eta: '11241400',
    lengthM: 244,
  });
  // No metadata yet: position only
  const bare = digitrafficVessel({ mmsi: 1, geometry: { coordinates: [20, 60] }, properties: { timestampExternal: 0, sog: 5 } }, undefined)!;
  assert.equal(bare.vessel_name, null);
  assert.equal(bare.imo, null);
  assert.equal(bare.speed, 5);
  assert.equal(digitrafficVessel({ geometry: { coordinates: [] }, properties: {} }, undefined), null);
}

console.log('digitrafficClient.test.ts: ok');
