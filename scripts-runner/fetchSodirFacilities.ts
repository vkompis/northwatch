/**
 * Fetch Sodir FactMaps "Facilities, in place" (surface) as GeoJSON.
 * Source: https://factmaps.sodir.no — synced daily with Sodir databases.
 */
import fs from 'fs';
import path from 'path';

const SODIR_BASE =
  'https://factmaps.sodir.no/api/rest/services/Factmaps/FactMapsWGS84/MapServer/304/query';
const PAGE_SIZE = 1000;
/** Surface fixed facilities — moveable units usually have no map coordinates in FactMaps. */
const WHERE = "fclSurface='Y' AND fclFixedOrMoveable='FIXED'";
const OUT_FIELDS = [
  'OBJECTID',
  'fclNpdidFacility',
  'fclName',
  'fclKind',
  'fclPhase',
  'fclFixedOrMoveable',
  'fclCurrentOperatorName',
  'fclBelongsToName',
  'fclFunctions',
  'fclStatus',
  'fclWaterDepth',
  'fclDateUpdated',
  'fclFactPageUrl',
  'fclSurface',
].join(',');

export type SodirFetchResult = {
  ok: boolean;
  featureCount?: number;
  path?: string;
  error?: string;
  meta?: Record<string, unknown>;
};

function epochToIso(v: unknown): string | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/** Sodir attribute record → the facility properties the map's rig card reads. */
function mapProps(p: any): Record<string, unknown> | null {
  const id = p.fclNpdidFacility != null ? String(p.fclNpdidFacility) : null;
  const name = p.fclName ? String(p.fclName).trim() : null;
  if (!name && !id) return null;
  return {
    id: id || name,
    name: name || `Facility ${id}`,
    kind: p.fclKind ? String(p.fclKind).trim() : null,
    phase: p.fclPhase ? String(p.fclPhase) : null,
    fixedOrMoveable: p.fclFixedOrMoveable ? String(p.fclFixedOrMoveable) : null,
    operator: p.fclCurrentOperatorName ? String(p.fclCurrentOperatorName) : null,
    belongsTo: p.fclBelongsToName ? String(p.fclBelongsToName) : null,
    functions: p.fclFunctions ? String(p.fclFunctions) : null,
    status: p.fclStatus ? String(p.fclStatus) : null,
    waterDepthM:
      p.fclWaterDepth != null && p.fclWaterDepth !== '' ? Number(p.fclWaterDepth) : null,
    updated: epochToIso(p.fclDateUpdated),
    factPageUrl: p.fclFactPageUrl ? String(p.fclFactPageUrl) : null,
    surface: p.fclSurface ? String(p.fclSurface) : 'Y',
    source: 'sodir-factmaps',
  };
}

function mapFeature(f: any): any | null {
  const geom = f?.geometry;
  const p = f?.properties || f?.attributes || {};
  let coordinates: number[] | null = null;
  if (geom?.type === 'Point' && Array.isArray(geom.coordinates)) {
    coordinates = geom.coordinates;
  } else if (
    geom &&
    Number.isFinite(Number(geom.x)) &&
    Number.isFinite(Number(geom.y))
  ) {
    coordinates = [Number(geom.x), Number(geom.y)];
  }
  if (!coordinates || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) {
    return null;
  }
  const properties = mapProps(p);
  if (!properties) return null;
  return { type: 'Feature', geometry: { type: 'Point', coordinates }, properties };
}

async function fetchPage(
  offset: number,
  where = WHERE,
  returnGeometry = true
): Promise<{
  features: any[];
  exceeded?: boolean;
}> {
  const q = new URLSearchParams({
    where,
    outFields: OUT_FIELDS,
    returnGeometry: String(returnGeometry),
    outSR: '4326',
    orderByFields: 'OBJECTID',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'json',
  });
  const url = `${SODIR_BASE}?${q.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Sodir HTTP ${res.status}`);
  }
  const data = (await res.json()) as any;
  if (data?.error) {
    throw new Error(data.error?.message || JSON.stringify(data.error));
  }
  const raw = Array.isArray(data?.features) ? data.features : [];
  return {
    features: raw,
    exceeded: Boolean(data?.exceededTransferLimit),
  };
}

export async function fetchSodirFacilitiesToFile(
  outDir: string
): Promise<SodirFetchResult> {
  try {
    const all: any[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const { features, exceeded } = await fetchPage(offset);
      console.log(`[sodir] page=${page} offset=${offset} got=${features.length}`);
      all.push(...features);
      if (features.length === 0) break;
      offset += features.length;
      if (!exceeded) break;
    }
    const mapped = all.map(mapFeature).filter(Boolean) as any[];
    if (mapped.length < all.length) {
      console.warn(
        `[sodir] dropped ${all.length - mapped.length} features without usable geometry`
      );
    }
    const fc = {
      type: 'FeatureCollection',
      features: mapped,
    };
    fs.mkdirSync(outDir, { recursive: true });
    const geoPath = path.join(outDir, 'petroleum.geojson');
    const metaPath = path.join(outDir, 'petroleum.meta.json');
    const tmp = `${geoPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(fc));
    fs.renameSync(tmp, geoPath);
    const meta = {
      source: 'sodir-factmaps',
      layer: 'FactMapsWGS84/304 Facilities, in place (surface)',
      where: WHERE,
      url: SODIR_BASE,
      generated_at: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      feature_count: mapped.length,
      note:
        'Sodir FactMaps surface FIXED facilities in place (daily sync). Moveable units are omitted — FactMaps has no coordinates for them.',
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return { ok: true, featureCount: mapped.length, path: geoPath, meta };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Moveable surface units (drilling rigs, flotels, intervention vessels). FactMaps has no
 * coordinates for them, so this is a register only — the API places them by AIS name.
 */
const MOVEABLE_WHERE = "fclSurface='Y' AND fclFixedOrMoveable='MOVEABLE'";
export const MOVEABLE_FILE = 'petroleum-moveable.json';

export async function fetchSodirMoveableToFile(outDir: string): Promise<SodirFetchResult> {
  try {
    const all: any[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const { features, exceeded } = await fetchPage(offset, MOVEABLE_WHERE, false);
      all.push(...features);
      if (features.length === 0 || !exceeded) break;
      offset += features.length;
    }
    const units = all.map((f) => mapProps(f?.attributes || {})).filter(Boolean);
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, MOVEABLE_FILE);
    const meta = {
      source: 'sodir-factmaps',
      layer: 'FactMapsWGS84/304 Facilities, in place (surface)',
      where: MOVEABLE_WHERE,
      generated_at: new Date().toISOString(),
      unit_count: units.length,
    };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ meta, units }));
    fs.renameSync(`${file}.tmp`, file);
    return { ok: true, featureCount: units.length, path: file, meta };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

if (require.main === module) {
  const out =
    process.argv[2] ||
    path.join(__dirname, '..', 'data', 'source', 'overlays');
  fetchSodirFacilitiesToFile(out).then((r) => {
    if (!r.ok) {
      console.error('[sodir]', r.error);
      process.exit(1);
    }
    console.log(`[sodir] wrote ${r.featureCount} facilities → ${r.path}`);
  });
}
