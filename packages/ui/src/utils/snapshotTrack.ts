/**
 * Ship tracks in the static GitHub Pages copy. The copy has no API to ask
 * BarentsWatch per click, so each snapshot run saves the tracks of the flagged
 * ships (scripts-runner/writeSiteSnapshot.ts): the newest day from BarentsWatch
 * (Norwegian waters) and the ship's live position (any feed, e.g. Digitraffic in
 * the Baltic), added to the previous run's track and kept for up to 14 days.
 * The map reads them back in the shape /api/tracks24h answers with.
 */

/** [unix seconds, lon, lat, speed kn, course °] */
export type StoredFix = [number, number, number, number | null, number | null];

export type StoredTrack = {
  mmsi: string;
  intervalMin: number;
  /** When BarentsWatch last answered for this ship (ISO time) */
  updated: string;
  spoofing: { kind: string; text: string; at: string }[];
  points: StoredFix[];
};

export const STORED_TRACK_DAYS = 14;

const DAY_MS = 24 * 3600e3;
const num = (v: unknown) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v: number, digits: number) => Number(v.toFixed(digits));

/** Keeps the fixes of an /api/tracks24h answer */
export function storedFromApi(mmsi: string, data: any, now = Date.now()): StoredTrack {
  const features = Array.isArray(data?.points?.features) ? data.points.features : [];
  const points: StoredFix[] = [];
  for (const f of features) {
    const [lon, lat] = f?.geometry?.coordinates || [];
    const t = Date.parse(String(f?.properties?.time ?? ''));
    if (!Number.isFinite(t) || !Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) continue;
    const speed = num(f.properties.speed);
    const course = num(f.properties.course);
    points.push([
      Math.round(t / 1000),
      round(Number(lon), 5),
      round(Number(lat), 5),
      speed == null ? null : round(speed, 1),
      course == null ? null : round(course, 1),
    ]);
  }
  points.sort((a, b) => a[0] - b[0]);
  return {
    mmsi,
    intervalMin: num(data?.meta?.intervalMin) ?? 15,
    updated: new Date(now).toISOString(),
    spoofing: Array.isArray(data?.meta?.spoofing) ? data.meta.spoofing : [],
    points,
  };
}

/**
 * Both tracks' fixes in time order, cut to the last `keepDays` and thinned so
 * fixes are at least two thirds of the step apart (the same day fetched twice
 * comes back at other minutes). Spoofing lines keep the newest of each text.
 */
export function mergeStoredTracks(
  prev: StoredTrack | null,
  next: StoredTrack,
  now = Date.now(),
  keepDays = STORED_TRACK_DAYS
): StoredTrack {
  const cutoff = Math.floor((now - keepDays * DAY_MS) / 1000);
  const minGap = (next.intervalMin * 60 * 2) / 3;
  const points: StoredFix[] = [];
  for (const p of [...(prev?.points || []), ...next.points].sort((a, b) => a[0] - b[0])) {
    if (p[0] < cutoff) continue;
    if (points.length && p[0] - points[points.length - 1][0] < minGap) continue;
    points.push(p);
  }
  const spoofing = new Map<string, StoredTrack['spoofing'][number]>();
  for (const r of [...(prev?.spoofing || []), ...next.spoofing]) {
    if (Date.parse(r.at) < cutoff * 1000) continue;
    const had = spoofing.get(r.text);
    if (!had || Date.parse(had.at) < Date.parse(r.at)) spoofing.set(r.text, r);
  }
  return { ...next, spoofing: [...spoofing.values()], points };
}

/** The stored track as /api/tracks24h would answer for the last `days` */
export function apiFromStored(stored: StoredTrack, days: number, now = Date.now()) {
  const from = now - days * DAY_MS;
  const keep = stored.points.filter((p) => p[0] * 1000 >= from);
  return {
    line: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: keep.map((p) => [p[1], p[2]]) },
      properties: { mmsi: stored.mmsi, points: keep.length, days },
    },
    points: {
      type: 'FeatureCollection',
      features: keep.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p[1], p[2]] },
        properties: {
          mmsi: stored.mmsi,
          time: new Date(p[0] * 1000).toISOString(),
          speed: p[3],
          course: p[4],
        },
      })),
    },
    meta: {
      mmsi: stored.mmsi,
      days,
      returned: keep.length,
      intervalMin: stored.intervalMin,
      source: 'BarentsWatch Historic AIS and live positions, saved with this copy',
      updated: stored.updated,
      spoofing: (stored.spoofing || []).filter((r) => Date.parse(r.at) >= from),
    },
  };
}

/** The saved track of a ship in the static copy, or null when the copy has none for it */
export async function loadSnapshotTrack(apiBase: string, mmsi: string, days: number, signal?: AbortSignal) {
  const res = await fetch(`${apiBase}/api/tracks/${encodeURIComponent(mmsi)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Track HTTP ${res.status}`);
  return apiFromStored((await res.json()) as StoredTrack, days);
}
