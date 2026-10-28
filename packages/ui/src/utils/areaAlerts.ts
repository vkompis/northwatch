export type AlertAreaId = 'eez-norway' | 'eez-janmayen' | 'eez-svalbard' | 'custom';

export type AlertPolygon = {
  type: 'Polygon';
  coordinates: number[][][];
};

export type AreaAlertRule = {
  id: string;
  /** Empty array = watch any vessel entering the area */
  mmsis: string[];
  vesselNames: Record<string, string>;
  areaId: AlertAreaId;
  areaLabel: string;
  /** Custom AOI polygon (required when areaId === 'custom') */
  polygon: AlertPolygon | null;
  /** Minutes inside before firing (0 = on entry) */
  dwellMinutes: number;
  watchHours: number;
  email: string | null;
  createdAt: string;
  /** mmsi -> ISO enteredAt while currently inside */
  insideSince: Record<string, string>;
  /** mmsis already notified this watch (avoid repeat spam) */
  notified: string[];
  /**
   * "Any ship" watches: vessels already inside on the first check. They only
   * alert after leaving and coming back, so a busy area doesn't fire instantly.
   */
  baseline: string[];
  /** True once the first check has run (baseline captured). */
  primed: boolean;
  /** Newest first, capped — a watch keeps running after the first hit. */
  hits: AlertHit[];
  /** 'triggered' is legacy (watches used to stop after one hit); read as 'watching'. */
  status: 'watching' | 'triggered' | 'expired';
  triggeredAt: string | null;
  message: string | null;
  lastEmailError: string | null;
};

export type AlertHit = { mmsi: string; name: string; at: string; message: string };

export type AlertPosition = {
  mmsi?: unknown;
  lon?: unknown;
  lat?: unknown;
  longitude?: unknown;
  latitude?: unknown;
  vessel_name?: unknown;
  name?: unknown;
};

const MAX_HITS = 50;

export type AlertAreaDef = {
  id: Exclude<AlertAreaId, 'custom'>;
  label: string;
  file: string;
};

export const ALERT_AREAS: AlertAreaDef[] = [
  { id: 'eez-norway', label: 'Norway EEZ', file: 'norway-eez.geojson' },
  { id: 'eez-janmayen', label: 'Jan Mayen EEZ', file: 'janmayen-eez.geojson' },
  { id: 'eez-svalbard', label: 'Svalbard FPZ', file: 'svalbard-fpz.geojson' },
];

export const ALERTS_STORAGE_KEY = 'svalmap.areaAlerts.v2';

function normalizeMmsi(raw: string): string {
  return String(raw).replace(/\D/g, '').padStart(9, '0').slice(-9);
}

export function parseMmsiList(raw: string): string[] {
  const parts = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const m = normalizeMmsi(p);
    if (m.length === 9 && m !== '000000000' && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

export function loadAlertRules(): AreaAlertRule[] {
  try {
    const raw = localStorage.getItem(ALERTS_STORAGE_KEY);
    if (!raw) {
      // migrate v1
      const v1 = localStorage.getItem('svalmap.areaAlerts.v1');
      if (!v1) return [];
      const old = JSON.parse(v1);
      if (!Array.isArray(old)) return [];
      return old.map((r: any) => migrateV1(r));
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeRule) : [];
  } catch {
    return [];
  }
}

function migrateV1(r: any): AreaAlertRule {
  const mmsi = normalizeMmsi(r.mmsi || '');
  return normalizeRule({
    id: r.id || `alert-${Date.now()}`,
    mmsis: mmsi ? [mmsi] : [],
    vesselNames: mmsi ? { [mmsi]: r.vesselName || `MMSI ${mmsi}` } : {},
    areaId: r.areaId || 'eez-svalbard',
    areaLabel: r.areaLabel || areaLabel(r.areaId || 'eez-svalbard'),
    polygon: null,
    dwellMinutes: r.dwellMinutes ?? 60,
    watchHours: r.watchHours ?? 24,
    email: null,
    createdAt: r.createdAt || new Date().toISOString(),
    insideSince: r.enteredAt && mmsi ? { [mmsi]: r.enteredAt } : {},
    notified: [],
    baseline: [],
    primed: false,
    hits: [],
    status: r.status || 'watching',
    triggeredAt: r.triggeredAt || null,
    message: r.message || null,
    lastEmailError: null,
  });
}

export function normalizeRule(r: any): AreaAlertRule {
  return {
    id: String(r.id),
    mmsis: Array.isArray(r.mmsis) ? r.mmsis.map(normalizeMmsi) : [],
    vesselNames: r.vesselNames && typeof r.vesselNames === 'object' ? r.vesselNames : {},
    areaId: r.areaId || 'eez-svalbard',
    areaLabel: r.areaLabel || areaLabel(r.areaId || 'eez-svalbard'),
    polygon: r.polygon || null,
    dwellMinutes: Math.max(0, Number(r.dwellMinutes) || 0),
    watchHours: Math.max(1, Number(r.watchHours) || 24),
    email: r.email ? String(r.email).trim() : null,
    createdAt: r.createdAt || new Date().toISOString(),
    insideSince: r.insideSince && typeof r.insideSince === 'object' ? r.insideSince : {},
    notified: Array.isArray(r.notified) ? r.notified : [],
    baseline: Array.isArray(r.baseline) ? r.baseline : [],
    // Rules from before baselines existed have already been running — don't re-prime them
    primed: typeof r.primed === 'boolean' ? r.primed : Array.isArray(r.notified),
    hits: Array.isArray(r.hits) ? r.hits.slice(0, MAX_HITS) : [],
    status: r.status === 'expired' ? 'expired' : 'watching',
    triggeredAt: r.triggeredAt || null,
    message: r.message || null,
    lastEmailError: r.lastEmailError || null,
  };
}

export function saveAlertRules(rules: AreaAlertRule[]) {
  try {
    localStorage.setItem(ALERTS_STORAGE_KEY, JSON.stringify(rules));
  } catch {
    /* ignore */
  }
}

export function createAlertRule(input: {
  mmsis: string[];
  vesselNames?: Record<string, string>;
  areaId: AlertAreaId;
  areaLabel?: string;
  polygon?: AlertPolygon | null;
  dwellMinutes: number;
  watchHours: number;
  email?: string | null;
}): AreaAlertRule {
  const mmsis = input.mmsis.map(normalizeMmsi).filter(Boolean);
  const label =
    input.areaLabel ||
    (input.areaId === 'custom' ? 'Custom AOI' : areaLabel(input.areaId));
  return {
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mmsis,
    vesselNames: input.vesselNames || {},
    areaId: input.areaId,
    areaLabel: label,
    polygon: input.areaId === 'custom' ? input.polygon || null : null,
    dwellMinutes: Math.max(0, Math.round(input.dwellMinutes)),
    watchHours: Math.max(1, Math.round(input.watchHours)),
    email: input.email?.trim() || null,
    createdAt: new Date().toISOString(),
    insideSince: {},
    notified: [],
    baseline: [],
    primed: false,
    hits: [],
    status: 'watching',
    triggeredAt: null,
    message: null,
    lastEmailError: null,
  };
}

export function areaLabel(id: AlertAreaId): string {
  if (id === 'custom') return 'Custom AOI';
  return ALERT_AREAS.find((a) => a.id === id)?.label || id;
}

export function ruleWatchSummary(rule: AreaAlertRule): string {
  const ships =
    rule.mmsis.length === 0
      ? 'any ship'
      : rule.mmsis.length === 1
        ? rule.vesselNames[rule.mmsis[0]] || rule.mmsis[0]
        : `${rule.mmsis.length} ships`;
  const dwell =
    rule.dwellMinutes <= 0 ? 'on entry' : `≥${rule.dwellMinutes} min`;
  return `${ships} · ${rule.areaLabel} · ${dwell} · ${rule.watchHours}h`;
}

/**
 * One evaluation pass of a watch against live positions. Shared by the browser
 * (notifications + UI) and the scripts-runner watcher (email), so both agree.
 */
export function evaluateAlertRule(
  rule: AreaAlertRule,
  positions: AlertPosition[],
  inArea: (lon: number, lat: number) => boolean,
  nowMs: number = Date.now()
): { rule: AreaAlertRule; hits: AlertHit[]; changed: boolean } {
  if (rule.status === 'expired') return { rule, hits: [], changed: false };

  if (nowMs > new Date(rule.createdAt).getTime() + rule.watchHours * 3600_000) {
    return {
      rule: { ...rule, status: 'expired', message: `Watch ended (${rule.watchHours}h)` },
      hits: [],
      changed: true,
    };
  }

  const nowIso = new Date(nowMs).toISOString();
  const watchAny = rule.mmsis.length === 0;
  const wanted = new Set(rule.mmsis);
  const insideSince = { ...rule.insideSince };
  const notified = new Set(rule.notified);
  const baseline = new Set(rule.baseline);
  const vesselNames = { ...rule.vesselNames };
  const stillInside = new Set<string>();
  const hits: AlertHit[] = [];
  let changed = !rule.primed || rule.status !== 'watching';

  for (const v of positions) {
    const mmsi = normalizeMmsi(String(v.mmsi ?? ''));
    if (!mmsi || mmsi === '000000000') continue;
    if (!watchAny && !wanted.has(mmsi)) continue;
    const lon = Number(v.lon ?? v.longitude);
    const lat = Number(v.lat ?? v.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inArea(lon, lat)) continue;

    stillInside.add(mmsi);
    const name = String(v.vessel_name || v.name || '').trim();
    if (name && vesselNames[mmsi] !== name) {
      vesselNames[mmsi] = name;
      changed = true;
    }
    if (watchAny && !rule.primed) {
      baseline.add(mmsi);
      continue;
    }
    if (baseline.has(mmsi) || notified.has(mmsi)) continue;
    if (!insideSince[mmsi]) {
      insideSince[mmsi] = nowIso;
      changed = true;
    }
    if (nowMs - new Date(insideSince[mmsi]).getTime() < rule.dwellMinutes * 60_000) continue;

    notified.add(mmsi);
    const label = vesselNames[mmsi] || `MMSI ${mmsi}`;
    // A specifically watched ship that was already there when the watch started
    const verb = !rule.primed ? 'is inside' : 'entered';
    hits.push({
      mmsi,
      name: label,
      at: nowIso,
      message: `${label} ${verb} ${rule.areaLabel}${
        rule.dwellMinutes > 0 ? ` (≥${rule.dwellMinutes} min)` : ''
      }`,
    });
  }

  for (const m of Object.keys(insideSince)) {
    if (!stillInside.has(m)) {
      delete insideSince[m];
      changed = true;
    }
  }
  for (const m of baseline) {
    if (!stillInside.has(m)) {
      baseline.delete(m);
      changed = true;
    }
  }

  if (!hits.length && !changed) return { rule, hits, changed: false };
  const latest = hits[hits.length - 1];
  return {
    rule: {
      ...rule,
      status: 'watching',
      primed: true,
      insideSince,
      notified: [...notified],
      baseline: [...baseline],
      vesselNames,
      hits: [...[...hits].reverse(), ...rule.hits].slice(0, MAX_HITS),
      triggeredAt: latest ? latest.at : rule.triggeredAt,
      message: latest ? latest.message : rule.message,
    },
    hits,
    changed: true,
  };
}
