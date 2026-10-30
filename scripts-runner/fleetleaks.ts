/**
 * FleetLeaks (https://fleetleaks.com) — an independent tracker of sanctioned tankers and
 * shadow-fleet ships, with who sanctioned each one (US, EU, UK, Canada, Australia, NZ).
 * Used to corroborate our own list matches, not to flag ships on the map.
 *
 * Read weekly through its public WordPress REST API, 100 ships a page, with the 30 s
 * crawl delay its robots.txt asks for between requests (~6 minutes for ~1000 ships).
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { dataSource } from './paths';

const DATA_DIR = process.env.DATA_DIR || dataSource();
export const FLEETLEAKS_FILE = path.join(DATA_DIR, 'fleetleaks-vessels.json');
const API = 'https://fleetleaks.com/wp-json/wp/v2';
const CRAWL_DELAY_MS = 31_000;
const HEADERS = { 'User-Agent': 'NorthWatch research map (weekly sync, 30 s crawl delay)' };

export type FleetleaksVessel = {
  imo: string;
  mmsi: string | null;
  name: string;
  flag: string | null;
  type: string | null;
  sanctioners: string[];
  url: string;
};

type FleetleaksFile = { fetchedAt: string; vessels: FleetleaksVessel[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, params: Record<string, string | number>) {
  return axios.get(url, { params, headers: HEADERS, timeout: 60_000 });
}

const decode = (s: string) =>
  s.replace(/&#8211;/g, '–').replace(/&#8217;/g, '’').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").trim();

export function readFleetleaks(): FleetleaksFile | null {
  try {
    return JSON.parse(fs.readFileSync(FLEETLEAKS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function fleetleaksAgeMs(): number | null {
  const t = Date.parse(readFleetleaks()?.fetchedAt || '');
  return Number.isFinite(t) ? Date.now() - t : null;
}

/** Re-read every ship; a read that comes back much shorter than last time keeps the old file. */
export async function updateFleetleaks(): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    const terms = await get(`${API}/sanctioner`, { per_page: 100, _fields: 'id,name' });
    const sanctioner = new Map<number, string>((terms.data || []).map((t: any) => [Number(t.id), String(t.name)]));
    const vessels: FleetleaksVessel[] = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      await sleep(CRAWL_DELAY_MS);
      const r = await get(`${API}/vessel`, {
        per_page: 100,
        page,
        _fields: 'link,title,meta.imo,meta.mmsi,meta.flag,meta.vessel_type,sanctioner',
      });
      pages = Number(r.headers['x-wp-totalpages'] || 1);
      for (const v of r.data || []) {
        const imo = String(v?.meta?.imo || '').match(/\d{7}/)?.[0];
        if (!imo) continue;
        vessels.push({
          imo,
          mmsi: String(v.meta?.mmsi || '').match(/\d{9}/)?.[0] || null,
          name: decode(String(v.title?.rendered || '')),
          flag: v.meta?.flag || null,
          type: v.meta?.vessel_type || null,
          sanctioners: (v.sanctioner || []).map((id: number) => sanctioner.get(Number(id))).filter(Boolean),
          url: String(v.link || `https://fleetleaks.com/vessels/imo-${imo}/`),
        });
      }
    }
    const previous = readFleetleaks()?.vessels.length || 0;
    if (previous && vessels.length < previous * 0.6) {
      throw new Error(`only ${vessels.length} ships read (had ${previous}); keeping the previous file`);
    }
    fs.writeFileSync(FLEETLEAKS_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), vessels } satisfies FleetleaksFile));
    console.log(`[fleetleaks] updated ships=${vessels.length}`);
    return { ok: true, count: vessels.length };
  } catch (e: any) {
    const error = e?.message || String(e);
    console.warn('[fleetleaks] update failed', error);
    return { ok: false, error };
  }
}
