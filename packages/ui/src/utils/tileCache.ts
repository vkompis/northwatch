/**
 * Keeps map tiles in the viewer's browser. Kartverket's WMS sends "no-store", so without this every
 * visit downloads every tile again. Costs nothing on any server, and only the viewer's own disk.
 *
 * Bump the version when the tiles' look changes, such as the relief colours, to drop the old ones.
 */
const CACHE_NAME = 'northwatch-tiles-v1';
const STORED_AT = 'x-northwatch-stored-at';
/** New chart and seabed data reach viewers within a month */
const MAX_AGE_MS = 30 * 24 * 3600e3;
const MAX_TILES = 3000;
const PRUNE_DELAY_MS = 15_000;

const keyUrl = (key: string) => `https://tiles.northwatch.invalid/${encodeURIComponent(key)}`;

let opened: Promise<Cache | null> | null = null;

/** Cache storage is missing on plain http and can be refused in private windows: then just fetch. */
function openCache(): Promise<Cache | null> {
  if (!opened) {
    opened = (async () => {
      if (typeof caches === 'undefined') return null;
      const cache = await caches.open(CACHE_NAME);
      setTimeout(() => void pruneTileCache(cache), PRUNE_DELAY_MS);
      return cache;
    })().catch(() => null);
  }
  return opened;
}

/** The tile from the browser if it is there and not too old, otherwise from `load`, then stored. */
export async function cachedTile(key: string, load: () => Promise<ArrayBuffer>, now = Date.now()): Promise<ArrayBuffer> {
  const cache = await openCache();
  if (!cache) return load();
  const url = keyUrl(key);
  try {
    const hit = await cache.match(url);
    if (hit && now - Number(hit.headers.get(STORED_AT)) < MAX_AGE_MS) return await hit.arrayBuffer();
  } catch {
    /* read problems only cost a download */
  }
  const data = await load();
  // Not awaited: the map should not wait for the disk
  void cache
    .put(url, new Response(data.slice(0), { headers: { [STORED_AT]: String(now) } }))
    .catch(() => undefined);
  return data;
}

/** Drop tiles past their age, and the oldest ones over the limit. */
export async function pruneTileCache(cache: Cache, now = Date.now()): Promise<void> {
  try {
    // keys() lists oldest first
    const keys = await cache.keys();
    const over = keys.length - MAX_TILES;
    await Promise.all(
      keys.map(async (request, i) => {
        const stored = Number((await cache.match(request))?.headers.get(STORED_AT));
        if (i < over || !(now - stored < MAX_AGE_MS)) await cache.delete(request);
      })
    );
  } catch {
    /* tidied up next visit */
  }
}

/** Forget the opened cache (tests). */
export function resetTileCacheForTests(): void {
  opened = null;
}
