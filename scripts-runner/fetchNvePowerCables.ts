/**
 * NVE "Nettanlegg" – high-voltage power cables in the sea (layer 3, "Sjokabler"):
 * transmission, regional and high-voltage distribution grid, 1 kV and up, with owner.
 * Open data (NLOD); NVE refreshes the dataset about every six months.
 * https://kart.nve.no/enterprise/rest/services/Nettanlegg4/MapServer/3
 */
import fs from 'fs';
import path from 'path';

const NVE_LAYER = 'https://kart.nve.no/enterprise/rest/services/Nettanlegg4/MapServer/3/query';
const PAGE_SIZE = 2000;
export const POWER_CABLES_FILE = 'power-cables-nve.geojson';
const META_FILE = 'power-cables-nve.meta.json';

/** NVE net levels: 1 transmission, 2 regional, 3 distribution */
const NET_LEVEL: Record<string, string> = {
  '1': 'Transmission grid',
  '2': 'Regional grid',
  '3': 'Distribution grid',
};

export type PowerCableFetchResult = { ok: boolean; featureCount?: number; error?: string };

async function fetchPage(offset: number): Promise<any[]> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'objectid,eier,nvenettnivaa,spenning_kv,driftsattaar,navn',
    outSR: '4326',
    // ~5 m: plenty for a map, and keeps the file small
    maxAllowableOffset: '0.00005',
    geometryPrecision: '5',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    orderByFields: 'objectid',
    f: 'geojson',
  });
  const res = await fetch(`${NVE_LAYER}?${params}`, {
    headers: { 'User-Agent': 'NorthWatch map (power cable sync, weekly)' },
  });
  if (!res.ok) throw new Error(`NVE sea cables: HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(`NVE sea cables: ${data.error.message || 'query failed'}`);
  return Array.isArray(data?.features) ? data.features : [];
}

export function readPowerCablesMeta(dir: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Fetch every page and replace the overlay file; a short read keeps the previous file. */
export async function fetchNvePowerCablesToFile(dir: string): Promise<PowerCableFetchResult> {
  try {
    const raw: any[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await fetchPage(offset);
      raw.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    const features = raw
      .filter((f) => f?.geometry)
      .map((f) => {
        const p = f.properties || {};
        const level = String(p.nvenettnivaa ?? '');
        return {
          type: 'Feature',
          geometry: f.geometry,
          properties: {
            id: `nve-${p.objectid}`,
            name: p.navn || null,
            owner: p.eier || null,
            netLevel: NET_LEVEL[level] || null,
            voltageKv: p.spenning_kv != null && p.spenning_kv !== '' ? Number(p.spenning_kv) : null,
            year: p.driftsattaar != null && p.driftsattaar !== '' ? Number(p.driftsattaar) : null,
            source: 'NVE Nettanlegg (NLOD)',
          },
        };
      });
    const previous = readPowerCablesMeta(dir)?.featureCount || 0;
    if (previous && features.length < previous * 0.6) {
      throw new Error(`only ${features.length} cables read (had ${previous}); keeping the previous file`);
    }
    fs.writeFileSync(path.join(dir, POWER_CABLES_FILE), JSON.stringify({ type: 'FeatureCollection', features }));
    fs.writeFileSync(
      path.join(dir, META_FILE),
      JSON.stringify({ fetchedAt: new Date().toISOString(), featureCount: features.length, source: NVE_LAYER }, null, 2)
    );
    return { ok: true, featureCount: features.length };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
