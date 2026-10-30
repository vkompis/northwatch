#!/usr/bin/env ts-node
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import axios from 'axios';
import https from 'https';
import * as turf from '@turf/turf';
import cron from 'node-cron';
import {
  updateEuDesignatedVessels,
  metaAgeMs,
  EU_DESIGNATED_META,
  readEuDesignatedCsv,
  readOpenSanctionsVesselIds,
  OPENSANCTIONS_VESSELS_CSV,
  DMA_PAGE_URL,
} from './sanctionsUpdater';
import {
  startAisStreamClient,
  getAisStreamVessels,
  getAisStreamStatus,
  vesselLengthMeters,
  NORTH_ATLANTIC_BBOX,
} from './aisstreamClient';
import { isRussianResearchVessel, RUSSIAN_RESEARCH_VESSELS } from './russianResearchVessels';
import { dataSource } from './paths';
import {
  deleteServerAlert,
  emailConfigured,
  listServerAlerts,
  loadServerAlerts,
  sendAlertEmail,
  upsertServerAlert,
} from './alertMail';
import { startAlertWatcher } from './alertWatcher';
import {
  fetchSodirFacilitiesToFile,
  fetchSodirMoveableToFile,
  MOVEABLE_FILE,
} from './fetchSodirFacilities';
import { fetchSodirPipelinesToFile } from './fetchSodirPipelines';
import { fetchNvePowerCablesToFile, readPowerCablesMeta } from './fetchNvePowerCables';
import { currentInfraDwell, INFRA_WATCH_RULES, resetInfraWatch, updateInfraWatch } from './infraWatch';
import {
  MAX_KN as DARK_MAX_KN,
  detectionDay,
  detectionLeadsForGap,
  gapLeadsForDetection,
  quietLeadsForDetection,
  sentinel1Url,
} from './darkVessels';
import { gurMetaAgeMs, updateGurVessels, GUR_VESSELS_META } from './gurVessels';
import { gurImoSets, sanctionListings } from './sanctionListings';
import { fleetleaksAgeMs, updateFleetleaks } from './fleetleaks';
import { noteReport, noteTrackReasons, spoofingReasons, sweepSpoofing, trackReasons } from './aisSpoofing';
import { warningPartsFromText } from '../packages/ui/src/utils/navWarningGeometry';

const RESEARCH_NAME_BY_MMSI = new Map(
  RUSSIAN_RESEARCH_VESSELS.map((v) => [v.mmsi, v.name] as const)
);

/** Prefer secure TLS; set TLS_INSECURE=1 only if a corporate proxy breaks verification. */
function httpsAgent() {
  return new https.Agent({ rejectUnauthorized: process.env.TLS_INSECURE !== '1' });
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
// The live ship list is ~1 MB of JSON; gzip cuts what every open map downloads
app.use(compression());

const API_KEY = (process.env.API_KEY || process.env.SVALMAP_API_KEY || '').trim();
app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : true,
}));
app.use(express.json());

// Optional API key (set API_KEY to enforce). Health endpoints stay open.
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.path === '/healthz' || req.path === '/api/health') return next();
  const key = String(req.header('x-api-key') || req.query.api_key || '');
  if (key && key === API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized — provide X-API-Key' });
});

const PORT = Number(process.env.PORT || 8787);
// Global Fishing Watch API (v3 gateway — see https://globalfishingwatch.org/our-apis/documentation/docs/v3)
const GFW_API_BASE =
  process.env.GFW_API_BASE || 'https://gateway.api.globalfishingwatch.org/v3';
const GFW_API_TOKEN = process.env.GFW_API_TOKEN || process.env.GFW_TOKEN || '';
function gfwClient() {
  return axios.create({
    baseURL: GFW_API_BASE,
    headers: GFW_API_TOKEN ? { Authorization: `Bearer ${GFW_API_TOKEN}` } : {},
    timeout: 120000,
    httpsAgent: httpsAgent(),
  });
}

// In-memory sanctioned MMSI cache
let SANCTIONED_MMSI: Set<string> = new Set();
let SANCTIONED_IMO: Set<string> = new Set();
let SANCTIONED_CACHE_TS = 0;
// In-memory shadow fleet MMSI cache
let SHADOWFLEET_MMSI: Set<string> = new Set();
let SHADOWFLEET_IMO: Set<string> = new Set();
/** Ships on any GUR list (shown on the map wherever they are) */
let GUR_LISTED_IMO: Set<string> = new Set();
/** Ships whose master is on GUR's list of sanctioned captains */
let SANCTIONED_MASTER_IMO: Set<string> = new Set();
let SHADOW_CACHE_TS = 0;
const SHADOW_TEST_SET: Set<string> = new Set(
  (process.env.SHADOW_TEST_MMSI || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// In-memory Norwegian military vessel MMSI cache
let MILITARY_MMSI: Set<string> = new Set();
let MILITARY_CACHE_TS = 0;

// In-memory IMO to MMSI mapping for EU sanctions
let IMO_TO_MMSI_MAP: Map<string, string> = new Map();
let IMO_MAP_CACHE_TS = 0;

const LOCAL_SANCTIONS_CSV = dataSource('Sanctionlist.CSV');
const LOCAL_EU_SANCTIONS_CSV = dataSource('eu-designated-vessels.csv');
const LOCAL_EU_SANCTIONS_CSV_LEGACY = dataSource('Sanction list EU.CSV');
const LOCAL_SHADOWFLEET_CSV = dataSource('shadowfleet2.csv');
const LOCAL_OPENSANCTIONS_VESSELS_CSV = OPENSANCTIONS_VESSELS_CSV;
const LOCAL_MILITARY_MMSI = dataSource('Norwegian-military-vessel-mmsi.txt');

function readMmsiCsv(filePath: string): Set<string> {
  const result = new Set<string>();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return result;
    const header = lines[0];
    const delim = header.includes(';') ? ';' : ',';
    const headers = header.split(delim).map(h => h.trim().toLowerCase());
    const mmsiIdx = headers.findIndex(h => h === 'mmsi' || h === 'mmsi number' || h === 'mmsinumber' || h === 'mmsi_no');
    for (let i = (mmsiIdx >= 0 ? 1 : 0); i < lines.length; i++) {
      const cols = lines[i].split(delim);
      const val = mmsiIdx >= 0 ? (cols[mmsiIdx] || '') : lines[i];
      const match = String(val).match(/\b\d{7,9}\b/);
      if (match) result.add(match[0]);
    }
  } catch {}
  return result;
}

function readImoCsv(filePath: string): Set<string> {
  const result = new Set<string>();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return result;
    const header = lines[0];
    const delim = header.includes(';') ? ';' : ',';
    const headers = header.split(delim).map(h => h.trim().toLowerCase());
    const imoIdx = headers.findIndex(h => h === 'imo' || h === 'imo number' || h === 'imonumber' || h === 'imo_no');
    for (let i = (imoIdx >= 0 ? 1 : 0); i < lines.length; i++) {
      const cols = lines[i].split(delim);
      const val = imoIdx >= 0 ? (cols[imoIdx] || '') : lines[i];
      const match = String(val).match(/\b\d{7,9}\b/);
      if (match) result.add(match[0]);
    }
  } catch {}
  return result;
}
async function ensureSanctionedLoaded(): Promise<void> {
  const now = Date.now();
  if (now - SANCTIONED_CACHE_TS < 10 * 60 * 1000 && (SANCTIONED_MMSI.size > 0 || SANCTIONED_IMO.size > 0)) return;
  try {
    const s = new Set<string>();
    const imos = new Set<string>();

    // Local lists (Sanctionlist has MMSI+IMO; EU designated vessels are IMO-only)
    readMmsiCsv(LOCAL_SANCTIONS_CSV).forEach((m) => s.add(String(m)));
    readImoCsv(LOCAL_SANCTIONS_CSV).forEach((m) => imos.add(String(m)));
    readImoCsv(LOCAL_EU_SANCTIONS_CSV).forEach((m) => imos.add(String(m)));
    // Legacy EU CSV kept as fallback merge if present
    if (fs.existsSync(LOCAL_EU_SANCTIONS_CSV_LEGACY)) {
      readImoCsv(LOCAL_EU_SANCTIONS_CSV_LEGACY).forEach((m) => imos.add(String(m)));
    }
    // OpenSanctions maritime vessels (OFAC/EU/UA and other programs) — verify + expand
    if (fs.existsSync(LOCAL_OPENSANCTIONS_VESSELS_CSV)) {
      const os = readOpenSanctionsVesselIds(LOCAL_OPENSANCTIONS_VESSELS_CSV);
      os.imos.forEach((m) => imos.add(m));
      os.mmsis.forEach((m) => s.add(m));
    }

    // Known sanctioned MMSI kept for continuity
    s.add('273148810');

    SANCTIONED_MMSI = s;
    SANCTIONED_IMO = imos;
    SANCTIONED_CACHE_TS = now;
    console.log(`[sanctions] mmsi=${SANCTIONED_MMSI.size} imo=${SANCTIONED_IMO.size}`);
  } catch (e) {
    console.warn('[sanctions] load failed', e);
  }
}

async function ensureShadowLoaded(): Promise<void> {
  const now = Date.now();
  if (now - SHADOW_CACHE_TS < 10 * 60 * 1000 && (SHADOWFLEET_MMSI.size > 0 || SHADOWFLEET_IMO.size > 0)) return;
  try {
    SHADOWFLEET_MMSI = new Set(Array.from(readMmsiCsv(LOCAL_SHADOWFLEET_CSV)).map((x) => String(x)));
    SHADOWFLEET_IMO = new Set(Array.from(readImoCsv(LOCAL_SHADOWFLEET_CSV)).map((x) => String(x)));
    // shadowfleet2.csv is a one-off GUR export (Aug 2025); OpenSanctions carries the
    // same GUR list refreshed with the weekly sanctions update
    if (fs.existsSync(LOCAL_OPENSANCTIONS_VESSELS_CSV)) {
      const os = readOpenSanctionsVesselIds(LOCAL_OPENSANCTIONS_VESSELS_CSV, 'shadow');
      os.imos.forEach((m) => SHADOWFLEET_IMO.add(m));
      os.mmsis.forEach((m) => SHADOWFLEET_MMSI.add(m));
    }
    // GUR lists read directly (daily): shadow fleet, marine vessels, sanctioned masters
    const gur = gurImoSets();
    gur.shadow.forEach((m) => SHADOWFLEET_IMO.add(m));
    GUR_LISTED_IMO = gur.listed;
    SANCTIONED_MASTER_IMO = gur.master;
    SHADOW_CACHE_TS = now;
    console.log(`[shadowfleet] mmsi=${SHADOWFLEET_MMSI.size} imo=${SHADOWFLEET_IMO.size}`);
  } catch (e) {
    console.warn('[shadowfleet] load failed', e);
  }
}

async function ensureMilitaryLoaded(): Promise<void> {
  const now = Date.now();
  if (now - MILITARY_CACHE_TS < 10 * 60 * 1000 && MILITARY_MMSI.size > 0) return;
  try {
    MILITARY_MMSI = new Set(Array.from(readMmsiCsv(LOCAL_MILITARY_MMSI)).map(x => String(x)));
    MILITARY_CACHE_TS = now;
  } catch {}
}

/** Shared BarentsWatch "latest combined" cache — avoids 15–30s blocking on every /api/live-positions. */
const BW_LATEST_TTL_MS = 25_000;
let BW_LATEST_CACHE: { list: any[]; fetchedAt: number } | null = null;
let BW_LATEST_INFLIGHT: Promise<any[]> | null = null;

function rebuildImoMapFromList(list: any[]): void {
  if (!Array.isArray(list) || list.length === 0) return;
  IMO_TO_MMSI_MAP.clear();
  for (const v of list) {
    const mmsi = String(v?.mmsi ?? v?.MMSI ?? '');
    const imo = v?.imoNumber ?? v?.imo ?? v?.IMO ?? v?.properties?.imoNumber;
    if (mmsi && imo && String(imo).match(/\b\d{7,9}\b/)) {
      IMO_TO_MMSI_MAP.set(String(imo), mmsi);
    }
  }
  IMO_MAP_CACHE_TS = Date.now();
}

function getBarentsWatchCached(): any[] | null {
  if (!BW_LATEST_CACHE) return null;
  if (Date.now() - BW_LATEST_CACHE.fetchedAt > BW_LATEST_TTL_MS * 4) return null; // hard stale
  return BW_LATEST_CACHE.list;
}

async function fetchBarentsWatchLatest(opts?: {
  force?: boolean;
}): Promise<any[]> {
  const now = Date.now();
  if (
    !opts?.force &&
    BW_LATEST_CACHE &&
    now - BW_LATEST_CACHE.fetchedAt < BW_LATEST_TTL_MS
  ) {
    return BW_LATEST_CACHE.list;
  }
  if (BW_LATEST_INFLIGHT) return BW_LATEST_INFLIGHT;

  BW_LATEST_INFLIGHT = (async () => {
    const token = await getBarentsWatchAccessToken();
    if (!token) return BW_LATEST_CACHE?.list || [];
    const agent = httpsAgent();
    try {
      let data: any;
      try {
        const r1 = await axios.get(
          'https://live.ais.barentswatch.no/v1/latest/combined?modelType=Full&modelFormat=Json',
          {
            headers: { Authorization: `Bearer ${token}` },
            httpsAgent: agent,
            timeout: 15000,
          }
        );
        data = r1.data;
      } catch {
        const r2 = await axios.get(
          'https://live.ais.barentswatch.no/v1/combined?modelType=Full&modelFormat=Json',
          {
            headers: { Authorization: `Bearer ${token}` },
            httpsAgent: agent,
            timeout: 20000,
          }
        );
        data = r2.data;
      }
      const list: any[] = Array.isArray(data)
        ? data
        : data?.vessels || data?.positions || [];
      BW_LATEST_CACHE = { list, fetchedAt: Date.now() };
      rebuildImoMapFromList(list);
      return list;
    } catch (e) {
      console.warn(
        '[barentswatch] latest fetch failed',
        (e as any)?.message || String(e)
      );
      return BW_LATEST_CACHE?.list || [];
    } finally {
      BW_LATEST_INFLIGHT = null;
    }
  })();

  return BW_LATEST_INFLIGHT;
}

async function ensureImoMapLoaded(): Promise<void> {
  const now = Date.now();
  if (now - IMO_MAP_CACHE_TS < 10 * 60 * 1000 && IMO_TO_MMSI_MAP.size > 0) return;
  try {
    // Reuse shared BW cache / single in-flight fetch (do not hit BW a second time)
    const list = await fetchBarentsWatchLatest();
    rebuildImoMapFromList(list);
  } catch {
    /* ignore */
  }
}

// Local perimeter files
const AOI_GEOJSON_PATH = dataSource('fisheriesprotectionzone.geojson');
let AOI_GEOJSON_STRING = '';
try { AOI_GEOJSON_STRING = fs.readFileSync(AOI_GEOJSON_PATH, 'utf8'); } catch { console.warn('AOI GeoJSON not found at', AOI_GEOJSON_PATH); }

function toGeometryJSONString(rawJsonStr: string): string {
  if (!rawJsonStr) return '';
  try {
    const obj = JSON.parse(rawJsonStr);
    if (!obj || !obj.type) return '';
    if (obj.type === 'Feature') return JSON.stringify(obj.geometry || {});
    if (obj.type === 'FeatureCollection') {
      const geoms = (obj.features || []).map((f: any) => f && f.geometry).filter(Boolean);
      if (geoms.length === 0) return '';
      const polyCoords: any[] = [];
      const mpolyCoords: any[] = [];
      const lineCoords: any[] = [];
      const mlineCoords: any[] = [];
      for (const g of geoms) {
        if (g.type === 'Polygon') polyCoords.push(g.coordinates);
        else if (g.type === 'MultiPolygon') mpolyCoords.push(...g.coordinates);
        else if (g.type === 'LineString') lineCoords.push(g.coordinates);
        else if (g.type === 'MultiLineString') mlineCoords.push(...g.coordinates);
      }
      if (polyCoords.length || mpolyCoords.length) {
        const coords = [...mpolyCoords, ...polyCoords];
        return JSON.stringify({ type: 'MultiPolygon', coordinates: coords });
      }
      if (lineCoords.length || mlineCoords.length) {
        const coords = [...mlineCoords, ...lineCoords];
        return JSON.stringify({ type: 'MultiLineString', coordinates: coords });
      }
      // fallback: first geometry
      return JSON.stringify(geoms[0]);
    }
    // Already a geometry
    return JSON.stringify(obj);
  } catch (e) {
    console.warn('Failed to parse GeoJSON:', (e as any)?.message);
    return '';
  }
}

const AOI_GEOM_JSON = toGeometryJSONString(AOI_GEOJSON_STRING);
let AOI_TURF_GEOMETRY: any = null;
try { AOI_TURF_GEOMETRY = AOI_GEOM_JSON ? JSON.parse(AOI_GEOM_JSON) : null; } catch {}

// Ship type mapping (per BarentsWatch docs)
function getShipTypeDescriptionFromCode(code: any): string {
  const n = Number(code);
  if (!isFinite(n)) return 'Unknown';
  if (n >= 1 && n <= 19) return 'Reserved for future use';
  switch (n) {
    case 0: return 'Not available';
    case 20: return 'Wing in ground';
    case 21: return 'WIG, Hazardous A';
    case 22: return 'WIG, Hazardous B';
    case 23: return 'WIG, Hazardous C';
    case 24: return 'WIG, Hazardous D';
    case 25: case 26: case 27: case 28: case 29: return 'WIG (reserved)';
    case 30: return 'Fishing';
    case 31: return 'Towing';
    case 32: return 'Towing >200m or >25m';
    case 33: return 'Dredging/underwater ops';
    case 34: return 'Diving ops';
    case 35: return 'Military ops';
    case 36: return 'Sailing';
    case 37: return 'Pleasure craft';
    case 38: case 39: return 'Reserved';
    case 40: return 'High speed craft';
    case 41: return 'HSC, Hazardous A';
    case 42: return 'HSC, Hazardous B';
    case 43: return 'HSC, Hazardous C';
    case 44: return 'HSC, Hazardous D';
    case 45: case 46: case 47: case 48: return 'HSC (reserved)';
    case 49: return 'HSC, No additional info';
    case 50: return 'Pilot vessel';
    case 51: return 'Search and Rescue';
    case 52: return 'Tug';
    case 53: return 'Port tender';
    case 54: return 'Anti-pollution';
    case 55: return 'Law enforcement';
    case 56: case 57: return 'Spare - Local vessel';
    case 58: return 'Medical transport';
    case 59: return 'Noncombatant ship';
    case 60: return 'Passenger';
    case 61: return 'Passenger, Hazardous A';
    case 62: return 'Passenger, Hazardous B';
    case 63: return 'Passenger, Hazardous C';
    case 64: return 'Passenger, Hazardous D';
    case 65: case 66: case 67: case 68: return 'Passenger (reserved)';
    case 69: return 'Passenger, No additional info';
    case 70: return 'Cargo';
    case 71: return 'Cargo, Hazardous A';
    case 72: return 'Cargo, Hazardous B';
    case 73: return 'Cargo, Hazardous C';
    case 74: return 'Cargo, Hazardous D';
    case 75: case 76: case 77: case 78: return 'Cargo (reserved)';
    case 79: return 'Cargo, No additional info';
    case 80: return 'Tanker';
    case 81: return 'Tanker, Hazardous A';
    case 82: return 'Tanker, Hazardous B';
    case 83: return 'Tanker, Hazardous C';
    case 84: return 'Tanker, Hazardous D';
    case 85: case 86: case 87: case 88: return 'Tanker (reserved)';
    case 89: return 'Tanker, No additional info';
    case 90: return 'Other type';
    case 91: return 'Other, Hazardous A';
    case 92: return 'Other, Hazardous B';
    case 93: return 'Other, Hazardous C';
    case 94: return 'Other, Hazardous D';
    case 95: case 96: case 97: case 98: return 'Other (reserved)';
    case 99: return 'Other, No additional info';
    default: return 'Unknown';
  }
}

function formatEta(eta: any): string | null {
  if (!eta) return null;
  const s = String(eta).trim();
  if (!s) return null;
  // AIS msg 5: MMDDHHmm, '00000000' means N/A
  if (/^\d{8}$/.test(s) && s !== '00000000') {
    const mm = Number(s.slice(0,2));
    const dd = Number(s.slice(2,4));
    const hh = s.slice(4,6);
    const mi = s.slice(6,8);
    if (mm>=1 && mm<=12 && dd>=1 && dd<=31) return `${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')} ${hh}:${mi} UTC`;
  }
  // Sometimes ISO is provided
  if (s.includes(':') || s.includes('-')) return s;
  return null;
}

// Local Norway EEZ and Jan Mayen AOIs
const NORWAY_GEOJSON_PATH = dataSource('Proximity markers', 'AOI', 'Norway.geojson');
const JANMAYEN_GEOJSON_PATH = dataSource('Proximity markers', 'AOI', 'Jan Mayen.geojson');
let NORWAY_GEOJSON_STRING = '';
let JANMAYEN_GEOJSON_STRING = '';
try { NORWAY_GEOJSON_STRING = fs.readFileSync(NORWAY_GEOJSON_PATH, 'utf8'); } catch { console.warn('Norway GeoJSON not found at', NORWAY_GEOJSON_PATH); }
try { JANMAYEN_GEOJSON_STRING = fs.readFileSync(JANMAYEN_GEOJSON_PATH, 'utf8'); } catch { console.warn('Jan Mayen GeoJSON not found at', JANMAYEN_GEOJSON_PATH); }
const NORWAY_GEOM_JSON = toGeometryJSONString(NORWAY_GEOJSON_STRING);
const JANMAYEN_GEOM_JSON = toGeometryJSONString(JANMAYEN_GEOJSON_STRING);
let NORWAY_TURF_GEOMETRY: any = null;
let JANMAYEN_TURF_GEOMETRY: any = null;
try { NORWAY_TURF_GEOMETRY = NORWAY_GEOM_JSON ? JSON.parse(NORWAY_GEOM_JSON) : null; } catch {}
try { JANMAYEN_TURF_GEOMETRY = JANMAYEN_GEOM_JSON ? JSON.parse(JANMAYEN_GEOM_JSON) : null; } catch {}

// Reverted: no external JSON/catch-all table; use explicit mappings + fallbacks

// BarentsWatch OAuth token cache
let BW_TOKEN_CACHE: { accessToken: string; expiresAt: number } | null = null;
async function getBarentsWatchAccessToken(): Promise<string | null> {
  // If BW_ACCESS_TOKEN provided, use it
  if (process.env.BW_ACCESS_TOKEN && process.env.BW_ACCESS_TOKEN.trim()) return process.env.BW_ACCESS_TOKEN.trim();
  // Cached token still valid?
  const now = Date.now();
  if (BW_TOKEN_CACHE && BW_TOKEN_CACHE.expiresAt - 60000 > now) return BW_TOKEN_CACHE.accessToken;
  const clientId = process.env.BW_CLIENT_ID || process.env.BW_CLIENTID || '';
  const clientSecret = process.env.BW_CLIENT_SECRET || process.env.BW_CLIENTSECRET || '';
  if (!clientId || !clientSecret) return null;
  try {
    const params = new URLSearchParams();
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);
    params.set('grant_type', 'client_credentials');
    params.set('scope', 'ais');
    const resp = await axios.post('https://id.barentswatch.no/connect/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const token = resp.data?.access_token as string;
    const expiresIn = Number(resp.data?.expires_in || 3600);
    if (token) {
      BW_TOKEN_CACHE = { accessToken: token, expiresAt: now + expiresIn * 1000 };
      return token;
    }
  } catch (e) {
    console.warn('Failed to fetch BW token:', (e as any)?.message || String(e));
  }
  return null;
}

// In-memory cache for per-vessel static/voyage info so popups retain
// Destination/ETA/IMO/Type even when the latest sample is only a
// dynamic position message. 24h TTL.
const STATIC_INFO_TTL_MS = 24 * 60 * 60 * 1000;
type StaticInfo = { destination?: string|null; eta?: string|null; imo?: string|null; shipType?: string|null; vessel_name?: string|null; updatedAt: number };
const staticInfoByMmsi: Record<string, StaticInfo> = {};
function upsertStaticInfo(mmsi: string, info: Partial<StaticInfo>): void {
  if (!mmsi) return;
  const now = Date.now();
  const existing = staticInfoByMmsi[mmsi] || { updatedAt: 0 };
  const sanitized: any = {};
  for (const [k, v] of Object.entries(info)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') sanitized[k] = v;
  }
  staticInfoByMmsi[mmsi] = { ...existing, ...sanitized, updatedAt: now } as StaticInfo;
}
function populateFromStaticCache(mmsi: string, obj: any): any {
  const cached = staticInfoByMmsi[mmsi];
  if (!cached) return obj;
  const fill = (k: keyof StaticInfo) => {
    if (obj[k] === undefined || obj[k] === null || String(obj[k]).trim() === '') obj[k] = cached[k];
  };
  fill('destination');
  fill('eta');
  fill('imo');
  fill('shipType');
  if (obj['vessel_name'] == null || String(obj['vessel_name']).trim() === '') obj['vessel_name'] = cached.vessel_name;
  return obj;
}
function sweepStaticCache(): void {
  const now = Date.now();
  for (const [mmsi, rec] of Object.entries(staticInfoByMmsi)) {
    if (!rec || now - (rec.updatedAt || 0) > STATIC_INFO_TTL_MS) delete staticInfoByMmsi[mmsi];
  }
}

// Note: Norway and Jan Mayen zones loaded from local GeoJSON files above

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/health', (_req, res) => {
  const ais = getAisStreamStatus();
  const iceMeta = readIceEdgeMeta();
  const iceAgeMs = iceMeta?.fetchedAt ? Date.now() - new Date(iceMeta.fetchedAt).getTime() : null;
  res.json({
    ok: true,
    api: 'scripts-runner',
    port: PORT,
    aisstream: ais,
    sanctions: {
      mmsi: SANCTIONED_MMSI.size,
      imo: SANCTIONED_IMO.size,
      cacheAgeMs: SANCTIONED_CACHE_TS ? Date.now() - SANCTIONED_CACHE_TS : null,
    },
    shadowfleet: { mmsi: SHADOWFLEET_MMSI.size },
    militaryMmsi: MILITARY_MMSI.size,
    iceEdge: {
      ready: fs.existsSync(path.join(OVERLAYS_DIR, 'ice-edge.geojson')),
      ageMs: iceAgeMs,
      meta: iceMeta,
    },
    petroleum: {
      ready:
        fs.existsSync(path.join(OVERLAYS_DIR, 'petroleum.geojson')) &&
        fs.existsSync(path.join(OVERLAYS_DIR, 'pipelines.geojson')),
      ageMs: (() => {
        const m = readPetroleumMeta();
        const t = m?.fetchedAt || m?.generated_at;
        return t ? Date.now() - new Date(t).getTime() : null;
      })(),
      meta: readPetroleumMeta(),
      pipelines: {
        ready: fs.existsSync(path.join(OVERLAYS_DIR, 'pipelines.geojson')),
        meta: readPipelinesMeta(),
      },
    },
    tlsInsecure: process.env.TLS_INSECURE === '1',
    apiKeyRequired: Boolean(API_KEY),
    emailConfigured: emailConfigured(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/alerts/status', (_req, res) => {
  res.json({
    emailConfigured: emailConfigured(),
    rules: listServerAlerts().filter((r) => r.status === 'watching').length,
  });
});

app.get('/api/alerts', (_req, res) => {
  res.json({ rules: listServerAlerts() });
});

app.post('/api/alerts', (req, res) => {
  try {
    const rule = req.body;
    if (!rule?.id) return res.status(400).json({ error: 'id required' });
    upsertServerAlert(rule);
    res.json({ ok: true, emailConfigured: emailConfigured() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.delete('/api/alerts/:id', (req, res) => {
  deleteServerAlert(String(req.params.id));
  res.json({ ok: true });
});

app.post('/api/alerts/notify', async (req, res) => {
  try {
    const { email, message, mmsi, rule } = req.body || {};
    const to = String(email || rule?.email || '').trim();
    if (!to) return res.status(400).json({ error: 'email required' });
    const text =
      message ||
      `SvalMap alert: vessel ${mmsi || ''} entered ${rule?.areaLabel || 'monitored area'}`;
    const result = await sendAlertEmail({
      to,
      subject: `SvalMap alert: ${rule?.areaLabel || 'AOI'}`,
      text: `${text}\n\nRule: ${rule?.id || ''}\nTime: ${new Date().toISOString()}\n`,
    });
    if (!result.ok) return res.status(503).json({ error: result.error });
    if (rule?.id) {
      const existing = listServerAlerts().find((r) => r.id === rule.id);
      if (existing) {
        upsertServerAlert({
          ...existing,
          status: 'triggered',
          triggeredAt: new Date().toISOString(),
          message: text,
          notified: [...new Set([...(existing.notified || []), String(mmsi || '')].filter(Boolean))],
        });
      }
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

loadServerAlerts();

// Kystverket navigation warnings (NAVAREA XIX + coastal).
// Public API returns currently in-force warnings only; recent=1 marks issued within 30 days.
const NAVWARNINGS_NAVAREA_URL =
  'https://api.kystverket.no/data/navigationwarnings/navareaxix/';
const NAVWARNINGS_COASTAL_URL =
  'https://api.kystverket.no/data/navigationwarnings/coastal/';
const NAVWARNINGS_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
let navWarningsCache: { ts: number; data: any } | null = null;

/** Parse simple WKT POINT / MULTIPOINT / POLYGON (lon lat pairs) to GeoJSON geometry. */
function parseWktGeometry(wkt: string | null | undefined): any | null {
  if (!wkt || typeof wkt !== 'string') return null;
  const s = wkt.trim();
  const point = /^POINT\s*\(\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s*\)$/i.exec(s);
  if (point) {
    return { type: 'Point', coordinates: [Number(point[1]), Number(point[2])] };
  }
  const multipoint = /^MULTIPOINT\s*\(\s*(.+)\s*\)$/i.exec(s);
  if (multipoint) {
    const coords: number[][] = [];
    const re = /\(\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(multipoint[1]))) {
      coords.push([Number(m[1]), Number(m[2])]);
    }
    if (!coords.length) return null;
    if (coords.length === 1) return { type: 'Point', coordinates: coords[0] };
    return { type: 'MultiPoint', coordinates: coords };
  }
  const polygon = /^POLYGON\s*\(\s*\((.+)\)\s*\)$/i.exec(s);
  if (polygon) {
    const ring = polygon[1].split(',').map((pair) => {
      const [lon, lat] = pair.trim().split(/\s+/).map(Number);
      return [lon, lat];
    });
    if (ring.length < 3 || ring.some((c) => !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) {
      return null;
    }
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) ring.push([...a]);
    return { type: 'Polygon', coordinates: [ring] };
  }
  return null;
}

/** Kystverket timestamps carry no zone; they are UTC (DTG). */
function kystverketUtc(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  return /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`;
}

function cleanWarningText(v: unknown): string | null {
  if (v == null || v === '') return null;
  return String(v)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Kystverket gives warnings without a position of their own the whole NAVAREA XIX as a
 * "general position". Drawn, that is a red sheet over the Norwegian Sea and the Arctic.
 */
function isAreaWideGeometry(geometry: any): boolean {
  if (geometry?.type !== 'Polygon') return false;
  const ring: number[][] = geometry.coordinates?.[0] || [];
  const lons = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  return Math.max(...lons) - Math.min(...lons) > 30 || Math.max(...lats) - Math.min(...lats) > 15;
}

function warningProps(w: any, kind: 'navarea' | 'coastal') {
  const issued = kystverketUtc(w.dtg_timestamp || w.updated_at);
  return {
    kind,
    eventid: w.eventid,
    status: w.status || 'active',
    warningnumber: w.warningnumber || null,
    title:
      kind === 'navarea'
        ? `NAVAREA XIX ${w.warningnumber || ''}`.trim()
        : `Coastal ${w.warningnumber || w.location || ''}`.trim(),
    message: cleanWarningText(w.message_en || w.message_no),
    messageNo: kind === 'coastal' ? cleanWarningText(w.message_no) : null,
    location: w.location || null,
    chart: w.norwegianchart || null,
    issued,
    updated_at: kystverketUtc(w.updated_at),
    recent: withinLastDays(issued, NAVWARNINGS_LOOKBACK_MS) ? 1 : 0,
  };
}

/** "Message 128/26 is cancelled", "warning 125/26 is cancelled", "This message is also cancelled". */
function cancelledWarningNumbers(warnings: any[]): Set<string> {
  const out = new Set<string>();
  for (const w of warnings) {
    const text = String(w?.message_en || w?.message_no || '');
    for (const m of text.matchAll(/(\d{1,4}\/\d{2,4})\s+is\s+cancell?ed/gi)) out.add(m[1]);
    if (/this message is (also )?cancell?ed/i.test(text) && w?.warningnumber) {
      out.add(String(w.warningnumber));
    }
  }
  return out;
}

function withinLastDays(iso: string | null | undefined, daysMs: number): boolean {
  if (!iso) return true; // keep if unknown date
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= daysMs;
}

async function fetchNavWarningsGeoJSON(): Promise<{
  type: 'FeatureCollection';
  features: any[];
  notices: any[];
  meta: any;
}> {
  const [navareaRes, coastalRes] = await Promise.all([
    axios.get(NAVWARNINGS_NAVAREA_URL, { timeout: 20000, httpsAgent: httpsAgent() }),
    axios.get(NAVWARNINGS_COASTAL_URL, { timeout: 20000, httpsAgent: httpsAgent() }),
  ]);
  const navarea = Array.isArray(navareaRes.data) ? navareaRes.data : [];
  const coastal = Array.isArray(coastalRes.data) ? coastalRes.data : [];
  // The feed still lists warnings that a later message cancelled (or that cancel themselves)
  const cancelled = cancelledWarningNumbers([...navarea, ...coastal]);
  const features: any[] = [];
  /** In force, but nothing to draw: area-wide general position, or no position at all. */
  const notices: any[] = [];
  for (const [list, kind] of [
    [navarea, 'navarea'],
    [coastal, 'coastal'],
  ] as const) {
    for (const w of list) {
      if (w?.warningnumber && cancelled.has(String(w.warningnumber))) continue;
      const properties = warningProps(w, kind);
      const geometry = parseWktGeometry(w?.position);
      const placed = geometry && !isAreaWideGeometry(geometry) ? geometry : null;
      const parts = warningPartsFromText(w?.message_en || w?.message_no);
      // Kystverket's own polygon is drawn as given. Its points are an unordered bag, so when
      // the text says they bound an area, follow a route or mark a circle, draw that instead;
      // and when it only has the whole-NAVAREA position, use whatever positions the text gives.
      const fromText = placed
        ? placed.type !== 'Polygon' && parts.some((p) => p.shape !== 'points')
        : parts.length > 0;
      if (fromText) {
        parts.forEach((p, i) =>
          features.push({
            type: 'Feature',
            geometry: p.geometry,
            properties: { ...properties, shape: p.shape, shapeFrom: 'text', primary: i === 0 ? 1 : 0 },
          })
        );
        continue;
      }
      if (!placed) {
        notices.push({ ...properties, areaWide: Boolean(geometry) });
        continue;
      }
      features.push({
        type: 'Feature',
        geometry: placed,
        properties: {
          ...properties,
          shape: placed.type === 'Polygon' ? 'area' : 'points',
          shapeFrom: 'kystverket',
          primary: 1,
        },
      });
    }
  }
  return {
    type: 'FeatureCollection',
    features,
    notices,
    meta: {
      source: 'Kystverket Data API',
      note:
        'Currently active NAVAREA XIX + coastal warnings (no archive). Areas, routes and circles are read from the warning text where Kystverket gives only points. Cancelled warnings are dropped; area-wide and position-less ones are listed as notices.',
      lookbackDays: 30,
      navareaActive: navarea.length,
      coastalActive: coastal.length,
      onMap: features.filter((f) => f.properties.primary === 1).length,
      notices: notices.length,
      cancelled: [...cancelled],
    },
  };
}

app.get('/api/navwarnings', async (req, res) => {
  try {
    const scope = String(req.query.scope || 'all').toLowerCase();
    const now = Date.now();
    if (!navWarningsCache || now - navWarningsCache.ts > 15 * 60 * 1000) {
      const data = await fetchNavWarningsGeoJSON();
      navWarningsCache = { ts: now, data };
    }
    let data = navWarningsCache.data;
    if (scope === 'recent' || scope === '30d') {
      data = {
        ...data,
        features: (data.features || []).filter((f: any) => f?.properties?.recent === 1),
        notices: (data.notices || []).filter((n: any) => n?.recent === 1),
      };
    }
    // scope=active|all → full in-force set
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Static GeoJSON overlays for MapLibre (EEZ, cables, NSM, etc.)
const OVERLAYS_DIR = dataSource('overlays');

/** SAR detections are limited to Norway EEZ + Jan Mayen EEZ + Svalbard FPZ. */
const SAR_ZONE_OVERLAY_FILES = [
  'norway-eez.geojson',
  'janmayen-eez.geojson',
  'svalbard-fpz.geojson',
] as const;
const SAR_LOOKBACK_HOURS = 24 * 30; // last 30 days (GFW SAR also lags ~5d)

type SarZone = { feature: any; bbox: [number, number, number, number] };
let SAR_ZONES: SarZone[] = [];
/** Simplified MultiPolygon for GFW 4wings report requests. */
let SAR_ZONES_GFW_GEOMETRY: { type: 'MultiPolygon'; coordinates: number[][][][] } | null = null;

function loadSarZones() {
  const zones: SarZone[] = [];
  const multiCoords: number[][][][] = [];
  for (const file of SAR_ZONE_OVERLAY_FILES) {
    try {
      const full = path.join(OVERLAYS_DIR, file);
      if (!fs.existsSync(full)) {
        console.warn('[gfw/sar] zone file missing', file);
        continue;
      }
      const gj = JSON.parse(fs.readFileSync(full, 'utf8'));
      const features: any[] =
        gj?.type === 'FeatureCollection'
          ? gj.features || []
          : gj?.type === 'Feature'
            ? [gj]
            : gj?.type === 'Polygon' || gj?.type === 'MultiPolygon'
              ? [{ type: 'Feature', properties: {}, geometry: gj }]
              : [];
      for (const f of features) {
        if (!f?.geometry) continue;
        const bbox = turf.bbox(f) as [number, number, number, number];
        zones.push({ feature: f, bbox });
        try {
          const simp = turf.simplify(f, { tolerance: 0.04, highQuality: false, mutate: false });
          const g = simp.geometry;
          if (g?.type === 'Polygon') multiCoords.push(g.coordinates);
          else if (g?.type === 'MultiPolygon') multiCoords.push(...g.coordinates);
        } catch {
          const g = f.geometry;
          if (g?.type === 'Polygon') multiCoords.push(g.coordinates);
          else if (g?.type === 'MultiPolygon') multiCoords.push(...g.coordinates);
        }
      }
    } catch (e: any) {
      console.warn('[gfw/sar] zone load failed', file, e?.message || e);
    }
  }
  SAR_ZONES = zones;
  SAR_ZONES_GFW_GEOMETRY = multiCoords.length
    ? { type: 'MultiPolygon', coordinates: multiCoords }
    : null;
  console.log(
    `[gfw/sar] zones=${zones.length} gfwGeom=${SAR_ZONES_GFW_GEOMETRY ? 'MultiPolygon' : 'bbox-fallback'}`
  );
}
loadSarZones();

function pointInSarZones(lon: number, lat: number): boolean {
  if (!SAR_ZONES.length) return pointInGfwMonitorBbox(lon, lat);
  const pt = turf.point([lon, lat]);
  for (const z of SAR_ZONES) {
    const [minX, minY, maxX, maxY] = z.bbox;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    try {
      if (turf.booleanPointInPolygon(pt, z.feature)) return true;
    } catch {
      /* ignore bad ring */
    }
  }
  return false;
}

function sarZonesRequestGeometry():
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  | { type: 'Polygon'; coordinates: number[][][] } {
  return SAR_ZONES_GFW_GEOMETRY || gfwMonitorGeometry();
}

app.use('/overlays', express.static(OVERLAYS_DIR));
app.get('/api/overlays', (_req, res) => {
  try {
    const files = fs.existsSync(OVERLAYS_DIR)
      ? fs.readdirSync(OVERLAYS_DIR).filter((f) => f.endsWith('.geojson'))
      : [];
    res.json({
      overlays: files.map((f) => ({
        id: f.replace(/\.geojson$/, ''),
        url: `/overlays/${encodeURIComponent(f)}`,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

const ICE_EDGE_META = path.join(OVERLAYS_DIR, 'ice-edge.meta.json');
const ICE_EDGE_SCRIPT = path.join(__dirname, 'fetch_ice_edge.py');
const ICE_EDGE_PYTHON = path.join(__dirname, '.venv-cmems', 'bin', 'python');

function readIceEdgeMeta(): any | null {
  try {
    if (!fs.existsSync(ICE_EDGE_META)) return null;
    return JSON.parse(fs.readFileSync(ICE_EDGE_META, 'utf8'));
  } catch {
    return null;
  }
}

app.get('/api/ice-edge/status', (_req, res) => {
  const meta = readIceEdgeMeta();
  const geo = path.join(OVERLAYS_DIR, 'ice-edge.geojson');
  res.json({
    ready: fs.existsSync(geo),
    meta,
    url: '/overlays/ice-edge.geojson',
  });
});

let iceEdgeRefreshing = false;
function refreshIceEdge(reason: string): Promise<{ ok: boolean; error?: string; meta?: any }> {
  if (iceEdgeRefreshing) return Promise.resolve({ ok: false, error: 'already running' });
  if (!fs.existsSync(ICE_EDGE_PYTHON)) {
    return Promise.resolve({
      ok: false,
      error: 'Python venv missing (.venv-cmems). Run: python3 -m venv .venv-cmems && pip install copernicusmarine matplotlib numpy xarray python-dotenv',
    });
  }
  iceEdgeRefreshing = true;
  console.log(`[ice-edge] refresh (${reason})…`);
  return new Promise((resolve) => {
    const child = spawn(ICE_EDGE_PYTHON, [ICE_EDGE_SCRIPT], {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => process.stdout.write(b));
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
      process.stderr.write(b);
    });
    child.on('close', (code) => {
      iceEdgeRefreshing = false;
      if (code === 0) {
        resolve({ ok: true, meta: readIceEdgeMeta() });
      } else {
        resolve({ ok: false, error: stderr.slice(-500) || `exit ${code}` });
      }
    });
  });
}

app.post('/api/ice-edge/refresh', async (_req, res) => {
  const result = await refreshIceEdge('api');
  if (result.ok) res.json(result);
  else res.status(500).json(result);
});

const PETROLEUM_META = path.join(OVERLAYS_DIR, 'petroleum.meta.json');
const PIPELINES_META = path.join(OVERLAYS_DIR, 'pipelines.meta.json');

function readPetroleumMeta(): any | null {
  try {
    if (!fs.existsSync(PETROLEUM_META)) return null;
    return JSON.parse(fs.readFileSync(PETROLEUM_META, 'utf8'));
  } catch {
    return null;
  }
}

function readPipelinesMeta(): any | null {
  try {
    if (!fs.existsSync(PIPELINES_META)) return null;
    return JSON.parse(fs.readFileSync(PIPELINES_META, 'utf8'));
  } catch {
    return null;
  }
}

let petroleumRefreshing = false;
async function refreshPetroleum(reason: string): Promise<{
  ok: boolean;
  error?: string;
  meta?: any;
  featureCount?: number;
  pipelines?: { featureCount?: number; meta?: any };
}> {
  if (petroleumRefreshing) return { ok: false, error: 'already running' };
  petroleumRefreshing = true;
  console.log(`[petroleum/sodir] refresh (${reason})…`);
  try {
    const [facilities, pipelines, moveable] = await Promise.all([
      fetchSodirFacilitiesToFile(OVERLAYS_DIR),
      fetchSodirPipelinesToFile(OVERLAYS_DIR),
      fetchSodirMoveableToFile(OVERLAYS_DIR),
    ]);
    // The rig register is a nice-to-have: log, don't fail the refresh
    if (!moveable.ok) console.warn('[petroleum/sodir] moveable units failed', moveable.error);
    else MOVEABLE_RIGS_CACHE = null;
    if (!facilities.ok) {
      console.warn('[petroleum/sodir] facilities refresh failed', facilities.error);
      return { ok: false, error: facilities.error };
    }
    if (!pipelines.ok) {
      console.warn('[petroleum/sodir] pipelines refresh failed', pipelines.error);
      return { ok: false, error: pipelines.error };
    }
    resetInfraWatch();
    console.log(
      `[petroleum/sodir] ok facilities=${facilities.featureCount} pipelines=${pipelines.featureCount} source=sodir-factmaps`
    );
    return {
      ok: true,
      meta: facilities.meta || readPetroleumMeta(),
      featureCount: facilities.featureCount,
      pipelines: {
        featureCount: pipelines.featureCount,
        meta: pipelines.meta || readPipelinesMeta(),
      },
    };
  } finally {
    petroleumRefreshing = false;
  }
}

app.get('/api/petroleum/status', (_req, res) => {
  const meta = readPetroleumMeta();
  const pipelinesMeta = readPipelinesMeta();
  const geo = path.join(OVERLAYS_DIR, 'petroleum.geojson');
  const pipelinesGeo = path.join(OVERLAYS_DIR, 'pipelines.geojson');
  res.json({
    ready: fs.existsSync(geo) && fs.existsSync(pipelinesGeo),
    meta,
    pipelines: {
      ready: fs.existsSync(pipelinesGeo),
      meta: pipelinesMeta,
      url: '/overlays/pipelines.geojson',
    },
    url: '/overlays/petroleum.geojson',
  });
});

/**
 * Moveable rigs (semisubs, jack-ups, flotels) from the Sodir register, placed at the
 * AIS position of the vessel with the same name. Dive/intervention "VESSEL" units are
 * left out — they already show up as ordinary ships.
 */
const MOVEABLE_PATH = path.join(OVERLAYS_DIR, MOVEABLE_FILE);
let MOVEABLE_RIGS_CACHE: { at: number; body: any } | null = null;

function rigNameKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/Æ/g, 'AE')
    .replace(/Ø/g, 'O')
    .replace(/Å/g, 'A')
    .normalize('NFKD')
    .replace(/[^A-Z0-9]/g, '');
}

/** Same name on a cargo ship or trawler is a namesake, not the rig. */
const NOT_A_RIG = /cargo|tanker|fishing|passenger|pleasure|sailing|tug|pilot|high speed/i;

function readMoveableUnits(): any[] {
  try {
    if (!fs.existsSync(MOVEABLE_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(MOVEABLE_PATH, 'utf8'));
    return Array.isArray(data?.units) ? data.units : [];
  } catch {
    return [];
  }
}

async function buildMoveableRigs() {
  const live = await getLivePositionsList();
  const onMap = new Set(live.map((v) => v.mmsi));
  const byKey = new Map<string, any[]>();
  for (const v of [...live, ...allKnownVessels().filter((x) => !onMap.has(x.mmsi))]) {
    const name = String(v.vessel_name || '').trim();
    if (!name) continue;
    const key = rigNameKey(name);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(v);
  }
  // AIS names stop at 20 characters; long Sodir names match on that prefix
  const truncated = [...byKey.entries()].filter(([, vs]) =>
    vs.some((v) => String(v.vessel_name).trim().length >= 19)
  );

  const rigs = readMoveableUnits().filter(
    (u) => u.phase === 'IN SERVICE' && !/VESSEL/i.test(String(u.kind || ''))
  );
  const features: any[] = [];
  const unmatched: string[] = [];
  for (const u of rigs) {
    const key = rigNameKey(String(u.name || ''));
    const candidates = [
      ...(byKey.get(key) || []),
      ...truncated.filter(([k]) => k !== key && key.startsWith(k)).flatMap(([, vs]) => vs),
    ];
    const best = candidates.sort(
      (a, b) =>
        Number(NOT_A_RIG.test(a.shipType || '')) - Number(NOT_A_RIG.test(b.shipType || '')) ||
        Number(!onMap.has(a.mmsi)) - Number(!onMap.has(b.mmsi)) ||
        String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
    )[0];
    if (!best) {
      unmatched.push(u.name);
      continue;
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [best.lon, best.lat] },
      properties: {
        ...u,
        mmsi: best.mmsi,
        aisName: best.vessel_name,
        aisTimestamp: best.timestamp || null,
        aisOnMap: onMap.has(best.mmsi),
        source: 'sodir-factmaps+ais',
      },
    });
  }
  return {
    type: 'FeatureCollection',
    features,
    meta: { rigsInService: rigs.length, placed: features.length, unmatched },
  };
}

app.get('/api/petroleum/moveable', async (_req, res) => {
  try {
    if (!MOVEABLE_RIGS_CACHE || Date.now() - MOVEABLE_RIGS_CACHE.at > 60_000) {
      MOVEABLE_RIGS_CACHE = { at: Date.now(), body: await buildMoveableRigs() };
    }
    res.json(MOVEABLE_RIGS_CACHE.body);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post('/api/petroleum/refresh', async (_req, res) => {
  const result = await refreshPetroleum('api');
  if (result.ok) res.json(result);
  else res.status(500).json(result);
});

// Global Fishing Watch — real proxy is registered below (/api/gfw/events, /api/gfw/detections)

const GEOM_BBOX = new WeakMap<object, [number, number, number, number]>();

function geomBbox(geom: any): [number, number, number, number] | null {
  if (!geom) return null;
  const cached = GEOM_BBOX.get(geom);
  if (cached) return cached;
  try {
    const b = turf.bbox({ type: 'Feature', properties: {}, geometry: geom } as any) as [
      number,
      number,
      number,
      number,
    ];
    GEOM_BBOX.set(geom, b);
    return b;
  } catch {
    return null;
  }
}

function pointInGeom(lon: number, lat: number, geom: any): boolean {
  if (!geom) return false;
  const b = geomBbox(geom);
  if (b && (lon < b[0] || lat < b[1] || lon > b[2] || lat > b[3])) return false;
  try {
    return turf.booleanPointInPolygon(turf.point([lon, lat]), {
      type: 'Feature',
      properties: {},
      geometry: geom,
    } as any);
  } catch {
    return false;
  }
}

function inNorthAtlanticBox(lon: number, lat: number): boolean {
  return (
    lat >= NORTH_ATLANTIC_BBOX.minLat &&
    lat <= NORTH_ATLANTIC_BBOX.maxLat &&
    lon >= NORTH_ATLANTIC_BBOX.minLon &&
    lon <= NORTH_ATLANTIC_BBOX.maxLon
  );
}

function isMilitaryShipType(shipType: any): boolean {
  const n = Number(shipType);
  if (n === 35 || n === 55) return true;
  const s = String(shipType || '').toLowerCase();
  return s.includes('military') || s.includes('law enforcement');
}

function isFishingShipType(shipType: any): boolean {
  const n = Number(shipType);
  if (n === 30) return true;
  return String(shipType || '').toLowerCase().includes('fishing');
}

function isRecreationalShipType(shipType: any): boolean {
  const n = Number(shipType);
  if (n === 36 || n === 37) return true;
  const s = String(shipType || '').toLowerCase();
  return s.includes('pleasure') || s.includes('sailing') || s.includes('recreational');
}

/**
 * Same display rules as before, expanded geographically:
 * - Svalbard FPZ + Norway EEZ + Jan Mayen EEZ: all vessels
 *   (drop fishing <15 m / recreational <45 m when length known)
 * - Rest of North Atlantic north of 54°N:
 *   Russian / research / shadow / sanctioned / military only
 */
function shouldIncludeVessel(opts: {
  lon: number;
  lat: number;
  mmsi: string;
  imo: string | null;
  shipType: any;
  lengthM: number | null;
}): { include: boolean; inSvalbard: boolean } {
  const { lon, lat, mmsi, imo, shipType, lengthM } = opts;

  // Cheap bbox gate before expensive EEZ polygon tests
  const maybeSvalbard = (() => {
    const b = geomBbox(AOI_TURF_GEOMETRY);
    return !b || (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3]);
  })();
  const maybeNorway = (() => {
    const b = geomBbox(NORWAY_TURF_GEOMETRY);
    return !b || (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3]);
  })();
  const maybeJanMayen = (() => {
    const b = geomBbox(JANMAYEN_TURF_GEOMETRY);
    return !b || (lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3]);
  })();

  const inSvalbard = maybeSvalbard && pointInGeom(lon, lat, AOI_TURF_GEOMETRY);
  const inNorwayEez = maybeNorway && pointInGeom(lon, lat, NORWAY_TURF_GEOMETRY);
  const inJanMayenEez =
    maybeJanMayen && pointInGeom(lon, lat, JANMAYEN_TURF_GEOMETRY);
  const inFullCoverageZone = inSvalbard || inNorwayEez || inJanMayenEez;

  if (inFullCoverageZone) {
    if (lengthM != null) {
      if (isFishingShipType(shipType) && lengthM < 15)
        return { include: false, inSvalbard };
      if (isRecreationalShipType(shipType) && lengthM < 45)
        return { include: false, inSvalbard };
    }
    return { include: true, inSvalbard };
  }

  // Followed worldwide: shown wherever they are
  if (isRussianResearchVessel(mmsi, imo)) return { include: true, inSvalbard: false };
  if (!inNorthAtlanticBox(lon, lat)) return { include: false, inSvalbard: false };

  const isRussian = parseInt(mmsi.slice(0, 3), 10) === 273;
  const isResearch = isRussianResearchVessel(mmsi, imo);
  const isSanctioned =
    SANCTIONED_MMSI.has(mmsi) ||
    (!!imo && SANCTIONED_IMO.has(imo)) ||
    (!!imo && IMO_TO_MMSI_MAP.has(imo) && SANCTIONED_MMSI.has(IMO_TO_MMSI_MAP.get(imo)!));
  const isShadow =
    SHADOWFLEET_MMSI.has(mmsi) ||
    SHADOW_TEST_SET.has(mmsi) ||
    (!!imo && SHADOWFLEET_IMO.has(imo));
  const isMilitary = isMilitaryShipType(shipType) || MILITARY_MMSI.has(mmsi);
  const isGurListed = !!imo && GUR_LISTED_IMO.has(imo);
  return {
    include: isRussian || isResearch || isSanctioned || isShadow || isMilitary || isGurListed,
    inSvalbard: false,
  };
}

function normalizeLiveVessel(input: {
  mmsi: string;
  lon: number;
  lat: number;
  speed?: any;
  course?: any;
  heading?: any;
  status?: any;
  vessel_name?: any;
  destination?: any;
  imo?: any;
  shipType?: any;
  shipTypeCode?: any;
  eta?: any;
  timestamp?: any;
  lengthM?: number | null;
  source?: string;
}, opts?: { ignoreDisplayRules?: boolean }): any | null {
  const mmsiStr = String(input.mmsi || '').replace(/\D/g, '').padStart(9, '0').slice(-9);
  if (!mmsiStr || mmsiStr === '000000000') return null;
  const lon = Number(input.lon);
  const lat = Number(input.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const imoRaw = input.imo != null && input.imo !== '' ? String(input.imo) : '';
  const imoStr = imoRaw && imoRaw !== '0' ? imoRaw : '';
  const shipTypeRaw = input.shipType ?? input.shipTypeCode ?? null;
  const shipType =
    typeof shipTypeRaw === 'string'
      ? shipTypeRaw
      : getShipTypeDescriptionFromCode(shipTypeRaw);

  // Point-in-EEZ tests are the expensive part — skip them when the caller ignores the rules
  if (!opts?.ignoreDisplayRules) {
    const decision = shouldIncludeVessel({
      lon,
      lat,
      mmsi: mmsiStr,
      imo: imoStr || null,
      shipType: shipTypeRaw ?? shipType,
      lengthM: input.lengthM ?? null,
    });
    if (!decision.include) return null;
  }

  const isEuSanctioned =
    (!!imoStr && SANCTIONED_IMO.has(imoStr)) ||
    (!!imoStr && IMO_TO_MMSI_MAP.has(imoStr) && SANCTIONED_MMSI.has(IMO_TO_MMSI_MAP.get(imoStr)!));
  const isShadow =
    SHADOWFLEET_MMSI.has(mmsiStr) ||
    SHADOW_TEST_SET.has(mmsiStr) ||
    (!!imoStr && SHADOWFLEET_IMO.has(imoStr));

  const normalized = {
    mmsi: mmsiStr,
    timestamp: input.timestamp ?? null,
    lon,
    lat,
    speed: input.speed ?? null,
    course: input.course ?? null,
    heading: input.heading ?? null,
    status: input.status ?? null,
    vessel_name:
      input.vessel_name ||
      RESEARCH_NAME_BY_MMSI.get(mmsiStr) ||
      null,
    destination: typeof input.destination === 'string' ? input.destination : null,
    imo: imoStr || null,
    shipType,
    sanctioned: SANCTIONED_MMSI.has(mmsiStr) || isEuSanctioned,
    shadowfleet: isShadow,
    // Only flagged when the ship is not sanctioned in its own right
    sanctionedMaster:
      !!imoStr &&
      SANCTIONED_MASTER_IMO.has(imoStr) &&
      !(SANCTIONED_MMSI.has(mmsiStr) || isEuSanctioned),
    military: isMilitaryShipType(shipTypeRaw ?? shipType) || MILITARY_MMSI.has(mmsiStr),
    research: isRussianResearchVessel(mmsiStr, imoStr || null),
    eta: formatEta(input.eta),
    source: input.source || 'unknown',
  };
  upsertStaticInfo(mmsiStr, {
    destination: normalized.destination,
    eta: normalized.eta,
    imo: normalized.imo,
    shipType: normalized.shipType,
    vessel_name: normalized.vessel_name,
  });
  return populateFromStaticCache(mmsiStr, normalized);
}

function aisStreamInput(v: ReturnType<typeof getAisStreamVessels>[number]) {
  return {
    mmsi: v.mmsi,
    lon: v.lon,
    lat: v.lat,
    speed: v.speed,
    course: v.course,
    heading: v.heading,
    status: v.status,
    vessel_name: v.vessel_name,
    destination: v.destination,
    imo: v.imo,
    shipType: v.shipType,
    shipTypeCode: v.shipTypeCode,
    eta: v.eta,
    timestamp: v.updatedAt ? new Date(v.updatedAt).toISOString() : null,
    lengthM: vesselLengthMeters(v),
    source: 'aisstream',
  };
}

/** BarentsWatch "latest combined" record → normalizeLiveVessel input (null without a fix). */
function barentsWatchInput(v: any) {
  const lon =
    v?.lon ??
    v?.Lon ??
    v?.longitude ??
    v?.Longitude ??
    v?.position?.longitude ??
    v?.position?.lon ??
    v?.coordinates?.longitude;
  const lat =
    v?.lat ??
    v?.Lat ??
    v?.latitude ??
    v?.Latitude ??
    v?.position?.latitude ??
    v?.position?.lat ??
    v?.coordinates?.latitude;
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  const lengthRaw = Number(
    v?.shipLength ??
      v?.length ??
      (v?.dimensionA != null && v?.dimensionB != null
        ? Number(v.dimensionA) + Number(v.dimensionB)
        : NaN)
  );
  return {
    mmsi: String(v?.mmsi ?? v?.MMSI ?? ''),
    lon,
    lat,
    speed: v?.speedOverGround ?? v?.sog ?? v?.SpeedOverGround ?? null,
    course: v?.courseOverGround ?? v?.cog ?? v?.CourseOverGround ?? null,
    heading: v?.trueHeading ?? v?.heading ?? v?.TrueHeading ?? null,
    status: v?.navigationalStatus ?? v?.navstat ?? v?.NavigationalStatus ?? null,
    vessel_name: v?.shipName ?? v?.name ?? v?.ShipName ?? v?.properties?.name ?? null,
    destination: v?.destination ?? v?.Destination ?? v?.properties?.destination ?? null,
    imo: v?.imoNumber ?? v?.imo ?? v?.IMO ?? v?.properties?.imoNumber ?? null,
    shipType: v?.shipTypeDesc ?? v?.shipType ?? v?.properties?.shipType ?? null,
    eta: v?.eta ?? v?.ETA ?? v?.properties?.eta ?? null,
    timestamp: v?.msgtime ?? v?.msgTime ?? v?.time ?? v?.Timestamp ?? null,
    // Without length the fishing <15 m / leisure <45 m rule never applied to BW traffic
    lengthM: Number.isFinite(lengthRaw) && lengthRaw > 0 ? lengthRaw : null,
    source: 'barentswatch',
  };
}

/** Same vessel from AISStream (existing) and BarentsWatch: newest fix wins, static fields fill gaps. */
function mergeFeedRecords(existing: any, bw: any): any {
  // AISStream used to win unconditionally, even with a fix up to 45 min older than BW's
  const bwTime = Date.parse(String(bw.timestamp ?? ''));
  const aisTime = Date.parse(String(existing.timestamp ?? ''));
  const fix = Number.isFinite(bwTime) && (!Number.isFinite(aisTime) || bwTime > aisTime)
    ? bw
    : existing;
  return {
    ...bw,
    ...existing,
    lon: fix.lon,
    lat: fix.lat,
    speed: fix.speed,
    course: fix.course,
    heading: fix.heading,
    status: fix.status ?? existing.status ?? bw.status,
    timestamp: fix.timestamp,
    vessel_name: existing.vessel_name || bw.vessel_name,
    destination: existing.destination || bw.destination,
    imo: existing.imo || bw.imo,
    shipType:
      existing.shipType && existing.shipType !== 'Unknown' ? existing.shipType : bw.shipType,
    eta: existing.eta || bw.eta,
    source: existing.source === 'aisstream' ? 'aisstream+bw' : existing.source,
  };
}

/** Live AIS merge used by UI, search, incidents, and alert watcher. */
const LIVE_LIST_TTL_MS = 8_000;
const LIVE_LIST_PARTIAL_TTL_MS = 1_500;
let LIVE_LIST_CACHE: { list: any[]; fetchedAt: number; ttl: number } | null =
  null;
let LIVE_LIST_INFLIGHT: Promise<any[]> | null = null;

async function getLivePositionsList(): Promise<any[]> {
  const now = Date.now();
  if (
    LIVE_LIST_CACHE &&
    now - LIVE_LIST_CACHE.fetchedAt < LIVE_LIST_CACHE.ttl
  ) {
    return LIVE_LIST_CACHE.list;
  }
  if (LIVE_LIST_INFLIGHT) return LIVE_LIST_INFLIGHT;

  LIVE_LIST_INFLIGHT = (async () => {
    try {
      const { list, partial } = await buildLivePositionsList();
      LIVE_LIST_CACHE = {
        list,
        fetchedAt: Date.now(),
        ttl: partial ? LIVE_LIST_PARTIAL_TTL_MS : LIVE_LIST_TTL_MS,
      };
      return list;
    } finally {
      LIVE_LIST_INFLIGHT = null;
    }
  })();
  return LIVE_LIST_INFLIGHT;
}

async function buildLivePositionsList(): Promise<{
  list: any[];
  partial: boolean;
}> {
  await Promise.all([
    ensureSanctionedLoaded(),
    ensureShadowLoaded(),
    ensureMilitaryLoaded(),
  ]);
  // IMO map is warmed from the shared BW cache; never block first paint on a second BW fetch
  void ensureImoMapLoaded();

  const byMmsi = new Map<string, any>();
  const now = Date.now();
  // Every report from both feeds goes through the spoofing checks before the merge. Ships with
  // evidence are shown wherever they are in the North Atlantic box, like ships on the lists.
  const normalizeAndCheck = (input: any) => {
    const mmsi = String(input.mmsi || '').replace(/\D/g, '').padStart(9, '0').slice(-9);
    const typeRaw = input.shipType ?? input.shipTypeCode ?? null;
    noteReport(
      mmsi,
      {
        t: Date.parse(String(input.timestamp ?? '')),
        lon: Number(input.lon),
        lat: Number(input.lat),
        course: input.course,
        heading: input.heading,
        speed: input.speed,
        shipType:
          typeRaw == null
            ? populateFromStaticCache(mmsi, {}).shipType
            : typeof typeRaw === 'string'
              ? typeRaw
              : getShipTypeDescriptionFromCode(typeRaw),
      },
      now
    );
    const shown = normalizeLiveVessel(input);
    if (shown || !spoofingReasons(mmsi, now).length || !inNorthAtlanticBox(Number(input.lon), Number(input.lat))) return shown;
    return normalizeLiveVessel(input, { ignoreDisplayRules: true });
  };

  for (const v of getAisStreamVessels()) {
    const normalized = normalizeAndCheck(aisStreamInput(v));
    if (normalized) byMmsi.set(normalized.mmsi, normalized);
  }

  // Prefer warm cache; if cold, wait briefly for BW so coastal/RU traffic is not missing
  let bwList = getBarentsWatchCached();
  let bwPartial = false;
  if (!bwList) {
    bwList = await Promise.race([
      fetchBarentsWatchLatest(),
      new Promise<any[]>((resolve) =>
        setTimeout(() => resolve(getBarentsWatchCached() || []), 2500)
      ),
    ]);
    if (!getBarentsWatchCached()) bwPartial = true;
  } else if (Date.now() - (BW_LATEST_CACHE?.fetchedAt || 0) > BW_LATEST_TTL_MS) {
    // Soft-expired: still use, refresh in background
    void fetchBarentsWatchLatest();
  }

  for (const v of bwList) {
    const input = barentsWatchInput(v);
    const normalized = input && normalizeAndCheck(input);
    if (!normalized) continue;
    const existing = byMmsi.get(normalized.mmsi);
    byMmsi.set(normalized.mmsi, existing ? mergeFeedRecords(existing, normalized) : normalized);
  }

  for (const v of byMmsi.values()) {
    const why = spoofingReasons(v.mmsi, now);
    if (why.length) v.spoofing = why;
  }

  sweepStaticCache();
  return { list: Array.from(byMmsi.values()), partial: bwPartial };
}

app.get('/api/live-positions', async (_req, res) => {
  try {
    res.json(await getLivePositionsList());
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * Every vessel the feeds currently hold, display rules ignored — lets search find ships
 * the map does not show (e.g. non-Russian traffic outside the Norwegian zones).
 */
let ALL_KNOWN_CACHE: { list: any[]; at: number } | null = null;
function allKnownVessels(): any[] {
  if (ALL_KNOWN_CACHE && Date.now() - ALL_KNOWN_CACHE.at < 15_000) return ALL_KNOWN_CACHE.list;
  const byMmsi = new Map<string, any>();
  for (const v of getAisStreamVessels()) {
    const n = normalizeLiveVessel(aisStreamInput(v), { ignoreDisplayRules: true });
    if (n) byMmsi.set(n.mmsi, n);
  }
  for (const v of getBarentsWatchCached() || []) {
    const input = barentsWatchInput(v);
    const n = input && normalizeLiveVessel(input, { ignoreDisplayRules: true });
    if (!n) continue;
    const existing = byMmsi.get(n.mmsi);
    byMmsi.set(n.mmsi, existing ? mergeFeedRecords(existing, n) : n);
  }
  ALL_KNOWN_CACHE = { list: Array.from(byMmsi.values()), at: Date.now() };
  return ALL_KNOWN_CACHE.list;
}

/** Lower is better: exact id, id prefix, exact name, name prefix, word prefix, substring. */
function searchRank(v: any, q: string, digits: string): number | null {
  const mmsi = String(v.mmsi || '');
  const imo = String(v.imo || '');
  const name = String(v.vessel_name || '').toLowerCase();
  if (digits.length >= 3) {
    if (mmsi === digits || imo === digits) return 0;
    if (mmsi.startsWith(digits) || imo.startsWith(digits)) return 1;
    if (mmsi.includes(digits) || imo.includes(digits)) return 4;
  }
  if (!name) return null;
  if (name === q) return 0;
  if (name.startsWith(q)) return 2;
  if (name.split(/[\s.-]+/).some((w) => w.startsWith(q))) return 3;
  if (name.includes(q)) return 4;
  return null;
}

app.get('/api/vessels/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ results: [] });
    const list = await getLivePositionsList();
    const live = new Set(list.map((v) => v.mmsi));
    const digits = /^[\d\s]+$/.test(q) ? q.replace(/\D/g, '') : '';
    const candidates = [...list, ...allKnownVessels().filter((v) => !live.has(v.mmsi))];
    const ranked: { v: any; rank: number }[] = [];
    for (const v of candidates) {
      const rank = searchRank(v, q, digits);
      if (rank == null) continue;
      // Ships on the map first when equally good
      ranked.push({ v, rank: rank + (live.has(v.mmsi) ? 0 : 0.5) });
    }
    ranked.sort((a, b) => a.rank - b.rank);
    const results = ranked.slice(0, 25).map(({ v }) => ({
      mmsi: v.mmsi,
      vessel_name: v.vessel_name,
      imo: v.imo,
      lon: v.lon,
      lat: v.lat,
      timestamp: v.timestamp,
      speed: v.speed,
      course: v.course,
      heading: v.heading,
      status: v.status,
      destination: v.destination,
      eta: v.eta,
      sanctioned: !!v.sanctioned,
      shadowfleet: !!v.shadowfleet,
      sanctionedMaster: !!v.sanctionedMaster,
      spoofing: spoofingReasons(v.mmsi),
      military: !!v.military,
      research: !!v.research,
      shipType: v.shipType,
      onMap: live.has(v.mmsi),
    }));
    res.json({ results, totalLive: list.length, totalKnown: candidates.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/api/sanctions/lookup', async (req, res) => {
  try {
    await ensureSanctionedLoaded();
    await ensureShadowLoaded();
    const mmsi = String(req.query.mmsi || '')
      .replace(/\D/g, '')
      .padStart(9, '0')
      .slice(-9);
    const imo = String(req.query.imo || '').replace(/\D/g, '');
    const sanctionedMmsi = mmsi.length === 9 && SANCTIONED_MMSI.has(mmsi);
    const sanctionedImo = imo.length >= 7 && SANCTIONED_IMO.has(imo);
    const shadowMmsi = mmsi.length === 9 && (SHADOWFLEET_MMSI.has(mmsi) || SHADOW_TEST_SET.has(mmsi));
    const shadowImo = imo.length >= 7 && SHADOWFLEET_IMO.has(imo);
    const sanctioned = sanctionedMmsi || sanctionedImo;
    const listings = sanctionListings(imo.length === 7 ? imo : null, mmsi.length === 9 ? mmsi : null);
    // Older local lists (Sanctionlist.CSV, hand-added MMSIs) carry no programme details
    if (sanctioned && !listings.some((l) => l.kind === 'sanction')) {
      listings.unshift({
        kind: 'sanction',
        source: 'Local',
        title: 'Older local sanctions list',
        programmes: [],
        detail: 'Sanctionlist.CSV or a hand-added MMSI — no programme recorded',
        listedName: null,
        listedImo: sanctionedImo ? imo : null,
        listedMmsi: sanctionedMmsi ? mmsi : null,
        since: null,
        url: null,
        urlLabel: null,
        matchedBy: [sanctionedImo ? 'imo' : 'mmsi'],
      });
    }
    // A listed entry links to itself; otherwise search by IMO (OpenSanctions indexes "IMO1234567")
    const osEntry = listings.find((l) => l.source === 'OpenSanctions' && l.url);
    res.json({
      mmsi: mmsi || null,
      imo: imo || null,
      sanctioned,
      shadowfleet: shadowMmsi || shadowImo,
      sanctionedMaster: listings.some((l) => l.kind === 'master') && !sanctioned,
      listings,
      opensanctionsUrl:
        osEntry?.url ||
        `https://www.opensanctions.org/search/?q=${encodeURIComponent(imo.length === 7 ? `IMO${imo}` : mmsi)}`,
      euListUrl: DMA_PAGE_URL,
      gurListUrl: 'https://war-sanctions.gur.gov.ua/en/transport/ships',
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * Ports where a stopped vessel is just in harbour. Norwegian port facilities come from
 * ports.geojson; this covers the main non-Norwegian harbours inside the AIS box.
 */
const EXTRA_PORTS: { name: string; lon: number; lat: number; radiusNm: number }[] = [
  { name: 'Murmansk', lon: 33.06, lat: 68.97, radiusNm: 8 },
  { name: 'Severomorsk', lon: 33.42, lat: 69.07, radiusNm: 5 },
  { name: 'Polyarny', lon: 33.45, lat: 69.2, radiusNm: 4 },
  { name: 'Arkhangelsk', lon: 40.52, lat: 64.55, radiusNm: 10 },
  { name: 'Severodvinsk', lon: 39.82, lat: 64.57, radiusNm: 6 },
  { name: 'Kandalaksha', lon: 32.4, lat: 67.15, radiusNm: 5 },
  { name: 'St Petersburg', lon: 30.2, lat: 59.9, radiusNm: 12 },
  { name: 'Kronstadt', lon: 29.77, lat: 59.99, radiusNm: 4 },
  { name: 'Ust-Luga', lon: 28.4, lat: 59.68, radiusNm: 5 },
  { name: 'Primorsk', lon: 28.67, lat: 60.35, radiusNm: 4 },
  { name: 'Vysotsk', lon: 28.57, lat: 60.63, radiusNm: 4 },
  { name: 'Kaliningrad', lon: 20.45, lat: 54.7, radiusNm: 6 },
  { name: 'Baltiysk', lon: 19.9, lat: 54.65, radiusNm: 4 },
  { name: 'Kiel', lon: 10.15, lat: 54.35, radiusNm: 5 },
  { name: 'Rostock', lon: 12.1, lat: 54.15, radiusNm: 5 },
  { name: 'Gdansk / Gdynia', lon: 18.6, lat: 54.45, radiusNm: 8 },
  { name: 'Copenhagen', lon: 12.6, lat: 55.7, radiusNm: 5 },
  { name: 'Gothenburg', lon: 11.85, lat: 57.69, radiusNm: 5 },
  { name: 'Helsinki', lon: 24.95, lat: 60.15, radiusNm: 5 },
  { name: 'Tallinn', lon: 24.75, lat: 59.45, radiusNm: 5 },
  { name: 'Riga', lon: 24.1, lat: 57.0, radiusNm: 6 },
  { name: 'Reykjavik', lon: -21.93, lat: 64.15, radiusNm: 4 },
  { name: 'Tórshavn', lon: -6.77, lat: 62.0, radiusNm: 3 },
  { name: 'Lerwick', lon: -1.14, lat: 60.16, radiusNm: 3 },
  { name: 'Aberdeen', lon: -2.07, lat: 57.14, radiusNm: 3 },
];
const PORT_RADIUS_NM = 1.5;
const RENDEZVOUS_MAX_KN = 3;
const HEURISTIC_MAX_AGE_MS = 3 * 60 * 60 * 1000;

let HEURISTIC_PORTS: { lon: number; lat: number; radiusNm: number }[] | null = null;
function heuristicPorts() {
  if (HEURISTIC_PORTS) return HEURISTIC_PORTS;
  const out = EXTRA_PORTS.map(({ lon, lat, radiusNm }) => ({ lon, lat, radiusNm }));
  try {
    const gj = JSON.parse(fs.readFileSync(path.join(dataSource('overlays'), 'ports.geojson'), 'utf8'));
    for (const f of gj.features || []) {
      const c = f?.geometry?.coordinates;
      if (Array.isArray(c) && c.length >= 2) {
        out.push({ lon: Number(c[0]), lat: Number(c[1]), radiusNm: PORT_RADIUS_NM });
      }
    }
  } catch {
    /* ports overlay missing — extra list only */
  }
  HEURISTIC_PORTS = out;
  return out;
}

/** Fast equirectangular distance — plenty for sub-10 nm checks. */
function approxNm(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const dLat = (bLat - aLat) * 60;
  const dLon = (bLon - aLon) * 60 * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function inHarbour(v: any): boolean {
  if (Number(v.status) === 5) return true; // moored
  return heuristicPorts().some((p) => approxNm(v.lon, v.lat, p.lon, p.lat) <= p.radiusNm);
}

/** Why a vessel is worth watching, most serious first; null = not a subject. */
function interestReason(v: any): { rank: number; label: string } | null {
  if (v.shadowfleet) return { rank: 0, label: 'shadow fleet' };
  if (v.sanctioned) return { rank: 1, label: 'sanctioned' };
  if (v.research) return { rank: 2, label: 'RU research' };
  if (String(v.mmsi).startsWith('273')) {
    return /fish/i.test(String(v.shipType || ''))
      ? { rank: 4, label: 'RU fishing' }
      : { rank: 3, label: 'Russian' };
  }
  return null;
}

/**
 * Free live heuristics around Russian, sanctioned, shadow-fleet and research vessels:
 * slow / stopped at sea (loiter) and slow close approaches to any other vessel
 * (possible rendezvous / STS). Vessels in harbour, moored or with stale fixes are skipped.
 */
app.get('/api/incidents/live', async (req, res) => {
  try {
    const proxNm = Math.max(0.2, Math.min(10, parseFloat(String(req.query.nm || '1')) || 1));
    const loiterKn = Math.max(0.1, Math.min(3, parseFloat(String(req.query.loiter || '0.8')) || 0.8));
    const list = await getLivePositionsList();
    const now = Date.now();
    const fresh = (v: any) => {
      const t = Date.parse(String(v.timestamp ?? ''));
      return Number.isFinite(t) && now - t <= HEURISTIC_MAX_AGE_MS;
    };
    const atSea = list.filter(
      (v) => Number.isFinite(v.lon) && Number.isFinite(v.lat) && fresh(v) && !inHarbour(v)
    );
    const subjects = atSea
      .map((v) => ({ v, why: interestReason(v) }))
      .filter((x): x is { v: any; why: { rank: number; label: string } } => !!x.why);
    const slow = (v: any) => {
      const spd = Number(v.speed);
      return Number.isFinite(spd) && spd <= RENDEZVOUS_MAX_KN;
    };
    const name = (v: any) => v.vessel_name || v.mmsi;
    const incidents: any[] = [];
    const seenPairs = new Set<string>();

    for (const { v: a, why } of subjects) {
      if (!slow(a)) continue;
      for (const b of atSea) {
        if (b === a || !slow(b)) continue;
        const nm = approxNm(a.lon, a.lat, b.lon, b.lat);
        if (nm > proxNm) continue;
        const key = [a.mmsi, b.mmsi].sort().join('-');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const bWhy = interestReason(b);
        incidents.push({
          id: `prox-${key}`,
          type: 'proximity',
          title: `Possible rendezvous · ${why.label}`,
          message: `${name(a)} ↔ ${name(b)}${bWhy ? ` (${bWhy.label})` : ''} · ${nm.toFixed(2)} nm`,
          mmsi: [a.mmsi, b.mmsi],
          lon: (a.lon + b.lon) / 2,
          lat: (a.lat + b.lat) / 2,
          distanceNm: Math.round(nm * 100) / 100,
          rank: Math.min(why.rank, bWhy?.rank ?? 9),
        });
      }
    }

    for (const { v, why } of subjects) {
      const spd = Number(v.speed);
      if (!Number.isFinite(spd) || spd > loiterKn) continue;
      incidents.push({
        id: `loiter-${v.mmsi}`,
        type: 'loiter',
        title: `Stopped at sea · ${why.label}`,
        message: `${name(v)} · ${spd.toFixed(1)} kn`,
        mmsi: [v.mmsi],
        lon: v.lon,
        lat: v.lat,
        speed: spd,
        rank: why.rank,
      });
    }

    // Any ship lingering over cables / pipelines (tracked every minute, see infraWatch.ts)
    const byMmsi = new Map(list.map((v: any) => [String(v.mmsi), v]));
    for (const d of currentInfraDwell(now)) {
      const v = byMmsi.get(d.mmsi);
      const why = v ? interestReason(v) : null;
      const minutes = Math.round((now - d.since) / 60000);
      incidents.push({
        id: `infra-${d.mmsi}`,
        type: 'infra',
        title: `Lingering over ${d.infra.kind}${why ? ` · ${why.label}` : ''}`,
        message: `${v ? name(v) : d.mmsi} · ${minutes} min within ${d.distanceM} m of ${d.infra.name}`,
        mmsi: [d.mmsi],
        lon: d.lon,
        lat: d.lat,
        minutes,
        // Ships of interest keep their rank; any other ship comes after them
        rank: why ? why.rank : 5,
      });
    }

    // Most serious vessel first, then closest approach
    incidents.sort((a, b) => a.rank - b.rank || (a.distanceNm ?? 99) - (b.distanceNm ?? 99));
    res.json({
      incidents: incidents.slice(0, 40),
      meta: {
        interestCount: subjects.length,
        liveCount: list.length,
        proxNm,
        loiterKn,
        infraRules: INFRA_WATCH_RULES,
        note:
          'Heuristic only — Russian / sanctioned / shadow / research vessels at sea, and any ship lingering over cables or pipelines; harbours, moored and old fixes skipped.',
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/api/aisstream/status', (_req, res) => {
  res.json(getAisStreamStatus());
});

// Historic AIS track (BarentsWatch free open data, max 14 days)
// Docs: https://historic.ais.barentswatch.no
async function fetchHistoricTrack(mmsi: string, days: number, intervalMin: number) {
  const token = await getBarentsWatchAccessToken();
  if (!token) throw Object.assign(new Error('BarentsWatch credentials not configured'), { status: 400 });
  const agent = httpsAgent();
  const clampedDays = Math.max(1, Math.min(14, days));
  let list: any[] = [];
  let endpoint = 'trackslast24hours';

  if (clampedDays <= 1) {
    const url = `https://historic.ais.barentswatch.no/v1/historic/trackslast24hours/${encodeURIComponent(mmsi)}`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: agent,
      timeout: 45000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (r.status >= 400) {
      const err: any = new Error(r.data?.title || r.data?.detail || `Historic AIS HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    list = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.tracks) ? r.data.tracks : [];
  } else {
    endpoint = 'tracks';
    const to = new Date();
    const from = new Date(to.getTime() - clampedDays * 24 * 60 * 60 * 1000);
    const fromIso = from.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const toIso = to.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const url = `https://historic.ais.barentswatch.no/v1/historic/tracks/${encodeURIComponent(mmsi)}/${encodeURIComponent(fromIso)}/${encodeURIComponent(toIso)}`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: agent,
      timeout: 60000,
      validateStatus: (s) => s >= 200 && s < 500,
      params: { filterSatellitePositions: false },
    });
    if (r.status >= 400) {
      const err: any = new Error(r.data?.title || r.data?.detail || `Historic AIS HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    list = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.tracks) ? r.data.tracks : [];
  }

  const rows = list
    .map((v) => ({
      lon: Number(v.longitude ?? v.lon ?? v.lng),
      lat: Number(v.latitude ?? v.lat),
      time: v.msgtime || v.msgTime || v.timestamp || v.time || null,
      speed: v.speedOverGround ?? v.sog ?? v.speed ?? null,
      course: v.courseOverGround ?? v.cog ?? v.course ?? null,
      heading: v.trueHeading ?? v.heading ?? null,
      name: v.name || null,
      shipType: v.shipType ?? null,
      mmsi: String(v.mmsi ?? mmsi),
    }))
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat) && p.time)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  // Spoofing checks run on every fix, before the track is thinned out for drawing
  const rowType = rows.find((p) => p.shipType != null)?.shipType;
  const shipType =
    populateFromStaticCache(mmsi, {}).shipType ??
    (rowType == null ? null : typeof rowType === 'string' ? rowType : getShipTypeDescriptionFromCode(rowType));
  const spoofing = trackReasons(
    rows.map((p) => ({ t: Date.parse(p.time), lon: p.lon, lat: p.lat, course: p.course, heading: p.heading, speed: p.speed, shipType }))
  );
  noteTrackReasons(mmsi, spoofing);

  const keep: typeof rows = [];
  let lastKeptTs = 0;
  const stepMs = intervalMin * 60 * 1000;
  for (const p of rows) {
    const t = new Date(p.time).getTime();
    if (!Number.isFinite(t)) continue;
    if (keep.length === 0 || t - lastKeptTs >= stepMs) {
      keep.push(p);
      lastKeptTs = t;
    }
  }
  if (rows.length && (!keep.length || keep[keep.length - 1].time !== rows[rows.length - 1].time)) {
    keep.push(rows[rows.length - 1]);
  }

  const line = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: keep.map((p) => [p.lon, p.lat]) },
    properties: { mmsi, points: keep.length, days: clampedDays },
  };
  const points = {
    type: 'FeatureCollection',
    features: keep.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        mmsi,
        time: p.time,
        speed: p.speed,
        course: p.course,
        heading: p.heading,
      },
    })),
  };
  return {
    line,
    points,
    meta: {
      mmsi,
      days: clampedDays,
      endpoint,
      raw: list.length,
      returned: keep.length,
      intervalMin,
      source: 'BarentsWatch Historic AIS (open, Norwegian waters, ≤14 days)',
      maxLookbackDays: 14,
      spoofing,
    },
  };
}

app.get('/api/tracks24h', async (req, res) => {
  try {
    const mmsi = String(req.query.mmsi || '').trim();
    const intervalMin = Math.max(5, Math.min(120, parseInt(String(req.query.interval || '15'), 10) || 15));
    const days = Math.max(1, Math.min(14, parseInt(String(req.query.days || '1'), 10) || 1));
    if (!mmsi) return res.status(400).json({ error: 'mmsi required' });
    const data = await fetchHistoricTrack(mmsi, days, intervalMin);
    res.json(data);
  } catch (e: any) {
    const status = e?.status || 500;
    console.warn('[tracks]', e?.message || e);
    res.status(status).json({
      error: e?.message || String(e),
      line: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { mmsi: req.query.mmsi } },
      points: { type: 'FeatureCollection', features: [] },
    });
  }
});

app.get('/api/tracks', async (req, res) => {
  try {
    const mmsi = String(req.query.mmsi || '').trim();
    const intervalMin = Math.max(5, Math.min(120, parseInt(String(req.query.interval || '15'), 10) || 15));
    const days = Math.max(1, Math.min(14, parseInt(String(req.query.days || '1'), 10) || 1));
    if (!mmsi) return res.status(400).json({ error: 'mmsi required' });
    res.json(await fetchHistoricTrack(mmsi, days, intervalMin));
  } catch (e: any) {
    res.status(e?.status || 500).json({ error: e?.message || String(e) });
  }
});

// GFW proxy endpoints — Global Fishing Watch API v3
// Docs: https://globalfishingwatch.org/our-apis/documentation/docs/v3
// Gaps first — AIS-off is the priority layer and shouldn't wait on denser datasets.
const GFW_EVENT_DATASETS = [
  'public-global-gaps-events:latest',
  'public-global-loitering-events:latest',
  'public-global-encounters-events:latest',
  'public-global-port-visits-events:latest',
] as const;

type GfwCacheEntry = { ts: number; payload: any };
const GFW_EVENTS_CACHE = new Map<string, GfwCacheEntry>();
const GFW_CACHE_TTL_MS = 10 * 60 * 1000;
/** Share in-flight loads so concurrent warm/UI requests don't stampede GFW. */
const GFW_EVENTS_INFLIGHT = new Map<string, Promise<any>>();

function getGfwEventsCached(hours: number): any | null {
  const cacheKey = `events:${hours}`;
  const cached = GFW_EVENTS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < GFW_CACHE_TTL_MS) return cached.payload;
  return null;
}

function loadGfwEventsShared(hours: number, limitRaw = 500): Promise<any> {
  const cacheKey = `events:${hours}`;
  const fresh = getGfwEventsCached(hours);
  if (fresh) return Promise.resolve(fresh);
  const existing = GFW_EVENTS_INFLIGHT.get(cacheKey);
  if (existing) return existing;
  const p = loadGfwEvents(hours, limitRaw).finally(() => {
    GFW_EVENTS_INFLIGHT.delete(cacheKey);
  });
  GFW_EVENTS_INFLIGHT.set(cacheKey, p);
  return p;
}

/** Norway monitoring bbox (mainland + Jan Mayen + Svalbard) */
function gfwMonitorGeometry(): { type: 'Polygon'; coordinates: number[][][] } {
  return {
    type: 'Polygon',
    coordinates: [[[-10, 57.5], [35, 57.5], [35, 81], [-10, 81], [-10, 57.5]]],
  };
}

function pointInGfwMonitorBbox(lon: number, lat: number): boolean {
  // Slightly wider so Barents / coastal Russia AIS-off events are kept
  return lon >= -15 && lon <= 45 && lat >= 54 && lat <= 82;
}

function normalizeGfwEventType(raw: unknown): string {
  const t = String(raw || '').toLowerCase();
  if (t.includes('loiter')) return 'loitering';
  if (t.includes('encounter')) return 'encounter';
  if (t.includes('port')) return 'port_visit';
  if (t.includes('gap') || t.includes('ais')) return 'ais_off';
  if (t.includes('fish')) return 'fishing';
  return t || 'event';
}

function gfwEventPosition(ev: any): { lon: number; lat: number } | null {
  let lon: number | undefined;
  let lat: number | undefined;
  // Prefer AIS-off / on positions when present (gap events)
  const off = ev?.gap?.offPosition;
  if (off) {
    lon = Number(off.lon ?? off.longitude);
    lat = Number(off.lat ?? off.latitude);
  }
  if ((!Number.isFinite(lon) || !Number.isFinite(lat)) && ev?.position) {
    lon = Number(ev.position.lon ?? ev.position.longitude);
    lat = Number(ev.position.lat ?? ev.position.latitude);
  } else if (
    (!Number.isFinite(lon) || !Number.isFinite(lat)) &&
    ev?.geometry?.type === 'Point' &&
    Array.isArray(ev.geometry.coordinates)
  ) {
    lon = Number(ev.geometry.coordinates[0]);
    lat = Number(ev.geometry.coordinates[1]);
  }
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon: lon!, lat: lat! };
}

/** True if the event time range overlaps [windowStart, now]. */
function isRecentEnoughGfwEvent(ev: any, windowStart: number, now: number): boolean {
  const evStart = ev.start ? Date.parse(ev.start) : NaN;
  const evEnd = ev.end ? Date.parse(ev.end) : NaN;
  if (!Number.isFinite(evStart)) return false;
  if (evStart > now + 24 * 3600e3) return false;
  // Still open / no end → include if started within last 90d or after windowStart
  if (!Number.isFinite(evEnd)) {
    return evStart >= windowStart || evStart >= now - 90 * 24 * 3600e3;
  }
  // Closed event must overlap the window
  if (evEnd < windowStart) return false;
  // Drop multi-year “forever” port/loiter rows that only barely touch the window
  const durationMs = Math.max(0, evEnd - evStart);
  if (durationMs > 120 * 24 * 3600e3 && evStart < windowStart) return false;
  return true;
}

function normalizeImo(raw: unknown): string | null {
  const m = String(raw || '').match(/\b(\d{7})\b/);
  return m ? m[1] : null;
}

function normalizeMmsi(raw: unknown): string | null {
  const m = String(raw || '').match(/\b(\d{9})\b/);
  return m ? m[1] : null;
}

function isRussianIdentity(mmsi: string | null, flag: string | null): boolean {
  if (flag && String(flag).toUpperCase() === 'RUS') return true;
  if (mmsi && mmsi.startsWith('273')) return true;
  return false;
}

type GfwVesselInterest = {
  russian: boolean;
  sanctioned: boolean;
  shadowfleet: boolean;
  interest: boolean;
};

function classifyGfwVesselInterest(mmsi: string | null, imo: string | null, flag: string | null): GfwVesselInterest {
  const russian = isRussianIdentity(mmsi, flag);
  const sanctioned = Boolean(
    (mmsi && SANCTIONED_MMSI.has(mmsi)) || (imo && SANCTIONED_IMO.has(imo))
  );
  const shadowfleet = Boolean(
    (mmsi && (SHADOWFLEET_MMSI.has(mmsi) || SHADOW_TEST_SET.has(mmsi))) ||
      (imo && SHADOWFLEET_IMO.has(imo))
  );
  return {
    russian,
    sanctioned,
    shadowfleet,
    interest: russian || sanctioned || shadowfleet,
  };
}

function gfwLonLat(p: any): { lon: number; lat: number } | null {
  const lon = Number(p?.lon);
  const lat = Number(p?.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
}

function mapGfwEntry(ev: any, opts?: { requireInterest?: boolean }) {
  const pos = gfwEventPosition(ev);
  if (!pos) return null;
  const subtype = normalizeGfwEventType(ev.type || ev.eventType);
  const vesselName = ev.vessel?.name || ev.vessel?.shipname || null;
  const vessels: string[] = [];
  if (vesselName) vessels.push(String(vesselName));
  if (ev.encounter?.vessel?.name) vessels.push(String(ev.encounter.vessel.name));
  const startIso = ev.start || ev.time || ev.startTime || null;
  const endIso = ev.end || null;
  let duration = ev.duration || ev.loitering?.totalTimeHours || ev.gap?.durationHours || null;
  if (duration == null && startIso && endIso) {
    const ms = Date.parse(endIso) - Date.parse(startIso);
    if (Number.isFinite(ms) && ms > 0) duration = ms / 3600e3;
  }
  const mmsi = normalizeMmsi(ev.vessel?.ssvid || ev.vessel?.mmsi);
  const partnerMmsi = normalizeMmsi(ev.encounter?.vessel?.ssvid || ev.encounter?.vessel?.mmsi);
  const imo = normalizeImo(ev.vessel?.imo || ev.vessel?.imoNumber);
  const partnerImo = normalizeImo(ev.encounter?.vessel?.imo || ev.encounter?.vessel?.imoNumber);
  const flag = ev.vessel?.flag ? String(ev.vessel.flag).toUpperCase() : null;
  const partnerFlag = ev.encounter?.vessel?.flag
    ? String(ev.encounter.vessel.flag).toUpperCase()
    : null;

  const primary = classifyGfwVesselInterest(mmsi, imo, flag);
  const partner = classifyGfwVesselInterest(partnerMmsi, partnerImo, partnerFlag);
  const interest = primary.interest || partner.interest;
  const requireInterest = opts?.requireInterest !== false;
  if (requireInterest && !interest) return null;

  const intentional =
    ev.gap?.intentionalDisabling === true || ev.gap?.intentionalDisabling === 'true';

  return {
    type: subtype,
    time: startIso,
    end: endIso,
    duration,
    position: pos,
    vessels,
    mmsi,
    partnerMmsi,
    imo,
    partnerImo,
    flag,
    partnerFlag,
    russian: primary.russian || partner.russian,
    sanctioned: primary.sanctioned || partner.sanctioned,
    shadowfleet: primary.shadowfleet || partner.shadowfleet,
    intentionalDisabling: intentional || null,
    gapDistanceKm: ev.gap?.distanceKm != null ? Number(ev.gap.distanceKm) : null,
    // Where AIS went off and came back on (for linking radar detections to the gap)
    offPosition: gfwLonLat(ev.gap?.offPosition),
    onPosition: gfwLonLat(ev.gap?.onPosition),
    impliedSpeedKn: ev.gap?.impliedSpeedKnots != null ? Number(ev.gap.impliedSpeedKnots) : null,
    links: ev.links || [],
  };
}

async function fetchGfwDatasetPage(
  client: ReturnType<typeof gfwClient>,
  dataset: string,
  startDate: string,
  endDate: string,
  windowStart: number,
  now: number,
  limit: number
): Promise<{ dataset: string; entries: any[]; total: number; scanned: number; error?: string }> {
  try {
    if (dataset.includes('gaps')) {
      return await fetchGfwGapsInAoi(client, dataset, startDate, endDate, windowStart, now, limit);
    }
    const pageLimit = Math.min(500, Math.max(100, limit));
    const r = await client.post(
      '/events',
      { datasets: [dataset], startDate, endDate, geometry: gfwMonitorGeometry() },
      {
        params: { limit: pageLimit, offset: 0, sort: '-start' },
        validateStatus: (s) => s >= 200 && s < 300,
        timeout: 90000,
      }
    );
    const total = Number(r.data?.total || 0);
    const raw: any[] = r.data?.entries || [];
    const entries: any[] = [];
    const seen = new Set<string>();
    for (const ev of raw) {
      if (!isRecentEnoughGfwEvent(ev, windowStart, now)) continue;
      const mapped = mapGfwEntry(ev, { requireInterest: true });
      if (!mapped) continue;
      const key = `${mapped.type}|${mapped.time}|${mapped.position.lon.toFixed(3)}|${mapped.position.lat.toFixed(3)}|${mapped.mmsi || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(mapped);
    }
    return { dataset, entries, total, scanned: raw.length };
  } catch (e: any) {
    const detail =
      e?.response?.data?.messages?.[0]?.detail || e?.response?.data?.error || e?.message || String(e);
    console.warn('[gfw/events]', dataset, detail);
    return { dataset, entries: [], total: 0, scanned: 0, error: detail };
  }
}

/**
 * AIS gap events: GFW returns empty when geometry is set.
 * 1) Flag-filter NOR/RUS (fast, sparse)
 * 2) Paginate global recent gaps and keep AOI hits (other flags near Norway)
 */
async function fetchGfwGapsInAoi(
  client: ReturnType<typeof gfwClient>,
  dataset: string,
  startDate: string,
  endDate: string,
  windowStart: number,
  now: number,
  limit: number
): Promise<{ dataset: string; entries: any[]; total: number; scanned: number; error?: string }> {
  const want = Math.min(120, Math.max(30, limit));
  const entries: any[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let total = 0;
  let lastError: string | undefined;

  const pushMapped = (ev: any) => {
    if (!isRecentEnoughGfwEvent(ev, windowStart, now)) return;
    const mapped = mapGfwEntry(ev, { requireInterest: false });
    if (!mapped) return;
    if (!pointInGfwMonitorBbox(mapped.position.lon, mapped.position.lat)) return;
    const key = `${mapped.type}|${mapped.time}|${mapped.position.lon.toFixed(3)}|${mapped.position.lat.toFixed(3)}|${mapped.mmsi || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(mapped);
  };

  const attempts: { flags?: string[]; pageSize: number; maxPages: number }[] = [
    { flags: ['RUS', 'NOR'], pageSize: 200, maxPages: 3 },
    // Recent global gaps are mostly outside our AOI — scan deeper for northern hits
    { pageSize: 500, maxPages: 8 },
  ];

  for (const attempt of attempts) {
    if (entries.length >= want) break;
    try {
      const body: any = { datasets: [dataset], startDate, endDate };
      if (attempt.flags) body.flags = attempt.flags;

      for (let page = 0; page < attempt.maxPages && entries.length < want; page++) {
        const r = await client.post('/events', body, {
          params: { limit: attempt.pageSize, offset: page * attempt.pageSize, sort: '-start' },
          validateStatus: (s) => s >= 200 && s < 300,
          timeout: 90000,
        });
        total = Math.max(total, Number(r.data?.total || 0));
        const raw: any[] = r.data?.entries || [];
        scanned += raw.length;
        if (!raw.length) break;
        for (const ev of raw) {
          pushMapped(ev);
          if (entries.length >= want) break;
        }
        if (raw.length < attempt.pageSize) break;
      }
    } catch (e: any) {
      lastError =
        e?.response?.data?.messages?.[0]?.detail || e?.response?.data?.error || e?.message || String(e);
      console.warn('[gfw/gaps]', attempt.flags ? attempt.flags.join(',') : 'global', lastError);
    }
  }

  console.log(`[gfw/gaps] aoi=${entries.length} scanned=${scanned} total=${total}`);
  return {
    dataset,
    entries,
    total,
    scanned,
    error: entries.length === 0 ? lastError : undefined,
  };
}

/** Split [start,end] into ~7-day chunks so dense GFW datasets cover the full lookback. */
function gfwDateChunks(start: Date, end: Date): { startDate: string; endDate: string }[] {
  const chunks: { startDate: string; endDate: string }[] = [];
  const weekMs = 7 * 24 * 3600e3;
  let cursor = start.getTime();
  const endMs = end.getTime();
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + weekMs, endMs);
    chunks.push({
      startDate: new Date(cursor).toISOString().slice(0, 10),
      endDate: new Date(chunkEnd).toISOString().slice(0, 10),
    });
    cursor = chunkEnd;
  }
  return chunks.length ? chunks : [{ startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) }];
}

async function fetchGfwDatasetAcrossWindow(
  client: ReturnType<typeof gfwClient>,
  dataset: string,
  start: Date,
  end: Date,
  limit: number
): Promise<{ dataset: string; entries: any[]; total: number; scanned: number; error?: string }> {
  const dense = dataset.includes('loitering') || dataset.includes('port-visits');
  const isGaps = dataset.includes('gaps');
  // Gaps: one window + pagination (geometry unsupported). Others: weekly chunks when dense.
  const chunks =
    dense && !isGaps
      ? gfwDateChunks(start, end)
      : [
          {
            startDate: start.toISOString().slice(0, 10),
            endDate: new Date(end.getTime() + 24 * 3600e3).toISOString().slice(0, 10),
          },
        ];
  const perChunk = Math.min(500, Math.max(200, limit));

  const merged: any[] = [];
  const seen = new Set<string>();
  let total = 0;
  let scanned = 0;
  let lastError: string | undefined;

  for (const chunk of chunks) {
    const page = await fetchGfwDatasetPage(
      client,
      dataset,
      chunk.startDate,
      chunk.endDate,
      start.getTime(),
      end.getTime(),
      perChunk
    );
    total = Math.max(total, page.total);
    scanned += page.scanned;
    if (page.error) lastError = page.error;
    for (const e of page.entries) {
      const key = `${e.type}|${e.time}|${e.position.lon.toFixed(3)}|${e.position.lat.toFixed(3)}|${e.mmsi || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(e);
    }
  }

  return {
    dataset,
    entries: merged,
    total,
    scanned,
    error: merged.length === 0 ? lastError : undefined,
  };
}

async function loadGfwEvents(hours: number, limitRaw = 200) {
  const cacheKey = `events:${hours}`;
  await Promise.all([ensureSanctionedLoaded(), ensureShadowLoaded()]);
  const client = gfwClient();
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = new Date(end.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const limit = Math.min(500, Math.max(100, limitRaw || 200));

  // Sequential — GFW rate-limits / times out under parallel POSTs.
  // Progressive cache after each dataset so AIS-off (first) is usable ASAP.
  const lists: Awaited<ReturnType<typeof fetchGfwDatasetAcrossWindow>>[] = [];
  const publish = (partial: boolean) => {
    const events = lists.flatMap((l) => l.entries);
    const payload = {
      events,
      meta: {
        returned: events.length,
        startDate,
        endDate,
        hours,
        source: 'gfw-v3',
        filter: 'events: russian|sanctioned|shadow; ais_off: all in AOI; detections: GFW SAR',
        partial,
        datasets: lists.map((l) => ({
          dataset: l.dataset,
          total: l.total,
          scanned: l.scanned,
          returned: l.entries.length,
          error: l.error || null,
        })),
      },
    };
    const anyOk = lists.some((l) => l.entries.length > 0 || (!l.error && l.scanned > 0));
    if (anyOk || events.length > 0) {
      GFW_EVENTS_CACHE.set(cacheKey, { ts: Date.now(), payload });
    }
    return payload;
  };

  for (const dataset of GFW_EVENT_DATASETS) {
    lists.push(await fetchGfwDatasetAcrossWindow(client, dataset, start, end, limit));
    const mid = publish(lists.length < GFW_EVENT_DATASETS.length);
    console.log(
      `[gfw/events] progress ${lists.length}/${GFW_EVENT_DATASETS.length} returned=${mid.events.length}`
    );
  }

  const payload = publish(false);
  console.log(`[gfw/events] returned=${payload.events.length} hours=${hours}`);
  return payload;
}

app.get('/api/gfw/events', async (req, res) => {
  try {
    if (!GFW_API_TOKEN) {
      return res.status(400).json({ error: 'GFW_API_TOKEN not configured', events: [] });
    }
    // Default 30 days — shipping-watch lookback for loitering / encounters / ports
    const hours = Math.max(24, Math.min(24 * 90, parseInt(String(req.query.hours || '720'), 10) || 720));
    const cacheKey = `events:${hours}`;
    const cached = GFW_EVENTS_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.ts < GFW_CACHE_TTL_MS) {
      return res.json({ ...cached.payload, meta: { ...cached.payload.meta, cached: true } });
    }

    // Serve stale cache immediately while a refresh runs (GFW scans can take minutes).
    if (cached?.payload) {
      if (!GFW_EVENTS_INFLIGHT.has(cacheKey)) {
        loadGfwEventsShared(hours, parseInt(String(req.query.limit || '500'), 10) || 500).catch(
          (e) => console.warn('[gfw/events] background refresh', e?.message || e)
        );
      }
      return res.json({
        ...cached.payload,
        meta: { ...cached.payload.meta, cached: true, stale: true, refreshing: true },
      });
    }

    // No cache yet: kick off shared load and wait, but cap wait so the UI isn't stuck forever.
    const limit = parseInt(String(req.query.limit || '500'), 10) || 500;
    const loadPromise = loadGfwEventsShared(hours, limit);
    const payload = await Promise.race([
      loadPromise,
      new Promise<any>((resolve) =>
        setTimeout(
          () =>
            resolve({
              events: [],
              meta: { loading: true, hours, note: 'GFW still loading — retry shortly' },
            }),
          12_000
        )
      ),
    ]);
    res.json(payload);
  } catch (e: any) {
    const detail =
      e?.response?.data?.messages?.[0]?.detail ||
      e?.response?.data?.error ||
      e?.message ||
      String(e);
    console.warn('[gfw/events]', detail);
    res.json({ events: [], error: detail });
  }
});

const GFW_DETECTIONS_CACHE = new Map<string, GfwCacheEntry>();
const GFW_DETECTIONS_INFLIGHT = new Map<string, Promise<any>>();

function parseSarReportEntries(data: any, matched: boolean): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  const rows = Array.isArray(data?.entries) ? data.entries : [];
  for (const block of rows) {
    if (!block || typeof block !== 'object') continue;
    for (const key of Object.keys(block)) {
      if (!key.includes('sar-presence')) continue;
      const list = Array.isArray(block[key]) ? block[key] : [];
      for (const d of list) {
        const lon = Number(d.lon ?? d.longitude);
        const lat = Number(d.lat ?? d.latitude);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (!pointInSarZones(lon, lat)) continue;
        const time = d.date || d.entryTimestamp || d.time || null;
        const mmsi = normalizeMmsi(d.mmsi || d.ssvid);
        const keyId = `${matched ? 1 : 0}|${time}|${lon.toFixed(3)}|${lat.toFixed(3)}|${mmsi || ''}`;
        if (seen.has(keyId)) continue;
        seen.add(keyId);
        out.push({
          type: matched ? 'sar_matched' : 'sar',
          subtype: matched ? 'sar_matched' : 'sar',
          matched,
          time,
          position: { lon, lat },
          detections: Number(d.detections || 1),
          mmsi,
          imo: normalizeImo(d.imo),
          vessel: d.shipName || d.vesselName || null,
          flag: d.flag ? String(d.flag).toUpperCase() : null,
          vesselId: d.vesselId || null,
          vesselType: d.vesselType || null,
          geartype: d.geartype || null,
          source: 'gfw-4wings-sar',
          note: matched
            ? 'SAR detection matched to AIS (GFW)'
            : 'SAR detection with no AIS match — possible dark vessel (GFW)',
        });
      }
    }
  }
  return out;
}

async function fetchSarPresenceReport(
  client: ReturnType<typeof gfwClient>,
  startDate: string,
  endDate: string,
  matched: boolean
): Promise<{ detections: any[]; error?: string }> {
  try {
    const r = await client.post(
      '/4wings/report',
      { geojson: sarZonesRequestGeometry() },
      {
        params: {
          'spatial-resolution': 'HIGH',
          'temporal-resolution': 'HOURLY',
          'datasets[0]': 'public-global-sar-presence:latest',
          'date-range': `${startDate},${endDate}`,
          format: 'JSON',
          'filters[0]': matched ? "matched='true'" : "matched='false'",
        },
        validateStatus: (s) => s >= 200 && s < 300,
        timeout: 120000,
      }
    );
    return { detections: parseSarReportEntries(r.data, matched) };
  } catch (e: any) {
    const detail =
      e?.response?.data?.messages?.[0]?.detail || e?.response?.data?.error || e?.message || String(e);
    console.warn('[gfw/detections] sar', matched ? 'matched' : 'unmatched', detail);
    return { detections: [], error: detail };
  }
}

async function loadGfwDetections(hours: number) {
  // Always last 30 days inside Norway EEZ / Jan Mayen EEZ / Svalbard FPZ
  const lookbackHours = Math.min(SAR_LOOKBACK_HOURS, Math.max(24, hours || SAR_LOOKBACK_HOURS));
  const cacheKey = `detections:zones:${lookbackHours}`;
  const client = gfwClient();
  // SAR presence lags ~5 days — window is 30d of available SAR ending at lag
  const end = new Date(Date.now() - 5 * 24 * 3600e3);
  const start = new Date(end.getTime() - lookbackHours * 3600e3);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  // Unmatched first (dark), then matched for context — sequential to avoid GFW concurrency limits
  const unmatched = await fetchSarPresenceReport(client, startDate, endDate, false);
  const matched = await fetchSarPresenceReport(client, startDate, endDate, true);
  // Cap for map performance — prefer unmatched (dark) over matched
  const unmatchedCap = unmatched.detections.slice(0, 800);
  const matchedCap = matched.detections.slice(0, 400);
  const detections = [...unmatchedCap, ...matchedCap];
  const payload = {
    detections,
    meta: {
      returned: detections.length,
      unmatched: unmatched.detections.length,
      matched: matched.detections.length,
      unmatchedShown: unmatchedCap.length,
      matchedShown: matchedCap.length,
      startDate,
      endDate,
      hours: lookbackHours,
      zones: ['norway-eez', 'janmayen-eez', 'svalbard-fpz'],
      source: 'gfw-4wings-sar',
      dataset: 'public-global-sar-presence:latest',
      note:
        'SAR only in Norway EEZ, Jan Mayen EEZ, and Svalbard FPZ · last 30 days · unmatched = no AIS match (possible dark) · lags ~5 days',
      errors: [unmatched.error, matched.error].filter(Boolean),
    },
  };
  GFW_DETECTIONS_CACHE.set(cacheKey, { ts: Date.now(), payload });
  console.log(
    `[gfw/detections] unmatched=${unmatched.detections.length} matched=${matched.detections.length} zones=${SAR_ZONES.length}`
  );
  return payload;
}

function loadGfwDetectionsShared(hours: number = SAR_LOOKBACK_HOURS): Promise<any> {
  const lookbackHours = Math.min(SAR_LOOKBACK_HOURS, Math.max(24, hours || SAR_LOOKBACK_HOURS));
  const cacheKey = `detections:zones:${lookbackHours}`;
  const cached = GFW_DETECTIONS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < GFW_CACHE_TTL_MS) return Promise.resolve(cached.payload);
  const existing = GFW_DETECTIONS_INFLIGHT.get(cacheKey);
  if (existing) return existing;
  const p = loadGfwDetections(lookbackHours).finally(() => {
    GFW_DETECTIONS_INFLIGHT.delete(cacheKey);
  });
  GFW_DETECTIONS_INFLIGHT.set(cacheKey, p);
  return p;
}

app.get('/api/gfw/detections', async (req, res) => {
  try {
    if (!GFW_API_TOKEN) {
      return res.status(400).json({
        detections: [],
        error: 'GFW_API_TOKEN not configured',
      });
    }
    // Fixed 30-day lookback inside EEZ/FPZ zones
    const hours = SAR_LOOKBACK_HOURS;
    const cacheKey = `detections:zones:${hours}`;
    const cached = GFW_DETECTIONS_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.ts < GFW_CACHE_TTL_MS) {
      return res.json({ ...cached.payload, meta: { ...cached.payload.meta, cached: true } });
    }
    // Return stale while refreshing if available
    if (cached) {
      loadGfwDetectionsShared(hours).catch(() => undefined);
      return res.json({
        ...cached.payload,
        meta: { ...cached.payload.meta, cached: true, refreshing: true },
      });
    }
    const payload = await loadGfwDetectionsShared(hours);
    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ detections: [], error: e?.message || String(e) });
  }
});

/** GFW events and SAR detections as cached for the map (waits briefly on a cold start). */
async function gfwCachedForLeads(): Promise<{ events: any[]; detections: any[] }> {
  const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T) =>
    Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
  const ev =
    GFW_EVENTS_CACHE.get('events:720')?.payload ||
    (await withTimeout(loadGfwEventsShared(720, 500).catch(() => null), 15_000, null));
  const det = await withTimeout(loadGfwDetectionsShared().catch(() => null), 15_000, null);
  return { events: ev?.events || [], detections: det?.detections || [] };
}

/**
 * Leads for a radar detection with no AIS match: GFW AIS-off gaps whose ship could have
 * been there that day, and ships of interest last seen nearby before going quiet.
 */
app.get('/api/gfw/dark-leads', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const time = String(req.query.time || '');
    const d = detectionDay(time);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !d) {
      return res.status(400).json({ error: 'lat, lon and time are required' });
    }
    const det = { time, position: { lon, lat }, matched: false };
    const { events } = await gfwCachedForLeads();
    const live = await getLivePositionsList().catch(() => []);
    const gapLeads = gapLeadsForDetection(det, events).slice(0, 8).map((l) => ({
      mmsi: l.gap.mmsi,
      name: l.gap.vessels?.[0] || null,
      flag: l.gap.flag,
      russian: !!l.gap.russian,
      sanctioned: !!l.gap.sanctioned,
      shadowfleet: !!l.gap.shadowfleet,
      gapStart: l.gap.time,
      gapEnd: l.gap.end,
      kmFromOff: l.kmFromOff,
      kmToOn: l.kmToOn,
      detourKm: l.detourKm,
    }));
    const quietLeads = quietLeadsForDetection(det, live, (v) => !!interestReason(v) || !!v.sanctionedMaster).map((q) => ({
      mmsi: String(q.vessel.mmsi),
      name: q.vessel.vessel_name || null,
      why: interestReason(q.vessel)?.label || (q.vessel.sanctionedMaster ? 'sanctioned master' : null),
      lastFix: q.lastFix,
      hoursSilentBefore: q.hoursSilentBefore,
      km: q.km,
    }));
    res.json({
      day: d.day,
      gapLeads,
      quietLeads,
      sentinel1Url: sentinel1Url({ lon, lat }, d.day),
      rules: { maxKn: DARK_MAX_KN, note: 'Could have been there at no more than 15 kn — a lead, not an identification.' },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/** Radar detections without AIS that the ship of an AIS-off gap could have been. */
app.get('/api/gfw/gap-radar', async (req, res) => {
  try {
    const mmsi = String(req.query.mmsi || '');
    const time = String(req.query.time || '');
    const { events, detections } = await gfwCachedForLeads();
    const gap = events.find((e: any) => e.type === 'ais_off' && e.mmsi === mmsi && e.time === time);
    if (!gap) return res.status(404).json({ error: 'gap not in the current GFW window' });
    const leads = detectionLeadsForGap(gap, detections).slice(0, 12).map((l) => {
      const day = detectionDay(l.det.time)!.day;
      return {
        day,
        lon: l.det.position.lon,
        lat: l.det.position.lat,
        kmFromOff: l.kmFromOff,
        detourKm: l.detourKm,
        sentinel1Url: sentinel1Url(l.det.position, day),
      };
    });
    const offDay = String(gap.time).slice(0, 10);
    const onDay = gap.end ? String(gap.end).slice(0, 10) : null;
    res.json({
      detections: leads,
      sentinel1Off: sentinel1Url(gap.offPosition || gap.position, offDay),
      sentinel1On: gap.onPosition && onDay ? sentinel1Url(gap.onPosition, onDay) : null,
      offPosition: gap.offPosition || gap.position,
      onPosition: gap.onPosition || null,
      rules: { maxKn: DARK_MAX_KN },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/api/gfw/status', (_req, res) => {
  const cached = [...GFW_EVENTS_CACHE.entries()].map(([k, v]) => ({
    key: k,
    ageSec: Math.round((Date.now() - v.ts) / 1000),
    events: v.payload?.events?.length ?? 0,
  }));
  res.json({
    configured: Boolean(GFW_API_TOKEN),
    base: GFW_API_BASE,
    cache: cached,
  });
});

/** Proxy ship-info.com vessel photos by IMO (same asset Arctic tools reference). */
const SHIP_PHOTO_CACHE = new Map<string, { ts: number; buf: Buffer; type: string; ok: boolean }>();
const SHIP_PHOTO_TTL_MS = 24 * 3600e3;
const SHIP_PHOTO_NEG_TTL_MS = 6 * 3600e3;

app.get('/api/ship-photo/:imo', async (req, res) => {
  const imo = String(req.params.imo || '').replace(/\D/g, '');
  if (!/^\d{7}$/.test(imo)) {
    return res.status(400).json({ error: 'IMO must be 7 digits' });
  }
  const cached = SHIP_PHOTO_CACHE.get(imo);
  const now = Date.now();
  if (cached) {
    const ttl = cached.ok ? SHIP_PHOTO_TTL_MS : SHIP_PHOTO_NEG_TTL_MS;
    if (now - cached.ts < ttl) {
      if (!cached.ok) return res.status(404).end();
      res.setHeader('Content-Type', cached.type);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Photo-Source', 'ship-info.com');
      return res.send(cached.buf);
    }
  }
  try {
    const url = `https://www.ship-info.com/vessels/${imo}.jpg`;
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      httpsAgent: httpsAgent(),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.ship-info.com/prog/search_fish.asp',
      },
      validateStatus: (s) => s >= 200 && s < 500,
    });
    const type = String(r.headers['content-type'] || '');
    const buf = Buffer.from(r.data || []);
    const ok =
      r.status === 200 &&
      buf.length > 2000 &&
      (/image\/(jpeg|jpg|png|webp)/i.test(type) || buf[0] === 0xff);
    SHIP_PHOTO_CACHE.set(imo, {
      ts: now,
      buf: ok ? buf : Buffer.alloc(0),
      type: ok ? type || 'image/jpeg' : 'application/octet-stream',
      ok,
    });
    if (!ok) return res.status(404).end();
    res.setHeader('Content-Type', type || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Photo-Source', 'ship-info.com');
    return res.send(buf);
  } catch (e: any) {
    SHIP_PHOTO_CACHE.set(imo, {
      ts: now,
      buf: Buffer.alloc(0),
      type: 'application/octet-stream',
      ok: false,
    });
    console.warn('[ship-photo]', imo, e?.message || e);
    return res.status(404).end();
  }
});

app.get('/api/sanctions/status', (_req, res) => {
  let meta: any = {};
  try {
    meta = JSON.parse(fs.readFileSync(EU_DESIGNATED_META, 'utf8'));
  } catch {
    /* empty */
  }
  let gur: any = {};
  try {
    gur = JSON.parse(fs.readFileSync(GUR_VESSELS_META, 'utf8'));
  } catch {
    /* empty */
  }
  res.json({
    euImoCount: readEuDesignatedCsv().size,
    sanctionedMmsiCache: SANCTIONED_MMSI.size,
    sanctionedImoCache: SANCTIONED_IMO.size,
    meta,
    gur,
  });
});

app.post('/api/sanctions/refresh', async (_req, res) => {
  const result = await updateEuDesignatedVessels();
  SANCTIONED_CACHE_TS = 0; // force reload
  await ensureSanctionedLoaded();
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`SvalMap server on http://localhost:${PORT}`);
  console.log(`[gfw] base=${GFW_API_BASE} token=${GFW_API_TOKEN ? 'configured' : 'MISSING'}`);
  // Russian research ships are followed anywhere in the world, not just in the area
  startAisStreamClient({ worldwideMmsi: RUSSIAN_RESEARCH_VESSELS.map((v) => v.mmsi) });
  console.log(
    `[aisstream] key=${process.env.AISSTREAM_API_KEY ? 'configured' : 'MISSING'} bbox=N≥${NORTH_ATLANTIC_BBOX.minLat}`
  );

  // Warm BarentsWatch latest cache in background so first map load is not blocked 15–30s
  fetchBarentsWatchLatest()
    .then(async (list) => {
      console.log(`[barentswatch] cache warmed vessels=${list.length}`);
      // Pre-build merged live list so the first UI request is a cache hit
      const merged = await getLivePositionsList();
      console.log(`[live-positions] prebuilt vessels=${merged.length}`);
    })
    .catch((e) => console.warn('[barentswatch] warm failed', e));
  setInterval(() => {
    fetchBarentsWatchLatest({ force: true })
      .then(() => getLivePositionsList())
      .catch(() => undefined);
  }, BW_LATEST_TTL_MS);

  // Daily ice-edge refresh (06:30) + startup if missing/stale (>36h)
  cron.schedule('30 6 * * *', () => {
    refreshIceEdge('daily-cron').catch((e) => console.warn('[ice-edge] cron failed', e));
  });
  {
    const meta = readIceEdgeMeta();
    const ageMs = meta?.generated_at ? Date.now() - Date.parse(meta.generated_at) : null;
    const stale = ageMs == null || !Number.isFinite(ageMs) || ageMs > 36 * 3600e3;
    if (stale) {
      refreshIceEdge('startup').catch((e) => console.warn('[ice-edge] startup failed', e));
    } else {
      console.log(`[ice-edge] cache ok age=${Math.round((ageMs || 0) / 3600000)}h features=${meta?.feature_count}`);
    }
  }

  // NVE high-voltage sea cables — weekly (NVE updates about twice a year), and on startup
  // when the file is missing or over two weeks old
  const refreshPowerCables = (reason: string) =>
    fetchNvePowerCablesToFile(OVERLAYS_DIR).then((r) => {
      if (r.ok) resetInfraWatch();
      console.log(`[power-cables/nve] ${reason} ok=${r.ok} count=${r.featureCount ?? 0}${r.error ? ` ${r.error}` : ''}`);
    });
  cron.schedule('50 6 * * 1', () => {
    refreshPowerCables('weekly-cron').catch((e) => console.warn('[power-cables/nve] cron failed', e));
  });
  {
    const fetchedAt = Date.parse(readPowerCablesMeta(OVERLAYS_DIR)?.fetchedAt || '');
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > 14 * 24 * 3600e3) {
      refreshPowerCables('startup').catch((e) => console.warn('[power-cables/nve] startup failed', e));
    }
  }

  // Sodir FactMaps facilities + pipelines — daily + startup if missing/stale (>7d) or not Sodir
  cron.schedule('45 6 * * *', () => {
    refreshPetroleum('daily-cron').catch((e) =>
      console.warn('[petroleum/sodir] cron failed', e)
    );
  });
  {
    const meta = readPetroleumMeta();
    const pipeMeta = readPipelinesMeta();
    const ageFrom = (m: any) =>
      m?.fetchedAt
        ? Date.now() - Date.parse(m.fetchedAt)
        : m?.generated_at
          ? Date.now() - Date.parse(m.generated_at)
          : null;
    const ageMs = ageFrom(meta);
    const pipeAgeMs = ageFrom(pipeMeta);
    const notSodir =
      meta?.source !== 'sodir-factmaps' || pipeMeta?.source !== 'sodir-factmaps';
    const staleAge = (age: number | null) =>
      age == null || !Number.isFinite(age) || age > 7 * 24 * 3600e3;
    const stale = notSodir || staleAge(ageMs) || staleAge(pipeAgeMs);
    if (!stale && !fs.existsSync(MOVEABLE_PATH)) {
      // Rig register is newer than the facility cache — fetch it on its own
      fetchSodirMoveableToFile(OVERLAYS_DIR).then((r) =>
        console.log(`[petroleum/sodir] moveable units ok=${r.ok} count=${r.featureCount ?? 0}`)
      );
    }
    if (stale) {
      refreshPetroleum('startup').catch((e) =>
        console.warn('[petroleum/sodir] startup failed', e)
      );
    } else {
      console.log(
        `[petroleum/sodir] cache ok age=${Math.round((ageMs || 0) / 3600000)}h facilities=${meta?.feature_count} pipelines=${pipeMeta?.feature_count}`
      );
    }
  }

  if (GFW_API_TOKEN) {
    // Warm caches so UI toggles are instant after startup
    loadGfwEventsShared(720, 500).catch((e) => console.warn('[gfw] warm events failed', e?.message || e));
    loadGfwDetectionsShared(SAR_LOOKBACK_HOURS).catch((e) =>
      console.warn('[gfw] warm detections failed', e?.message || e)
    );
  }

  // Weekly EU designated vessels refresh (Monday 06:00 Europe/Oslo-ish via server local TZ)
  // Also run on startup if the list is older than 7 days.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  async function maybeRefreshSanctions(reason: string) {
    const age = metaAgeMs();
    if (reason === 'startup' && age != null && age < WEEK_MS) {
      console.log(`[sanctions] skip startup refresh (age ${Math.round((age || 0) / 3600000)}h)`);
      return;
    }
    console.log(`[sanctions] refresh (${reason})…`);
    const result = await updateEuDesignatedVessels();
    SANCTIONED_CACHE_TS = 0;
    SHADOW_CACHE_TS = 0;
    await Promise.all([ensureSanctionedLoaded(), ensureShadowLoaded()]);
    console.log(
      `[sanctions] refresh done ok=${result.ok} imos=${result.imoCount} added=${result.added.length}`
    );
  }

  cron.schedule('0 6 * * 1', () => {
    maybeRefreshSanctions('weekly-cron').catch((e) => console.warn('[sanctions] cron failed', e));
  });
  maybeRefreshSanctions('startup').catch((e) => console.warn('[sanctions] startup refresh failed', e));

  // GUR War & Sanctions lists (marine vessels, shadow fleet, captains): daily, ~5 min of
  // slow page reads; on startup only when the last read is over a day old
  const DAY_MS = 24 * 60 * 60 * 1000;
  async function refreshGur(reason: string) {
    const age = gurMetaAgeMs();
    if (reason === 'startup' && age != null && age < DAY_MS) return;
    console.log(`[gur] refresh (${reason})…`);
    const result = await updateGurVessels();
    if (result.ok) {
      SHADOW_CACHE_TS = 0;
      await ensureShadowLoaded();
    }
  }
  cron.schedule('20 5 * * *', () => {
    refreshGur('daily-cron').catch((e) => console.warn('[gur] cron failed', e));
  });
  refreshGur('startup').catch((e) => console.warn('[gur] startup refresh failed', e));

  // FleetLeaks (corroboration of sanctioned / shadow-fleet ships): weekly, ~6 min at its
  // 30 s crawl delay; on startup only when the last read is over a week old
  cron.schedule('40 4 * * 2', () => {
    updateFleetleaks().catch((e) => console.warn('[fleetleaks] cron failed', e));
  });
  {
    const age = fleetleaksAgeMs();
    if (age == null || age > 7 * DAY_MS) {
      updateFleetleaks().catch((e) => console.warn('[fleetleaks] startup refresh failed', e));
    }
  }

  // File-backed area alerts — runs without an open browser (email if SMTP configured)
  // Ships lingering over cables and pipelines: checked every minute (fixes older than 30 min skipped)
  setInterval(() => {
    getLivePositionsList()
      .then((list) => {
        const now = Date.now();
        const recent = (v: any) => {
          const t = Date.parse(String(v.timestamp ?? ''));
          return Number.isFinite(t) && now - t <= 30 * 60 * 1000;
        };
        updateInfraWatch(OVERLAYS_DIR, list, (v) => recent(v) && !inHarbour(v), now);
        sweepSpoofing(now);
      })
      .catch((e) => console.warn('[infra-watch]', e?.message || e));
  }, 60_000);

  startAlertWatcher(async () => {
    const list = await getLivePositionsList();
    return list.map((v) => ({
      mmsi: String(v.mmsi),
      lon: Number(v.lon),
      lat: Number(v.lat),
      vessel_name: v.vessel_name || null,
    }));
  }, 30_000);
});


