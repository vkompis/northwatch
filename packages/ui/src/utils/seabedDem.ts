import maplibregl from 'maplibre-gl';
import { flattenLand } from './terrarium';
import { RELIEF_COLOURS, reliefGain, tileBbox3857, tintKartverketRelief, type Rgb } from './kartverketRelief';

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
export const KV_RELIEF_TILES = `${KV_PROTOCOL}://{z}/{x}/{y}`;

let kvRegistered = false;
let kvColours = RELIEF_COLOURS;

/** Match the basemap's water fill; tiles drawn after this use it. */
export function setKartverketReliefWater(water: Rgb | null): void {
  if (water) kvColours = { ...RELIEF_COLOURS, water };
}

async function loadKartverketReliefTile(path: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const [z, x, y] = path.split('/').map(Number);
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
  tintKartverketRelief(image.data, kvColours, reliefGain(z));
  ctx.putImageData(image, 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

export function registerKartverketReliefProtocol(): void {
  if (kvRegistered || typeof window === 'undefined') return;
  kvRegistered = true;
  maplibregl.addProtocol(KV_PROTOCOL, (params, callback) => {
    const controller = new AbortController();
    loadKartverketReliefTile(params.url.slice(`${KV_PROTOCOL}://`.length), controller.signal)
      .then((data) => callback(null, data, null, null))
      .catch((e) => {
        if (!controller.signal.aborted) callback(e instanceof Error ? e : new Error(String(e)));
      });
    return { cancel: () => controller.abort() };
  });
}
