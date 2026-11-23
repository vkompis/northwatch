/**
 * Server-side AISStream.io WebSocket client.
 * Docs: https://aisstream.io/documentation
 *
 * Keeps an in-memory cache of latest positions + static/voyage fields for the
 * North Atlantic north of 54°N. A second connection follows a short list of ships
 * (Russian research vessels) anywhere in the world, filtered on their MMSI. The API key
 * must never be exposed to the browser.
 */

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { dataCache, ensureDir } from './paths';

export type AisStreamVessel = {
  mmsi: string;
  lon: number;
  lat: number;
  speed: number | null;
  course: number | null;
  heading: number | null;
  status: number | string | null;
  vessel_name: string | null;
  destination: string | null;
  imo: string | null;
  shipType: string | number | null;
  shipTypeCode: number | null;
  eta: string | null;
  dimensionToBow: number | null;
  dimensionToStern: number | null;
  /** Time of the last position fix — exposed as the vessel timestamp. */
  updatedAt: number;
  /** Time of the last message of any kind — keeps static data cached between fixes. */
  seenAt: number;
  source: 'aisstream';
};

/** North Atlantic / Arctic north of 54°N (approx. Newfoundland → Novaya Zemlya). */
export const NORTH_ATLANTIC_BBOX = {
  minLat: 54,
  maxLat: 85,
  minLon: -80,
  maxLon: 45,
};

/** AISStream docs: each corner is [latitude, longitude]. */
const SUBSCRIBE_BBOX: [[number, number], [number, number]] = [
  [NORTH_ATLANTIC_BBOX.minLat, NORTH_ATLANTIC_BBOX.minLon],
  [NORTH_ATLANTIC_BBOX.maxLat, NORTH_ATLANTIC_BBOX.maxLon],
];

const POSITION_TYPES = new Set([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'LongRangeAisBroadcastMessage',
]);

const STATIC_TYPES = new Set(['ShipStaticData', 'StaticDataReport']);
const SUBSCRIBED_TYPES = [...POSITION_TYPES, ...STATIC_TYPES];
const STREAM_URL = 'wss://stream.aisstream.io/v0/stream';
/**
 * How long the WebSocket handshake may take. AISStream's 3-second limit runs from the
 * socket opening, and the subscription goes out on open, so this only guards a hung
 * handshake — which AISStream has been seen to take ~30 s to finish.
 */
const OPEN_TIMEOUT_MS = 60 * 1000;

const STALE_MS = 45 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
/** Force reconnect if the socket looks open but no AIS traffic arrives. */
const SILENCE_RECONNECT_MS = 90 * 1000;
const WATCHDOG_MS = 15 * 1000;

const vesselsByMmsi = new Map<string, AisStreamVessel>();

/** Ships followed anywhere in the world on their own MMSI-filtered connection */
const worldwideMmsi = new Set<string>();
/** Far from receivers a followed ship may be heard once a day: keep its last position two weeks */
const WORLDWIDE_STALE_MS = 14 * 24 * 3600 * 1000;
const staleMsFor = (mmsi: string) => (worldwideMmsi.has(mmsi) ? WORLDWIDE_STALE_MS : STALE_MS);
let worldSocket: WebSocket | null = null;
let worldConnected = false;
let worldReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let worldAttempt = 0;
let worldLastMessageAt = 0;

let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let lastMessageAt = 0;
let connected = false;
let connectedAt = 0;
let messageCount = 0;
let apiKeyHeld = '';

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function padMmsi(v: unknown): string {
  const s = String(v ?? '').replace(/\D/g, '');
  if (!s) return '';
  return s.padStart(9, '0').slice(-9);
}

function inNorthAtlantic(lat: number, lon: number): boolean {
  return (
    lat >= NORTH_ATLANTIC_BBOX.minLat &&
    lat <= NORTH_ATLANTIC_BBOX.maxLat &&
    lon >= NORTH_ATLANTIC_BBOX.minLon &&
    lon <= NORTH_ATLANTIC_BBOX.maxLon
  );
}

function ensureVessel(mmsi: string): AisStreamVessel {
  let v = vesselsByMmsi.get(mmsi);
  if (!v) {
    v = {
      mmsi,
      lon: NaN,
      lat: NaN,
      speed: null,
      course: null,
      heading: null,
      status: null,
      vessel_name: null,
      destination: null,
      imo: null,
      shipType: null,
      shipTypeCode: null,
      eta: null,
      dimensionToBow: null,
      dimensionToStern: null,
      updatedAt: 0,
      seenAt: 0,
      source: 'aisstream',
    };
    vesselsByMmsi.set(mmsi, v);
  }
  return v;
}

function applyMeta(v: AisStreamVessel, meta: any) {
  if (!meta || typeof meta !== 'object') return;
  const name = str(meta.ShipName ?? meta.shipName ?? meta.Name);
  if (name) v.vessel_name = name;
  const lat = num(meta.Latitude ?? meta.latitude);
  const lon = num(meta.Longitude ?? meta.longitude);
  if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    if (lat !== 91 && lon !== 181) {
      v.lat = lat;
      v.lon = lon;
      // MetaData often carries the latest fix even when the typed body is sparse
      if (!v.updatedAt) v.updatedAt = Date.now();
    }
  }
}

function applyPosition(v: AisStreamVessel, body: any) {
  const lat = num(body?.Latitude ?? body?.latitude);
  const lon = num(body?.Longitude ?? body?.longitude);
  if (lat == null || lon == null) return;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  // AIS "not available" sentinels
  if (lat === 91 || lon === 181) return;
  v.lat = lat;
  v.lon = lon;
  v.speed = num(body?.Sog ?? body?.sog ?? body?.SpeedOverGround);
  v.course = num(body?.Cog ?? body?.cog ?? body?.CourseOverGround);
  const hdg = num(body?.TrueHeading ?? body?.trueHeading ?? body?.Heading);
  v.heading = hdg != null && hdg !== 511 ? hdg : null;
  v.status = body?.NavigationalStatus ?? body?.navigationalStatus ?? v.status;
  v.updatedAt = Date.now();
}

function applyStatic(v: AisStreamVessel, body: any) {
  if (!body || typeof body !== 'object') return;
  const name = str(body.Name ?? body.ShipName ?? body?.Dimension?.Name);
  if (name) v.vessel_name = name;

  const imo = body.ImoNumber ?? body.IMO ?? body.imo ?? body?.Eta?.ImoNumber;
  if (imo != null && Number(imo) > 0) v.imo = String(imo);

  const dest = str(body.Destination ?? body.destination);
  if (dest) v.destination = dest;

  const shipType = body.Type ?? body.ShipType ?? body.shipType ?? body?.VesselType;
  if (shipType != null && shipType !== '') {
    v.shipTypeCode = num(shipType);
    v.shipType = shipType;
  }

  const eta = body.Eta ?? body.ETA ?? body.eta;
  if (eta != null) {
    if (typeof eta === 'object') {
      // Some payloads nest ETA as { Month, Day, Hour, Minute }
      const mm = num(eta.Month ?? eta.month);
      const dd = num(eta.Day ?? eta.day);
      const hh = num(eta.Hour ?? eta.hour);
      const mi = num(eta.Minute ?? eta.minute);
      if (mm && dd && hh != null && mi != null) {
        v.eta = `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')} UTC`;
      }
    } else {
      v.eta = String(eta);
    }
  }

  const dim = body.Dimension ?? body.dimension;
  if (dim && typeof dim === 'object') {
    v.dimensionToBow = num(dim.A ?? dim.ToBow ?? dim.toBow);
    v.dimensionToStern = num(dim.B ?? dim.ToStern ?? dim.toStern);
  }
  // updatedAt is the position time: static reports must not make an old fix look fresh
}

function handleEnvelope(raw: Buffer | ArrayBuffer | Buffer[] | string, feed: 'area' | 'world' = 'area') {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
  else text = Buffer.from(raw).toString('utf8');

  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  // The worldwide feed is quiet for hours; only the area feed counts for the silence watchdog
  if (feed === 'world') worldLastMessageAt = Date.now();
  else lastMessageAt = Date.now();
  messageCount += 1;

  const type = String(msg?.MessageType || '');
  if (type === 'SubscriptionConfirmation') {
    console.log(
      `[aisstream] subscribed compression=${msg?.Message?.CompressionEnabled ?? msg?.Message?.compressionEnabled}`
    );
    return;
  }

  const meta = msg?.MetaData || msg?.metaData;
  const mmsi = padMmsi(meta?.MMSI ?? meta?.mmsi ?? msg?.Message?.[type]?.UserID);
  if (!mmsi) return;

  const body = msg?.Message?.[type] ?? msg?.Message?.[Object.keys(msg?.Message || {})[0]];
  const v = ensureVessel(mmsi);
  v.seenAt = Date.now();
  applyMeta(v, meta);

  if (POSITION_TYPES.has(type)) {
    applyPosition(v, body);
  } else if (STATIC_TYPES.has(type)) {
    applyStatic(v, body);
    // StaticDataReport sometimes nests ReportA / ReportB
    if (body?.ReportA) applyStatic(v, body.ReportA);
    if (body?.ReportB) applyStatic(v, body.ReportB);
  }

  // Drop vessels that never got a valid position, or that left the AOI (followed ships never leave it)
  if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon) || !(inNorthAtlantic(v.lat, v.lon) || worldwideMmsi.has(mmsi))) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return;
    vesselsByMmsi.delete(mmsi);
  }
}

function forceReconnect(reason: string) {
  console.warn(`[aisstream] forcing reconnect: ${reason}`);
  connected = false;
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.terminate();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  if (apiKeyHeld) scheduleReconnect(apiKeyHeld);
}

function scheduleReconnect(apiKey: string) {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempt)) + Math.floor(Math.random() * 500);
  reconnectAttempt += 1;
  console.warn(`[aisstream] reconnect in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(apiKey);
  }, delay);
}

function connect(apiKey: string) {
  apiKeyHeld = apiKey;
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.terminate();
    } catch {
      /* ignore */
    }
    socket = null;
  }

  connected = false;
  const ws = new WebSocket(STREAM_URL, {
    perMessageDeflate: true,
  });
  socket = ws;

  const subscribeTimer = setTimeout(() => {
    console.warn(`[aisstream] not open after ${OPEN_TIMEOUT_MS / 1000}s — closing`);
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }, OPEN_TIMEOUT_MS);

  ws.on('open', () => {
    clearTimeout(subscribeTimer);
    connected = true;
    connectedAt = Date.now();
    // Treat connect as activity so the watchdog doesn't fire before first AIS msg
    if (!lastMessageAt) lastMessageAt = connectedAt;
    reconnectAttempt = 0;
    const subscription = {
      APIKey: apiKey,
      BoundingBoxes: [SUBSCRIBE_BBOX],
      FilterMessageTypes: SUBSCRIBED_TYPES,
    };
    ws.send(JSON.stringify(subscription));
    console.log(
      `[aisstream] connected — subscribed N Atlantic N of ${NORTH_ATLANTIC_BBOX.minLat}° (${SUBSCRIBE_BBOX[0]} → ${SUBSCRIBE_BBOX[1]})`
    );
  });

  ws.on('message', (data) => {
    try {
      handleEnvelope(data as any);
    } catch (e: any) {
      console.warn('[aisstream] message handler error', e?.message || e);
    }
  });

  ws.on('error', (err) => {
    console.warn('[aisstream] socket error', (err as Error)?.message || err);
  });

  ws.on('close', (code, reason) => {
    clearTimeout(subscribeTimer);
    connected = false;
    socket = null;
    console.warn(`[aisstream] closed code=${code} reason=${reason?.toString?.() || ''}`);
    scheduleReconnect(apiKey);
  });
}

function sweepStale() {
  const now = Date.now();
  let removed = 0;
  for (const [mmsi, v] of vesselsByMmsi) {
    if (now - Math.max(v.updatedAt, v.seenAt) > staleMsFor(mmsi)) {
      vesselsByMmsi.delete(mmsi);
      removed += 1;
    }
  }
  if (removed > 0) {
    console.log(`[aisstream] swept ${removed} stale vessels; cache=${vesselsByMmsi.size}`);
  }
  saveSnapshot();
}

/**
 * Warm start: the cache is written to disk every sweep and on shutdown, and reloaded
 * on start. Without it every restart empties the map outside BarentsWatch coverage
 * (e.g. the Baltic) and IMO-based sanction matches wait ~6 min for static reports.
 */
const SNAPSHOT_FILE = () => dataCache('aisstream-snapshot.json');

function saveSnapshot() {
  try {
    ensureDir(dataCache());
    const file = SNAPSHOT_FILE();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Array.from(vesselsByMmsi.values())));
    fs.renameSync(tmp, file);
  } catch (e: any) {
    console.warn('[aisstream] snapshot write failed', e?.message || e);
  }
}

function restoreSnapshot() {
  try {
    const file = SNAPSHOT_FILE();
    if (!fs.existsSync(file)) return;
    const now = Date.now();
    let restored = 0;
    for (const v of JSON.parse(fs.readFileSync(file, 'utf8')) as AisStreamVessel[]) {
      if (!v?.mmsi || vesselsByMmsi.has(v.mmsi)) continue;
      const seen = Math.max(v.updatedAt || 0, v.seenAt || 0);
      if (now - seen > staleMsFor(v.mmsi)) continue;
      vesselsByMmsi.set(v.mmsi, { ...v, seenAt: v.seenAt || seen, source: 'aisstream' });
      restored += 1;
    }
    console.log(`[aisstream] restored ${restored} vessels from ${path.basename(file)}`);
  } catch (e: any) {
    console.warn('[aisstream] snapshot restore failed', e?.message || e);
  }
}

function runWatchdog() {
  if (!apiKeyHeld) return;
  const now = Date.now();
  if (!connected || !socket) {
    // scheduleReconnect should handle this; nudge if stuck
    if (!reconnectTimer && !socket) {
      forceReconnect('watchdog: socket missing');
    }
    return;
  }
  const silentFor = now - (lastMessageAt || connectedAt || now);
  if (silentFor >= SILENCE_RECONNECT_MS) {
    forceReconnect(`no messages for ${Math.round(silentFor / 1000)}s`);
  }
}

/**
 * Second connection: the whole world, but only the followed MMSIs (AISStream allows 200 per
 * subscription and 3 connections per account). Reconnects slowly; it is quiet by nature.
 */
function connectWorldwide(apiKey: string) {
  if (!worldwideMmsi.size) return;
  const ws = new WebSocket(STREAM_URL, { perMessageDeflate: true });
  worldSocket = ws;
  const subscribeTimer = setTimeout(() => {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }, OPEN_TIMEOUT_MS);
  ws.on('open', () => {
    clearTimeout(subscribeTimer);
    worldConnected = true;
    worldAttempt = 0;
    ws.send(
      JSON.stringify({
        APIKey: apiKey,
        BoundingBoxes: [
          [
            [-90, -180],
            [90, 180],
          ],
        ],
        FiltersShipMMSI: [...worldwideMmsi].slice(0, 200),
        FilterMessageTypes: SUBSCRIBED_TYPES,
      })
    );
    console.log(`[aisstream] worldwide — following ${worldwideMmsi.size} ships`);
  });
  ws.on('message', (data) => {
    try {
      handleEnvelope(data as any, 'world');
    } catch (e: any) {
      console.warn('[aisstream] worldwide message error', e?.message || e);
    }
  });
  ws.on('error', (err) => {
    console.warn('[aisstream] worldwide socket error', (err as Error)?.message || err);
  });
  ws.on('close', (code, reason) => {
    clearTimeout(subscribeTimer);
    worldConnected = false;
    worldSocket = null;
    console.warn(`[aisstream] worldwide closed code=${code} reason=${reason?.toString?.() || ''}`);
    if (worldReconnectTimer) return;
    const delay = Math.min(10 * 60_000, 5000 * Math.pow(2, worldAttempt));
    worldAttempt += 1;
    worldReconnectTimer = setTimeout(() => {
      worldReconnectTimer = null;
      connectWorldwide(apiKey);
    }, delay);
  });
}

export function startAisStreamClient(opts?: { worldwideMmsi?: Iterable<string> }): void {
  if (started) return;
  for (const m of opts?.worldwideMmsi || []) worldwideMmsi.add(padMmsi(m));
  const apiKey = (process.env.AISSTREAM_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('[aisstream] AISSTREAM_API_KEY not set — live North Atlantic stream disabled');
    return;
  }
  started = true;
  apiKeyHeld = apiKey;
  restoreSnapshot();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      saveSnapshot();
      process.exit(0);
    });
  }
  connect(apiKey);
  connectWorldwide(apiKey);
  if (!sweepTimer) sweepTimer = setInterval(sweepStale, SWEEP_MS);
  if (!watchdogTimer) watchdogTimer = setInterval(runWatchdog, WATCHDOG_MS);
}

export function getAisStreamVessels(): AisStreamVessel[] {
  const now = Date.now();
  const out: AisStreamVessel[] = [];
  for (const v of vesselsByMmsi.values()) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    if (!inNorthAtlantic(v.lat, v.lon) && !worldwideMmsi.has(v.mmsi)) continue;
    if (!v.updatedAt || now - v.updatedAt > staleMsFor(v.mmsi)) continue;
    out.push(v);
  }
  return out;
}

export function getAisStreamStatus() {
  let west = 0;
  let withPos = 0;
  for (const v of vesselsByMmsi.values()) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    if (!inNorthAtlantic(v.lat, v.lon)) continue;
    withPos += 1;
    if (v.lon < -10) west += 1;
  }
  return {
    started,
    connected,
    cacheSize: vesselsByMmsi.size,
    withPosition: withPos,
    westOfMinus10: west,
    messageCount,
    lastMessageAt: lastMessageAt || null,
    silenceSec: lastMessageAt ? Math.round((Date.now() - lastMessageAt) / 1000) : null,
    bbox: NORTH_ATLANTIC_BBOX,
    worldwide: {
      following: worldwideMmsi.size,
      connected: worldConnected,
      withPosition: [...worldwideMmsi].filter((m) => Number.isFinite(vesselsByMmsi.get(m)?.lat)).length,
      lastMessageAt: worldLastMessageAt || null,
    },
  };
}

export function vesselLengthMeters(v: AisStreamVessel): number | null {
  if (v.dimensionToBow == null || v.dimensionToStern == null) return null;
  const len = v.dimensionToBow + v.dimensionToStern;
  return Number.isFinite(len) && len > 0 ? len : null;
}
