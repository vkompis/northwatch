'use client';

import type { VesselFeatureProps } from '@svalmap/ui';
import { HEADER_COLORS, formatLatLonDm, navStatusLabel } from '@svalmap/ui';
import { MasterMarker, SANCTION_EDGE, SHADOW_EDGE, TriangleMarker, WarningMarker } from './LayerRow';

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

/** One entry on a sanctions / GUR list, as /api/sanctions/lookup returns it. */
type Listing = {
  kind: 'sanction' | 'shadow' | 'gur' | 'master';
  source: string;
  title: string;
  programmes: string[];
  detail: string | null;
  listedName: string | null;
  listedImo: string | null;
  listedMmsi: string | null;
  since: string | null;
  url: string | null;
  urlLabel: string | null;
  matchedBy: ('imo' | 'mmsi')[];
};

const sameName = (a: string, b: string) =>
  a.toUpperCase().replace(/[^A-Z0-9]/g, '') === b.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Matched on MMSI only, but listed under another IMO or name: the MMSI may have been reused. */
function mmsiOnlyMismatch(l: Listing, v: VesselFeatureProps): boolean {
  if (l.matchedBy.includes('imo')) return false;
  if (l.listedImo && v.imo && l.listedImo !== v.imo) return true;
  return !!(l.listedName && v.name && !sameName(l.listedName, v.name));
}

function ListingMarker({ kind }: { kind: Listing['kind'] }) {
  if (kind === 'sanction') return <WarningMarker edge={SANCTION_EDGE} />;
  if (kind === 'shadow') return <WarningMarker edge={SHADOW_EDGE} />;
  if (kind === 'master') return <MasterMarker />;
  return <TriangleMarker color="var(--sv-muted)" />;
}

const externalLink = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** Right-hand dossier for a selected vessel: identity, risk, live facts, reach, sources, note. */
export default function VesselDossier({
  vessel: v,
  sanctions,
  note,
  onNoteChange,
  watched,
  onWatch,
  onAreaAlert,
  onExport,
}: {
  vessel: VesselFeatureProps;
  sanctions: any | null;
  note: string;
  onNoteChange: (text: string) => void;
  watched: boolean;
  onWatch: () => void;
  onAreaAlert: () => void;
  onExport: () => void;
}) {
  const sanctioned = !!v.sanctioned || sanctions?.sanctioned === true;
  const shadow = !!v.shadowfleet || sanctions?.shadowfleet === true;
  const listings: Listing[] = Array.isArray(sanctions?.listings) ? sanctions.listings : [];
  const sanctionListings = listings.filter((l) => l.kind === 'sanction');
  const master = !sanctioned && (!!v.sanctionedMaster || listings.some((l) => l.kind === 'master'));
  // Badge names the programme; a match that rests on a reused-looking MMSI says so
  const sanctionBadge = sanctionListings.length
    ? sanctionListings.every((l) => mmsiOnlyMismatch(l, v))
      ? 'Sanctions match on MMSI only'
      : `Sanctioned · ${sanctionListings[0].programmes[0] || sanctionListings[0].title}`
    : 'Sanctioned · list match';
  const imoOk = !!v.imo && /^\d{7}$/.test(v.imo);
  const lookups: [string, string][] = [
    ['VesselFinder', `https://www.vesselfinder.com/vessels/details/${imoOk ? v.imo : v.mmsi}`],
    ['MarineTraffic', `https://www.marinetraffic.com/en/ais/details/ships/${imoOk ? `imo:${v.imo}` : `mmsi:${v.mmsi}`}`],
    ['OpenSanctions', sanctions?.opensanctionsUrl || `https://www.opensanctions.org/search/?q=${imoOk ? `IMO${v.imo}` : v.mmsi}`],
    ['EU designated vessels (DMA)', sanctions?.euListUrl || 'https://www.dma.dk/growth-and-framework-conditions/maritime-sanctions/general-information/eu-vessel-designations'],
    ['GUR War & Sanctions', sanctions?.gurListUrl || 'https://war-sanctions.gur.gov.ua/en/transport/ships'],
  ];
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

      {(sanctioned || shadow || master || v.category === 'research' || v.category === 'military') && (
        <div className="dossier-badges">
          {sanctioned && (
            <span className="dossier-badge sanction">
              <WarningMarker edge={SANCTION_EDGE} />
              {sanctionBadge}
            </span>
          )}
          {master && (
            <span className="dossier-badge master">
              <MasterMarker />
              Sanctioned master
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

      <dl className="dossier-facts">
        {facts.map(([k, val]) => (
          <div key={k} className={k === 'Position' || k === 'Last fix' ? 'wide' : undefined}>
            <dt>{k}</dt>
            <dd className={val ? undefined : 'missing'}>{val || 'Not reported'}</dd>
          </div>
        ))}
      </dl>

      <h3 className="dossier-h">Lists</h3>
      {!sanctions ? (
        <p className="dossier-note">Checking the lists…</p>
      ) : listings.length === 0 ? (
        <p className="dossier-note">Not on the EU, OpenSanctions or Ukraine GUR lists.</p>
      ) : (
        <ul className="dossier-listings">
          {listings.map((l, i) => (
            <li key={`${l.source}-${l.kind}-${i}`} className={`dossier-listing ${l.kind}`}>
              <span className="listing-marker">
                <ListingMarker kind={l.kind} />
              </span>
              <div>
                <div className="listing-title">{l.title}</div>
                {l.programmes.length > 0 && <div className="listing-programmes">{l.programmes.join(' · ')}</div>}
                {l.detail && <div className="listing-detail">{l.kind === 'master' ? `Master: ${l.detail}` : l.detail}</div>}
                <div className="listing-meta">
                  {[
                    l.listedName && `Listed as ${l.listedName}`,
                    l.listedImo && `IMO ${l.listedImo}`,
                    l.listedMmsi && `MMSI ${l.listedMmsi}`,
                    l.since && `since ${l.since}`,
                    `matched on ${l.matchedBy.map((m) => m.toUpperCase()).join(' + ')}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {mmsiOnlyMismatch(l, v) && (
                  <div className="listing-warn">
                    Listed under another name or IMO — this MMSI may have been reused. Check the entry before relying on it.
                  </div>
                )}
                {l.url && (
                  <a className="dossier-link" href={l.url} {...externalLink}>
                    {l.urlLabel || 'Open entry'} ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="dossier-h">Look up</h3>
      <div className="dossier-lookups">
        {lookups.map(([label, href]) => (
          <a key={label} href={href} {...externalLink}>
            {label} ↗
          </a>
        ))}
      </div>
      <p className="dossier-note">
        Position via {SOURCE_LABELS[v.source || ''] || (v.source ? v.source : 'search (not in the live feed)')}
      </p>

      <label className="dossier-notefield">
        <span className="dossier-h">Note</span>
        <textarea rows={3} value={note} onChange={(e) => onNoteChange(e.target.value)} />
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
