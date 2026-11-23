/**
 * For the GitHub Pages workflow: refresh GUR's ship and captain lists (a ~5 min crawl)
 * when the cached copy is over a day old, so the snapshot's dossiers can link straight
 * to each ship's GUR page. The API's own startup refresh skips a copy this fresh.
 *
 *   npx tsx updateGurIfStale.ts
 */
import { gurMetaAgeMs, updateGurVessels } from './gurVessels';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const age = gurMetaAgeMs();
  if (age != null && age < DAY_MS) {
    console.log(`[gur] lists are ${Math.round(age / 3600000)} h old; keeping them`);
    return;
  }
  const result = await updateGurVessels();
  console.log('[gur]', JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

main();
