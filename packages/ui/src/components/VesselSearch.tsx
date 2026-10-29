'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

export type VesselSearchHit = {
  mmsi: string;
  vessel_name?: string | null;
  name?: string | null;
  imo?: string | null;
  lon: number;
  lat: number;
  sanctioned?: boolean;
  shadowfleet?: boolean;
  sanctionedMaster?: boolean;
  military?: boolean;
  research?: boolean;
  shipType?: string | null;
  timestamp?: string | null;
  speed?: number | null;
  course?: number | null;
  heading?: number | null;
  status?: string | number | null;
  destination?: string | null;
  eta?: string | null;
  /** False when the ship is in the AIS feeds but outside the map's display rules. */
  onMap?: boolean;
};

type Props = {
  apiBase: string;
  onSelect: (hit: VesselSearchHit) => void;
  /** A 9-digit MMSI with no AIS match — open it anyway (sanctions lookup, history). */
  onOpenMmsi?: (mmsi: string) => void;
  className?: string;
};

function ageLabel(ts?: string | null): string {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 60) return `${Math.max(min, 0)} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export default function VesselSearch({ apiBase, onSelect, onOpenMmsi, className = '' }: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<VesselSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  // Results for an older query must not replace those of the current one
  const latestQuery = useRef('');
  /** Text we put in the box after a pick — searching it must not reopen the list. */
  const pickedText = useRef<string | null>(null);
  /** Enter pressed before results arrived — pick the top hit when they do. */
  const enterPending = useRef(false);
  const onSelectRef = useRef<(h: VesselSearchHit) => void>(() => undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const search = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length < 2) {
        latestQuery.current = trimmed;
        setHits([]);
        setLoading(false);
        return;
      }
      latestQuery.current = trimmed;
      setLoading(true);
      try {
        const { data } = await axios.get(`${apiBase}/api/vessels/search`, {
          params: { q: trimmed },
          timeout: 15000,
        });
        if (latestQuery.current !== trimmed) return;
        const results: VesselSearchHit[] = Array.isArray(data?.results) ? data.results : [];
        setHits(results);
        setActive(0);
        if (enterPending.current && results[0]) {
          enterPending.current = false;
          onSelectRef.current(results[0]);
          return;
        }
        if (pickedText.current !== trimmed) setOpen(true);
      } catch {
        if (latestQuery.current === trimmed) setHits([]);
      } finally {
        if (latestQuery.current === trimmed) setLoading(false);
      }
    },
    [apiBase]
  );

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(q), 220);
    return () => clearTimeout(timer.current);
  }, [q, search]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  onSelectRef.current = (h) => choose(h);
  const choose = (h: VesselSearchHit) => {
    onSelect(h);
    const text = h.vessel_name || h.name || h.mmsi;
    pickedText.current = text.trim();
    setQ(text);
    setOpen(false);
  };
  const mmsiQuery = /^\d{9}$/.test(q.trim()) ? q.trim() : null;
  const offerMmsi = Boolean(onOpenMmsi && mmsiQuery && !hits.some((h) => h.mmsi === mmsiQuery));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      // Still typing (debounce) or waiting for the server: pick once the results land
      if (loading || latestQuery.current !== q.trim()) enterPending.current = true;
      else if (hits[active]) choose(hits[active]);
      else if (offerMmsi && mmsiQuery) {
        onOpenMmsi?.(mmsiQuery);
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={`vessel-search ${className}`.trim()} ref={boxRef}>
      <input
        type="search"
        placeholder="Search MMSI, IMO, name…"
        value={q}
        onChange={(e) => {
          pickedText.current = null;
          enterPending.current = false;
          setQ(e.target.value);
        }}
        onFocus={() => hits.length && setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search vessels"
        autoComplete="off"
      />
      {loading && <span className="vessel-search-hint">…</span>}
      {open && hits.length > 0 && (
        <ul className="vessel-search-results" role="listbox">
          {hits.map((h, i) => (
            <li key={h.mmsi}>
              <button
                type="button"
                className={i === active ? 'active' : undefined}
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(h)}
              >
                <span className="vs-name">
                  {h.vessel_name || h.name || 'Unnamed'}
                  {h.onMap === false && <span className="vs-tag">not on map</span>}
                </span>
                <span className="vs-meta">
                  {h.mmsi}
                  {h.imo ? ` · IMO ${h.imo}` : ''}
                  {h.sanctioned ? ' · sanctioned' : ''}
                  {h.shadowfleet ? ' · shadow' : ''}
                  {h.sanctionedMaster ? ' · sanctioned master' : ''}
                  {h.timestamp ? ` · ${ageLabel(h.timestamp)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && !loading && q.trim().length >= 2 && hits.length === 0 && (
        <div className="vessel-search-empty">
          No ship in the current AIS data
          {offerMmsi && mmsiQuery && (
            <button
              type="button"
              className="vessel-search-open"
              onClick={() => {
                onOpenMmsi?.(mmsiQuery);
                setOpen(false);
              }}
            >
              Open MMSI {mmsiQuery} anyway
            </button>
          )}
        </div>
      )}
    </div>
  );
}
