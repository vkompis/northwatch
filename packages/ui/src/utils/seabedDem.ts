import maplibregl from 'maplibre-gl';
import { flattenLand } from './terrarium';
import { reliefColours, reliefGain, tileBbox3857, tintKartverketRelief, type MapTheme } from './kartverketRelief';
import { cachedTile } from './tileCache';

/**
 * Seabed-only DEM: AWS terrarium tiles with every land pixel flattened to 0 m, so a
 * hillshade over it shades the sea floor and leaves land untouched (MapLibre 3 has
 * no way to mask a hillshade by elevation or by the water polygons).
 */
const TERRARIUM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const PROTOCOL = 'seabed';
export const SEABED_DEM_TILES = `${PROTOCOL}://{z}/{x}/{y}`;

let registered = false;

async function loadSeabedTile(path: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(`${TERRARIUM_BASE}/${path}.png`, { signal });
  if (!res.ok) throw new Error(`Terrain tile ${path}: HTTP ${res.status}`);
  // No colour management or premultiplication — the RGB values are elevations
  const bitmap = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  flattenLand(image.data);
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

export function registerSeabedProtocol(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;
  maplibregl.addProtocol(PROTOCOL, (params, callback) => {
    const controller = new AbortController();
    loadSeabedTile(params.url.slice(`${PROTOCOL}://`.length), controller.signal)
      .then((data) => callback(null, data, null, null))
      .catch((e) => {
        if (!controller.signal.aborted) callback(e instanceof Error ? e : new Error(String(e)));
      });
    return { cancel: () => controller.abort() };
  });
}

/** Kartverket seabed hillshade, recoloured to the DEM relief's colours (see kartverketRelief.ts). */
const KV_RELIEF_WMS = 'https://wms.geonorge.no/skwms1/wms.havbunnraster3';
const KV_PROTOCOL = 'kvrelief';
/** The theme is part of the tile URL, so switching it fetches tiles in the other colours. */
export const kartverketReliefTiles = (theme: MapTheme) => `${KV_PROTOCOL}://${theme}/{z}/{x}/{y}`;

let kvRegistered = false;

async function loadKartverketReliefTile(path: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const [themePart, ...xyz] = path.split('/');
  const theme: MapTheme = themePart === 'light' ? 'light' : 'dark';
  const [z, x, y] = xyz.map(Number);
  // 512 px for a 256 px tile: crisp on high-density screens
  const url =
    `${KV_RELIEF_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=bare_skygge&STYLES=` +
    `&CRS=EPSG:3857&BBOX=${tileBbox3857(z, x, y).join(',')}&WIDTH=512&HEIGHT=512` +
    '&FORMAT=image/png&TRANSPARENT=TRUE';
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Kartverket relief ${path}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  tintKartverketRelief(image.data, reliefColours(theme), reliefGain(z));
  ctx.putImageData(image, 0, 0);
  // WebP: a tenth of the PNG's size, and these are shaded relief where it does not show
  return (await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })).arrayBuffer();
}

export function registerKartverketReliefProtocol(): void {
  if (kvRegistered || typeof window === 'undefined') return;
  kvRegistered = true;
  maplibregl.addProtocol(KV_PROTOCOL, (params, callback) => {
    const controller = new AbortController();
    const path = params.url.slice(`${KV_PROTOCOL}://`.length);
    cachedTile(`${KV_PROTOCOL}/${path}`, () => loadKartverketReliefTile(path, controller.signal))
      .then((data) => callback(null, data, null, null))
      .catch((e) => {
        if (!controller.signal.aborted) callback(e instanceof Error ? e : new Error(String(e)));
      });
    return { cancel: () => controller.abort() };
  });
}

/** A plain WMS tile, kept in the browser because the service sends "no-store". */
const CACHED_PROTOCOL = 'nwcached';
export const cachedTileUrl = (url: string) => `${CACHED_PROTOCOL}://${url}`;

let cachedRegistered = false;

export function registerCachedTileProtocol(): void {
  if (cachedRegistered || typeof window === 'undefined') return;
  cachedRegistered = true;
  maplibregl.addProtocol(CACHED_PROTOCOL, (params, callback) => {
    const controller = new AbortController();
    const url = params.url.slice(`${CACHED_PROTOCOL}://`.length);
    cachedTile(url, async () => {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);
      return res.arrayBuffer();
    })
      .then((data) => callback(null, data, null, null))
      .catch((e) => {
        if (!controller.signal.aborted) callback(e instanceof Error ? e : new Error(String(e)));
      });
    return { cancel: () => controller.abort() };
  });
}
