/**
 * Navigational warning text → map geometry.
 *
 * Kystverket's position field is a bag of points sorted by longitude (or the whole
 * NAVAREA for warnings it could not place). Whether those positions bound an area,
 * follow a route or mark a circle — and in which order — is only in the text.
 */

export type LonLat = [number, number];
export type WarningShape = 'area' | 'circle' | 'route' | 'points';
export type WarningGeometry =
  | { type: 'Polygon'; coordinates: LonLat[][] }
  | { type: 'LineString'; coordinates: LonLat[] }
  | { type: 'Point'; coordinates: LonLat }
  | { type: 'MultiPoint'; coordinates: LonLat[] };
export type WarningPart = { shape: WarningShape; geometry: WarningGeometry };

type Found = { lonlat: LonLat; start: number; end: number };

// 72-32.46N 020-21.45E · 64-20.3N 011-15.8E · 70 12,5N 020 01,0E · 64°20.3'N 011°15.8'E
const DM_RE =
  /(?<![\d.,])(\d{1,2})\s*[-°\s]\s*(\d{1,2}(?:[.,]\d+)?)\s*['′]?\s*([NS])(?![A-Za-z])[\s,/]*(\d{1,3})\s*[-°\s]\s*(\d{1,2}(?:[.,]\d+)?)\s*['′]?\s*([EW])(?![A-Za-z])/g;
// 7012.5N 02001.0E
const COMPACT_RE =
  /(?<![\d.,])(\d{2})(\d{2}(?:[.,]\d+)?)([NS])[\s,/]*(\d{3})(\d{2}(?:[.,]\d+)?)([EW])(?![A-Za-z])/g;

function degrees(deg: string, min: string, hemi: string, maxDeg: number): number | null {
  const d = Number(deg);
  const m = Number(min.replace(',', '.'));
  if (!Number.isFinite(d) || !Number.isFinite(m) || m >= 60 || d > maxDeg) return null;
  const v = d + m / 60;
  if (v > maxDeg) return null;
  return hemi === 'S' || hemi === 'W' ? -v : v;
}

/** Every degrees–minutes position in the text, in reading order. */
export function findWarningPositions(text: string): Found[] {
  const found: Found[] = [];
  for (const re of [DM_RE, COMPACT_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const lat = degrees(m[1], m[2], m[3], 90);
      const lon = degrees(m[4], m[5], m[6], 180);
      if (lat == null || lon == null) continue;
      const start = m.index ?? 0;
      found.push({ lonlat: [round6(lon), round6(lat)], start, end: start + m[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start);
  return found.filter((f, i) => i === 0 || f.start >= found[i - 1].end);
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** "A. ", "b) ", "(2) ", "3. " directly in front of a position. */
const TRAILING_LABEL_RE = /(?:^|[\s.,;:])\(?(?:[A-Za-z]|\d{1,2}|[ivx]{1,4})[.)]\s*$/;
const CONNECTOR_RE = /\b(?:AND|TO|THEN|THENCE|OG|TIL)\b/gi;

/** What sits between two positions: nothing (same list), a list label, or other words. */
function gapKind(gap: string): 'join' | 'label' | 'break' {
  const labelled = TRAILING_LABEL_RE.test(gap);
  const rest = gap
    .replace(TRAILING_LABEL_RE, ' ')
    .replace(CONNECTOR_RE, ' ')
    .replace(/[\s,;:.\-–—/()]+/g, '');
  if (rest) return 'break';
  return labelled ? 'label' : 'join';
}

/** The last line of text before a list of positions, e.g. "AREA BOUNDED BY POSITIONS:". */
function leadLine(gap: string): string {
  const lines = gap
    .split(/\n/)
    .map((l) => l.replace(TRAILING_LABEL_RE, '').trim())
    .filter((l) => /[A-Za-zÆØÅæøå]{2,}/.test(l));
  return lines[lines.length - 1] || '';
}

const BOUNDED_RE = /\b(?:BOUNDED|BOUNDARIES|ENCLOSED|POLYGON|AVGRENSET|AVGRENSA)\b/i;
const ROUTE_RE =
  /\b(?:ROUTES?|TRACKS?|LINES?|JOINING|ALONG|TOWING|TOW|RUTE|LINJE|LANGS|TRASÉ|TRASE)\b|\b(?:BETWEEN|MELLOM)\s*(?:POSITIONS?|POINTS?|POSISJONENE)?\s*:?\s*$/i;
const AREA_RE = /\b(?:AREAS?|ZONES?|BOX|WITHIN|OMRÅDE|OMRÅDET|FELT|INNENFOR)\b/i;

const UNIT =
  String.raw`(NM|NMI|N\.\s?M\.?|NAUTICAL\s+MILES?|NAUTISKE?\s+MIL|CABLES?|KABELLENGDER?|KM|KILOMET(?:RE|ER)S?|MET(?:RE|ER)S?|M)`;
const RADIUS_BEFORE_RE = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s*${UNIT}\.?\s*(?:RADIUS|SAFETY\s+ZONE|OF|FROM|AROUND|RUNDT|FRA)\b`,
  'i'
);
const RADIUS_AFTER_RE = new RegExp(String.raw`\bRADIUS\s*(?:OF\s*)?(\d+(?:[.,]\d+)?)\s*${UNIT}(?![A-Za-z])`, 'i');

function unitMetres(unit: string): number {
  const u = unit.toUpperCase().replace(/\s+/g, ' ');
  if (/^(NM|NMI|N\.)/.test(u) || u.startsWith('NAUTIC') || u.startsWith('NAUTISK')) return 1852;
  if (u.startsWith('CABLE') || u.startsWith('KABEL')) return 185.2;
  if (u === 'KM' || u.startsWith('KILOMET')) return 1000;
  return 1;
}

/** Radius in metres stated around the positions ("within 2 NM radius of", "radius 500 m"). */
export function radiusMetres(text: string): number | null {
  const m = RADIUS_AFTER_RE.exec(text) || RADIUS_BEFORE_RE.exec(text);
  if (!m) return null;
  const metres = Number(m[1].replace(',', '.')) * unitMetres(m[2]);
  // Under 100 m it would vanish on the map; beyond 100 NM it describes an area, not a circle
  return metres >= 100 && metres <= 100 * 1852 ? metres : null;
}

/** Polygon approximating a circle on the sphere. */
export function circlePolygon([lon, lat]: LonLat, metres: number, steps = 48): LonLat[] {
  const R = 6371008.8;
  const d = metres / R;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const ring: LonLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const θ = (2 * Math.PI * (i % steps)) / steps;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
    ring.push([round6((λ2 * 180) / Math.PI), round6((φ2 * 180) / Math.PI)]);
  }
  return ring;
}

function distinct(points: LonLat[]): LonLat[] {
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

function closedRing(points: LonLat[]): LonLat[] | null {
  const ring = distinct(points);
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (ring.length > 1 && a[0] === b[0] && a[1] === b[1]) ring.pop();
  if (ring.length < 3) return null;
  return [...ring, [...a] as LonLat];
}

type Run = { points: LonLat[]; lead: string; tail: string };

/** Group positions into lists: split where other words come between them. */
function runsFromText(text: string, found: Found[]): Run[] {
  const runs: { found: Found[]; gaps: ('join' | 'label')[]; lead: string }[] = [];
  found.forEach((f, i) => {
    const gapStart = i === 0 ? 0 : found[i - 1].end;
    const gap = text.slice(gapStart, f.start);
    const kind = i === 0 ? 'break' : gapKind(gap);
    if (kind === 'break') runs.push({ found: [f], gaps: [], lead: leadLine(gap) });
    else {
      const run = runs[runs.length - 1];
      run.found.push(f);
      run.gaps.push(kind);
    }
  });

  const out: Run[] = [];
  for (const run of runs) {
    // "A. p1, p2, p3  B. p4, p5, p6": letters name separate lists. When every position
    // has its own letter ("A. p1  B. p2  C. p3") they only name points of one list.
    const mixed = run.gaps.includes('join') && run.gaps.includes('label');
    let current: Found[] = [run.found[0]];
    const flush = () => {
      const last = current[current.length - 1];
      const lineEnd = text.indexOf('\n', last.end);
      out.push({
        points: current.map((f) => f.lonlat),
        lead: run.lead,
        tail: text.slice(last.end, lineEnd === -1 ? undefined : lineEnd),
      });
    };
    run.gaps.forEach((g, i) => {
      if (mixed && g === 'label') {
        flush();
        current = [];
      }
      current.push(run.found[i + 1]);
    });
    flush();
  }
  return out;
}

function partsForRun(run: Run): WarningPart[] {
  const pts = distinct(run.points);
  const n = pts.length;
  const ring = n >= 3 ? closedRing(pts) : null;
  if (ring && BOUNDED_RE.test(run.lead)) {
    return [{ shape: 'area', geometry: { type: 'Polygon', coordinates: [ring] } }];
  }
  if (n >= 2 && ROUTE_RE.test(run.lead)) {
    return [{ shape: 'route', geometry: { type: 'LineString', coordinates: pts } }];
  }
  const radius = radiusMetres(`${run.lead} ${run.tail}`);
  if (radius != null) {
    return pts.map((p) => ({
      shape: 'circle' as const,
      geometry: { type: 'Polygon' as const, coordinates: [circlePolygon(p, radius)] },
    }));
  }
  if (ring && AREA_RE.test(run.lead)) {
    return [{ shape: 'area', geometry: { type: 'Polygon', coordinates: [ring] } }];
  }
  return [{ shape: 'points', geometry: { type: 'MultiPoint', coordinates: pts } }];
}

/**
 * Areas, circles, routes and loose positions described in a warning's text.
 * Loose positions are merged into one Point / MultiPoint part, listed last.
 */
export function warningPartsFromText(text: string | null | undefined): WarningPart[] {
  if (!text) return [];
  const clean = text.replace(/\r\n?/g, '\n').replace(/&nbsp;/g, ' ');
  const found = findWarningPositions(clean);
  if (!found.length) return [];
  const parts = runsFromText(clean, found).flatMap(partsForRun);
  const shapes = parts.filter((p) => p.shape !== 'points');
  const loose = distinct(
    parts.flatMap((p) => (p.geometry.type === 'MultiPoint' ? p.geometry.coordinates : []))
  );
  if (loose.length) {
    shapes.push({
      shape: 'points',
      geometry:
        loose.length === 1
          ? { type: 'Point', coordinates: loose[0] }
          : { type: 'MultiPoint', coordinates: loose },
    });
  }
  return shapes;
}
