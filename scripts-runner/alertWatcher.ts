import fs from 'fs';
import path from 'path';
import * as turf from '@turf/turf';
import {
  listServerAlerts,
  loadServerAlerts,
  upsertServerAlert,
  sendAlertEmail,
  type ServerAlertRule,
} from './alertMail';
import { dataSource } from './paths';
import { evaluateAlertRule, normalizeRule } from '../packages/ui/src/utils/areaAlerts';

type Position = {
  mmsi: string;
  lon: number;
  lat: number;
  vessel_name?: string | null;
};

type FetchPositions = () => Promise<Position[]>;

const areaCache: Record<string, any> = {};

async function loadAreaGeoJSON(rule: ServerAlertRule): Promise<any | null> {
  if (rule.areaId === 'custom' && rule.polygon) {
    return { type: 'Feature', geometry: rule.polygon, properties: {} };
  }
  if (areaCache[rule.areaId]) return areaCache[rule.areaId];
  const fileMap: Record<string, string> = {
    'eez-norway': 'norway-eez.geojson',
    'eez-janmayen': 'janmayen-eez.geojson',
    'eez-svalbard': 'svalbard-fpz.geojson',
  };
  const file = fileMap[rule.areaId];
  if (!file) return null;
  const full = path.join(dataSource('overlays'), file);
  if (!fs.existsSync(full)) return null;
  const gj = JSON.parse(fs.readFileSync(full, 'utf8'));
  areaCache[rule.areaId] = gj;
  return gj;
}

function pointIn(lon: number, lat: number, gj: any): boolean {
  try {
    const pt = turf.point([lon, lat]);
    if (gj.type === 'FeatureCollection') {
      return gj.features.some((f: any) => turf.booleanPointInPolygon(pt, f));
    }
    if (gj.type === 'Feature') return turf.booleanPointInPolygon(pt, gj);
    return turf.booleanPointInPolygon(pt, {
      type: 'Feature',
      geometry: gj,
      properties: {},
    });
  } catch {
    return false;
  }
}

/**
 * Durable area-alert watcher: evaluates disk-persisted rules against live positions
 * without requiring an open browser tab. Email only if SMTP_* is configured.
 */
export function startAlertWatcher(fetchPositions: FetchPositions, intervalMs = 30_000) {
  loadServerAlerts();
  console.log('[alertWatcher] started (file-backed rules)');

  async function tick() {
    const rules = listServerAlerts().filter((r) => r.status !== 'expired');
    if (!rules.length) return;
    let positions: Position[] = [];
    try {
      positions = await fetchPositions();
    } catch (e: any) {
      console.warn('[alertWatcher] positions failed', e?.message || e);
      return;
    }
    const now = Date.now();

    for (const stored of rules) {
      const rule = normalizeRule(stored);
      let gj: any;
      try {
        gj = await loadAreaGeoJSON(rule);
      } catch {
        continue;
      }
      if (!gj) continue;

      const result = evaluateAlertRule(rule, positions, (lon, lat) => pointIn(lon, lat, gj), now);
      for (const hit of result.hits) {
        if (!rule.email) {
          console.log('[alertWatcher]', hit.message);
          continue;
        }
        const sent = await sendAlertEmail({
          to: rule.email,
          subject: `SvalMap alert: ${rule.areaLabel}`,
          text: `${hit.message}\n\nMMSI: ${hit.mmsi}\nRule: ${rule.id}\nTime: ${hit.at}\n`,
        });
        if (!sent.ok) {
          console.warn('[alertWatcher] email failed', sent.error);
          result.rule.lastEmailError = sent.error || 'Email failed';
        }
      }
      if (result.changed) upsertServerAlert(result.rule as ServerAlertRule);
    }
  }

  tick().catch(() => undefined);
  return setInterval(() => {
    tick().catch(() => undefined);
  }, intervalMs);
}
