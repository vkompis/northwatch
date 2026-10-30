/**
 * "Possible AIS spoofing": raised only on reports that are impossible, never on what is merely
 * unusual. Two kinds of evidence:
 *
 * 1. Values AIS cannot carry, or no such ship can reach: a course over 360° (other than the
 *    "not available" codes), a heading of 360–510°, or 40 kn or more for a cargo ship, tanker,
 *    fishing vessel or tug.
 * 2. Positions no ship can sail between: two fixes at least 30 km apart that imply 80 kn or
 *    more. One bad fix (out and back) does not count. It takes a pattern: jumping back and
 *    forth (3 jumps, and at least 1 step in 5), or a jump after which the ship keeps reporting
 *    from the new place (2 fixes before it, 3 after it over 10 minutes or more).
 *
 * A bad value counts for as long as a feed still shows that report, and 6 hours after. Jumps
 * count while both fixes are within the last 6 hours.
 *
 * Only ship stations (an MMSI starting with a country's MID): net buoys, aircraft and craft MMSIs
 * are left out. Nothing is stored on disk: the history is the last 6 hours of fixes, in memory.
 */
import { MID_COUNTRIES } from '../packages/ui/src/utils/mid';
import { haversineKm } from './darkVessels';

export type SpoofReason = { kind: 'values' | 'jumps'; text: string; at: string };

export type Fix = { t: number; lon: number; lat: number };

export type Report = Fix & { course?: unknown; heading?: unknown; speed?: unknown; shipType?: unknown };

const JUMP_MIN_KM = 30;
const JUMP_MIN_KN = 80;
const MIN_SUSTAIN_FIXES = 3;
const MIN_SUSTAIN_MS = 10 * 60 * 1000;
const LIVE_WINDOW_MS = 6 * 3600e3;
const TRACK_KEEP_MS = 24 * 3600e3;
/** Live fixes are kept at most every 10 minutes, unless the ship has jumped (~6000 ships in memory) */
const SAMPLE_MS = 10 * 60 * 1000;
const MAX_FIXES = 60;
const SLOW_TYPES = /^(cargo|tanker|fishing|tug|towing)/i;
const SLOW_NAMES: Record<string, string> = {
  cargo: 'a cargo ship',
  tanker: 'a tanker',
  fishing: 'a fishing vessel',
  tug: 'a tug',
  towing: 'a tug',
};

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Net buoys often use made-up MIDs (586…), so the MID must belong to a country */
export const isShipStation = (mmsi: string) => /^[2-7]\d{8}$/.test(mmsi) && !!MID_COUNTRIES[Number(mmsi.slice(0, 3))];

/** Impossible values in one report, as reason texts. */
export function valueReasons(r: Omit<Report, keyof Fix>): string[] {
  const out: string[] = [];
  const course = num(r.course);
  // 360 = not available; 409.5 is the top of the "do not use" range some decoders pass through;
  // 511 = not available in long-range (satellite) reports
  if (course != null && course > 360 && course !== 409.5 && course !== 511) {
    out.push(`Reported a course of ${Math.round(course)}°, which AIS cannot carry`);
  }
  const heading = num(r.heading);
  if (heading != null && heading >= 360 && heading !== 511) {
    out.push(`Reported a heading of ${Math.round(heading)}°, which AIS cannot carry`);
  }
  const speed = num(r.speed);
  const type = typeof r.shipType === 'string' ? r.shipType : '';
  // 102.3 = not available, 102.2 = "102.2 kn or more", 63 = not available in long-range reports
  const slow = SLOW_TYPES.exec(type)?.[1].toLowerCase();
  if (speed != null && speed >= 40 && speed < 102.2 && speed !== 63 && slow) {
    out.push(`Reported ${Math.round(speed)} kn, impossible for ${SLOW_NAMES[slow]}`);
  }
  return out;
}

const knots = (km: number, ms: number) => (ms > 0 ? km / 1.852 / (ms / 3600e3) : Infinity);
const fmtKn = (kn: number) => (Number.isFinite(kn) ? `${Math.round(kn)} kn` : 'no time between them');
const fmtDuration = (ms: number) =>
  ms < 2 * 3600e3 ? `${Math.max(1, Math.round(ms / 60000))} min` : `${Math.round(ms / 3600e3)} h`;

type Jump = { i: number; km: number; ms: number; kn: number };

function jumpsIn(fixes: Fix[]): Jump[] {
  const jumps: Jump[] = [];
  for (let i = 1; i < fixes.length; i++) {
    const km = haversineKm(fixes[i - 1], fixes[i]);
    const ms = fixes[i].t - fixes[i - 1].t;
    const kn = knots(km, ms);
    if (km >= JUMP_MIN_KM && kn >= JUMP_MIN_KN) jumps.push({ i, km, ms, kn });
  }
  return jumps;
}

/** Jump patterns in time-ordered fixes (see the header for the rules). */
export function jumpReasons(fixes: Fix[]): SpoofReason[] {
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  if (sorted.length < 3) return [];
  const jumps = jumpsIn(sorted);
  if (!jumps.length) return [];
  const last = jumps[jumps.length - 1];
  const steps = sorted.length - 1;

  if (jumps.length >= 3 && jumps.length * 5 >= steps) {
    const maxKm = Math.max(...jumps.map((j) => j.km));
    return [
      {
        kind: 'jumps',
        text:
          `Position jumped ${jumps.length} times between places up to ${Math.round(maxKm)} km apart. ` +
          'Two transmitters may be using this MMSI, or the positions are faked',
        at: new Date(sorted[last.i].t).toISOString(),
      },
    ];
  }

  // A jump with a steady run on both sides of it: the ship kept reporting from the new place
  const bounds = [0, ...jumps.map((j) => j.i), sorted.length];
  for (let k = jumps.length - 1; k >= 0; k--) {
    const before = bounds[k + 1] - bounds[k];
    const runStart = bounds[k + 1];
    const runEnd = bounds[k + 2] - 1;
    const after = runEnd - runStart + 1;
    if (before >= 2 && after >= MIN_SUSTAIN_FIXES && sorted[runEnd].t - sorted[runStart].t >= MIN_SUSTAIN_MS) {
      const j = jumps[k];
      return [
        {
          kind: 'jumps',
          text:
            `Jumped ${Math.round(j.km)} km in ${fmtDuration(j.ms)} (${fmtKn(j.kn)}) and kept reporting ` +
            'from the new place. No ship can sail that fast',
          at: new Date(sorted[j.i].t).toISOString(),
        },
      ];
    }
  }
  return [];
}

/** Every reason found in a stretch of track (values reported in it, and its jump pattern). */
export function trackReasons(reports: Report[]): SpoofReason[] {
  const out: SpoofReason[] = [];
  const seen = new Set<string>();
  for (const r of [...reports].sort((a, b) => b.t - a.t)) {
    for (const text of valueReasons(r)) {
      // One line per kind of value, from the latest report that had it
      const key = text.replace(/\d+/g, '#');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: 'values', text, at: new Date(r.t).toISOString() });
    }
  }
  return [...out, ...jumpReasons(reports)];
}

// --- Live tracker -------------------------------------------------------------------------------

type ShipState = {
  fixes: Fix[];
  /** Bad values by kind, with when a feed last showed the report */
  values: Map<string, { reason: SpoofReason; seenAt: number }>;
  track: SpoofReason[];
  trackAt: number;
};
const ships = new Map<string, ShipState>();

function state(mmsi: string): ShipState {
  let s = ships.get(mmsi);
  if (!s) {
    s = { fixes: [], values: new Map(), track: [], trackAt: 0 };
    ships.set(mmsi, s);
  }
  return s;
}

/** One live report from either feed. Old or duplicate fixes are left out of the jump history. */
export function noteReport(mmsi: string, r: Report, now = Date.now()): void {
  if (!isShipStation(mmsi) || !Number.isFinite(r.t)) return;
  if (!Number.isFinite(r.lon) || !Number.isFinite(r.lat)) return;
  const reasons = valueReasons(r);
  if (!reasons.length && r.t < now - LIVE_WINDOW_MS) return;
  const s = state(mmsi);
  for (const text of reasons) {
    const key = text.replace(/\d+/g, '#');
    const prev = s.values.get(key);
    const reason: SpoofReason =
      !prev || Date.parse(prev.reason.at) <= r.t ? { kind: 'values', text, at: new Date(r.t).toISOString() } : prev.reason;
    s.values.set(key, { reason, seenAt: now });
  }
  if (r.t < now - LIVE_WINDOW_MS) return;
  // Keep the fixes in time order: the two feeds do not arrive in order
  let i = s.fixes.length;
  while (i > 0 && s.fixes[i - 1].t > r.t) i--;
  const prev = s.fixes[i - 1];
  if (prev && r.t - prev.t < SAMPLE_MS && haversineKm(prev, r) < JUMP_MIN_KM) return;
  const next = s.fixes[i];
  if (next && next.t - r.t < SAMPLE_MS && haversineKm(next, r) < JUMP_MIN_KM) return;
  s.fixes.splice(i, 0, { t: r.t, lon: r.lon, lat: r.lat });
  if (s.fixes.length > MAX_FIXES) s.fixes.splice(0, s.fixes.length - MAX_FIXES);
}

/** Reasons found in a ship's historic track, shown on the map for a day. */
export function noteTrackReasons(mmsi: string, reasons: SpoofReason[], now = Date.now()): void {
  if (!isShipStation(mmsi)) return;
  const s = state(mmsi);
  s.track = reasons;
  s.trackAt = now;
}

/** Everything known for a ship now: live values and jumps, plus its last track check. */
export function spoofingReasons(mmsi: string, now = Date.now()): SpoofReason[] {
  const s = ships.get(mmsi);
  if (!s) return [];
  const live = [
    ...[...s.values.values()].filter((v) => now - v.seenAt <= LIVE_WINDOW_MS).map((v) => v.reason),
    ...jumpReasons(s.fixes.filter((f) => now - f.t <= LIVE_WINDOW_MS)),
  ];
  const fromTrack = now - s.trackAt <= TRACK_KEEP_MS ? s.track : [];
  const out = [...live];
  for (const r of fromTrack) {
    if (!out.some((o) => o.kind === r.kind && o.text.replace(/\d+/g, '#') === r.text.replace(/\d+/g, '#'))) out.push(r);
  }
  return out;
}

/** Drop ships with nothing left in the window. */
export function sweepSpoofing(now = Date.now()): void {
  for (const [mmsi, s] of ships) {
    s.fixes = s.fixes.filter((f) => now - f.t <= LIVE_WINDOW_MS);
    for (const [k, v] of s.values) if (now - v.seenAt > LIVE_WINDOW_MS) s.values.delete(k);
    if (now - s.trackAt > TRACK_KEEP_MS) s.track = [];
    if (!s.fixes.length && !s.values.size && !s.track.length) ships.delete(mmsi);
  }
}

export const SPOOFING_RULES = { jumpMinKm: JUMP_MIN_KM, jumpMinKn: JUMP_MIN_KN, windowH: LIVE_WINDOW_MS / 3600e3 };
