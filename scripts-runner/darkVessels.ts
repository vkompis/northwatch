/**
 * Dark-vessel leads: link radar (SAR) detections with no AIS match to ships that were not
 * transmitting at the time — GFW AIS-off gaps and ships of interest gone quiet — when the ship
 * could have been there. Nothing is stored: it works on the GFW data the server already caches.
 *
 * "Could have been there" = from where AIS went off, it could reach the detection by then, and
 * from the detection it could reach where AIS came back on, at no more than MAX_KN. Leads are
 * ranked by detour (how far off the straight off → on line the detection lies). Over a long gap
 * a ship could reach almost anywhere, so a lead must also lie near that line: a detour of at
 * most MAX_DETOUR_KM or half the off → on distance, whichever is larger. A lead, not a match.
 */

export const MAX_KN = 15;
const KM_PER_H = MAX_KN * 1.852;
const MAX_DETOUR_KM = 60;
/** With no "on" position (gap still open), only detections this close to where AIS went off */
const MAX_KM_WITHOUT_ON = 300;
/** SAR detections are dated by day; a gap only has to overlap that day */
const DAY_MS = 24 * 3600e3;

export type LonLat = { lon: number; lat: number };

export type GapEvent = {
  type: string;
  time: string;
  end: string | null;
  mmsi: string | null;
  vessels: string[];
  flag: string | null;
  position: LonLat;
  offPosition?: LonLat | null;
  onPosition?: LonLat | null;
  impliedSpeedKn?: number | null;
  russian?: boolean;
  sanctioned?: boolean;
  shadowfleet?: boolean;
};

export type SarDetection = { time: string; position: LonLat; matched: boolean; detections?: number };

export function haversineKm(a: LonLat, b: LonLat): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** GFW 4Wings SAR dates ("2026-10-04 06:00") → the UTC day they stand for. */
export function detectionDay(time: string): { start: number; end: number; day: string } | null {
  const day = String(time).slice(0, 10);
  const start = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(start) ? { start, end: start + DAY_MS, day } : null;
}

export type GapLead = {
  gap: GapEvent;
  kmFromOff: number;
  kmToOn: number | null;
  detourKm: number | null;
  hoursIntoGap: number;
};

/** AIS-off gaps whose ship could have been at this detection. */
export function gapLeadsForDetection(det: SarDetection, gaps: GapEvent[]): GapLead[] {
  const d = detectionDay(det.time);
  if (!d) return [];
  const leads: GapLead[] = [];
  for (const gap of gaps) {
    if (gap.type !== 'ais_off') continue;
    const off = gap.offPosition || gap.position;
    const start = Date.parse(gap.time);
    const end = gap.end ? Date.parse(gap.end) : Date.now();
    if (!Number.isFinite(start) || start > d.end || end < d.start) continue;
    const kmFromOff = haversineKm(off, det.position);
    // Latest moment that day it could have been there, and the earliest
    if (kmFromOff > KM_PER_H * Math.max(0, (Math.min(d.end, end) - start) / 3600e3)) continue;
    let kmToOn: number | null = null;
    let detourKm: number | null = null;
    if (gap.onPosition) {
      kmToOn = haversineKm(det.position, gap.onPosition);
      if (kmToOn > KM_PER_H * Math.max(0, (end - Math.max(d.start, start)) / 3600e3)) continue;
      const direct = haversineKm(off, gap.onPosition);
      detourKm = kmFromOff + kmToOn - direct;
      if (detourKm > Math.max(MAX_DETOUR_KM, direct / 2)) continue;
    } else if (kmFromOff > MAX_KM_WITHOUT_ON) {
      continue;
    }
    leads.push({
      gap,
      kmFromOff: Math.round(kmFromOff),
      kmToOn: kmToOn == null ? null : Math.round(kmToOn),
      detourKm: detourKm == null ? null : Math.round(detourKm),
      hoursIntoGap: Math.round(Math.max(0, (d.start + DAY_MS / 2 - start) / 3600e3)),
    });
  }
  return leads.sort((a, b) => (a.detourKm ?? a.kmFromOff) - (b.detourKm ?? b.kmFromOff));
}

export type DetectionLead = { det: SarDetection; kmFromOff: number; detourKm: number | null };

/** Radar detections without AIS that this gap's ship could have been. */
export function detectionLeadsForGap(gap: GapEvent, dets: SarDetection[]): DetectionLead[] {
  return dets
    .filter((det) => !det.matched)
    .map((det) => ({ det, lead: gapLeadsForDetection(det, [gap])[0] }))
    .filter((x) => x.lead)
    .map(({ det, lead }) => ({ det, kmFromOff: lead.kmFromOff, detourKm: lead.detourKm }))
    .sort((a, b) => (a.detourKm ?? a.kmFromOff) - (b.detourKm ?? b.kmFromOff));
}

export type QuietLead = { vessel: any; lastFix: string; hoursSilentBefore: number; km: number };

/**
 * Ships of interest whose last AIS fix came before the detection day and was close enough to
 * have reached it — "last seen here, then nothing".
 */
export function quietLeadsForDetection(det: SarDetection, vessels: any[], isOfInterest: (v: any) => boolean): QuietLead[] {
  const d = detectionDay(det.time);
  if (!d) return [];
  const out: QuietLead[] = [];
  for (const v of vessels) {
    if (!isOfInterest(v) || !Number.isFinite(v.lon) || !Number.isFinite(v.lat)) continue;
    const t = Date.parse(String(v.timestamp ?? ''));
    // Silent since before the detection day, but not for more than a week before it
    if (!Number.isFinite(t) || t >= d.start || d.start - t > 7 * DAY_MS) continue;
    const km = haversineKm({ lon: v.lon, lat: v.lat }, det.position);
    if (km > KM_PER_H * ((d.end - t) / 3600e3)) continue;
    out.push({ vessel: v, lastFix: new Date(t).toISOString(), hoursSilentBefore: Math.round((d.start - t) / 3600e3), km: Math.round(km) });
  }
  return out.sort((a, b) => a.km - b.km).slice(0, 8);
}

/** Copernicus Browser on Sentinel-1 radar (IW, VV+VH) for one place and UTC day. */
export function sentinel1Url(pos: LonLat, day: string, zoom = 10): string {
  const params = new URLSearchParams({
    zoom: String(zoom),
    lat: pos.lat.toFixed(5),
    lng: pos.lon.toFixed(5),
    themeId: 'DEFAULT-THEME',
    datasetId: 'S1_CDAS_IW_VVVH',
    fromTime: `${day}T00:00:00.000Z`,
    toTime: `${day}T23:59:59.999Z`,
    dateMode: 'SINGLE',
  });
  return `https://browser.dataspace.copernicus.eu/?${params}`;
}
