/** Vessel category / color helpers — source of truth matching scripts-runner legend */

import {
  isRussianResearchVessel,
  RESEARCH_COLOR,
} from './russianResearchVessels';
import { MID_COUNTRIES } from './mid';

export type VesselCategory =
  | 'norway'
  | 'russia'
  | 'eu'
  | 'china'
  | 'military'
  | 'research'
  | 'rest';

/** Flag / MID country bucket — independent of military/research marker category. */
export type FlagCountry = 'norway' | 'russia' | 'eu' | 'china' | 'rest';

export const HEADER_COLORS: Record<VesselCategory, string> = {
  norway: '#ff4040',
  russia: '#4dd0ff',
  eu: '#2b2bcc',
  china: '#f2c403',
  military: '#2b6206', // matches Mapmarkers/Militarycircle.svg
  research: RESEARCH_COLOR,
  rest: '#f7f7f7',
};

export function headerTextColor(cat: VesselCategory): string {
  return cat === 'rest' ? '#111' : '#fff';
}

const EU_ISO = new Set([
  'se', 'dk', 'fi', 'de', 'nl', 'fr', 'es', 'pt', 'it', 'gr', 'ie', 'pl', 'ee', 'lv', 'lt',
  'be', 'bg', 'ro', 'cz', 'sk', 'si', 'hr', 'cy', 'mt', 'hu', 'lu', 'at',
]);

/** Mainland China plus Hong Kong / Macao registries (Taiwan is not included). */
const CHINA_ISO = new Set(['cn', 'hk', 'mo']);

const MILITARY_TYPE_CODES = new Set([35, 55, 59]);
const MILITARY_TYPE_LABELS = new Set(['military ops', 'law enforcement', 'noncombatant ship']);

export function isMilitaryShipType(shipType: unknown): boolean {
  if (typeof shipType === 'number') return MILITARY_TYPE_CODES.has(shipType);
  return MILITARY_TYPE_LABELS.has(String(shipType ?? '').trim().toLowerCase());
}

function midOf(mmsi: unknown): number {
  return parseInt(String(mmsi || '').slice(0, 3), 10);
}

export function mmsiFlagCountry(mmsi: unknown): FlagCountry {
  const iso = MID_COUNTRIES[midOf(mmsi)]?.[0];
  if (iso === 'no') return 'norway';
  if (iso === 'ru') return 'russia';
  if (iso && EU_ISO.has(iso)) return 'eu';
  if (iso && CHINA_ISO.has(iso)) return 'china';
  return 'rest';
}

/**
 * Marker category — one per vessel, and the same bucket the category filters use.
 * Precedence: curated research list → military / law enforcement → flag.
 */
export function mmsiCategory(
  mmsi: unknown,
  shipType?: unknown,
  imo?: unknown,
  militaryFlag?: unknown
): VesselCategory {
  if (isRussianResearchVessel(mmsi, imo)) return 'research';
  if (militaryFlag === true || militaryFlag === 1 || isMilitaryShipType(shipType)) {
    return 'military';
  }
  return mmsiFlagCountry(mmsi);
}

export function countryInfoFromMmsi(mmsi: unknown): { iso: string; name: string } {
  const hit = MID_COUNTRIES[midOf(mmsi)];
  return hit ? { iso: hit[0], name: hit[1] } : { iso: 'xx', name: 'Unknown' };
}

const BUOY_NAME = /\b(BUOY|BOUY|BOYE|BØYE|BOEYE)\b/i;

/**
 * Fishing-gear buoys, AtoN, MOB / SART beacons and other AIS transmitters that are not ships.
 * Ship MMSIs start with a known MID (first digit 2–7); anything with an IMO is treated as a ship.
 */
export function isLikelyAisDevice(v: {
  mmsi?: unknown;
  imo?: unknown;
  name?: unknown;
}): boolean {
  if (v.imo != null && String(v.imo).replace(/\D/g, '').length >= 7) return false;
  const mmsi = String(v.mmsi ?? '');
  if (!/^[2-7]/.test(mmsi)) return true;
  if (!MID_COUNTRIES[midOf(mmsi)]) return true;
  return BUOY_NAME.test(String(v.name ?? ''));
}

export function navStatusLabel(code: unknown): string {
  const n = typeof code === 'number' ? code : parseInt(String(code ?? ''), 10);
  const map: Record<number, string> = {
    0: 'Under way using engine',
    1: 'At anchor',
    2: 'Not under command',
    3: 'Restricted manoeuvrability',
    4: 'Constrained by draught',
    5: 'Moored',
    6: 'Aground',
    7: 'Engaged in fishing',
    8: 'Under way sailing',
    14: 'AIS-SART is active',
    15: 'Not defined',
  };
  if (Number.isNaN(n)) return code == null || code === '' ? 'Not available' : String(code);
  return map[n] ?? String(code);
}

export {
  isRussianResearchVessel,
  RUSSIAN_RESEARCH_VESSELS,
  RUSSIAN_RESEARCH_MMSI,
  RESEARCH_COLOR,
} from './russianResearchVessels';
