'use client';

import type { SpoofReason, VesselFeatureProps } from '@svalmap/ui';
import { HEADER_COLORS, formatLatLonDm, navStatusLabel } from '@svalmap/ui';
import { MasterMarker, SANCTION_EDGE, SHADOW_EDGE, SpoofMarker, TriangleMarker, WarningMarker } from './LayerRow';

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
  kind: 'sanction' | 'shadow' | 'gur' | 'master' | 'fleetleaks';
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

/** Live evidence (on the ship's map record) and what its track showed, newest first, once each. */
function spoofReasons(v: VesselFeatureProps, fromTrack: SpoofReason[] | undefined): SpoofReason[] {
  let live: SpoofReason[] = [];
  try {
    live = v.spoofingWhy ? JSON.parse(v.spoofingWhy) : [];
  } catch {
    /* ignore */
  }
  const shape = (r: SpoofReason) => `${r.kind}:${r.text.replace(/\d+/g, '#')}`;
  const out: SpoofReason[] = [];
  for (const r of [...live, ...(fromTrack || [])]) if (!out.some((o) => shape(o) === shape(r))) out.push(r);
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function ListingMarker({ kind }: { kind: Listing['kind'] }) {
  if (kind === 'sanction') return <WarningMarker edge={SANCTION_EDGE} />;
  if (kind === 'shadow') return <WarningMarker edge={SHADOW_EDGE} />;
  if (kind === 'master') return <MasterMarker />;
  if (kind === 'fleetleaks') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sv-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.7 2.7L16.5 9.5" />
      </svg>
    );
  }
  return <TriangleMarker color="var(--sv-muted)" />;
}

const externalLink = { target: '_blank', rel: 'noopener noreferrer' } as const;

/**
 * Copernicus Browser on Sentinel-2 true colour, at the ship's position on the day of its
 * last fix — the place to start looking for an image of it. Sentinel-2 is optical: in the
 * polar night and under cloud, switch the browser to Sentinel-1 radar.
 */
function copernicusUrl(v: VesselFeatureProps): string {
  const base = 'https://browser.dataspace.copernicus.eu/';
  const day = (v.timestamp && !Number.isNaN(Date.parse(v.timestamp)) ? new Date(v.timestamp) : new Date())
    .toISOString()
    .slice(0, 10);
  const params = new URLSearchParams({
    zoom: '12',
    themeId: 'DEFAULT-THEME',
    datasetId: 'S2_L2A_CDAS',
    layerId: '1_TRUE_COLOR',
    fromTime: `${day}T00:00:00.000Z`,
    toTime: `${day}T23:59:59.999Z`,
    dateMode: 'SINGLE',
    cloudCoverage: '30',
  });
  if (v.lat != null && v.lon != null && Number.isFinite(v.lat) && Number.isFinite(v.lon)) {
    params.set('lat', v.lat.toFixed(5));
    params.set('lng', v.lon.toFixed(5));
  }
  return `${base}?${params}`;
}

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
  trackSpoofing,
}: {
  vessel: VesselFeatureProps;
  sanctions: any | null;
  note: string;
  onNoteChange: (text: string) => void;
  watched: boolean;
  onWatch: () => void;
  onAreaAlert: () => void;
  onExport: () => void;
  /** Spoofing evidence in the ship's loaded track */
  trackSpoofing?: SpoofReason[];
}) {
  const sanctioned = !!v.sanctioned || sanctions?.sanctioned === true;
  const shadow = !!v.shadowfleet || sanctions?.shadowfleet === true;
  const listings: Listing[] = Array.isArray(sanctions?.listings) ? sanctions.listings : [];
  const sanctionListings = listings.filter((l) => l.kind === 'sanction');
  const master = !sanctioned && (!!v.sanctionedMaster || listings.some((l) => l.kind === 'master'));
  const spoofing = spoofReasons(v, trackSpoofing);
  // Badge names the programme; a match that rests on a reused-looking MMSI says so
  const sanctionBadge = sanctionListings.length
    ? sanctionListings.every((l) => mmsiOnlyMismatch(l, v))
      ? 'Sanctions match on MMSI only'
      : `Sanctioned · ${sanctionListings[0].programmes[0] || sanctionListings[0].title}`
    : 'Sanctioned · list match';
  const imoOk = !!v.imo && /^\d{7}$/.test(v.imo);
  // Straight to the ship's own entry when it is listed; otherwise the list searched for it
  const gurEntry = listings.find((l) => l.source === 'GUR' && l.url && l.kind !== 'master');
  const gurUrl =
    gurEntry?.url ||
    `https://war-sanctions.gur.gov.ua/en/transport/ships?f%5Bsearch%5D=${encodeURIComponent(imoOk ? v.imo! : v.name || v.mmsi)}`;
  const lookups: [string, string][] = [
    ['VesselFinder', `https://www.vesselfinder.com/vessels/details/${imoOk ? v.imo : v.mmsi}`],
    ['MarineTraffic', `https://www.marinetraffic.com/en/ais/details/ships/${imoOk ? `imo:${v.imo}` : `mmsi:${v.mmsi}`}`],
    [listings.some((l) => l.source === 'OpenSanctions') ? 'OpenSanctions entry' : 'Search OpenSanctions', sanctions?.opensanctionsUrl || `https://www.opensanctions.org/search/?q=${imoOk ? `IMO${v.imo}` : v.mmsi}`],
    ['EU designated vessels (DMA)', sanctions?.euListUrl || 'https://www.dma.dk/growth-and-framework-conditions/maritime-sanctions/general-information/eu-vessel-designations'],
    [gurEntry ? 'GUR entry' : 'Search GUR War & Sanctions', gurUrl],
    ['Satellite images (Copernicus)', copernicusUrl(v)],
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

      {(sanctioned || shadow || master || spoofing.length > 0 || v.category === 'research' || v.category === 'military') && (
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
          {spoofing.length > 0 && (
            <span className="dossier-badge spoof">
              <SpoofMarker />
              Possible AIS spoofing
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

      {spoofing.length > 0 && (
        <div className="dossier-spoof">
          <ul>
            {spoofing.map((r) => (
              <li key={`${r.kind}-${r.text}`}>
                {r.text}
                <span className="spoof-when">
                  {utc(r.at)} · {ago(r.at)}
                </span>
              </li>
            ))}
          </ul>
          <p>
            A real ship with working AIS and GPS does not report this. Its AIS may be faked, or its GPS
            jammed or spoofed, so the position shown may not be where it is. Compare the track and
            satellite images.
          </p>
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
        <p className="dossier-note">Not on the EU, OpenSanctions, Ukraine GUR or FleetLeaks lists.</p>
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
                {l.kind === 'fleetleaks' && !sanctioned && !mmsiOnlyMismatch(l, v) && (
                  <div className="listing-warn">
                    FleetLeaks lists this ship as sanctioned, but it is not on the lists NorthWatch reads.
                    Check the official list FleetLeaks names before relying on it.
                  </div>
                )}
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
          Download position &amp; track
        </button>
      </div>
    </div>
  );
}
