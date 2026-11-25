/**
 * Saves the API responses the map reads into static files for the GitHub Pages
 * copy (.github/workflows/pages.yml). Each response is written at its API path
 * without the query, so the static site can use the out dir as its API base.
 *
 *   npx tsx writeSiteSnapshot.ts <api base> <out dir>
 *
 * SNAPSHOT_COLLECT_SECONDS (default 180) is how long to let AISStream fill the
 * vessel cache before saving.
 */
import fs from 'fs';
import path from 'path';
import { dataCache, dataSource, ensureDir } from './paths';
import {
  mergeStoredTracks,
  STORED_TRACK_DAYS,
  storedFromApi,
  type StoredFix,
  type StoredTrack,
} from '../packages/ui/src/utils/snapshotTrack';

/** Requests the map makes on load, with the query it sends. */
const ENDPOINTS = [
  '/api/health',
  '/api/live-positions',
  '/api/gfw/events?hours=720',
  '/api/gfw/detections?hours=720',
  '/api/navwarnings?scope=all',
  '/api/gps-interference',
  '/api/incidents/live',
  '/api/petroleum/moveable',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  return { status: res.status, body: await res.json() };
}

async function waitForApi(base: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(2_000);
  }
  throw new Error(`API at ${base} did not start`);
}

/** GFW loads in the background and answers `meta.loading` until it is done. */
async function capture(url: string): Promise<{ status: number; body: any }> {
  let last = await getJson(url);
  for (let i = 0; i < 12 && last.body?.meta?.loading; i++) {
    await sleep(15_000);
    last = await getJson(url);
  }
  return last;
}

/** A track BarentsWatch answered for less than this long ago only needs the last day added */
const TRACK_TOP_UP_MS = 20 * 3600e3;
const TRACK_SHIPS_MAX = 150;

/** No flagged ship (tankers, cargo, tugs, research) does this; a fix reporting it is spoofed */
const TRACK_MAX_KN = 50;
/** A spoofing finding this close to the fix makes the fix itself suspect */
const SPOOF_NEAR_MS = 3600e3;
/** Saved fixes this close to a spoofed position are the same fake spot */
const FAKE_SPOT_KM = 3;

function km(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The live position is spoofed when the spoofing checks found something around its time */
function spoofedNow(v: any): boolean {
  const t = Date.parse(String(v.timestamp ?? ''));
  return (Array.isArray(v.spoofing) ? v.spoofing : []).some(
    (r: any) => Number.isFinite(t) && Math.abs(Date.parse(r?.at) - t) <= SPOOF_NEAR_MS
  );
}

/**
 * Drops fixes no real ship reports (an impossible speed) and, while the ship is spoofed, the
 * fixes saved at its fake spot. GPS spoofing in the Gulf of Finland puts ships hundreds of km
 * inland, and a track through them would draw lines across Russia.
 */
function withoutFakeFixes(track: StoredTrack, fakeSpot: [number, number] | null): StoredTrack {
  const points = track.points.filter(
    (p) => !(p[3] != null && p[3] >= TRACK_MAX_KN) && !(fakeSpot && km([p[1], p[2]], fakeSpot) <= FAKE_SPOT_KM)
  );
  return points.length === track.points.length ? track : { ...track, points };
}

/** The ship's position in this snapshot as a track fix (not a GFW last-seen or spoofed position) */
function liveFix(v: any): StoredFix | null {
  const t = Date.parse(String(v.timestamp ?? ''));
  if (v.lastSeenOnly || spoofedNow(v) || !Number.isFinite(t) || !Number.isFinite(v.lon) || !Number.isFinite(v.lat)) {
    return null;
  }
  const n = (x: unknown) => (x != null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
  return [Math.round(t / 1000), Number(v.lon.toFixed(5)), Number(v.lat.toFixed(5)), n(v.speed), n(v.course)];
}

/**
 * Saves the track of each flagged or research ship at api/tracks/<mmsi>
 * (packages/ui/src/utils/snapshotTrack.ts): BarentsWatch history in Norwegian
 * waters, plus the position each run sees, so ships the other feeds hear (the
 * Baltic through Digitraffic, open sea through AISStream) get a track too. The
 * last run's tracks wait in data/cache/site-tracks (kept by pages.yml), so a run
 * only asks BarentsWatch for the last day.
 */
async function writeTracks(base: string, outDir: string, vessels: any[]): Promise<void> {
  const cacheDir = dataCache('site-tracks');
  const outTracks = path.join(outDir, 'api/tracks');
  ensureDir(cacheDir);
  ensureDir(outTracks);
  const now = Date.now();
  const queue = vessels
    .filter((v) => v.sanctioned || v.shadowfleet || v.sanctionedMaster || v.research)
    .slice(0, TRACK_SHIPS_MAX);
  const ships = queue.length;
  let published = 0;
  let failed = 0;
  let firstError = '';

  async function worker() {
    for (let v = queue.shift(); v; v = queue.shift()) {
      const cached = path.join(cacheDir, `${v.mmsi}.json`);
      let prev: StoredTrack | null = null;
      try {
        prev = JSON.parse(fs.readFileSync(cached, 'utf8'));
      } catch {
        /* first time this ship is saved */
      }
      const topUp = prev && now - Date.parse(prev.updated) < TRACK_TOP_UP_MS;
      const q = new URLSearchParams({ mmsi: v.mmsi, days: String(topUp ? 1 : STORED_TRACK_DAYS), interval: '15' });
      // BarentsWatch only knows Norwegian waters. The first 14 days show whether a ship now in the
      // Baltic was off Norway lately; after that, ask only while BarentsWatch hears the ship.
      const askBw = !prev || !(Date.parse(prev.updated) > 0) || /barentswatch|\bbw\b/.test(String(v.source));
      let fetched: StoredTrack | null = null;
      if (askBw) {
        try {
          const { status, body } = await getJson(`${base}/api/tracks24h?${q}`);
          if (status !== 200) throw new Error(`${status} ${body?.error || ''}`.trim());
          fetched = storedFromApi(v.mmsi, body, now);
        } catch (e: any) {
          failed++;
          firstError ||= e?.message || String(e);
        }
      }
      const fix = liveFix(v);
      const next: StoredTrack = fetched || {
        mmsi: v.mmsi,
        intervalMin: prev?.intervalMin || 15,
        updated: prev?.updated || new Date(0).toISOString(),
        spoofing: [],
        points: [],
      };
      if (fix) next.points.push(fix);
      const fakeSpot: [number, number] | null = spoofedNow(v) ? [v.lon, v.lat] : null;
      const track = withoutFakeFixes(mergeStoredTracks(prev, next, now), fakeSpot);
      fs.writeFileSync(cached, JSON.stringify(track));
      // One position is not a track yet
      if (track.points.length >= 2) {
        fs.writeFileSync(path.join(outTracks, v.mmsi), JSON.stringify(track));
        published++;
      }
    }
  }
  await Promise.all([1, 2, 3].map(worker));

  // A ship gone from the map keeps its track until its last position is 14 days old. One with
  // no position yet (all spoofed, say) stays a day, so BarentsWatch is not asked again each run.
  for (const name of fs.readdirSync(cacheDir)) {
    const file = path.join(cacheDir, name);
    try {
      const { points, updated } = JSON.parse(fs.readFileSync(file, 'utf8'));
      const last = points?.[points.length - 1]?.[0];
      if (last * 1000 > now - STORED_TRACK_DAYS * 24 * 3600e3) continue;
      if (!points?.length && now - Date.parse(updated) < 24 * 3600e3) continue;
    } catch {
      /* unreadable: drop it */
    }
    fs.rmSync(file, { force: true });
  }
  console.log(
    `[snapshot] tracks for ${published} of ${ships} flagged ships` +
      (failed ? `; ${failed} fetches failed (first: ${firstError})` : '')
  );
}

async function main() {
  const [base, outDir] = process.argv.slice(2);
  if (!base || !outDir) throw new Error('usage: writeSiteSnapshot.ts <api base> <out dir>');
  const collectMs = Number(process.env.SNAPSHOT_COLLECT_SECONDS || 180) * 1000;

  await waitForApi(base);
  // Start the slow upstream loads (GFW scans) while AISStream collects
  await Promise.allSettled(ENDPOINTS.map((p) => getJson(`${base}${p}`)));
  console.log(`[snapshot] collecting AIS for ${collectMs / 1000}s`);
  await sleep(collectMs);

  let vessels: any[] = [];
  for (const endpoint of ENDPOINTS) {
    const { status, body } = await capture(`${base}${endpoint}`);
    const file = path.join(outDir, endpoint.split('?')[0]);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(body));
    const size = Array.isArray(body) ? `${body.length} items` : `${JSON.stringify(body).length} bytes`;
    console.log(`[snapshot] ${endpoint} -> ${status}, ${size}`);
    if (endpoint === '/api/live-positions') {
      // Research ships drawn at their last GFW position are there without any AIS feed
      if (!(Array.isArray(body) && body.some((v) => !v.lastSeenOnly))) {
        // Keep the last good site instead of publishing an empty map
        throw new Error('no live AIS positions; check the AIS secrets');
      }
      vessels = body;
    }
  }

  // The dossier's list entries (with links straight to each ship's GUR / OpenSanctions
  // page) for every flagged ship, keyed by MMSI; the live API looks them up per click
  const lookups: Record<string, any> = {};
  for (const v of vessels.filter((v) => v.sanctioned || v.shadowfleet || v.sanctionedMaster)) {
    const q = new URLSearchParams({ mmsi: v.mmsi, ...(v.imo ? { imo: v.imo } : {}) });
    const { body } = await getJson(`${base}/api/sanctions/lookup?${q}`);
    // GUR's captain list names people; keep the entry and its link, not the name
    for (const l of body?.listings || []) if (l.kind === 'master') l.detail = null;
    lookups[v.mmsi] = body;
  }
  ensureDir(path.join(outDir, 'api/sanctions'));
  fs.writeFileSync(path.join(outDir, 'api/sanctions/lookups'), JSON.stringify(lookups));
  console.log(`[snapshot] list entries for ${Object.keys(lookups).length} flagged ships`);

  await writeTracks(base, outDir, vessels);

  fs.cpSync(dataSource('overlays'), path.join(outDir, 'overlays'), { recursive: true });
  console.log('[snapshot] copied overlays');
}

main().catch((e) => {
  console.error('[snapshot] failed:', e?.message || e);
  process.exit(1);
});
