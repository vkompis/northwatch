/**
 * Which lists a vessel is on, and what each listing says — the listed name and IMO,
 * since when, under which programme, and a link to the entry — so a match can be checked.
 *
 * "sanction" = formal sanctions (EU designations, programmes carried by OpenSanctions);
 * "shadow" = GUR shadow fleet; "gur" = GUR marine vessels (war logistics, evasion);
 * "master" = the ship's master is on GUR's list of sanctioned captains;
 * "fleetleaks" = FleetLeaks' independent tracker lists it as sanctioned (corroboration).
 */
import fs from 'fs';
import {
  DMA_PAGE_URL,
  EU_DESIGNATED_CSV,
  OPENSANCTIONS_VESSELS_CSV,
  readEuDesignatedCsv,
  readOpenSanctionsVessels,
} from './sanctionsUpdater';
import { GUR_CAPTAINS_CSV, GUR_LISTS, GUR_VESSELS_CSV, readGurCaptains, readGurVessels } from './gurVessels';
import { FLEETLEAKS_FILE, readFleetleaks } from './fleetleaks';

export type ListingKind = 'sanction' | 'shadow' | 'gur' | 'master' | 'fleetleaks';

export type SanctionListing = {
  kind: ListingKind;
  source: 'EU' | 'OpenSanctions' | 'GUR' | 'Local' | 'FleetLeaks';
  title: string;
  programmes: string[];
  /** GUR category, or the sanctioned master's name */
  detail: string | null;
  listedName: string | null;
  listedImo: string | null;
  listedMmsi: string | null;
  since: string | null;
  url: string | null;
  urlLabel: string | null;
  matchedBy: ('imo' | 'mmsi')[];
};

type Entry = Omit<SanctionListing, 'matchedBy'>;

const DATASET_LABELS: Record<string, string> = {
  us_ofac_sdn: 'US OFAC SDN',
  us_trade_csl: 'US Consolidated Screening List',
  eu_sanctions_map: 'EU Sanctions Map',
  eu_journal_sanctions: 'EU Official Journal',
  eu_fsf: 'EU Financial Sanctions Files',
  gb_fcdo_sanctions: 'UK FCDO',
  ca_dfatd_sema_sanctions: 'Canada SEMA',
  ch_seco_sanctions: 'Switzerland SECO',
  un_1718_vessels: 'UN 1718 (DPRK)',
  fr_tresor_gels_avoir: 'France Trésor asset freeze',
  ua_war_sanctions: 'Ukraine GUR War & Sanctions',
};

/** EUR-Lex link and label for the act that listed a vessel ("…celex%3A32025R0932", "Regulation - 2026/1848 - EN"). */
function euAct(link: string): { url: string; label: string } | null {
  const celex = /3(\d{4})R(\d{4})/.exec(link);
  const ref = celex ? [celex[1], String(Number(celex[2]))] : /(\d{4})\/(\d{1,4})/.exec(link)?.slice(1);
  if (ref) {
    const url = /^https?:/.test(link)
      ? link
      : `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:3${ref[0]}R${ref[1].padStart(4, '0')}`;
    return { url, label: `Regulation ${ref[0]}/${ref[1]}` };
  }
  return /^https?:/.test(link) ? { url: link, label: 'EUR-Lex' } : null;
}

let cache: { key: string; byImo: Map<string, Entry[]>; byMmsi: Map<string, Entry[]> } | null = null;

const FILES = [EU_DESIGNATED_CSV, OPENSANCTIONS_VESSELS_CSV, GUR_VESSELS_CSV, GUR_CAPTAINS_CSV, FLEETLEAKS_FILE];

const SANCTIONER_NAMES: Record<string, string> = {
  US: 'United States',
  EU: 'European Union',
  UK: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  NZ: 'New Zealand',
};

function index() {
  const key = FILES.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)).join('|');
  if (cache?.key === key) return cache;
  const byImo = new Map<string, Entry[]>();
  const byMmsi = new Map<string, Entry[]>();
  const add = (e: Entry) => {
    if (e.listedImo) byImo.set(e.listedImo, [...(byImo.get(e.listedImo) || []), e]);
    if (e.listedMmsi) byMmsi.set(e.listedMmsi, [...(byMmsi.get(e.listedMmsi) || []), e]);
  };

  for (const row of readEuDesignatedCsv().values()) {
    const act = euAct(row.eu_oj_link || '');
    add({
      kind: 'sanction',
      source: 'EU',
      title: 'EU designated vessels',
      programmes: ['Regulation 833/2014, Annex XLII'],
      detail: null,
      listedName: row.name || null,
      listedImo: row.imo,
      listedMmsi: null,
      since: row.date_of_application || null,
      url: act?.url || DMA_PAGE_URL,
      urlLabel: act?.label || 'DMA list',
    });
  }

  for (const row of readOpenSanctionsVessels()) {
    const shadow = row.risk.includes('shadow');
    add({
      kind: shadow ? 'shadow' : 'sanction',
      source: 'OpenSanctions',
      title: shadow ? 'Shadow fleet' : 'Sanctions',
      programmes: row.datasets
        .split(';')
        .filter(Boolean)
        .map((d) => DATASET_LABELS[d] || d),
      detail: null,
      listedName: row.name || null,
      listedImo: row.imo || null,
      listedMmsi: row.mmsi || null,
      since: null,
      url: row.url || null,
      urlLabel: 'OpenSanctions',
    });
  }

  const gur = readGurVessels();
  const gurImoByPage = new Map(gur.map((r) => [`${r.list}/${r.id}`, r.imo]));
  for (const row of gur) {
    add({
      kind: row.list === 'shadow-fleet' ? 'shadow' : 'gur',
      source: 'GUR',
      title: `Ukraine GUR · ${GUR_LISTS[row.list].label}`,
      programmes: [],
      detail: row.category || null,
      listedName: row.name || null,
      listedImo: row.imo || null,
      listedMmsi: null,
      since: null,
      url: row.url,
      urlLabel: 'War & Sanctions',
    });
  }
  for (const c of readGurCaptains()) {
    add({
      kind: 'master',
      source: 'GUR',
      title: 'Sanctioned master · Ukraine GUR',
      programmes: [],
      detail: c.name || null,
      listedName: c.shipName || null,
      listedImo: gurImoByPage.get(`${c.shipList}/${c.shipId}`) || null,
      listedMmsi: null,
      since: null,
      url: c.shipUrl,
      urlLabel: 'War & Sanctions',
    });
  }

  for (const v of readFleetleaks()?.vessels || []) {
    add({
      kind: 'fleetleaks',
      source: 'FleetLeaks',
      title: 'FleetLeaks tracker',
      programmes: v.sanctioners.map((c) => `Sanctioned by ${SANCTIONER_NAMES[c] || c}`),
      detail: [v.type, v.flag ? `${v.flag} flag` : null].filter(Boolean).join(' · ') || null,
      listedName: v.name || null,
      listedImo: v.imo,
      listedMmsi: v.mmsi,
      since: null,
      url: v.url,
      urlLabel: 'FleetLeaks',
    });
  }

  cache = { key, byImo, byMmsi };
  return cache;
}

const sameName = (a: string, b: string) =>
  a.toUpperCase().replace(/[^A-Z0-9]/g, '') === b.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The IMO for a ship that has not sent its own, from list entries under its MMSI. MMSIs get
 * reused, so every entry that has an IMO must carry the ship's name and agree on the number.
 */
export function pickListedImo(entries: { listedName: string | null; listedImo: string | null }[], name: string): string | null {
  const withImo = entries.filter((e) => e.listedImo);
  if (!name.trim() || !withImo.length) return null;
  if (!withImo.every((e) => e.listedName && sameName(e.listedName, name))) return null;
  const imos = new Set(withImo.map((e) => e.listedImo));
  return imos.size === 1 ? withImo[0].listedImo : null;
}

let indexCheckedAt = 0;

/** Called for every ship without an IMO on each refresh, so the list files are checked once a minute. */
export function listedImoForShip(mmsi: string, name: string | null | undefined): string | null {
  if (!cache || Date.now() - indexCheckedAt > 60_000) {
    index();
    indexCheckedAt = Date.now();
  }
  return pickListedImo(cache?.byMmsi.get(mmsi) || [], name || '');
}

export function sanctionListings(imo: string | null, mmsi: string | null): SanctionListing[] {
  const { byImo, byMmsi } = index();
  const found = new Map<Entry, SanctionListing>();
  for (const [by, entries] of [
    ['imo', imo ? byImo.get(imo) : undefined],
    ['mmsi', mmsi ? byMmsi.get(mmsi) : undefined],
  ] as const) {
    for (const e of entries || []) {
      const hit = found.get(e) || { ...e, matchedBy: [] };
      hit.matchedBy.push(by);
      found.set(e, hit);
    }
  }
  const out = [...found.values()];
  // OpenSanctions re-publishes GUR's shadow fleet; keep GUR's own entry when both are there
  const gurShadow = new Set(out.filter((l) => l.kind === 'shadow' && l.source === 'GUR').map((l) => l.listedImo));
  const order: ListingKind[] = ['sanction', 'shadow', 'master', 'fleetleaks', 'gur'];
  return out
    .filter((l) => !(l.kind === 'shadow' && l.source === 'OpenSanctions' && gurShadow.has(l.listedImo)))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** IMOs per GUR list, for flags on the map. */
export function gurImoSets(): { shadow: Set<string>; listed: Set<string>; master: Set<string> } {
  const { byImo } = index();
  const shadow = new Set<string>();
  const listed = new Set<string>();
  const master = new Set<string>();
  for (const [imo, entries] of byImo) {
    for (const e of entries) {
      if (e.source !== 'GUR') continue;
      listed.add(imo);
      if (e.kind === 'shadow') shadow.add(imo);
      if (e.kind === 'master') master.add(imo);
    }
  }
  return { shadow, listed, master };
}
