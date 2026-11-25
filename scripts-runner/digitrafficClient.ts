/**
 * Finnish AIS from Fintraffic's Digitraffic: open data with no key, covering the
 * Gulf of Finland (Russian ports included), the Gulf of Bothnia and the northern
 * Baltic. The live list runs these ships through the same display rules as the
 * other feeds, so outside Norway only Russian, research, listed and military
 * ships show.
 *
 * Source: Fintraffic / digitraffic.fi, license CC 4.0 BY
 * https://www.digitraffic.fi/en/marine-traffic/
 */
import axios from 'axios';

const BASE = 'https://meri.digitraffic.fi/api/ais/v1';
/** Digitraffic asks every client to name itself and to accept gzip */
const HEADERS = { 'Digitraffic-User': 'NorthWatch', 'Accept-Encoding': 'gzip' };
/** Digitraffic caches responses for a minute, so asking more often gains nothing */
export const DIGITRAFFIC_REFRESH_MS = 60_000;
const METADATA_REFRESH_MS = 15 * 60_000;
/** Same as AISStream: a ship not heard for this long is no longer drawn */
const MAX_AGE_MS = 45 * 60_000;

export type DigitrafficVessel = {
  mmsi: string;
  lon: number;
  lat: number;
  speed: number | null;
  course: number | null;
  heading: number | null;
  status: number | null;
  timestamp: string;
  vessel_name: string | null;
  imo: string | null;
  destination: string | null;
  shipTypeCode: number | null;
  eta: string | null;
  lengthM: number | null;
};

let locations: { list: any[]; fetchedAt: number } | null = null;
let metadata: { byMmsi: Map<string, any>; fetchedAt: number } | null = null;
let lastError: string | null = null;
let inflight: Promise<void> | null = null;

const finite = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

/** AIS "not available" values: speed 102.3, course 360, heading 511 */
const orNull = (v: unknown, notAvailable: number) => {
  const n = finite(v);
  return n == null || n >= notAvailable ? null : n;
};

/**
 * Digitraffic packs the ETA as AIS bits (month << 16 | day << 11 | hour << 6 | minute);
 * the other feeds give MMDDHHmm, which the live list formats.
 */
export function digitrafficEta(eta: unknown): string | null {
  const n = finite(eta);
  if (!n) return null;
  const month = (n >> 16) & 0xf;
  const day = (n >> 11) & 0x1f;
  const hour = (n >> 6) & 0x1f;
  const minute = n & 0x3f;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  return [month, day, hour, minute].map((x) => String(x).padStart(2, '0')).join('');
}

export function digitrafficVessel(location: any, meta: any): DigitrafficVessel | null {
  const [lon, lat] = location?.geometry?.coordinates || [];
  const p = location?.properties || {};
  const t = finite(p.timestampExternal);
  if (finite(lon) == null || finite(lat) == null || t == null) return null;
  const imo = finite(meta?.imo);
  const length = (finite(meta?.referencePointA) ?? 0) + (finite(meta?.referencePointB) ?? 0);
  return {
    mmsi: String(location.mmsi ?? p.mmsi ?? ''),
    lon: Number(lon),
    lat: Number(lat),
    speed: orNull(p.sog, 102.3),
    course: orNull(p.cog, 360),
    heading: orNull(p.heading, 511),
    status: finite(p.navStat),
    timestamp: new Date(t).toISOString(),
    vessel_name: typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : null,
    imo: imo ? String(imo) : null,
    destination: typeof meta?.destination === 'string' && meta.destination.trim() ? meta.destination.trim() : null,
    shipTypeCode: finite(meta?.shipType),
    eta: digitrafficEta(meta?.eta),
    lengthM: length > 0 ? length : null,
  };
}

async function get(pathAndQuery: string): Promise<any> {
  const r = await axios.get(`${BASE}${pathAndQuery}`, { headers: HEADERS, timeout: 20_000 });
  return r.data;
}

/** Fetches the latest positions, and the names and types every 15 minutes */
export function refreshDigitraffic(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const now = Date.now();
      const [loc, ves] = await Promise.all([
        get(`/locations?from=${now - MAX_AGE_MS}`),
        !metadata || now - metadata.fetchedAt > METADATA_REFRESH_MS ? get('/vessels') : null,
      ]);
      if (Array.isArray(ves)) {
        metadata = { byMmsi: new Map(ves.map((v: any) => [String(v.mmsi), v])), fetchedAt: now };
      }
      locations = { list: Array.isArray(loc?.features) ? loc.features : [], fetchedAt: now };
      lastError = null;
    } catch (e: any) {
      lastError = e?.response?.status ? `HTTP ${e.response.status}` : e?.message || String(e);
      console.warn('[digitraffic] fetch failed', lastError);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Ships heard in the last 45 minutes */
export function getDigitrafficVessels(): DigitrafficVessel[] {
  if (!locations) return [];
  const since = Date.now() - MAX_AGE_MS;
  const out: DigitrafficVessel[] = [];
  for (const f of locations.list) {
    const v = digitrafficVessel(f, metadata?.byMmsi.get(String(f?.mmsi)));
    if (v && Date.parse(v.timestamp) >= since) out.push(v);
  }
  return out;
}

export function getDigitrafficStatus() {
  return {
    vessels: locations?.list.length ?? 0,
    withNames: metadata?.byMmsi.size ?? 0,
    fetchedAt: locations ? new Date(locations.fetchedAt).toISOString() : null,
    error: lastError,
  };
}
