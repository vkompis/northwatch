/**
 * Ships lingering over subsea infrastructure: slow (≤ 2 kn) within 500 m of a telecom cable,
 * a petroleum pipeline or a regional / transmission power cable for 30 minutes or more,
 * outside harbours. Checked every minute from the live AIS picture, so a ship is followed
 * whether or not anyone has the map open.
 *
 * NVE distribution-grid cables (short fjord crossings, thousands of them) are left out:
 * every ferry and fishing boat in a harbour would trip them.
 */
import fs from 'fs';
import path from 'path';

const BUFFER_M = 500;
const MAX_SPEED_KN = 2;
const MIN_DWELL_MS = 30 * 60 * 1000;
/** A ship that leaves the buffer for less than this keeps its dwell time */
const GRACE_MS = 10 * 60 * 1000;
const CELL_DEG = 0.1;

type Infra = { kind: 'telecom cable' | 'pipeline' | 'power cable'; name: string };
type Segment = { a: [number, number]; b: [number, number]; infra: Infra };

export type InfraDwell = {
  mmsi: string;
  infra: Infra;
  since: number;
  lastSeen: number;
  lon: number;
  lat: number;
  distanceM: number;
};

let grid: Map<string, Segment[]> | null = null;
const dwell = new Map<string, InfraDwell>();

const cellKey = (lon: number, lat: number) => `${Math.floor(lon / CELL_DEG)}:${Math.floor(lat / CELL_DEG)}`;

function lines(geometry: any): [number, number][][] {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function readFeatures(file: string): any[] {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).features || [];
  } catch {
    return [];
  }
}

/** Segments bucketed by the grid cells their bounding box (plus the buffer) touches. */
function buildGrid(overlaysDir: string): Map<string, Segment[]> {
  const g = new Map<string, Segment[]>();
  const pad = BUFFER_M / 111_000 + 0.01;
  const add = (seg: Segment) => {
    const [x1, y1] = seg.a;
    const [x2, y2] = seg.b;
    const lonPad = pad / Math.max(0.2, Math.cos((((y1 + y2) / 2) * Math.PI) / 180));
    for (let cx = Math.floor((Math.min(x1, x2) - lonPad) / CELL_DEG); cx <= Math.floor((Math.max(x1, x2) + lonPad) / CELL_DEG); cx++) {
      for (let cy = Math.floor((Math.min(y1, y2) - pad) / CELL_DEG); cy <= Math.floor((Math.max(y1, y2) + pad) / CELL_DEG); cy++) {
        const k = `${cx}:${cy}`;
        if (!g.has(k)) g.set(k, []);
        g.get(k)!.push(seg);
      }
    }
  };
  const sources: { file: string; infra: (p: any) => Infra | null }[] = [
    {
      file: 'cables-all.geojson',
      infra: (p) => ({ kind: 'telecom cable', name: p.name || p.kabeltype || 'Subsea cable' }),
    },
    {
      file: 'cables-telegeography-norway.geojson',
      infra: (p) => ({ kind: 'telecom cable', name: p.name || 'Subsea cable' }),
    },
    {
      file: 'pipelines.geojson',
      infra: (p) => ({ kind: 'pipeline', name: p.mapLabel || p.name || 'Pipeline' }),
    },
    {
      file: 'power-cables-nve.geojson',
      infra: (p) =>
        p.netLevel === 'Transmission grid' || p.netLevel === 'Regional grid'
          ? { kind: 'power cable', name: p.name || (p.owner ? `${p.owner} (${p.netLevel.toLowerCase()})` : 'Power cable') }
          : null,
    },
  ];
  for (const { file, infra } of sources) {
    for (const f of readFeatures(path.join(overlaysDir, file))) {
      const meta = infra(f.properties || {});
      if (!meta) continue;
      for (const line of lines(f.geometry)) {
        for (let i = 1; i < line.length; i++) add({ a: line[i - 1], b: line[i], infra: meta });
      }
    }
  }
  return g;
}

/** Metres from a point to a segment, on a local flat projection (fine at these distances). */
function distanceM(lon: number, lat: number, seg: Segment): number {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_574;
  const ax = (seg.a[0] - lon) * kx;
  const ay = (seg.a[1] - lat) * ky;
  const bx = (seg.b[0] - lon) * kx;
  const by = (seg.b[1] - lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function nearestInfra(lon: number, lat: number): { infra: Infra; distanceM: number } | null {
  let best: { infra: Infra; distanceM: number } | null = null;
  for (const seg of grid?.get(cellKey(lon, lat)) || []) {
    const d = distanceM(lon, lat, seg);
    if (d <= BUFFER_M && (!best || d < best.distanceM)) best = { infra: seg.infra, distanceM: d };
  }
  return best;
}

/** Reload the infrastructure (after an overlay refresh) on the next check. */
export function resetInfraWatch() {
  grid = null;
}

/**
 * One check of the live picture. `atSea(v)` filters out stale fixes and ships in harbour.
 * Returns the ships that have lingered long enough, longest first.
 */
export function updateInfraWatch(overlaysDir: string, vessels: any[], atSea: (v: any) => boolean, now = Date.now()): InfraDwell[] {
  if (!grid) grid = buildGrid(overlaysDir);
  const seen = new Set<string>();
  for (const v of vessels) {
    const speed = Number(v.speed);
    if (!Number.isFinite(v.lon) || !Number.isFinite(v.lat) || !Number.isFinite(speed) || speed > MAX_SPEED_KN) continue;
    if (!atSea(v)) continue;
    const hit = nearestInfra(v.lon, v.lat);
    if (!hit) continue;
    const mmsi = String(v.mmsi);
    seen.add(mmsi);
    const prev = dwell.get(mmsi);
    dwell.set(mmsi, {
      mmsi,
      infra: hit.infra,
      since: prev ? prev.since : now,
      lastSeen: now,
      lon: v.lon,
      lat: v.lat,
      distanceM: Math.round(hit.distanceM),
    });
  }
  for (const [mmsi, d] of dwell) {
    if (!seen.has(mmsi) && now - d.lastSeen > GRACE_MS) dwell.delete(mmsi);
  }
  return [...dwell.values()]
    .filter((d) => d.lastSeen === now && now - d.since >= MIN_DWELL_MS)
    .sort((a, b) => a.since - b.since);
}

export function currentInfraDwell(now = Date.now()): InfraDwell[] {
  return [...dwell.values()]
    .filter((d) => now - d.lastSeen <= 2 * 60 * 1000 && now - d.since >= MIN_DWELL_MS)
    .sort((a, b) => a.since - b.since);
}

export const INFRA_WATCH_RULES = { bufferM: BUFFER_M, maxSpeedKn: MAX_SPEED_KN, minDwellMin: MIN_DWELL_MS / 60000 };
