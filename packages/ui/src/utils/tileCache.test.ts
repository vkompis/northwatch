import assert from 'node:assert/strict';
import { cachedTile, pruneTileCache, resetTileCacheForTests } from './tileCache.ts';

/** Enough of the browser's Cache storage to test against */
class FakeCache {
  store = new Map<string, Response>();
  async match(req: string | { url: string }) {
    return this.store.get(typeof req === 'string' ? req : req.url)?.clone();
  }
  async put(url: string, res: Response) {
    this.store.set(url, res);
  }
  async delete(req: string | { url: string }) {
    return this.store.delete(typeof req === 'string' ? req : req.url);
  }
  async keys() {
    return [...this.store.keys()].map((url) => ({ url }));
  }
}

const bytes = (n: number) => new Uint8Array([n]).buffer;
const first = (b: ArrayBuffer) => new Uint8Array(b)[0];
const tick = () => new Promise((r) => setTimeout(r, 0));
const DAY = 24 * 3600e3;
const NOW = Date.parse('2026-10-30T00:00:00Z');

async function main() {
  // Without cache storage (plain http) it just loads
  {
    resetTileCacheForTests();
    assert.equal(first(await cachedTile('a', async () => bytes(1), NOW)), 1);
  }

  const fake = new FakeCache();
  (globalThis as any).caches = { open: async () => fake };
  resetTileCacheForTests();
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, ms?: number) => (ms ? (undefined as any) : realSetTimeout(fn, 0));

  let loads = 0;
  const load = (n: number) => async () => {
    loads++;
    return bytes(n);
  };

  // First visit loads and stores, the next comes from the browser
  assert.equal(first(await cachedTile('tile', load(7), NOW)), 7);
  await tick();
  assert.equal(first(await cachedTile('tile', load(8), NOW + DAY)), 7);
  assert.equal(loads, 1);

  // After a month it is fetched again
  assert.equal(first(await cachedTile('tile', load(9), NOW + 31 * DAY)), 9);
  assert.equal(loads, 2);
  await tick();

  // A failed download is passed on and not stored
  await assert.rejects(cachedTile('bad', async () => {
    throw new Error('HTTP 500');
  }, NOW));
  assert.equal([...fake.store.keys()].some((k) => k.includes('bad')), false);

  // Storage trouble never breaks the map
  {
    const broken = new FakeCache();
    broken.match = async () => {
      throw new Error('read failed');
    };
    broken.put = async () => {
      throw new Error('quota');
    };
    (globalThis as any).caches = { open: async () => broken };
    resetTileCacheForTests();
    assert.equal(first(await cachedTile('x', load(3), NOW)), 3);
    await tick();
    (globalThis as any).caches = {
      open: async () => {
        throw new Error('refused');
      },
    };
    resetTileCacheForTests();
    assert.equal(first(await cachedTile('y', load(4), NOW)), 4);
  }

  // Pruning drops old tiles, then the oldest over the limit
  {
    const c = new FakeCache();
    await c.put('old', new Response('x', { headers: { 'x-northwatch-stored-at': String(NOW - 40 * DAY) } }));
    for (let i = 0; i < 3005; i++) await c.put(`t${i}`, new Response('x', { headers: { 'x-northwatch-stored-at': String(NOW - DAY) } }));
    await pruneTileCache(c as unknown as Cache, NOW);
    assert.equal(c.store.has('old'), false);
    assert.equal(c.store.has('t0'), false, 'over the limit');
    assert.equal(c.store.has('t3004'), true);
    assert.equal(c.store.size, 3000);
  }

  (globalThis as any).setTimeout = realSetTimeout;
  console.log('tileCache.test.ts: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
