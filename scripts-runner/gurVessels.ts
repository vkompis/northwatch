/**
 * Ukraine GUR "War & Sanctions" vessel lists (https://war-sanctions.gur.gov.ua/en/transport).
 *  - Marine vessels: ships involved in russia's war logistics or sanctions evasion
 *  - Shadow Fleet: tankers moving russian oil outside the price cap
 *  - Captains: sanctioned masters, each linked to the ship they command
 * The site has no export, so the lists are read page by page (~220 pages), slowly, once a
 * day. robots.txt allows /en/transport. Of the captains only the name and the ship are kept.
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { dataSource } from './paths';

const DATA_DIR = process.env.DATA_DIR || dataSource();
export const GUR_VESSELS_CSV = path.join(DATA_DIR, 'gur-vessels.csv');
export const GUR_VESSELS_META = path.join(DATA_DIR, 'gur-vessels.meta.json');
export const GUR_CAPTAINS_CSV = path.join(DATA_DIR, 'gur-captains.csv');

const GUR_BASE = 'https://war-sanctions.gur.gov.ua/en/transport';
export const GUR_LISTS = {
  ships: { url: `${GUR_BASE}/ships`, label: 'Marine vessels' },
  'shadow-fleet': { url: `${GUR_BASE}/shadow-fleet`, label: 'Shadow Fleet' },
} as const;
export const GUR_CAPTAINS_URL = `${GUR_BASE}/captains`;
export type GurList = keyof typeof GUR_LISTS;

export type GurVesselRow = {
  list: GurList;
  id: string;
  name: string;
  imo: string;
  flag: string;
  type: string;
  category: string;
  url: string;
};

/** A sanctioned master and the ship GUR lists them on (by GUR ship page). */
export type GurCaptainRow = { name: string; shipList: GurList; shipId: string; shipName: string; shipUrl: string };

const PAGE_DELAY_MS = 800;
const HEADERS = { 'User-Agent': 'SvalMap research map (vessel list sync, once a day)' };

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** Text of the first element in an HTML fragment (the category's headline, not its notes). */
function firstText(html: string): string {
  for (const part of html.split(/<[^>]+>/)) {
    const t = decode(part).replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

/** Ship cards on one list page, plus the last page number in the pager. */
export function parseGurListPage(html: string, list: GurList): { rows: GurVesselRow[]; lastPage: number } {
  const rows: GurVesselRow[] = [];
  const cards = html.split('<a class="d-block component-link item-cell').slice(1);
  for (const card of cards) {
    const href = /href="([^"]+\/transport\/[a-z-]+\/(\d+))"/.exec(card);
    if (!href) continue;
    const fields: Record<string, string> = {};
    // Each field is a label column ("col-4 text-white") followed by its value column
    for (const line of card.split('class="item-line').slice(1)) {
      const label = /<div class="col-4 text-white">\s*([^<]+?)\s*<\/div>/.exec(line);
      const value = /<div class="col-8[^"]*">([\s\S]*)$/.exec(line);
      if (label && value) fields[label[1].trim()] = firstText(value[1]);
    }
    const imo = (fields['IMO'] || '').match(/\b\d{7}\b/)?.[0] || '';
    rows.push({
      list,
      id: href[2],
      name: fields['Vessel name'] || '',
      imo,
      flag: fields['Flag (Current)'] || '',
      type: fields['Vessel Type'] || '',
      category: fields['Category'] || '',
      url: href[1],
    });
  }
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return { rows, lastPage: pages.length ? Math.max(...pages) : 1 };
}

/** Captain cards: name, and one or more "Master of the vessel" links to ship pages. */
export function parseGurCaptainsPage(html: string): { rows: GurCaptainRow[]; lastPage: number } {
  const rows: GurCaptainRow[] = [];
  for (const card of html.split('component-link item-cell').slice(1)) {
    let name = '';
    let ships: { list: GurList; id: string; name: string; url: string }[] = [];
    for (const line of card.split('class="item-line').slice(1)) {
      const label = /<div class="col-4 text-white">\s*([^<]+?)\s*<\/div>/.exec(line)?.[1].trim();
      if (label === 'Name') name = firstText(/<div class="col-8[^"]*">([\s\S]*)$/.exec(line)?.[1] || '');
      if (label === 'Master of the vessel') {
        ships = [...line.matchAll(/href="([^"]+\/transport\/(ships|shadow-fleet)\/(\d+))"[^>]*>([^<]*)</g)].map((m) => ({
          url: m[1],
          list: m[2] as GurList,
          id: m[3],
          name: decode(m[4]).trim(),
        }));
      }
    }
    for (const ship of ships) {
      rows.push({ name, shipList: ship.list, shipId: ship.id, shipName: ship.name, shipUrl: ship.url });
    }
  }
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return { rows, lastPage: pages.length ? Math.max(...pages) : 1 };
}

const CSV_COLUMNS: (keyof GurVesselRow)[] = ['list', 'id', 'name', 'imo', 'flag', 'type', 'category', 'url'];
const CAPTAIN_COLUMNS: (keyof GurCaptainRow)[] = ['name', 'shipList', 'shipId', 'shipName', 'shipUrl'];
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsv<T>(filePath: string, columns: (keyof T)[]): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map((line) => {
    const c = parseCsvLine(line);
    const row: any = {};
    columns.forEach((k, i) => (row[k] = c[i] ?? ''));
    return row as T;
  });
}

function writeCsv<T>(filePath: string, columns: (keyof T)[], rows: T[]) {
  const lines = [columns.join(','), ...rows.map((r) => columns.map((k) => csvCell(String(r[k] ?? ''))).join(','))];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

export const readGurVessels = (filePath = GUR_VESSELS_CSV) => readCsv<GurVesselRow>(filePath, CSV_COLUMNS);
export const readGurCaptains = (filePath = GUR_CAPTAINS_CSV) => readCsv<GurCaptainRow>(filePath, CAPTAIN_COLUMNS);

function readMeta(): any {
  try {
    return JSON.parse(fs.readFileSync(GUR_VESSELS_META, 'utf8'));
  } catch {
    return {};
  }
}

export function gurMetaAgeMs(): number | null {
  const t = Date.parse(readMeta().updated_at || '');
  return Number.isFinite(t) ? Date.now() - t : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every page of one paged GUR list, read one page at a time. */
async function fetchPages<T>(base: string, parse: (html: string) => { rows: T[]; lastPage: number }): Promise<T[]> {
  const get = async (page: number) =>
    String((await axios.get(`${base}?page=${page}`, { timeout: 30000, headers: HEADERS, responseType: 'text' })).data);
  const first = parse(await get(1));
  const rows = [...first.rows];
  for (let page = 2; page <= first.lastPage; page++) {
    await sleep(PAGE_DELAY_MS);
    rows.push(...parse(await get(page)).rows);
  }
  return rows;
}

/**
 * Re-read both lists and replace the local CSV. A run that comes back with far fewer
 * ships than last time (site change, partial outage) keeps the previous file.
 */
export async function updateGurVessels(): Promise<{ ok: boolean; counts?: Record<string, number>; error?: string }> {
  const updatedAt = new Date().toISOString();
  const previous = readGurVessels();
  const previousCaptains = readGurCaptains();
  try {
    const rows: GurVesselRow[] = [];
    for (const list of Object.keys(GUR_LISTS) as GurList[]) {
      rows.push(...(await fetchPages(GUR_LISTS[list].url, (html) => parseGurListPage(html, list))));
    }
    const captains = await fetchPages(GUR_CAPTAINS_URL, parseGurCaptainsPage);
    const counts = {
      ships: rows.filter((r) => r.list === 'ships').length,
      'shadow-fleet': rows.filter((r) => r.list === 'shadow-fleet').length,
      captains: captains.length,
    };
    if (previous.length && rows.length < previous.length * 0.6) {
      throw new Error(`only ${rows.length} vessels read (had ${previous.length}); keeping the previous list`);
    }
    if (previousCaptains.length && captains.length < previousCaptains.length * 0.6) {
      throw new Error(`only ${captains.length} captains read (had ${previousCaptains.length}); keeping the previous list`);
    }
    writeCsv(GUR_VESSELS_CSV, CSV_COLUMNS, rows);
    writeCsv(GUR_CAPTAINS_CSV, CAPTAIN_COLUMNS, captains);
    fs.writeFileSync(
      GUR_VESSELS_META,
      JSON.stringify(
        { updated_at: updatedAt, counts, with_imo: rows.filter((r) => r.imo).length, source: GUR_BASE },
        null,
        2
      )
    );
    console.log(`[gur] updated ships=${counts.ships} shadow-fleet=${counts['shadow-fleet']} captains=${counts.captains}`);
    return { ok: true, counts };
  } catch (e: any) {
    const error = e?.message || String(e);
    console.warn('[gur] update failed', error);
    fs.writeFileSync(GUR_VESSELS_META, JSON.stringify({ ...readMeta(), last_error: error, last_error_at: updatedAt }, null, 2));
    return { ok: false, error };
  }
}
