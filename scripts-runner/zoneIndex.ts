/**
 * Fast point-in-polygon for the big zone polygons. Norway's EEZ has about 120 000 points, and
 * testing every point for thousands of ships on each refresh held up the whole API for seconds.
 * Edges are sorted into latitude bands, so a test only looks at the edges at the ship's latitude.
 * Even-odd ray casting, so holes and separate parts need no special handling.
 */
const BAND_DEG = 0.1;

export type ZoneTest = (lon: number, lat: number) => boolean;

/** A test for a Polygon or MultiPolygon, or null for any other geometry. */
export function makeZoneTest(geom: any): ZoneTest | null {
  const polygons: number[][][][] | null =
    geom?.type === 'Polygon' ? [geom.coordinates] : geom?.type === 'MultiPolygon' ? geom.coordinates : null;
  if (!polygons) return null;
  const bands = new Map<number, number[]>();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i++) {
        const [x1, y1] = ring[i - 1];
        const [x2, y2] = ring[i];
        const last = Math.floor(Math.max(y1, y2) / BAND_DEG);
        for (let b = Math.floor(Math.min(y1, y2) / BAND_DEG); b <= last; b++) {
          let edges = bands.get(b);
          if (!edges) bands.set(b, (edges = []));
          edges.push(x1, y1, x2, y2);
        }
      }
    }
  }
  return (lon, lat) => {
    const edges = bands.get(Math.floor(lat / BAND_DEG));
    if (!edges) return false;
    let inside = false;
    for (let i = 0; i < edges.length; i += 4) {
      const y1 = edges[i + 1];
      const y2 = edges[i + 3];
      if (y1 > lat !== y2 > lat && lon < edges[i] + ((lat - y1) * (edges[i + 2] - edges[i])) / (y2 - y1)) inside = !inside;
    }
    return inside;
  };
}
