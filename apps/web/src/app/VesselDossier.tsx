'use client';

import type { VesselFeatureProps } from '@svalmap/ui';
import { HEADER_COLORS, ShipPhoto, formatLatLonDm, navStatusLabel } from '@svalmap/ui';
import { SANCTION_EDGE, SHADOW_EDGE, TriangleMarker, WarningMarker } from './LayerRow';

const SOURCE_LABELS: Record<string, string> = {
  aisstream: 'AISStream',
  barentswatch: 'BarentsWatch',
  'aisstream+bw': 'AISStream + BarentsWatch',
};

function ago(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function utc(iso: string | null): string | null {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Right-hand dossier for a selected vessel: identity, risk, live facts, reach, sources, note. */
export default function VesselDossier({
  vessel: v,
  sanctions,
  apiBase,
  note,
  onNoteChange,
  watched,
  onWatch,
  onAreaAlert,
  onExport,
}: {
  vessel: VesselFeatureProps;
  sanctions: any | null;
  apiBase: string;
  note: string;
  onNoteChange: (text: string) => void;
  watched: boolean;
  onWatch: () => void;
  onAreaAlert: () => void;
  onExport: () => void;
}) {
  const sanctioned = !!v.sanctioned || sanctions?.sanctioned === true;
  const shadow = !!v.shadowfleet || sanctions?.shadowfleet === true;
  const speed = num(v.speed);
  const course = num(v.course);
  const heading = num(v.heading);
  const hasPos = v.lon != null && v.lat != null && Number.isFinite(v.lon) && Number.isFinite(v.lat);
  const lastFix = utc(v.timestamp);

  const facts: [string, string | null][] = [
    ['MMSI', v.mmsi],
    ['IMO', v.imo],
    ['Speed', speed != null ? `${speed.toFixed(1)} kn` : null],
    ['Course', course != null ? `${course.toFixed(1)}°` : null],
    ['Heading', heading != null && heading !== 511 ? `${Math.round(heading)}°` : null],
    ['Status', v.status != null && v.status !== '' ? navStatusLabel(v.status) : null],
    ['Destination', v.destination],
    ['ETA', v.eta],
    ['Position', hasPos ? formatLatLonDm(v.lat as number, v.lon as number) : null],
    ['Last fix', lastFix ? `${ago(v.timestamp)} · ${lastFix}` : null],
  ];
  // Same distances the map's projection rings use
  const reach = speed != null && speed >= 0.5 ? [1, 3, 6].map((h) => ({ h, nm: Math.round(speed * h) })) : null;

  return (
    <div className="dossier">
      <div className="dossier-kicker">Vessel dossier</div>
      <h2 className="dossier-name">{v.name || `MMSI ${v.mmsi}`}</h2>
      <div className="dossier-sub">
        <TriangleMarker color={HEADER_COLORS[v.category] || HEADER_COLORS.rest} />
        <img
          src={`/flag-icons/${v.flag || 'xx'}.svg`}
          alt=""
          width={18}
          height={12}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
        <span>
          {v.shipType || 'Type not reported'} · {v.country || 'Unknown flag'}
        </span>
      </div>

      {(sanctioned || shadow || v.category === 'research' || v.category === 'military') && (
        <div className="dossier-badges">
          {sanctioned && (
            <span className="dossier-badge sanction">
              <WarningMarker edge={SANCTION_EDGE} />
              Sanctioned · list match
            </span>
          )}
          {shadow && (
            <span className="dossier-badge shadow">
              <WarningMarker edge={SHADOW_EDGE} />
              Shadow fleet · GUR list
            </span>
          )}
          {v.category === 'research' && (
            <span className="dossier-badge">
              <TriangleMarker color={HEADER_COLORS.research} />
              Russian research vessel
            </span>
          )}
          {v.category === 'military' && (
            <span className="dossier-badge">
              <TriangleMarker color={HEADER_COLORS.military} />
              Military / law enforcement
            </span>
          )}
        </div>
      )}

      <ShipPhoto imo={v.imo} vesselName={v.name} proxyBase={apiBase} />

      <dl className="dossier-facts">
        {facts.map(([k, val]) => (
          <div key={k} className={k === 'Position' || k === 'Last fix' ? 'wide' : undefined}>
            <dt>{k}</dt>
            <dd className={val ? undefined : 'missing'}>{val || 'Not reported'}</dd>
          </div>
        ))}
      </dl>

      <h3 className="dossier-h">Where it could be</h3>
      {reach ? (
        <>
          <div className="dossier-reach">
            {reach.map((r) => (
              <div key={r.h}>
                <span>+{r.h} h</span>
                <strong>{r.nm} nm</strong>
              </div>
            ))}
          </div>
          <p className="dossier-note">At current speed over ground. Rings on the map.</p>
        </>
      ) : (
        <p className="dossier-note">Stationary, or no speed reported.</p>
      )}

      <h3 className="dossier-h">Sources</h3>
      <ul className="dossier-sources">
        <li>
          <span>Position</span>
          {SOURCE_LABELS[v.source || ''] || (v.source ? v.source : 'Not in the live feed')}
        </li>
        <li>
          <span>Sanctions</span>
          {sanctions ? (sanctions.sanctioned ? 'Match' : 'No match') : 'Checking…'}
          {sanctions?.sanctioned && sanctions.sources?.[0] ? ` · ${sanctions.sources[0]}` : ''}
        </li>
        <li>
          <span>Shadow fleet</span>
          {sanctions ? (sanctions.shadowfleet ? 'Match · GUR list' : 'No match') : 'Checking…'}
        </li>
      </ul>
      {sanctions?.disclaimer && <p className="dossier-note">{sanctions.disclaimer}</p>}
      {sanctions?.opensanctionsUrl && (
        <a className="dossier-link" href={sanctions.opensanctionsUrl} target="_blank" rel="noopener noreferrer">
          Search OpenSanctions ↗
        </a>
      )}

      <label className="dossier-notefield">
        <span className="dossier-h">Analyst note</span>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          placeholder="What did you see, and where did it come from? (saved in this browser)"
        />
      </label>

      <div className="dossier-actions">
        <button type="button" className="primary" onClick={onWatch} aria-pressed={watched}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill={watched ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" />
          </svg>
          {watched ? 'On watchlist' : 'Watch vessel'}
        </button>
        <button type="button" onClick={onAreaAlert}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 7l9-3 6 8-5 8-10-3z" />
          </svg>
          Area alert
        </button>
        <button type="button" onClick={onExport}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
          </svg>
          Export pack
        </button>
      </div>
    </div>
  );
}
