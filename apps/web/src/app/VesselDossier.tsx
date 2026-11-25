'use client';

import { useState } from 'react';
import type { SpoofReason, VesselFeatureProps } from '@svalmap/ui';
import {
  BASE_PATH,
  HEADER_COLORS,
  SNAPSHOT_MODE,
  formatLatLonDm,
  isRussianResearchVessel,
  navStatusLabel,
} from '@svalmap/ui';
import { MasterMarker, SANCTION_EDGE, SHADOW_EDGE, SpoofMarker, TriangleMarker, WarningMarker } from './LayerRow';

const FEED_NAMES: Record<string, string> = {
  aisstream: 'AISStream',
  barentswatch: 'BarentsWatch',
  bw: 'BarentsWatch',
  digitraffic: 'Digitraffic (Finnish coastal stations)',
};

/** "aisstream+digitraffic" → "AISStream + Digitraffic (…)" */
function sourceLabel(source: string | null | undefined): string {
  if (!source) return 'search (not in the live feed)';
  if (source === 'gfw') return 'Global Fishing Watch (last known position, not live)';
  return source
    .split('+')
    .map((p) => FEED_NAMES[p] || p)
    .join(' + ');
}

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

/** /api/gfw/vessel-last-seen */
type GfwLastSeen = {
  lastSeen?: { label: string; time: string; lon: number; lat: number; sentinel1Url: string } | null;
  lastTransmission?: string | null;
  error?: string;
};

function span(ms: number): string {
  const h = Math.round(ms / 3600e3);
  if (h < 48) return `${Math.max(h, 1)} h`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} days` : `${Math.round(d / 30.44)} months`;
}

/** How GFW's dated position stands against the ship's latest AIS fix. */
function againstAis(gfwTime: string, aisTime: string | null): { older: boolean; text: string } {
  const gfw = Date.parse(gfwTime);
  const ais = aisTime ? Date.parse(aisTime) : NaN;
  if (!Number.isFinite(ais)) {
    return { older: false, text: 'No AIS position here, so this is the newest position NorthWatch has for this ship.' };
  }
  return gfw < ais
    ? { older: true, text: `Older than the AIS position above by ${span(ais - gfw)}. Go by the AIS position.` }
    : { older: false, text: `Newer than the AIS position above by ${span(gfw - ais)}.` };
}

/*
 * List entries, one block per kind of list. A sanctioned ship can have a dozen entries
 * (OpenSanctions has one per programme), so each block shows a line per programme or list,
 * merges repeats, and gives the shared "listed as / matched on" line once.
 */
type ListGroupId = 'sanction' | 'gur' | 'master' | 'fleetleaks';
const LIST_GROUP: Record<Listing['kind'], ListGroupId> = {
  sanction: 'sanction',
  shadow: 'gur',
  gur: 'gur',
  master: 'master',
  fleetleaks: 'fleetleaks',
};
const LIST_GROUP_LABEL: Record<ListGroupId, string> = {
  sanction: 'Sanctions',
  gur: 'Ukraine GUR',
  master: 'Sanctioned master',
  fleetleaks: 'FleetLeaks',
};
const LIST_GROUP_ORDER: ListGroupId[] = ['sanction', 'gur', 'master', 'fleetleaks'];

/** Who imposed a sanction, from the programme name: "UK FCDO" → "UK", "EU Sanctions Map" → "EU" */
function authorityOf(label: string): string {
  const m = label.match(/^(EU|UK|US|UN|Canada|Australia|New Zealand|Switzerland|Japan|Norway|Ukraine)\b/i);
  if (m) return m[1].length <= 2 ? m[1].toUpperCase() : m[1];
  return /^Older local/i.test(label) ? 'local list' : label.split(' ')[0];
}

/** One line in a block: what the list calls it, minus what the block heading already says */
function rowLabel(l: Listing): string {
  if (l.kind === 'sanction' && l.source === 'OpenSanctions' && l.programmes.length) return l.programmes.join(' · ');
  if (l.kind === 'master') return 'Ukraine GUR captain list';
  const title = l.source === 'GUR' ? l.title.replace(/^Ukraine GUR · | · Ukraine GUR$/g, '') : l.title;
  return [title, ...l.programmes].join(' · ');
}

const normName = (s: string | null) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function ListingGroups({
  listings,
  vessel,
  sanctioned,
}: {
  listings: Listing[];
  vessel: VesselFeatureProps;
  sanctioned: boolean;
}) {
  const groups = LIST_GROUP_ORDER.map((id) => ({ id, entries: listings.filter((l) => LIST_GROUP[l.kind] === id) })).filter(
    (g) => g.entries.length > 0
  );
  const [shown, setShown] = useState<ListGroupId | 'all'>('all');
  const visible = groups.filter((g) => shown === 'all' || g.id === shown);

  // "Listed as … · IMO … · matched on …" for one block: the name most entries give
  const metaOf = (entries: Listing[]) => {
    const counts = new Map<string, number>();
    for (const l of entries) if (l.listedName) counts.set(normName(l.listedName), (counts.get(normName(l.listedName)) || 0) + 1);
    const key = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const name = entries.find((l) => normName(l.listedName) === key)?.listedName || null;
    const imo = entries.find((l) => l.listedImo)?.listedImo || null;
    const matchedBy = [...new Set(entries.flatMap((l) => l.matchedBy))].sort();
    const text = [name && `Listed as ${name}`, imo && `IMO ${imo}`, `matched on ${matchedBy.map((m) => m.toUpperCase()).join(' + ')}`]
      .filter(Boolean)
      .join(' · ');
    return { key, text, same: `${key}|${imo}|${matchedBy.join('+')}` };
  };
  // Said once for the whole list when every block would say the same
  const sharedMeta = new Set(groups.map((g) => metaOf(g.entries).same)).size === 1 ? metaOf(groups[0].entries).text : null;

  return (
    <>
      {groups.length > 1 && (
        <div className="listing-filter" role="group" aria-label="Show lists">
          {(['all', ...groups.map((g) => g.id)] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={shown === id ? 'on' : ''}
              aria-pressed={shown === id}
              onClick={() => setShown(id)}
            >
              {id === 'all' ? 'All' : LIST_GROUP_LABEL[id]}
            </button>
          ))}
        </div>
      )}
      {sharedMeta && <div className="listing-meta listing-shared">{sharedMeta}</div>}
      <ul className="dossier-listings">
        {visible.map(({ id, entries }) => {
          // Entries listed under another name than most say so on their own line
          const meta = metaOf(entries);
          const commonKey = meta.key;

          const rows: { label: string; since: string | null; aside: string | null; url: string | null; urlLabel: string | null; n: number }[] = [];
          for (const l of entries) {
            const label = rowLabel(l);
            const aside =
              [
                l.listedName && normName(l.listedName) !== commonKey && `listed as ${l.listedName}`,
                l.listedMmsi && `MMSI ${l.listedMmsi}`,
              ]
                .filter(Boolean)
                .join(', ') || null;
            const same = rows.find((r) => r.label === label && r.aside === aside);
            if (same) same.n += 1;
            else rows.push({ label, since: l.since, aside, url: l.url, urlLabel: l.urlLabel, n: 1 });
          }
          const details = [...new Set(entries.map((l) => l.detail).filter((d): d is string => !!d))];
          const authorities =
            id === 'sanction' ? [...new Set(entries.map((l) => authorityOf(rowLabel(l))))].join(', ') : null;
          const marker = entries.some((l) => l.kind === 'shadow') ? 'shadow' : entries[0].kind;

          return (
            <li key={id} className={`dossier-listing ${id}`}>
              <span className="listing-marker">
                <ListingMarker kind={marker} />
              </span>
              <div>
                <div className="listing-title">
                  {LIST_GROUP_LABEL[id]}
                  {authorities && <span className="listing-sub"> · {authorities}</span>}
                </div>
                <ul className="listing-rows">
                  {rows.map((r, i) => (
                    <li key={i}>
                      <span>
                        {r.label}
                        {r.n > 1 && (id === 'master' ? ` · ${r.n} captains` : ` (${r.n} entries)`)}
                        {r.since && <span className="listing-aside"> · since {r.since}</span>}
                        {r.aside && <span className="listing-aside"> · {r.aside}</span>}
                      </span>
                      {r.url && (
                        <a className="listing-link" href={r.url} {...externalLink}>
                          {r.urlLabel || 'Open entry'} ↗
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
                {details.map((d) => (
                  <div key={d} className="listing-detail">
                    {id === 'master' ? `Master: ${d}` : d}
                  </div>
                ))}
                {!sharedMeta && <div className="listing-meta">{meta.text}</div>}
                {id === 'fleetleaks' && !sanctioned && entries.some((l) => !mmsiOnlyMismatch(l, vessel)) && (
                  <div className="listing-warn">
                    FleetLeaks lists this ship as sanctioned, but it is not on the lists NorthWatch reads.
                    Check the official list FleetLeaks names before relying on it.
                  </div>
                )}
                {entries.some((l) => mmsiOnlyMismatch(l, vessel)) && (
                  <div className="listing-warn">
                    Listed under another name or IMO — this MMSI may have been reused. Check the entry before relying on it.
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function GfwLastSeenSection({ data, aisTime }: { data: GfwLastSeen | null; aisTime: string | null }) {
  const seen = data?.lastSeen;
  const compared = seen ? againstAis(seen.time, aisTime) : null;
  const heardLater =
    seen && data?.lastTransmission && Date.parse(data.lastTransmission) - Date.parse(seen.time) > 24 * 3600e3
      ? utc(data.lastTransmission)
      : null;
  return (
    <>
      <h3 className="dossier-h">Last seen by Global Fishing Watch</h3>
      {!data ? (
        <p className="dossier-note">Checking Global Fishing Watch…</p>
      ) : data.error ? (
        <p className="dossier-note">Global Fishing Watch could not be reached.</p>
      ) : !seen ? (
        <p className="dossier-note">
          Global Fishing Watch has no dated position for this ship.
          {data.lastTransmission && ` It last received AIS from it on ${utc(data.lastTransmission)}.`}
        </p>
      ) : (
        <div className="dossier-lastseen">
          <div className="lastseen-where">
            {utc(seen.time)} · {formatLatLonDm(seen.lat, seen.lon)}
          </div>
          <div className="lastseen-kind">
            {seen.label} · {ago(seen.time)}
          </div>
          {compared && <div className={compared.older ? 'listing-warn' : 'lastseen-compare'}>{compared.text}</div>}
          {heardLater && (
            <div className="listing-warn">
              Global Fishing Watch last received AIS from this ship on {heardLater}, with no position, so the
              ship may have moved since the position above.
            </div>
          )}
          <a className="dossier-link" href={seen.sentinel1Url} {...externalLink}>
            Sentinel-1 radar for that place and day ↗
          </a>
        </div>
      )}
      {data && !data.error && (
        <p className="dossier-note">
          Only gives positions at port visits, loitering, encounters and AIS gaps, and runs a few days behind.{' '}
          <a href="https://globalfishingwatch.org" {...externalLink}>
            Powered by Global Fishing Watch
          </a>
          .
        </p>
      )}
    </>
  );
}

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
  gfwLastSeen,
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
  gfwLastSeen: GfwLastSeen | null;
  note: string;
  onNoteChange: (text: string) => void;
  watched: boolean;
  onWatch: () => void;
  /** Left out where area alerts are unavailable (the static snapshot) */
  onAreaAlert?: () => void;
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
  const latestSignal = utc(v.timestamp);

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
    ['Latest signal', v.lastSeenOnly ? 'Not heard on live AIS' : latestSignal ? `${ago(v.timestamp)} · ${latestSignal}` : null],
  ];

  return (
    <div className="dossier">
      <div className="dossier-kicker">Vessel dossier</div>
      <h2 className="dossier-name">{v.name || `MMSI ${v.mmsi}`}</h2>
      <div className="dossier-sub">
        <TriangleMarker color={HEADER_COLORS[v.category] || HEADER_COLORS.rest} />
        <img
          src={`${BASE_PATH}/flag-icons/${v.flag || 'xx'}.svg`}
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
          <div key={k} className={k === 'Position' || k === 'Latest signal' ? 'wide' : undefined}>
            <dt>{k}</dt>
            <dd className={val ? undefined : 'missing'}>{val || 'Not reported'}</dd>
          </div>
        ))}
      </dl>

      {isRussianResearchVessel(v.mmsi) && !SNAPSHOT_MODE && (
        <GfwLastSeenSection data={gfwLastSeen} aisTime={v.lastSeenOnly ? null : v.timestamp} />
      )}

      <h3 className="dossier-h">Lists</h3>
      {SNAPSHOT_MODE && !sanctions ? (
        <p className="dossier-note">List entries are not in this snapshot. The badges above show which lists the ship is on.</p>
      ) : !sanctions ? (
        <p className="dossier-note">Checking the lists…</p>
      ) : listings.length === 0 ? (
        <p className="dossier-note">Not on the EU, OpenSanctions, Ukraine GUR or FleetLeaks lists.</p>
      ) : (
        <ListingGroups key={v.mmsi} listings={listings} vessel={v} sanctioned={sanctioned} />
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
        Position via {sourceLabel(v.source)}
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
        {onAreaAlert && (
          <button type="button" onClick={onAreaAlert}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 7l9-3 6 8-5 8-10-3z" />
            </svg>
            Area alert
          </button>
        )}
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
