'use client';

import { RUSSIAN_RESEARCH_VESSELS, formatLatLonDm } from '@svalmap/ui';
import type { VesselFeatureProps } from '@svalmap/ui';

function ago(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'time unknown';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 60) return `${Math.max(1, min)} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * Where each Russian research ship was last heard, anywhere in the world (the server follows
 * them on their own AISStream connection). Most recent first; ships not heard in two weeks last.
 */
export default function ResearchShips({
  vessels,
  onOpen,
}: {
  vessels: VesselFeatureProps[];
  onOpen: (mmsi: string, name: string) => void;
}) {
  const byMmsi = new Map(vessels.map((v) => [v.mmsi, v]));
  const heard = (v: VesselFeatureProps | null) => Date.parse(v?.timestamp || '') || 0;
  const rows = RUSSIAN_RESEARCH_VESSELS.map((r) => ({ r, v: byMmsi.get(r.mmsi) || null })).sort(
    (a, b) => heard(b.v) - heard(a.v)
  );

  return (
    <div className="research-ships">
      <div className="panel-kicker">Russian research ships · anywhere in the world</div>
      <ul className="watchlist-list">
        {rows.map(({ r, v }) => (
          <li key={r.mmsi}>
            <button type="button" className="watchlist-open" onClick={() => onOpen(r.mmsi, r.name)}>
              <span className="vs-name">{r.name}</span>
              <span className="vs-meta">
                {v && v.lat != null && v.lon != null
                  ? `${ago(v.timestamp)} · ${formatLatLonDm(v.lat, v.lon)}`
                  : 'Not heard in the last 2 weeks'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="panel-note">
        AIS is only heard near a receiver on land, and not at all when a ship switches it off.
      </p>
    </div>
  );
}
