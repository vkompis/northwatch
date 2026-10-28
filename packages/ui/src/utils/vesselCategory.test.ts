import assert from 'node:assert/strict';
import {
  HEADER_COLORS,
  headerTextColor,
  mmsiCategory,
  mmsiFlagCountry,
  countryInfoFromMmsi,
  navStatusLabel,
  isMilitaryShipType,
  isLikelyAisDevice,
} from './vesselCategory.ts';

/** Colors must match data/source/Mapmarkers SVG fills */
assert.equal(HEADER_COLORS.norway, '#ff4040');
assert.equal(HEADER_COLORS.russia, '#4dd0ff');
assert.equal(HEADER_COLORS.eu, '#2b2bcc');
assert.equal(HEADER_COLORS.china, '#f2c403');
assert.equal(HEADER_COLORS.military, '#2b6206');
assert.equal(HEADER_COLORS.research, '#d946ef');
assert.equal(HEADER_COLORS.rest, '#f7f7f7');

assert.equal(headerTextColor('rest'), '#111');
assert.equal(headerTextColor('norway'), '#fff');

assert.equal(mmsiCategory('259000001'), 'norway');
assert.equal(mmsiCategory('273000001'), 'russia');
assert.equal(mmsiCategory('211000001'), 'eu');
assert.equal(mmsiCategory('412000001'), 'china');
assert.equal(mmsiCategory('366000001'), 'rest');
assert.equal(mmsiCategory('259000001', 35), 'military');
assert.equal(mmsiFlagCountry('259000001'), 'norway');
assert.equal(mmsiCategory('259000001', 'Military ops'), 'military');
assert.equal(mmsiCategory('259000001', 55), 'military');
assert.equal(mmsiCategory('273546520'), 'research'); // Yantar
assert.equal(mmsiFlagCountry('273546520'), 'russia');
assert.equal(mmsiCategory('273359440', null, '9548536'), 'research'); // Tryoshnikov
assert.ok(isMilitaryShipType('Law enforcement'));

assert.equal(countryInfoFromMmsi('273123456').iso, 'ru');
assert.equal(countryInfoFromMmsi('257123456').name, 'Norway');

// Full MID table: EU registries that used to fall into "rest", and neighbours that were misfiled
assert.equal(mmsiFlagCountry('215000001'), 'eu'); // Malta
assert.equal(mmsiFlagCountry('209000001'), 'eu'); // Cyprus
assert.equal(mmsiFlagCountry('205000001'), 'eu'); // Belgium
assert.equal(mmsiFlagCountry('203000001'), 'eu'); // Austria
assert.equal(mmsiFlagCountry('201000001'), 'rest'); // Albania (was mapped to Austria)
assert.equal(mmsiFlagCountry('419000001'), 'rest'); // India (was "China")
assert.equal(mmsiFlagCountry('416000001'), 'rest'); // Taiwan
assert.equal(mmsiFlagCountry('477000001'), 'china'); // Hong Kong
assert.equal(countryInfoFromMmsi('636123456').name, 'Liberia');
assert.equal(countryInfoFromMmsi('620123456').iso, 'km'); // Comoros
assert.equal(countryInfoFromMmsi('999123456').iso, 'xx');

// Server-side military list colours the marker as military
assert.equal(mmsiCategory('257000001', 'Cargo', null, true), 'military');
assert.equal(mmsiCategory('257000001', 'Noncombatant ship'), 'military');

// Buoys, beacons and other non-ship transmitters
assert.ok(isLikelyAisDevice({ mmsi: '109080013', name: 'HORNGRUNN BOUY 5' }));
assert.ok(isLikelyAisDevice({ mmsi: '941500519', name: 'BREITIND' }));
assert.ok(isLikelyAisDevice({ mmsi: '586706003', name: 'PP' })); // unassigned MID
assert.ok(isLikelyAisDevice({ mmsi: '257123456', name: 'SARA KARIN BUOY 1' }));
assert.ok(!isLikelyAisDevice({ mmsi: '257123456', name: 'NORMAND SAPPHIRE' }));
assert.ok(!isLikelyAisDevice({ mmsi: '941500519', imo: '9318539', name: 'X' }));

assert.equal(navStatusLabel(0), 'Under way using engine');
assert.equal(navStatusLabel(7), 'Engaged in fishing');
assert.equal(navStatusLabel(null), 'Not available');
assert.equal(navStatusLabel(''), 'Not available');

console.log('vesselCategory.test.ts: ok');
