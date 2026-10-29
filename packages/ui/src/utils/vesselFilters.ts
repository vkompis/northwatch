/**
 * Client-side visibility filters over live vessel Feature properties.
 *
 * Three groups, combined with AND:
 *  1. Category — one per vessel, identical to its marker colour
 *     (research → military / law enforcement → flag).
 *  2. Ship type — AIS type bucket. Applies to civilian categories only;
 *     military and research vessels are controlled by their category alone.
 *  3. Focus — optional. When any is on, the vessel must match at least one
 *     (Russian flag, sanctioned, shadow fleet, sanctioned master, watchlist).
 * Plus a freshness toggle (updated within the last 6 hours).
 */

import { SHIP_CLASS_KEYS, type ShipClass, resolveShipClass } from './shipClass';
import { mmsiFlagCountry, type VesselCategory } from './vesselCategory';

export const CATEGORY_KEYS = [
  'norway',
  'eu',
  'china',
  'russia',
  'rest',
  'military',
  'research',
] as const satisfies readonly VesselCategory[];

export const FOCUS_KEYS = ['russianFlag', 'sanctioned', 'shadow', 'sanctionedMaster', 'watchlistOnly'] as const;

export type VesselFilterFlags = Record<VesselCategory, boolean> &
  Record<ShipClass, boolean> &
  Record<(typeof FOCUS_KEYS)[number], boolean> & {
    /** When true, only vessels updated within the last 6 hours. */
    recent6h: boolean;
  };

export const DEFAULT_VESSEL_FILTERS: VesselFilterFlags = {
  norway: true,
  eu: true,
  china: true,
  russia: true,
  rest: true,
  military: true,
  research: true,
  fishing: true,
  cargo: true,
  tanker: true,
  passenger: true,
  pleasure: true,
  hsc: true,
  tugWork: true,
  other: true,
  unknown: true,
  // Fishing-gear buoys and beacons clutter the coast; opt in when needed
  device: false,
  russianFlag: false,
  sanctioned: false,
  shadow: false,
  sanctionedMaster: false,
  watchlistOnly: false,
  recent6h: false,
};

const ALL_KEYS = Object.keys(DEFAULT_VESSEL_FILTERS) as (keyof VesselFilterFlags)[];

export type VesselFilterExtras = {
  /** MMSIs on the user watchlist — used by the watchlist focus. */
  watchlistMmsis?: ReadonlySet<string> | Iterable<string> | null;
  /** Override "now" for recent6h (tests). */
  nowMs?: number;
};

type FilterableVessel = {
  sanctioned?: number | boolean;
  shadowfleet?: number | boolean;
  sanctionedMaster?: number | boolean;
  military?: number | boolean;
  research?: number | boolean;
  category?: string;
  flagCountry?: string;
  mmsi?: string;
  shipClass?: string;
  shipType?: string | number | null;
  shipTypeCode?: number | null;
  timestamp?: string | null;
};

/** True when the flags differ from the defaults (something is hidden or narrowed). */
export function anyFilterActive(f: VesselFilterFlags): boolean {
  return ALL_KEYS.some((k) => f[k] !== DEFAULT_VESSEL_FILTERS[k]);
}

export function anyFocusActive(f: VesselFilterFlags): boolean {
  return FOCUS_KEYS.some((k) => f[k]);
}

const isOn = (x: unknown) => x === 1 || x === true;

/** Category bucket used by both marker colour and the category filters. */
export function vesselCategoryKey(v: FilterableVessel): VesselCategory {
  const cat = String(v.category || '');
  if (cat === 'research' || isOn(v.research)) return 'research';
  if (cat === 'military' || isOn(v.military)) return 'military';
  if ((CATEGORY_KEYS as readonly string[]).includes(cat)) return cat as VesselCategory;
  const fc = String(v.flagCountry || '');
  if ((CATEGORY_KEYS as readonly string[]).includes(fc)) return fc as VesselCategory;
  return mmsiFlagCountry(v.mmsi);
}

export function vesselShipClass(v: FilterableVessel): ShipClass {
  const sc = String(v.shipClass || '');
  if ((SHIP_CLASS_KEYS as readonly string[]).includes(sc)) return sc as ShipClass;
  return resolveShipClass(v.shipType ?? null, v.shipTypeCode ?? null);
}

function recentEnough(v: FilterableVessel, nowMs: number): boolean {
  const ts = v.timestamp ? Date.parse(String(v.timestamp)) : NaN;
  return Number.isFinite(ts) && nowMs - ts <= 6 * 60 * 60 * 1000;
}

function toSet(raw: VesselFilterExtras['watchlistMmsis']): ReadonlySet<string> {
  if (!raw) return new Set();
  return raw instanceof Set ? raw : new Set([...raw].map(String));
}

export function vesselPassesFilter(
  v: FilterableVessel,
  f: VesselFilterFlags,
  extras?: VesselFilterExtras
): boolean {
  const cat = vesselCategoryKey(v);
  if (!f[cat]) return false;
  if (cat !== 'military' && cat !== 'research' && !f[vesselShipClass(v)]) return false;
  if (f.recent6h && !recentEnough(v, extras?.nowMs ?? Date.now())) return false;
  if (!anyFocusActive(f)) return true;
  if (f.russianFlag && (v.flagCountry || mmsiFlagCountry(v.mmsi)) === 'russia') return true;
  if (f.sanctioned && isOn(v.sanctioned)) return true;
  if (f.shadow && isOn(v.shadowfleet)) return true;
  if (f.sanctionedMaster && isOn(v.sanctionedMaster)) return true;
  if (f.watchlistOnly && toSet(extras?.watchlistMmsis).has(String(v.mmsi || ''))) return true;
  return false;
}

/** Merge stored/URL filter blobs onto defaults, migrating older shapes. */
export function mergeVesselFilters(
  raw: Partial<VesselFilterFlags> | Record<string, unknown> | null | undefined
): VesselFilterFlags {
  const f = { ...DEFAULT_VESSEL_FILTERS };
  if (!raw || typeof raw !== 'object') return f;
  const r = raw as Record<string, unknown>;
  // Legacy exclusive-only shape: just the focus flags
  if (typeof r.norway !== 'boolean') {
    f.sanctioned = Boolean(r.sanctioned);
    f.shadow = Boolean(r.shadow);
    return f;
  }
  for (const k of ALL_KEYS) {
    if (typeof r[k] === 'boolean') f[k] = r[k] as boolean;
  }
  // v1 had a separate "Military / law" AIS type toggle next to the Military category
  if (r.militaryAis === false) f.military = false;
  return f;
}

const URL_ALIASES: Record<string, keyof VesselFilterFlags> = {
  ru: 'russianFlag',
  russian: 'russia',
  shadowfleet: 'shadow',
  age6: 'recent6h',
  recent6h: 'recent6h',
  watchlist: 'watchlistOnly',
  favorites: 'watchlistOnly',
  master: 'sanctionedMaster',
  devices: 'device',
  tug_work: 'tugWork',
  'tug-work': 'tugWork',
  tugwork: 'tugWork',
  militaryais: 'military',
  military_ais: 'military',
  'military-ais': 'military',
};

const URL_NAMES: Partial<Record<keyof VesselFilterFlags, string>> = {
  russianFlag: 'ru',
  recent6h: 'age6',
  watchlistOnly: 'watchlist',
  sanctionedMaster: 'master',
};

function urlKey(token: string): keyof VesselFilterFlags | null {
  if (URL_ALIASES[token]) return URL_ALIASES[token];
  const hit = ALL_KEYS.find((k) => k.toLowerCase() === token);
  return hit ?? null;
}

/** Compact URL tokens: `-norway` hides a default-on toggle; `sanctioned`, `device`, … enable a default-off one. */
export function vesselFiltersToUrlTokens(f: VesselFilterFlags): string[] {
  const out: string[] = [];
  for (const k of ALL_KEYS) {
    if (f[k] === DEFAULT_VESSEL_FILTERS[k]) continue;
    const name = URL_NAMES[k] ?? k;
    out.push(f[k] ? name : `-${name}`);
  }
  return out;
}

export function vesselFiltersFromUrlTokens(tokens: string[]): VesselFilterFlags {
  const f = { ...DEFAULT_VESSEL_FILTERS };
  for (const raw of tokens) {
    const t = raw.trim().toLowerCase();
    const off = t.startsWith('-');
    const key = urlKey(t.replace(/^[-+]/, ''));
    if (key) f[key] = !off;
  }
  return f;
}

/** One-click starting points for common research questions. */
export const VESSEL_FILTER_PRESETS: { id: string; label: string; filters: VesselFilterFlags }[] = [
  { id: 'all', label: 'All ships', filters: { ...DEFAULT_VESSEL_FILTERS } },
  {
    id: 'interest',
    label: 'Vessels of interest',
    filters: { ...DEFAULT_VESSEL_FILTERS, russianFlag: true, sanctioned: true, shadow: true, sanctionedMaster: true },
  },
  {
    id: 'sanctions',
    label: 'Sanctions & shadow',
    filters: { ...DEFAULT_VESSEL_FILTERS, sanctioned: true, shadow: true, sanctionedMaster: true },
  },
  {
    id: 'watchlist',
    label: 'Watchlist',
    filters: { ...DEFAULT_VESSEL_FILTERS, watchlistOnly: true },
  },
];

export function sameFilters(a: VesselFilterFlags, b: VesselFilterFlags): boolean {
  return ALL_KEYS.every((k) => a[k] === b[k]);
}
