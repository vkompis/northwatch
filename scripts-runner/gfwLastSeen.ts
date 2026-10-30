/**
 * Fallback "last seen" for ships the land-based AIS receivers have not heard: the newest dated
 * position in Global Fishing Watch's events. Nothing is stored; the server caches it in memory.
 *
 * GFW gives positions only at events (port visits, loitering, encounters, AIS gaps). It has no
 * per-ship track for this token, and 4Wings reports refuse a vessel filter, so the position can
 * be well older than the last message GFW received, which comes without a position.
 */

export type GfwRecordKind = 'port_visit' | 'loitering' | 'encounter' | 'ais_back_on' | 'ais_off';

export type GfwLastSeenRecord = {
  kind: GfwRecordKind;
  /** Plain words for the dossier */
  label: string;
  time: string;
  lon: number;
  lat: number;
};

export type GfwIdentities = {
  ids: string[];
  /** Latest AIS message GFW received under these ids (no position comes with it) */
  lastTransmission: string | null;
};

function latestIso(a: string | null, b: unknown): string | null {
  const t = Date.parse(String(b ?? ''));
  if (!Number.isFinite(t)) return a;
  return a == null || t > Date.parse(a) ? new Date(t).toISOString() : a;
}

/**
 * The ids GFW holds for this MMSI. One ship can have several over the years. Ids with no ship
 * name are left out: they are a few stray messages on the same MMSI, not the ship.
 */
export function identitiesForMmsi(searchEntries: any[], mmsi: string): GfwIdentities {
  const ids: string[] = [];
  let lastTransmission: string | null = null;
  for (const entry of searchEntries || []) {
    for (const s of entry?.selfReportedInfo || []) {
      if (String(s?.ssvid) !== mmsi || !s?.id || !String(s?.shipname ?? '').trim()) continue;
      if (!ids.includes(s.id)) ids.push(s.id);
      lastTransmission = latestIso(lastTransmission, s.transmissionDateTo);
    }
  }
  return { ids, lastTransmission };
}

function lonLat(p: any): { lon: number; lat: number } | null {
  if (p?.lon == null || p?.lat == null) return null;
  const lon = Number(p.lon);
  const lat = Number(p.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
}

function iso(raw: unknown): string | null {
  const t = Date.parse(String(raw ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** When and where one event last places the ship. */
function recordOf(ev: any): GfwLastSeenRecord | null {
  const type = String(ev?.type || '').toLowerCase();
  if (type === 'gap') {
    // A gap's own position is the midpoint, where nobody saw the ship: use where AIS came back
    const on = lonLat(ev.gap?.onPosition);
    const back = iso(ev.end);
    if (on && back) return { kind: 'ais_back_on', label: 'AIS back on after a gap', time: back, ...on };
    const off = lonLat(ev.gap?.offPosition);
    const gone = iso(ev.start);
    return off && gone ? { kind: 'ais_off', label: 'AIS went off', time: gone, ...off } : null;
  }
  const pos = lonLat(ev?.position);
  const time = iso(ev?.end) || iso(ev?.start);
  if (!pos || !time) return null;
  if (type === 'port_visit') {
    const visit = ev.port_visit || {};
    const port = visit.endAnchorage?.name || visit.startAnchorage?.name;
    return { kind: 'port_visit', label: port ? `Port visit, ${port}` : 'Port visit', time, ...pos };
  }
  if (type === 'loitering') return { kind: 'loitering', label: 'Loitering', time, ...pos };
  if (type === 'encounter') return { kind: 'encounter', label: 'Encounter with another ship', time, ...pos };
  return null;
}

/** The newest dated position in a list of GFW events. */
export function latestDatedPosition(events: any[]): GfwLastSeenRecord | null {
  let best: GfwLastSeenRecord | null = null;
  for (const ev of events || []) {
    const r = recordOf(ev);
    if (r && (!best || Date.parse(r.time) > Date.parse(best.time))) best = r;
  }
  return best;
}
