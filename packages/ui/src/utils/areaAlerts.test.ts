import assert from 'node:assert/strict';
import { createAlertRule, evaluateAlertRule, normalizeRule } from './areaAlerts.ts';

// Area = everything east of 10°E
const inArea = (lon: number) => lon > 10;
const t0 = Date.parse('2026-10-28T12:00:00Z');
const at = (min: number) => t0 + min * 60_000;

function rule(input: Partial<Parameters<typeof createAlertRule>[0]> = {}) {
  return {
    ...createAlertRule({ mmsis: [], areaId: 'eez-svalbard', dwellMinutes: 0, watchHours: 24, ...input }),
    createdAt: new Date(t0).toISOString(),
  };
}

// "Any ship": vessels already inside at the first check are baseline, not alerts
{
  let r = rule();
  let res = evaluateAlertRule(r, [{ mmsi: '257000001', lon: 15, lat: 70 }], inArea, at(0));
  assert.equal(res.hits.length, 0);
  assert.deepEqual(res.rule.baseline, ['257000001']);
  assert.equal(res.rule.primed, true);
  r = res.rule;

  // A newcomer alerts; the watch keeps running for the next one
  res = evaluateAlertRule(
    r,
    [
      { mmsi: '257000001', lon: 15, lat: 70 },
      { mmsi: '273000002', lon: 12, lat: 70, vessel_name: 'YANTAR' },
    ],
    inArea,
    at(1)
  );
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].message, 'YANTAR entered Svalbard FPZ');
  assert.equal(res.rule.status, 'watching');
  r = res.rule;

  res = evaluateAlertRule(
    r,
    [
      { mmsi: '257000001', lon: 15, lat: 70 },
      { mmsi: '273000002', lon: 12, lat: 70 },
      { mmsi: '273000003', lon: 12, lat: 70 },
    ],
    inArea,
    at(2)
  );
  assert.deepEqual(res.hits.map((h) => h.mmsi), ['273000003']);
  assert.equal(res.rule.hits.length, 2);
  assert.equal(res.rule.hits[0].mmsi, '273000003'); // newest first
  r = res.rule;

  // Baseline vessel leaves and comes back → now it alerts
  res = evaluateAlertRule(r, [{ mmsi: '257000001', lon: 5, lat: 70 }], inArea, at(3));
  assert.equal(res.rule.baseline.length, 0);
  res = evaluateAlertRule(res.rule, [{ mmsi: '257000001', lon: 15, lat: 70 }], inArea, at(4));
  assert.deepEqual(res.hits.map((h) => h.mmsi), ['257000001']);
}

// Specific ship already inside at the start alerts right away ("is inside")
{
  const res = evaluateAlertRule(
    rule({ mmsis: ['273546520'], vesselNames: { '273546520': 'Yantar' } }),
    [{ mmsi: '273546520', lon: 20, lat: 75 }],
    inArea,
    at(0)
  );
  assert.equal(res.hits.length, 1);
  assert.match(res.hits[0].message, /is inside/);
}

// Dwell time
{
  let r = rule({ mmsis: ['273000009'], dwellMinutes: 30 });
  r = evaluateAlertRule(r, [], inArea, at(0)).rule;
  let res = evaluateAlertRule(r, [{ mmsi: '273000009', lon: 20, lat: 75 }], inArea, at(1));
  assert.equal(res.hits.length, 0);
  res = evaluateAlertRule(res.rule, [{ mmsi: '273000009', lon: 20, lat: 75 }], inArea, at(40));
  assert.equal(res.hits.length, 1);
}

// Expiry
{
  const res = evaluateAlertRule(rule({ watchHours: 1 }), [], inArea, at(61));
  assert.equal(res.rule.status, 'expired');
}

// Legacy "triggered" rules resume watching without re-alerting old ships
{
  const legacy = normalizeRule({
    ...rule({ mmsis: ['273000001'] }),
    status: 'triggered',
    notified: ['273000001'],
    primed: undefined,
  });
  assert.equal(legacy.status, 'watching');
  assert.equal(legacy.primed, true);
  const res = evaluateAlertRule(legacy, [{ mmsi: '273000001', lon: 20, lat: 70 }], inArea, at(1));
  assert.equal(res.hits.length, 0);
}

console.log('areaAlerts.test.ts: ok');
