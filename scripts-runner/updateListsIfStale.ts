/**
 * For the GitHub Pages workflow: refresh the ship lists the API reads when the copy kept
 * in the Actions cache is too old. Every run starts the API afresh, and its own startup
 * refresh would either repeat every half hour (sanctions) or never finish in a short run
 * (GUR, FleetLeaks); with fresh copies it does nothing. The lists come from different
 * sites, so they refresh side by side.
 *
 *   npx tsx updateListsIfStale.ts
 */
import fs from 'fs';
import { fleetleaksAgeMs, updateFleetleaks } from './fleetleaks';
import { gurMetaAgeMs, updateGurVessels } from './gurVessels';
import { dataCache, ensureDir } from './paths';
import { metaAgeMs, updateEuDesignatedVessels } from './sanctionsUpdater';

const DAY_MS = 24 * 60 * 60 * 1000;
/** When each list was last tried, kept in the cache too, so a site that keeps failing is asked once a period, not every run */
const ATTEMPTS_FILE = dataCache('list-attempts.json');

type List = {
  name: string;
  maxAgeMs: number;
  ageMs: () => number | null;
  update: () => Promise<{ ok: boolean; error?: string }>;
};

// At most once a day; FleetLeaks weekly, as the API does, since it asks for 30 s between pages
const LISTS: List[] = [
  { name: 'sanctions', maxAgeMs: DAY_MS, ageMs: metaAgeMs, update: updateEuDesignatedVessels },
  { name: 'gur', maxAgeMs: DAY_MS, ageMs: gurMetaAgeMs, update: updateGurVessels },
  { name: 'fleetleaks', maxAgeMs: 7 * DAY_MS, ageMs: fleetleaksAgeMs, update: updateFleetleaks },
];

function readAttempts(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(ATTEMPTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function refresh(list: List, attempts: Record<string, string>): Promise<boolean> {
  const hours = (ms: number) => Math.round(ms / 3600000);
  const age = list.ageMs();
  if (age != null && age < list.maxAgeMs) {
    console.log(`[${list.name}] ${hours(age)} h old; keeping it`);
    return true;
  }
  const tried = Date.now() - Date.parse(attempts[list.name] || '');
  if (tried < list.maxAgeMs) {
    console.log(`[${list.name}] stale, but last tried ${hours(tried)} h ago; keeping the old copy`);
    return true;
  }
  attempts[list.name] = new Date().toISOString();
  try {
    const result = await list.update();
    console.log(`[${list.name}] refreshed ok=${result.ok}${result.error ? ` ${result.error}` : ''}`);
    return result.ok;
  } catch (e: any) {
    console.warn(`[${list.name}] refresh failed`, e?.message || e);
    return false;
  }
}

async function main() {
  const attempts = readAttempts();
  const results = await Promise.all(LISTS.map((list) => refresh(list, attempts)));
  ensureDir(dataCache());
  fs.writeFileSync(ATTEMPTS_FILE, JSON.stringify(attempts));
  // A failed list keeps its older copy; flag the step so the run shows it
  if (results.includes(false)) process.exitCode = 1;
}

main();
