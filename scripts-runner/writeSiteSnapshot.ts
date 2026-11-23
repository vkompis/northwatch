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
import { dataSource, ensureDir } from './paths';

/** Requests the map makes on load, with the query it sends. */
const ENDPOINTS = [
  '/api/health',
  '/api/live-positions',
  '/api/gfw/events?hours=720',
  '/api/gfw/detections?hours=720',
  '/api/navwarnings?scope=all',
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

async function main() {
  const [base, outDir] = process.argv.slice(2);
  if (!base || !outDir) throw new Error('usage: writeSiteSnapshot.ts <api base> <out dir>');
  const collectMs = Number(process.env.SNAPSHOT_COLLECT_SECONDS || 180) * 1000;

  await waitForApi(base);
  // Start the slow upstream loads (GFW scans) while AISStream collects
  await Promise.allSettled(ENDPOINTS.map((p) => getJson(`${base}${p}`)));
  console.log(`[snapshot] collecting AIS for ${collectMs / 1000}s`);
  await sleep(collectMs);

  for (const endpoint of ENDPOINTS) {
    const { status, body } = await capture(`${base}${endpoint}`);
    const file = path.join(outDir, endpoint.split('?')[0]);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(body));
    const size = Array.isArray(body) ? `${body.length} items` : `${JSON.stringify(body).length} bytes`;
    console.log(`[snapshot] ${endpoint} -> ${status}, ${size}`);
    if (endpoint === '/api/live-positions' && !(Array.isArray(body) && body.length > 0)) {
      // Keep the last good site instead of publishing an empty map
      throw new Error('no live positions; check the AIS secrets');
    }
  }

  fs.cpSync(dataSource('overlays'), path.join(outDir, 'overlays'), { recursive: true });
  console.log('[snapshot] copied overlays');
}

main().catch((e) => {
  console.error('[snapshot] failed:', e?.message || e);
  process.exit(1);
});
