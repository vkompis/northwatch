'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { SNAPSHOT_MODE, type VesselScrub, type VesselTrack } from '@svalmap/ui';

const RANGES = [
  { days: 1, label: '24 h' },
  { days: 3, label: '3 d' },
  { days: 7, label: '7 d' },
  { days: 14, label: '14 d' },
];

/** Same colours as the Fishing Watch layers on the map. */
const EVENT_STYLE: Record<string, { color: string; label: string }> = {
  ais_off: { color: '#a855f7', label: 'AIS gap (GFW)' },
  loitering: { color: '#f6a21a', label: 'Loitering' },
  encounter: { color: '#ff3b30', label: 'Encounter' },
  port_visit: { color: '#22c55e', label: 'Port visit' },
};

type GfwEvent = {
  type: string;
  time: string;
  end?: string | null;
  mmsi?: string | null;
  partnerMmsi?: string | null;
  position?: { lon?: number; lat?: number } | null;
};
type Fix = VesselTrack['points'][number];

const HOUR = 3_600_000;
const W = 1000;
/** A whole range plays back in this long. */
const PLAYBACK_MS = 25_000;

function utc(t: number): string {
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function shortUtc(t: number, multiDay: boolean): string {
  const iso = new Date(t).toISOString();
  return multiDay
    ? `${new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} ${iso.slice(11, 16)}`
    : `${iso.slice(11, 16)} UTC`;
}

function duration(ms: number): string {
  const h = ms / HOUR;
  return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${(h / 24).toFixed(1)} d`;
}

function bearing(a: Fix, b: Fix): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toRad) * Math.cos(b.lat * toRad);
  const x =
    Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lon - a.lon) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** Where the vessel was at `t`: interpolated between close fixes, else the last known one. */
function positionAt(points: Fix[], t: number, threshold: number) {
  if (!points.length || t < points[0].t) return null;
  let i = points.length - 1;
  while (i > 0 && points[i].t > t) i -= 1;
  const a = points[i];
  const b = points[i + 1];
  if (b && b.t - a.t <= threshold) {
    const f = (t - a.t) / Math.max(b.t - a.t, 1);
    const speed = a.speed != null && b.speed != null ? a.speed + f * (b.speed - a.speed) : a.speed ?? b.speed;
    return {
      lon: a.lon + f * (b.lon - a.lon),
      lat: a.lat + f * (b.lat - a.lat),
      speed,
      course: a.course ?? bearing(a, b),
      stale: false,
      since: 0,
    };
  }
  const since = t - a.t;
  return { lon: a.lon, lat: a.lat, speed: a.speed, course: a.course, stale: since > threshold, since };
}

/**
 * Bottom strip for the selected vessel: speed from BarentsWatch history, every position
 * report, stretches with no position, and Global Fishing Watch events, on one time axis.
 * Hover or drag to see where the vessel was; click to keep that moment; play to replay it.
 */
export default function VesselTimeline({
  apiBase,
  mmsi,
  name,
  days,
  onDaysChange,
  track,
  loading,
  onScrub,
  className = '',
}: {
  apiBase: string;
  mmsi: string;
  name: string;
  days: number;
  onDaysChange: (days: number) => void;
  track: VesselTrack | null;
  loading: boolean;
  onScrub?: (scrub: VesselScrub | null) => void;
  className?: string;
}) {
  const [events, setEvents] = useState<GfwEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [scrubT, setScrubT] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const [playing, setPlaying] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const scrubTRef = useRef(scrubT);
  scrubTRef.current = scrubT;
  const onScrubRef = useRef(onScrub);
  onScrubRef.current = onScrub;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // The server caches the 30-day event set, so this is cheap to ask for per vessel
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/gfw/events?hours=720`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setEvents(Array.isArray(d?.events) ? d.events : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  // New vessel or range: start from "now" again
  useEffect(() => {
    setScrubT(null);
    setPinned(false);
    setPlaying(false);
  }, [mmsi, days]);

  useEffect(() => () => onScrubRef.current?.(null), []);

  const start = now - days * 24 * HOUR;
  const x = (t: number) => ((Math.min(Math.max(t, start), now) - start) / (now - start)) * W;

  const view = useMemo(() => {
    const current = track && track.mmsi === mmsi && track.days === days ? track : null;
    const points = (current?.points || []).filter((p) => p.t >= start && p.t <= now);
    // Downsampled history: anything well beyond the sampling step is "no position"
    const threshold = Math.max(3 * (current?.intervalMin || 15) * 60_000, HOUR);
    const gaps: [number, number][] = [];
    if (current) {
      let prev = start;
      for (const p of points) {
        if (p.t - prev > threshold) gaps.push([prev, p.t]);
        prev = p.t;
      }
      if (now - prev > threshold) gaps.push([prev, now]);
    }
    const maxSpeed = Math.max(15, ...points.map((p) => p.speed ?? 0));
    // Speed line, broken at gaps
    const segments: string[] = [];
    let seg: string[] = [];
    let last: number | null = null;
    for (const p of points) {
      if (p.speed == null) continue;
      if (last != null && p.t - last > threshold && seg.length) {
        segments.push(seg.join(' '));
        seg = [];
      }
      seg.push(`${x(p.t).toFixed(1)},${(34 - (p.speed / maxSpeed) * 28).toFixed(1)}`);
      last = p.t;
    }
    if (seg.length) segments.push(seg.join(' '));
    const vesselEvents = events
      .filter((e) => (e.mmsi === mmsi || e.partnerMmsi === mmsi) && EVENT_STYLE[e.type])
      .map((e) => {
        const t0 = Date.parse(e.time);
        const t1 = e.end ? Date.parse(e.end) : t0;
        return { ...e, t0, t1: Number.isFinite(t1) ? t1 : t0 };
      })
      .filter((e) => Number.isFinite(e.t0) && e.t1 >= start && e.t0 <= now);
    return { loaded: Boolean(current), points, threshold, gaps, segments, maxSpeed, vesselEvents };
    // x depends only on start/now
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, mmsi, days, events, start, now]);

  const multiDay = days > 1;
  const fromTrack = scrubT != null ? positionAt(view.points, scrubT, view.threshold) : null;
  // Outside BarentsWatch coverage, a GFW event at this moment still says where the vessel was
  const event =
    scrubT != null && (!fromTrack || fromTrack.stale)
      ? view.vesselEvents.find(
          (e) =>
            scrubT >= e.t0 - 60_000 &&
            scrubT <= Math.max(e.t1, e.t0) + 60_000 &&
            Number.isFinite(Number(e.position?.lon)) &&
            Number.isFinite(Number(e.position?.lat))
        )
      : undefined;
  const here = event
    ? {
        lon: Number(event.position!.lon),
        lat: Number(event.position!.lat),
        speed: null,
        course: null,
        stale: false,
        since: 0,
        eventLabel: EVENT_STYLE[event.type].label,
      }
    : fromTrack
      ? { ...fromTrack, eventLabel: null as string | null }
      : null;
  const readout =
    scrubT == null
      ? null
      : !here
        ? `${shortUtc(scrubT, multiDay)} · no position yet`
        : here.eventLabel
          ? `${shortUtc(scrubT, multiDay)} · ${here.eventLabel} · position from GFW`
          : here.stale
          ? `${shortUtc(scrubT, multiDay)} · no position, latest signal ${duration(here.since)} earlier`
          : [
              shortUtc(scrubT, multiDay),
              here.speed != null ? `${here.speed.toFixed(1)} kn` : null,
              here.course != null ? `${Math.round(here.course)}°` : null,
            ]
              .filter(Boolean)
              .join(' · ');

  // Tell the map where to draw the ghost marker
  useEffect(() => {
    if (scrubT == null || !here) {
      onScrubRef.current?.(null);
      return;
    }
    onScrubRef.current?.({
      lon: here.lon,
      lat: here.lat,
      label: here.eventLabel
        ? `${shortUtc(scrubT, multiDay)} · ${here.eventLabel}`
        : here.stale
          ? `${shortUtc(scrubT, multiDay)} · latest signal`
          : shortUtc(scrubT, multiDay),
      stale: here.stale,
      follow: pinned || playing,
    });
    // `here` is derived from scrubT and the track
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubT, view, multiDay, pinned, playing]);

  // Playback: walk the cursor from the first fix (or where it stands) to now
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let prev = performance.now();
    const step = (ts: number) => {
      const dt = ts - prev;
      prev = ts;
      const next = (scrubTRef.current ?? start) + (dt * (now - start)) / PLAYBACK_MS;
      if (next >= now) {
        setScrubT(now);
        setPlaying(false);
        return;
      }
      setScrubT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, start, now]);

  const timeFromPointer = (clientX: number) => {
    const r = chartRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    const f = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    return start + f * (now - start);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = timeFromPointer(e.clientX);
    if (t == null) return;
    dragging.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    setPlaying(false);
    setPinned(true);
    setScrubT(t);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current && (pinned || playing)) return;
    const t = timeFromPointer(e.clientX);
    if (t != null) setScrubT(t);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };
  const onPointerLeave = () => {
    if (!dragging.current && !pinned && !playing) setScrubT(null);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const range = now - start;
    const stepMs = e.shiftKey ? range / 20 : range / 100;
    const from = scrubT ?? now;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = from - stepMs;
    else if (e.key === 'ArrowRight') next = from + stepMs;
    else if (e.key === 'Home') next = start;
    else if (e.key === 'End') next = now;
    else if (e.key === 'Escape') {
      setPinned(false);
      setPlaying(false);
      setScrubT(null);
      return;
    } else return;
    e.preventDefault();
    setPlaying(false);
    setPinned(true);
    setScrubT(Math.min(Math.max(next, start), now));
  };

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Restart from the first fix when at the end or nothing is picked
    if (scrubT == null || scrubT >= now - 1000) setScrubT(view.points[0]?.t ?? start);
    setPinned(true);
    setPlaying(true);
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const hoursBack = (1 - f) * days * 24;
    return f === 1 ? 'now' : days === 1 ? `−${Math.round(hoursBack)} h` : `−${(hoursBack / 24).toFixed(hoursBack % 24 ? 1 : 0)} d`;
  });
  const eventTypes = [...new Set(view.vesselEvents.map((e) => e.type))];
  const cursorPct = scrubT != null ? (x(scrubT) / W) * 100 : null;

  return (
    <section className={`vessel-timeline ${className}`.trim()} aria-label={`Timeline for ${name}`}>
      <div className="vt-head">
        <div className="vt-title">Timeline · {name}</div>
        <div className="vt-ranges" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              aria-pressed={r.days === days}
              className={r.days === days ? 'on' : undefined}
              onClick={() => onDaysChange(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="vt-play"
          onClick={togglePlay}
          disabled={!view.points.length}
          aria-label={playing ? 'Pause playback' : 'Play back the track'}
        >
          {playing ? (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 1.5l7 4.5-7 4.5z" fill="currentColor" />
            </svg>
          )}
        </button>
        {readout ? (
          <span className="vt-readout" aria-live="polite">
            {readout}
            {pinned && !playing && (
              <button
                type="button"
                className="vt-clear"
                aria-label="Back to now"
                onClick={() => {
                  setPinned(false);
                  setScrubT(null);
                }}
              >
                ×
              </button>
            )}
          </span>
        ) : (
          <span className="vt-stats">
            {loading
              ? 'Loading positions…'
              : view.loaded
                ? `${view.points.length} positions · ${view.gaps.length} without position · ${view.vesselEvents.length} GFW events`
                : 'No history loaded'}
          </span>
        )}
      </div>

      <div className="vt-chart">
        <div
          ref={chartRef}
          className="vt-scrub"
          role="slider"
          tabIndex={0}
          aria-label="Move through time; arrow keys step, Escape returns to now"
          aria-valuemin={start}
          aria-valuemax={now}
          aria-valuenow={Math.round(scrubT ?? now)}
          aria-valuetext={readout || 'Now'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onKeyDown={onKeyDown}
        >
          <svg viewBox={`0 0 ${W} 72`} preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 34.5 H1000 M0 53.5 H1000" className="vt-grid" />
            <path d="M250 2 V70 M500 2 V70 M750 2 V70" className="vt-grid" />
            {view.gaps.map(([a, b]) => (
              <rect key={`${a}-${b}`} x={x(a)} y={38} width={Math.max(x(b) - x(a), 1.5)} height={14} rx={2} className="vt-gap">
                <title>{`No position received · ${duration(b - a)} · ${utc(a)} → ${utc(b)}`}</title>
              </rect>
            ))}
            {view.segments.map((pts, i) => (
              <polyline key={i} points={pts} className="vt-speed" />
            ))}
            {view.points.map((p) => (
              <rect key={p.t} x={x(p.t) - 0.4} y={40} width={0.8} height={10} className="vt-fix" />
            ))}
            {view.vesselEvents.map((e) => (
              <rect
                key={`${e.type}-${e.t0}`}
                x={x(e.t0)}
                y={57}
                width={Math.max(x(e.t1) - x(e.t0), 3)}
                height={10}
                rx={2}
                fill={EVENT_STYLE[e.type].color}
                className="vt-event"
                onPointerDown={(ev) => {
                  // Jump to the start of the event instead of where the pointer landed
                  ev.stopPropagation();
                  setPlaying(false);
                  setPinned(true);
                  setScrubT(e.t0);
                }}
              >
                <title>{`${EVENT_STYLE[e.type].label} · ${utc(e.t0)}${e.t1 > e.t0 ? ` → ${utc(e.t1)}` : ''} · click to jump`}</title>
              </rect>
            ))}
            <path d="M999 0 V72" className="vt-now" />
          </svg>
          {cursorPct != null && <span className="vt-cursor" style={{ left: `${cursorPct}%` }} aria-hidden="true" />}
        </div>
        <div className="vt-axis">
          {ticks.map((t, i) => (
            <span key={i} className={t === 'now' ? 'now' : undefined}>
              {t}
            </span>
          ))}
        </div>
      </div>

      <div className="vt-legend">
        <span>
          <i className="vt-key-speed" />
          Speed (max {Math.round(view.maxSpeed)} kn)
        </span>
        <span>
          <i className="vt-key-fix" />
          Position report
        </span>
        <span>
          <i className="vt-key-gap" />
          No position received
        </span>
        {eventTypes.map((type) => (
          <span key={type}>
            <i style={{ background: EVENT_STYLE[type].color }} />
            {EVENT_STYLE[type].label}
          </span>
        ))}
        <span className="vt-source">
          {/* The static copy adds each run's position (writeSiteSnapshot.ts), e.g. from Digitraffic */}
          {SNAPSHOT_MODE
            ? 'BarentsWatch history · positions saved every 30 min'
            : 'BarentsWatch history · Norwegian waters'}
        </span>
      </div>
    </section>
  );
}
