/**
 * GPS interference from GPSJam.org: aircraft broadcast how accurate their GPS is (ADS-B), and
 * GPSJam counts, per day and per H3 hexagon (resolution 4, ~40 km across), how many reported
 * good and bad accuracy. Low accuracy over an area usually means jamming or spoofing; in the
 * Baltic most of it is assumed to be Russian. This keeps the hexes in the watched area where
 * enough aircraft had bad GPS and joins neighbours of the same level into areas.
 *
 * Data: https://gpsjam.org/data/<date>-h3_4.csv, one file a day shortly after midnight UTC.
 * Credit GPSJam.org (https://gpsjam.org/faq/).
 */
import axios from 'axios';
import { cellsToMultiPolygon, cellToLatLng } from 'h3-js';
import { inWatchArea } from './aisstreamClient';

const BASE = 'https://gpsjam.org/data';
/** A new day appears shortly after midnight UTC; asking every few hours is plenty */
const REFRESH_MS = 3 * 3600e3;

export type InterferenceLevel = 'high' | 'medium';

/**
 * GPSJam's own share and colours: 100 × (bad − 1) / (good + bad), the −1 so one aircraft with
 * bad GPS in a quiet hex is not counted. Over 10 % is red (high), 2–10 % yellow (medium).
 */
export function interferenceLevel(good: number, bad: number): InterferenceLevel | null {
  const total = good + bad;
  if (!(total > 0)) return null;
  const pct = (100 * (bad - 1)) / total;
  if (pct > 10) return 'high';
  if (pct >= 2) return 'medium';
  return null;
}

/** The newest day in GPSJam's manifest not marked suspect */
export function latestDay(manifestCsv: string): string | null {
  const rows = manifestCsv
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.split(','))
    .filter(([date, suspect]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && suspect !== 'true');
  return rows.length ? rows[rows.length - 1][0] : null;
}

/** One area feature per level, from the day's hex file */
export function interferenceAreas(hexCsv: string, date: string) {
  const cells: Record<InterferenceLevel, string[]> = { high: [], medium: [] };
  for (const line of hexCsv.trim().split('\n').slice(1)) {
    const [hex, good, bad] = line.split(',');
    const level = interferenceLevel(Number(good), Number(bad));
    if (!level) continue;
    try {
      const [lat, lon] = cellToLatLng(hex);
      if (inWatchArea(lat, lon)) cells[level].push(hex);
    } catch {
      /* not a cell id */
    }
  }
  const features = (['medium', 'high'] as const)
    .filter((level) => cells[level].length)
    .map((level) => ({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: cellsToMultiPolygon(cells[level], true) },
      properties: { level, hexes: cells[level].length, date },
    }));
  return {
    type: 'FeatureCollection',
    features,
    meta: { date, source: 'GPSJam.org', high: cells.high.length, medium: cells.medium.length },
  };
}

let cache: { data: ReturnType<typeof interferenceAreas>; fetchedAt: number } | null = null;
let inflight: Promise<ReturnType<typeof interferenceAreas> | null> | null = null;

/** The latest day's areas, fetched at most every 3 hours; the last good copy if GPSJam fails */
export function getGpsInterference(): Promise<ReturnType<typeof interferenceAreas> | null> {
  if (cache && Date.now() - cache.fetchedAt < REFRESH_MS) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const get = async (file: string) =>
        (await axios.get(`${BASE}/${file}`, { timeout: 30_000, responseType: 'text' })).data as string;
      const date = latestDay(await get('manifest.csv'));
      if (!date) throw new Error('no day in the manifest');
      if (cache?.data.meta.date === date) {
        cache.fetchedAt = Date.now();
        return cache.data;
      }
      const data = interferenceAreas(await get(`${date}-h3_4.csv`), date);
      cache = { data, fetchedAt: Date.now() };
      console.log(`[gpsjam] ${date}: ${data.meta.high} high and ${data.meta.medium} medium hexes`);
      return data;
    } catch (e: any) {
      console.warn('[gpsjam] fetch failed', e?.message || String(e));
      return cache?.data ?? null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
