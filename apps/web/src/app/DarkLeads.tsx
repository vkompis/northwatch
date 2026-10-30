'use client';

import { useEffect, useState } from 'react';
import type { GfwEventProps } from '@svalmap/ui';

type GapLead = {
  mmsi: string | null;
  name: string | null;
  flag: string | null;
  russian: boolean;
  sanctioned: boolean;
  shadowfleet: boolean;
  gapStart: string;
  gapEnd: string | null;
  kmFromOff: number;
  detourKm: number | null;
};
type QuietLead = { mmsi: string; name: string | null; why: string | null; lastFix: string; hoursSilentBefore: number; km: number };
type RadarLead = { day: string; lon: number; lat: number; kmFromOff: number; detourKm: number | null; sentinel1Url: string };

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '…');
const ext = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * Dark-vessel leads for a GFW card: a radar detection with no AIS lists ships that went dark
 * and could have been there; an AIS-off gap lists radar detections its ship could have been.
 * Both link to Sentinel-1 radar for the same place and day.
 */
export default function DarkLeads({
  apiBase,
  event: ev,
  onOpenVessel,
}: {
  apiBase: string;
  event: GfwEventProps;
  onOpenVessel: (mmsi: string, name?: string | null) => void;
}) {
  const isDarkRadar = ev.subtype === 'sar' && ev.matched !== true;
  const isGap = ev.subtype === 'ais_off' && !!ev.mmsi && !!ev.time;
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!isDarkRadar && !isGap) return;
    const url = isDarkRadar
      ? `${apiBase}/api/gfw/dark-leads?lat=${ev.lat}&lon=${ev.lon}&time=${encodeURIComponent(ev.time || '')}`
      : `${apiBase}/api/gfw/gap-radar?mmsi=${encodeURIComponent(ev.mmsi!)}&time=${encodeURIComponent(ev.time!)}`;
    let cancelled = false;
    fetch(url)
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j?.error || `HTTP ${r.status}`)))))
      .then((j) => !cancelled && setData(j))
      .catch((e) => !cancelled && setError(e?.message || 'Could not load'));
    return () => {
      cancelled = true;
    };
  }, [apiBase, ev.lat, ev.lon, ev.time, ev.mmsi, isDarkRadar, isGap]);

  if (!isDarkRadar && !isGap) return null;

  return (
    <div className="row dark-leads" style={{ display: 'block' }}>
      <div className="panel-kicker">{isDarkRadar ? 'Who could this be?' : 'Radar detections during the gap'}</div>
      {error && <p className="panel-note">{error}</p>}
      {!data && !error && <p className="panel-note">Looking for leads…</p>}

      {data && isDarkRadar && (
        <>
          {(data.gapLeads as GapLead[]).map((l) => (
            <button key={`${l.mmsi}-${l.gapStart}`} type="button" className="lead" onClick={() => l.mmsi && onOpenVessel(l.mmsi, l.name)}>
              <span className="lead-name">
                {l.name || `MMSI ${l.mmsi}`}
                {l.flag ? ` · ${l.flag}` : ''}
                {l.sanctioned ? ' · sanctioned' : l.shadowfleet ? ' · shadow fleet' : ''}
              </span>
              <span className="lead-meta">
                AIS off {day(l.gapStart)} → {day(l.gapEnd)} · {l.kmFromOff} km from where it went dark
                {l.detourKm != null ? ` · ${l.detourKm} km off its route` : ''}
              </span>
            </button>
          ))}
          {(data.quietLeads as QuietLead[]).map((q) => (
            <button key={q.mmsi} type="button" className="lead" onClick={() => onOpenVessel(q.mmsi, q.name)}>
              <span className="lead-name">
                {q.name || `MMSI ${q.mmsi}`}
                {q.why ? ` · ${q.why}` : ''}
              </span>
              <span className="lead-meta">
                Silent since {q.hoursSilentBefore} h before · last seen {q.km} km away
              </span>
            </button>
          ))}
          {!data.gapLeads.length && !data.quietLeads.length && (
            <p className="panel-note">No ship of interest went dark within reach in GFW's 30-day window.</p>
          )}
          <a className="panel-link" href={data.sentinel1Url} {...ext}>
            Sentinel-1 radar here on {data.day} ↗
          </a>
        </>
      )}

      {data && isGap && (
        <>
          {(data.detections as RadarLead[]).map((d) => (
            <a key={`${d.day}-${d.lon}-${d.lat}`} className="lead" href={d.sentinel1Url} {...ext}>
              <span className="lead-name">{d.day} · radar, no AIS</span>
              <span className="lead-meta">
                {d.kmFromOff} km from where AIS went off
                {d.detourKm != null ? ` · ${d.detourKm} km off its route` : ''} · open in Sentinel-1 ↗
              </span>
            </a>
          ))}
          {!data.detections.length && (
            <p className="panel-note">No radar detection without AIS within reach during the gap.</p>
          )}
          <a className="panel-link" href={data.sentinel1Off} {...ext}>
            Sentinel-1 where AIS went off ({day(ev.time)}) ↗
          </a>
          {data.sentinel1On && (
            <a className="panel-link" href={data.sentinel1On} {...ext}>
              Sentinel-1 where AIS came back ({day(ev.end)}) ↗
            </a>
          )}
        </>
      )}
      <p className="panel-note">
        Could have been there at up to 15 kn — a lead to check in the imagery, not an identification.
      </p>
    </div>
  );
}
