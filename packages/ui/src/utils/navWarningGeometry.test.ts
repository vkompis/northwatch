import assert from 'node:assert/strict';
import { findWarningPositions, warningPartsFromText } from './navWarningGeometry.ts';

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

// Coastal 392/2026: area bounded by positions → one polygon, in the order given
{
  const parts = warningPartsFromText(`MILITARY DANGER AREA (MFO) ESTABLISHED DUE TO MILITARY ACTIVITIES FROM 251000 UTC OCT TO 301500 UTC OCT 2026.
AREA BOUNDED BY POSITIONS:
64-20.3N 011-15.8E
64-21.2N 011-16.4E
64-22.1N 011-19.3E
64-22.8N 011-20.4E
64-23.7N 011-20.2E
64-23.7N 011-19.0E
64-21.8N 011-14.7E
64-20.6N 011-14.6E

MARINERS ARE REQUESTED TO EXERCISE CAUTION AND COMPLY WITH INSTRUCTIONS FROM MILITARY AUTHORITIES.`);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].shape, 'area');
  assert.equal(parts[0].geometry.type, 'Polygon');
  const ring = (parts[0].geometry as any).coordinates[0];
  assert.equal(ring.length, 9);
  assert.ok(near(ring[0][0], 11.263333) && near(ring[0][1], 64.338333));
  assert.deepEqual(ring[0], ring[8]);
}

// Coastal 372/2026: moored positions stay points, the installation route is a line
{
  const parts = warningPartsFromText(`1. PIPELINE WORK IN PROGRESS 10OKT26 TO 15NOV26
MOORED IN FOLLOWING POSTIONES PENDING INSTALLATION

A. 69-42.92N 019-00.39E
B. 69-42.83N 018-59.36E
C. 69-42.33N 018-58.20E
D. 69-42.10N 018-57.50E
E. 69-41.88N 018-55.60E

INSTALLATION ROUTE
A. 69-43.92N 18-59.36E
B. 69-43.15N 19-00.52E
C. 69-43.01N 19-00.30E
D. 69-42.87N 19-00.47E

PARTS OF FAIRWAY MAY BE CLOSED UNDER FINAL INSTALLATION.`);
  assert.deepEqual(
    parts.map((p) => [p.shape, p.geometry.type]),
    [
      ['route', 'LineString'],
      ['points', 'MultiPoint'],
    ]
  );
  const route = (parts[0].geometry as any).coordinates;
  assert.equal(route.length, 4);
  assert.ok(near(route[0][0], 18.989333) && near(route[0][1], 69.732));
  assert.equal((parts[1].geometry as any).coordinates.length, 5);
}

// NAVAREA XIX 129/26 rig list: named positions, one per line → points
{
  const parts = warningPartsFromText(`1. Riglist. Correct at 220335 UTC Oct 26
Norwegian Sea: North of 65N, east of 5W.

72-32.46N 020-21.45E - Transocean Enabler
67-01.63N 005-18.17E - Transocean Norge
65-22.19N 007-21.33E - Transocean Encourage

Notes:
A. Rigs are protected by a 500 metre safety zone.`);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].shape, 'points');
  assert.equal((parts[0].geometry as any).coordinates.length, 3);
}

// Lettered lists of several positions are separate areas
{
  const parts = warningPartsFromText(`GUNNERY EXERCISES IN AREAS BOUNDED BY:
A. 70-00N 020-00E, 70-10N 020-30E, 70-05N 021-00E.
B. 71-00N 022-00E, 71-10N 022-30E, 71-05N 023-00E.`);
  assert.deepEqual(
    parts.map((p) => p.shape),
    ['area', 'area']
  );
  assert.deepEqual((parts[1].geometry as any).coordinates[0][0], [22, 71]);
}

// Same-line "bounded by", Russian NAVAREA style
{
  const parts = warningPartsFromText(
    'BARENTS SEA. ROCKET LAUNCHING 290800 TO 291600 UTC OCT NAVIGATION DANGEROUS IN AREA BOUNDED BY 70-07.0N 033-27.0E, 70-08.0N 033-37.0E, 70-03.0N 033-45.0E, 70-01.0N 033-30.0E.'
  );
  assert.equal(parts.length, 1);
  assert.equal(parts[0].shape, 'area');
  assert.equal((parts[0].geometry as any).coordinates[0].length, 5);
}

// Radius round a position → circle polygon of that radius
{
  const parts = warningPartsFromText('SEISMIC SURVEY WITHIN 2 NM RADIUS OF 70-30.0N 030-00.0E.');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].shape, 'circle');
  const ring = (parts[0].geometry as any).coordinates[0];
  // North point is 2 NM = 2/60° of latitude away
  assert.ok(near(ring[0][1] - 70.5, 2 / 60, 1e-3));
  assert.deepEqual(ring[0], ring[ring.length - 1]);
}

// Line between two positions
{
  const parts = warningPartsFromText('CABLE OPERATIONS ALONG LINE JOINING 69-40N 018-50E AND 69-45N 019-05E.');
  assert.equal(parts[0].shape, 'route');
  assert.deepEqual((parts[0].geometry as any).coordinates, [
    [18.833333, 69.666667],
    [19.083333, 69.75],
  ]);
}

// A single light is a point; DTGs and years are not positions
{
  const parts = warningPartsFromText('BÅEFLUA LIGHT 63-13.59N 007-52.16E IS DAMAGED.');
  assert.deepEqual(parts.map((p) => p.geometry.type), ['Point']);
  assert.equal(findWarningPositions('FROM 251000 UTC OCT TO 301500 UTC OCT 2026.').length, 0);
  assert.deepEqual(warningPartsFromText('The following NAVAREA XIX warnings are in effect: 114, 128.'), []);
}

// Other notations: compact, degree signs, decimal comma, west longitude
{
  assert.deepEqual(findWarningPositions('7012.5N 02001.0E')[0].lonlat, [20.016667, 70.208333]);
  assert.deepEqual(findWarningPositions("64°20.3'N 011°15.8'E")[0].lonlat, [11.263333, 64.338333]);
  assert.deepEqual(findWarningPositions('70 12,5N 020 01,0E')[0].lonlat, [20.016667, 70.208333]);
  assert.deepEqual(findWarningPositions('65-00N 005-00W')[0].lonlat, [-5, 65]);
}

console.log('navWarningGeometry.test.ts: ok');
