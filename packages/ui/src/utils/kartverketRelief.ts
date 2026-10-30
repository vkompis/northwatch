/**
 * Kartverket's seabed hillshade (WMS "havbunnraster3", layer bare_skygge: 50 m, and 25 / 5 m
 * where surveyed outside 12 nm) recoloured to the map's own relief. Kartverket shades in grey
 * with level seabed at 180 (sun 45° up); we paint the water colour and blend in the shadow and
 * highlight colours the DEM relief uses. Covered pixels come out opaque, so they replace the
 * coarser DEM relief beneath; where Kartverket has no data the tile stays transparent.
 */

export type Rgb = [number, number, number];

export type ReliefColours = {
  water: Rgb;
  shadow: Rgb;
  shadowAlpha: number;
  highlight: Rgb;
  highlightAlpha: number;
};

export type MapTheme = 'dark' | 'light';

/** Same as the DEM relief's hillshade paint, over the basemap's water-fill. */
export const RELIEF_COLOURS: ReliefColours = {
  water: [6, 22, 41],
  shadow: [0, 4, 12],
  shadowAlpha: 0.9,
  highlight: [120, 160, 200],
  highlightAlpha: 0.35,
};

/** Light map: soft blue-grey shadows and white light over the near-white sea. */
export const RELIEF_COLOURS_LIGHT: ReliefColours = {
  water: [245, 247, 248],
  shadow: [60, 80, 100],
  shadowAlpha: 0.4,
  highlight: [255, 255, 255],
  highlightAlpha: 0.55,
};

export const reliefColours = (theme: MapTheme): ReliefColours =>
  theme === 'light' ? RELIEF_COLOURS_LIGHT : RELIEF_COLOURS;

/** Kartverket's grey for level seabed, and the deviation that counts as full shade. */
const FLAT = 180;
const FULL = 75;

/**
 * Kartverket's shading is subtle at country zoom (50 m cells spread over a wide tile);
 * lift it there so it reads like the DEM relief next to it, less when zoomed in.
 */
export function reliefGain(zoom: number): number {
  if (zoom <= 6) return 3;
  if (zoom >= 12) return 1.6;
  return 3 - ((zoom - 6) / 6) * 1.4;
}

const mix = (a: number, b: number, f: number) => Math.round(a + (b - a) * f);

/** Recolour Kartverket grey shading in place (RGBA). Transparent pixels are left alone. */
export function tintKartverketRelief(px: Uint8ClampedArray, colours: ReliefColours, gain: number): void {
  const { water, shadow, highlight } = colours;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const t = ((px[i] - FLAT) / FULL) * gain;
    const [toward, f] =
      t < 0 ? [shadow, Math.min(1, -t) * colours.shadowAlpha] : [highlight, Math.min(1, t) * colours.highlightAlpha];
    px[i] = mix(water[0], toward[0], f);
    px[i + 1] = mix(water[1], toward[1], f);
    px[i + 2] = mix(water[2], toward[2], f);
  }
}

/** Web Mercator bounds of an XYZ tile, as WMS BBOX (minx,miny,maxx,maxy). */
export function tileBbox3857(z: number, x: number, y: number): [number, number, number, number] {
  const half = Math.PI * 6378137;
  const size = (2 * half) / 2 ** z;
  return [-half + x * size, half - (y + 1) * size, -half + (x + 1) * size, half - y * size];
}
