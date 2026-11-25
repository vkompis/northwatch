import assert from 'node:assert/strict';
import { apiFromStored, mergeStoredTracks, storedFromApi, type StoredTrack } from './snapshotTrack.ts';

const HOUR = 3600e3;
const now = Date.parse('2026-11-25T12:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
const answer = (hoursAgo: number[], spoofing: any[] = []) => ({
  points: {
    type: 'FeatureCollection',
    features: hoursAgo.map((h, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [30 + i * 0.1234567, 71] },
      properties: { time: at(h), speed: '12.14', course: i ? 130 : null },
    })),
  },
  meta: { intervalMin: 15, spoofing },
});

// An API answer is kept as compact fixes, oldest first
{
  const s = storedFromApi('273273930', answer([1, 3, 2]), now);
  assert.equal(s.points.length, 3);
  assert.deepEqual(
    s.points.map((p) => p[0]),
    [3, 2, 1].map((h) => (now - h * HOUR) / 1000)
  );
  assert.deepEqual(s.points[2], [(now - HOUR) / 1000, 30, 71, 12.1, null]);
  assert.equal(s.points[0][1], 30.12346);
}

// The new day replaces the overlap; anything older than 14 days drops off
{
  const prev = storedFromApi('1', answer([15 * 24, 10 * 24, 30, 20, 2]), now - HOUR);
  prev.spoofing = [
    { kind: 'values', text: 'old', at: at(20 * 24) },
    { kind: 'jumps', text: 'jump', at: at(30) },
  ];
  const next = storedFromApi('1', answer([23, 10, 0], [{ kind: 'jumps', text: 'jump', at: at(10) }]), now);
  const merged = mergeStoredTracks(prev, next, now);
  assert.deepEqual(
    merged.points.map((p) => (now - p[0] * 1000) / HOUR),
    [10 * 24, 30, 23, 10, 0]
  );
  assert.deepEqual(merged.spoofing, [{ kind: 'jumps', text: 'jump', at: at(10) }]);
  // A fetch with no positions keeps the history
  const empty = mergeStoredTracks(prev, storedFromApi('1', answer([]), now), now);
  assert.equal(empty.points.length, 4);
}

// Read back as /api/tracks24h for the chosen range
{
  const stored: StoredTrack = storedFromApi('9', answer([5 * 24, 30, 2]), now);
  stored.spoofing = [{ kind: 'values', text: 'x', at: at(30) }];
  const day = apiFromStored(stored, 1, now);
  assert.equal(day.points.features.length, 1);
  assert.equal(day.points.features[0].properties.time, at(2));
  assert.deepEqual(day.line.geometry.coordinates, [[30.24691, 71]]);
  assert.deepEqual(day.meta.spoofing, []);
  const week = apiFromStored(stored, 7, now);
  assert.equal(week.line.geometry.coordinates.length, 3);
  assert.equal(week.meta.spoofing.length, 1);
}

console.log('snapshotTrack.test.ts: ok');
