'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { pointInGeoJSON } from '../utils/geo';
import {
  ALERT_AREAS,
  type AlertAreaId,
  type AlertPolygon,
  type AreaAlertRule,
  createAlertRule,
  evaluateAlertRule,
  loadAlertRules,
  parseMmsiList,
  ruleWatchSummary,
  saveAlertRules,
} from '../utils/areaAlerts';

type Props = {
  apiBase?: string;
  draftMmsi?: string | null;
  draftName?: string | null;
  onDraftConsumed?: () => void;
  drawing: boolean;
  onDrawingChange: (on: boolean) => void;
  draftRing: number[][];
  onDraftRingChange: (ring: number[][]) => void;
  onRulesChange?: (rules: AreaAlertRule[]) => void;
  className?: string;
  collapsed?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
};

export default function AlertPanel({
  apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8787',
  draftMmsi = null,
  draftName = null,
  onDraftConsumed,
  drawing,
  onDrawingChange,
  draftRing,
  onDraftRingChange,
  onRulesChange,
  className = '',
  collapsed = false,
  onExpand,
  onCollapse,
}: Props) {
  const [rules, setRules] = useState<AreaAlertRule[]>([]);
  const [ready, setReady] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [mmsiText, setMmsiText] = useState('');
  const [watchAny, setWatchAny] = useState(false);
  const [areaId, setAreaId] = useState<AlertAreaId>('eez-svalbard');
  const [dwellMinutes, setDwellMinutes] = useState(0);
  const [watchHours, setWatchHours] = useState(24);
  const [email, setEmail] = useState('');
  const [smtpHint, setSmtpHint] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const areaCache = useRef<Record<string, any>>({});
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  useEffect(() => {
    setRules(loadAlertRules());
    setReady(true);
    axios
      .get(`${apiBase}/api/alerts/status`, { timeout: 8000 })
      .then((r) => {
        setSmtpHint(
          r.data?.emailConfigured
            ? 'Server email ready'
            : 'Email needs SMTP_* env on scripts-runner'
        );
      })
      .catch(() => setSmtpHint('Email server unreachable'));
  }, [apiBase]);

  useEffect(() => {
    if (!ready) return;
    saveAlertRules(rules);
    onRulesChange?.(rules);
  }, [rules, ready, onRulesChange]);

  useEffect(() => {
    if (draftMmsi) {
      setMmsiText((prev) => {
        const list = parseMmsiList(prev);
        const m = String(draftMmsi).replace(/\D/g, '');
        if (!list.includes(m.padStart(9, '0').slice(-9))) {
          return prev ? `${prev}, ${draftMmsi}` : String(draftMmsi);
        }
        return prev;
      });
      setWatchAny(false);
      setFormOpen(true);
      onExpand?.();
      onDraftConsumed?.();
    }
  }, [draftMmsi, draftName, onDraftConsumed, onExpand]);

  const loadArea = useCallback(
    async (rule: AreaAlertRule) => {
      if (rule.areaId === 'custom' && rule.polygon) {
        return { type: 'Feature', geometry: rule.polygon, properties: {} };
      }
      if (areaCache.current[rule.areaId]) return areaCache.current[rule.areaId];
      const def = ALERT_AREAS.find((a) => a.id === rule.areaId);
      if (!def) return null;
      const res = await fetch(`${apiBase}/overlays/${def.file}`);
      if (!res.ok) throw new Error(`Area load failed ${res.status}`);
      const gj = await res.json();
      areaCache.current[rule.areaId] = gj;
      return gj;
    },
    [apiBase]
  );

  const syncRuleToServer = useCallback(
    async (rule: AreaAlertRule) => {
      try {
        await axios.post(`${apiBase}/api/alerts`, rule, { timeout: 15000 });
      } catch (e: any) {
        console.warn('[AlertPanel] sync failed', e?.message || e);
      }
    },
    [apiBase]
  );

  // Push watching rules to disk-backed server once on load (durable watcher)
  useEffect(() => {
    if (!ready) return;
    for (const r of rules) {
      if (r.status === 'watching') syncRuleToServer(r);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, apiBase]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    async function tick() {
      const current = rulesRef.current;
      const watching = current.filter((r) => r.status !== 'expired');
      if (!watching.length) return;

      let positions: any[] = [];
      try {
        const { data } = await axios.get(`${apiBase}/api/live-positions`, { timeout: 25000 });
        positions = Array.isArray(data) ? data : data?.data || [];
      } catch {
        return;
      }
      if (cancelled) return;

      let changed = false;
      const next: AreaAlertRule[] = [];

      for (const rule of current) {
        if (rule.status === 'expired') {
          next.push(rule);
          continue;
        }
        let gj: any;
        try {
          gj = await loadArea(rule);
        } catch {
          next.push(rule);
          continue;
        }
        // Email is sent by the scripts-runner watcher (rule is synced there) — only notify locally
        const result = evaluateAlertRule(rule, positions, (lon, lat) => pointInGeoJSON(lon, lat, gj));
        for (const hit of result.hits) {
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              new Notification('SvalMap area alert', { body: hit.message });
            }
          } catch {
            /* ignore */
          }
        }
        if (result.changed) changed = true;
        next.push(result.rule);
      }

      if (!cancelled && changed) setRules(next);
    }

    tick();
    const t = setInterval(tick, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [apiBase, loadArea, ready]);

  const active = useMemo(() => rules.filter((r) => r.status !== 'expired'), [rules]);
  const hitCount = useMemo(() => active.reduce((n, r) => n + r.hits.length, 0), [active]);

  const finishPolygon = (): AlertPolygon | null => {
    if (draftRing.length < 3) return null;
    const ring = [...draftRing, draftRing[0]];
    return { type: 'Polygon', coordinates: [ring] };
  };

  const addRule = async () => {
    const mmsis = watchAny ? [] : parseMmsiList(mmsiText);
    if (!watchAny && mmsis.length === 0) {
      setFormError('Enter at least one 9-digit MMSI, or tick "Any ship in the area".');
      return;
    }

    let polygon: AlertPolygon | null = null;
    let finalArea: AlertAreaId = areaId;
    if (areaId === 'custom' || drawing) {
      polygon = finishPolygon();
      if (!polygon) {
        setFormError('Draw the area first: at least 3 corners, then close the shape.');
        return;
      }
      finalArea = 'custom';
    }
    setFormError(null);

    const names: Record<string, string> = {};
    if (draftName && mmsis.length === 1) names[mmsis[0]] = draftName;

    const rule = createAlertRule({
      mmsis,
      vesselNames: names,
      areaId: finalArea,
      polygon,
      dwellMinutes,
      watchHours,
      email: email.trim() || null,
    });
    setRules((prev) => [rule, ...prev]);
    setFormOpen(false);
    onDrawingChange(false);
    onDraftRingChange([]);
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => undefined);
    }
    await syncRuleToServer(rule);
  };

  const removeRule = async (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    try {
      await axios.delete(`${apiBase}/api/alerts/${encodeURIComponent(id)}`, { timeout: 8000 });
    } catch {
      /* ignore */
    }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className={`alerts-fab ${className}`.trim()}
        onClick={onExpand}
        aria-label="Open alerts"
      >
        Alerts{hitCount ? ` (${hitCount})` : ''}
      </button>
    );
  }

  return (
    <div className={`alert-panel ${className}`.trim()} role="region" aria-label="Area alerts">
      <div className="alert-panel-header">
        <div className="alert-panel-title">
          Alerts
          {hitCount > 0 ? <span className="alert-badge">{hitCount}</span> : null}
        </div>
        <div className="alert-panel-actions">
          <button
            type="button"
            className="alert-link"
            onClick={() => {
              if (formOpen) {
                onDrawingChange(false);
                onDraftRingChange([]);
                setFormError(null);
              }
              setFormOpen((v) => !v);
            }}
          >
            {formOpen ? 'Cancel' : 'New'}
          </button>
          {onCollapse && (
            <button type="button" className="alert-link" onClick={onCollapse} aria-label="Minimize alerts">
              Minimize
            </button>
          )}
        </div>
      </div>

      {formOpen && (
        <div className="alert-form">
          <label className="alert-check">
            <input
              type="checkbox"
              checked={watchAny}
              onChange={(e) => setWatchAny(e.target.checked)}
            />
            Any ship in the area
          </label>
          {!watchAny && (
            <label>
              MMSIs (comma-separated for many ships)
              <input
                value={mmsiText}
                onChange={(e) => setMmsiText(e.target.value)}
                placeholder="273…, 257…"
              />
            </label>
          )}
          <label>
            Area
            <select
              value={areaId}
              onChange={(e) => {
                const v = e.target.value as AlertAreaId;
                setAreaId(v);
                if (v === 'custom') onDrawingChange(true);
                else onDrawingChange(false);
              }}
            >
              {ALERT_AREAS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
              <option value="custom">Draw polygon on map…</option>
            </select>
          </label>
          {(areaId === 'custom' || drawing) && (
            <div className="alert-draw-tools">
              {drawing ? (
                <>
                  <span className="alert-help strong">
                    Drawing — {draftRing.length} corner{draftRing.length === 1 ? '' : 's'}.{' '}
                    {draftRing.length < 3
                      ? 'Click the map to add corners (at least 3).'
                      : 'Click the green first corner, double-click or press Enter to close.'}
                  </span>
                  <button
                    type="button"
                    className="alert-primary secondary"
                    onClick={() => onDrawingChange(false)}
                    disabled={draftRing.length < 3}
                  >
                    Finish area
                  </button>
                  <button
                    type="button"
                    className="alert-link"
                    onClick={() => onDraftRingChange(draftRing.slice(0, -1))}
                    disabled={!draftRing.length}
                  >
                    Undo corner
                  </button>
                  <button
                    type="button"
                    className="alert-link"
                    onClick={() => {
                      onDraftRingChange([]);
                      onDrawingChange(false);
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : draftRing.length >= 3 ? (
                <>
                  <span className="alert-help strong">
                    ✓ Area ready ({draftRing.length} corners)
                  </span>
                  <button
                    type="button"
                    className="alert-link"
                    onClick={() => {
                      onDraftRingChange([]);
                      onDrawingChange(true);
                    }}
                  >
                    Redraw
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="alert-primary secondary"
                  onClick={() => {
                    setAreaId('custom');
                    onDraftRingChange([]);
                    onDrawingChange(true);
                  }}
                >
                  Draw area on map
                </button>
              )}
            </div>
          )}
          <label>
            Time in area before alert (minutes, 0 = on entry)
            <input
              type="number"
              min={0}
              max={7 * 24 * 60}
              value={dwellMinutes}
              onChange={(e) => setDwellMinutes(Number(e.target.value) || 0)}
            />
          </label>
          <label>
            Watch for (hours)
            <input
              type="number"
              min={1}
              max={168}
              value={watchHours}
              onChange={(e) => setWatchHours(Number(e.target.value) || 1)}
            />
          </label>
          <label>
            Email (optional)
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          {smtpHint && <p className="alert-help">{smtpHint}</p>}
          <p className="alert-help">
            {watchAny
              ? 'Alerts when a ship enters — ships already inside when you start are ignored until they leave.'
              : 'Alerts once per ship when it enters (or right away if it is already inside).'}{' '}
            The server keeps watching and sends email even when this tab is closed.
          </p>
          {formError && <p className="alert-msg warn">{formError}</p>}
          <button
            type="button"
            className="alert-primary"
            onClick={() => addRule()}
            disabled={drawing}
            title={drawing ? 'Finish the area first' : undefined}
          >
            Start watching
          </button>
        </div>
      )}

      {!formOpen && active.length === 0 && (
        <div className="alert-panel-body">
          Watch specific ships or any traffic in a preset EEZ/FPZ or a drawn AOI. Optional email on
          entry.
        </div>
      )}

      <ul className="alert-list">
        {active.map((r) => (
          <li key={r.id} className={`alert-item status-${r.status}`}>
            <div className="alert-item-main">
              <strong>{ruleWatchSummary(r)}</strong>
              {r.hits.length === 0 && (
                <span className="alert-progress">
                  {!r.primed
                    ? 'Starting…'
                    : r.baseline.length
                      ? `Waiting for new arrivals (${r.baseline.length} already inside)`
                      : 'Waiting…'}
                </span>
              )}
              {r.hits.slice(0, 5).map((h) => (
                <span key={`${h.mmsi}-${h.at}`} className="alert-msg">
                  {new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
                  {h.message}
                </span>
              ))}
              {r.hits.length > 5 && (
                <span className="alert-progress">+{r.hits.length - 5} earlier</span>
              )}
              {r.email && <span className="alert-progress">Email: {r.email}</span>}
              {r.lastEmailError && (
                <span className="alert-msg warn">{r.lastEmailError}</span>
              )}
            </div>
            <button type="button" className="alert-link" onClick={() => removeRule(r.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>

      {rules.some((r) => r.status === 'expired') && (
        <button
          type="button"
          className="alert-link clear"
          onClick={() => setRules((prev) => prev.filter((r) => r.status !== 'expired'))}
        >
          Clear finished
        </button>
      )}
    </div>
  );
}
