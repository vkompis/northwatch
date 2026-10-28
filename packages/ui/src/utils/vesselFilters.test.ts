import assert from 'node:assert/strict';
import {
  DEFAULT_VESSEL_FILTERS,
  vesselPassesFilter,
  vesselFiltersFromUrlTokens,
  mergeVesselFilters,
  vesselFiltersToUrlTokens,
  anyFilterActive,
} from './vesselFilters.ts';

const all = { ...DEFAULT_VESSEL_FILTERS };

assert.equal(
  vesselPassesFilter({ category: 'norway', flagCountry: 'norway' }, all),
  true
);
assert.equal(
  vesselPassesFilter(
    { category: 'norway', flagCountry: 'norway' },
    { ...all, norway: false }
  ),
  false
);
assert.equal(
  vesselPassesFilter(
    { category: 'eu', flagCountry: 'eu' },
    { ...all, norway: false }
  ),
  true
);

// Priority types ignore country toggles
assert.equal(
  vesselPassesFilter(
    { category: 'military', flagCountry: 'norway', military: 1 },
    { ...all, norway: false }
  ),
  true
);
assert.equal(
  vesselPassesFilter(
    { category: 'military', flagCountry: 'norway', military: 1 },
    { ...all, norway: false, military: false }
  ),
  false
);
assert.equal(
  vesselPassesFilter(
    { category: 'research', flagCountry: 'russia', research: 1 },
    { ...all, russia: false }
  ),
  true
);
assert.equal(
  vesselPassesFilter(
    { category: 'research', flagCountry: 'russia', research: 1 },
    { ...all, russia: true, research: false }
  ),
  false
);
assert.equal(
  vesselPassesFilter(
    { category: 'military', flagCountry: 'eu', military: 1 },
    { ...all, military: false }
  ),
  false
);

// Civilian still follows country even when types are on
assert.equal(
  vesselPassesFilter(
    { category: 'norway', flagCountry: 'norway' },
    { ...all, norway: false, military: true, research: true }
  ),
  false
);

assert.equal(
  vesselPassesFilter(
    { category: 'rest', flagCountry: 'rest', sanctioned: 1 },
    { ...all, sanctioned: true }
  ),
  true
);
assert.equal(
  vesselPassesFilter(
    { category: 'rest', flagCountry: 'rest', sanctioned: 0 },
    { ...all, sanctioned: true }
  ),
  false
);
// Focus still applies to military
assert.equal(
  vesselPassesFilter(
    {
      category: 'military',
      flagCountry: 'norway',
      military: 1,
      sanctioned: 0,
    },
    { ...all, norway: false, sanctioned: true }
  ),
  false
);
assert.equal(
  vesselPassesFilter(
    {
      category: 'military',
      flagCountry: 'norway',
      military: 1,
      sanctioned: 1,
    },
    { ...all, norway: false, sanctioned: true }
  ),
  true
);

// Ship type bucket (AND with country)
assert.equal(
  vesselPassesFilter(
    { category: 'norway', flagCountry: 'norway', shipClass: 'fishing' },
    { ...all, fishing: false }
  ),
  false
);
assert.equal(
  vesselPassesFilter(
    { category: 'norway', flagCountry: 'norway', shipType: 'Cargo' },
    { ...all, fishing: false }
  ),
  true
);
assert.equal(
  vesselPassesFilter(
    { category: 'norway', flagCountry: 'norway', shipType: 'Not available' },
    { ...all, unknown: false }
  ),
  false
);

// recent 6h
const now = Date.parse('2026-09-26T12:00:00Z');
assert.equal(
  vesselPassesFilter(
    {
      category: 'norway',
      flagCountry: 'norway',
      timestamp: '2026-09-26T10:00:00Z',
    },
    { ...all, recent6h: true },
    { nowMs: now }
  ),
  true
);
assert.equal(
  vesselPassesFilter(
    {
      category: 'norway',
      flagCountry: 'norway',
      timestamp: '2026-09-26T01:00:00Z',
    },
    { ...all, recent6h: true },
    { nowMs: now }
  ),
  false
);

// watchlist only
assert.equal(
  vesselPassesFilter(
    { category: 'norway', flagCountry: 'norway', mmsi: '257000001' },
    { ...all, watchlistOnly: true },
    { watchlistMmsis: new Set(['257000001']) }
  ),
  true
);
assert.equal(
  vesselPassesFilter(
    { category: 'norway', flagCountry: 'norway', mmsi: '257000002' },
    { ...all, watchlistOnly: true },
    { watchlistMmsis: new Set(['257000001']) }
  ),
  false
);

// Legacy exclusive URL token must not hide everyone
assert.deepEqual(vesselFiltersFromUrlTokens(['russian']), all);
assert.equal(vesselFiltersFromUrlTokens(['-norway']).norway, false);
assert.equal(vesselFiltersFromUrlTokens(['-norway']).russia, true);
assert.equal(vesselFiltersFromUrlTokens(['-fishing', 'age6']).fishing, false);
assert.equal(vesselFiltersFromUrlTokens(['-fishing', 'age6']).recent6h, true);

// Legacy prefs shape → defaults (show all)
assert.deepEqual(
  mergeVesselFilters({ russian: true, exclusive: true }),
  all
);

// Defaults: buoys / AIS devices hidden, everything else visible, nothing "active"
assert.equal(anyFilterActive(all), false);
assert.equal(
  vesselPassesFilter({ category: 'rest', flagCountry: 'rest', shipClass: 'device' }, all),
  false
);
assert.equal(
  vesselPassesFilter(
    { category: 'rest', flagCountry: 'rest', shipClass: 'device' },
    { ...all, device: true }
  ),
  true
);

// Ship type only applies to civilian categories
assert.equal(
  vesselPassesFilter(
    { category: 'research', research: 1, shipType: 'Not available' },
    { ...all, unknown: false }
  ),
  true
);
assert.equal(
  vesselPassesFilter(
    { category: 'military', military: 1, shipType: 'Other type' },
    { ...all, other: false }
  ),
  true
);

// Server military flag = military category even when the marker category is a flag
assert.equal(
  vesselPassesFilter(
    { category: 'norway', flagCountry: 'norway', military: 1 },
    { ...all, military: false }
  ),
  false
);

// Focus flags combine with OR
assert.equal(
  vesselPassesFilter(
    { category: 'norway', mmsi: '257000001', sanctioned: 0 },
    { ...all, sanctioned: true, watchlistOnly: true },
    { watchlistMmsis: ['257000001'] }
  ),
  true
);

// URL tokens round-trip, including default-off toggles
const custom = { ...all, norway: false, device: true, shadow: true, recent6h: true };
assert.deepEqual(vesselFiltersToUrlTokens(custom).sort(), ['-norway', 'age6', 'device', 'shadow']);
assert.deepEqual(vesselFiltersFromUrlTokens(vesselFiltersToUrlTokens(custom)), custom);
assert.deepEqual(vesselFiltersToUrlTokens(all), []);
assert.equal(vesselFiltersFromUrlTokens(['-militaryais']).military, false);

// v1 prefs: separate "Military / law" type toggle folds into the military category
assert.equal(mergeVesselFilters({ ...all, militaryAis: false }).military, false);
assert.equal(mergeVesselFilters({ norway: false }).device, false);
assert.equal('militaryAis' in mergeVesselFilters({ ...all, militaryAis: true }), false);

// Russian-flag focus ORs with sanctions / shadow ("vessels of interest")
const interest = { ...all, russianFlag: true, sanctioned: true, shadow: true };
assert.equal(vesselPassesFilter({ category: 'russia', mmsi: '273000001' }, interest), true);
assert.equal(vesselPassesFilter({ category: 'research', research: 1, mmsi: '273546520' }, interest), true);
assert.equal(vesselPassesFilter({ category: 'eu', mmsi: '215000001', shadowfleet: 1 }, interest), true);
assert.equal(vesselPassesFilter({ category: 'norway', mmsi: '257000001' }, interest), false);
assert.deepEqual(vesselFiltersFromUrlTokens(vesselFiltersToUrlTokens(interest)), interest);

console.log('vesselFilters.test.ts: ok');
