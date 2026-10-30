'use client';

import { useMemo, useState } from 'react';
import type { ShipClass, VesselCategory, VesselFeatureProps, VesselFilterFlags } from '@svalmap/ui';
import {
  CATEGORY_KEYS,
  DEFAULT_VESSEL_FILTERS,
  HEADER_COLORS,
  SHIP_CLASS_KEYS,
  SHIP_CLASS_LABELS,
  VESSEL_FILTER_PRESETS,
  anyFilterActive,
  anyFocusActive,
  mmsiFlagCountry,
  sameFilters,
  vesselCategoryKey,
  vesselShipClass,
} from '@svalmap/ui';
import LayerRow, {
  MasterMarker,
  SANCTION_EDGE,
  SHADOW_EDGE,
  SpoofMarker,
  StarMarker,
  TriangleMarker,
  WarningMarker,
} from './LayerRow';

const CATEGORY_LABELS: Record<VesselCategory, string> = {
  norway: 'Norwegian',
  eu: 'EU',
  china: 'Chinese',
  russia: 'Russian',
  rest: 'Rest of world',
  military: 'Military & law enforcement',
  research: 'Research (Russian list)',
};

export default function VesselFilterPanel({
  filters,
  onChange,
  vessels,
  watchlistMmsis,
}: {
  filters: VesselFilterFlags;
  onChange: (next: VesselFilterFlags) => void;
  vessels: VesselFeatureProps[];
  watchlistMmsis: ReadonlySet<string>;
}) {
  const [typesOpen, setTypesOpen] = useState(false);

  // Counts follow the filter semantics: ship types only count civilian categories,
  // and category counts leave out civilian vessels whose type is currently hidden
  const counts = useMemo(() => {
    const category = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0])) as Record<
      VesselCategory,
      number
    >;
    const shipClass = Object.fromEntries(SHIP_CLASS_KEYS.map((k) => [k, 0])) as Record<
      ShipClass,
      number
    >;
    let russian = 0;
    let sanctioned = 0;
    let shadow = 0;
    let master = 0;
    let spoofing = 0;
    let watchlist = 0;
    for (const v of vessels) {
      const cat = vesselCategoryKey(v);
      const civilian = cat !== 'military' && cat !== 'research';
      const sc = civilian ? vesselShipClass(v) : null;
      if (sc) shipClass[sc] += 1;
      if (!sc || filters[sc]) category[cat] += 1;
      if ((v.flagCountry || mmsiFlagCountry(v.mmsi)) === 'russia') russian += 1;
      if (v.sanctioned) sanctioned += 1;
      if (v.shadowfleet) shadow += 1;
      if (v.sanctionedMaster) master += 1;
      if (v.spoofing) spoofing += 1;
      if (watchlistMmsis.has(v.mmsi)) watchlist += 1;
    }
    return { category, shipClass, russian, sanctioned, shadow, master, spoofing, watchlist };
  }, [vessels, watchlistMmsis, filters]);

  const set = (key: keyof VesselFilterFlags, on: boolean) => onChange({ ...filters, [key]: on });
  const active = anyFilterActive(filters);
  const hiddenTypes = SHIP_CLASS_KEYS.filter((k) => k !== 'device' && !filters[k]).length;
  const typeSummary =
    (hiddenTypes ? `${hiddenTypes} hidden` : 'all ships') + (filters.device ? ' + buoys' : '');

  return (
    <>
      <div className="filter-presets" role="group" aria-label="Quick views">
        {VESSEL_FILTER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`filter-preset ${sameFilters(filters, p.filters) ? 'on' : ''}`}
            aria-pressed={sameFilters(filters, p.filters)}
            onClick={() => onChange({ ...p.filters })}
          >
            {p.label}
          </button>
        ))}
      </div>
      {active && !VESSEL_FILTER_PRESETS.some((p) => sameFilters(filters, p.filters)) && (
        <button type="button" className="panel-link" onClick={() => onChange({ ...DEFAULT_VESSEL_FILTERS })}>
          Reset to all ships
        </button>
      )}

      <div className="panel-kicker">
        Show only · {anyFocusActive(filters) ? 'any of the checked' : 'off'}
      </div>
      <LayerRow
        label="Russian flag"
        marker={<TriangleMarker color={HEADER_COLORS.russia} />}
        count={counts.russian}
        checked={filters.russianFlag}
        onChange={(on) => set('russianFlag', on)}
      />
      <LayerRow
        label="Sanctioned"
        marker={<WarningMarker edge={SANCTION_EDGE} />}
        count={counts.sanctioned}
        checked={filters.sanctioned}
        onChange={(on) => set('sanctioned', on)}
      />
      <LayerRow
        label="Shadow fleet"
        marker={<WarningMarker edge={SHADOW_EDGE} />}
        count={counts.shadow}
        checked={filters.shadow}
        onChange={(on) => set('shadow', on)}
      />
      <LayerRow
        label="Sanctioned master"
        sub="Captain on Ukraine GUR's list"
        marker={<MasterMarker />}
        count={counts.master}
        checked={filters.sanctionedMaster}
        onChange={(on) => set('sanctionedMaster', on)}
      />
      <LayerRow
        label="Possible AIS spoofing"
        sub="Impossible values or position jumps"
        marker={<SpoofMarker />}
        count={counts.spoofing}
        checked={filters.spoofing}
        onChange={(on) => set('spoofing', on)}
      />
      <LayerRow
        label="Watchlist"
        marker={<StarMarker />}
        count={counts.watchlist}
        checked={filters.watchlistOnly}
        onChange={(on) => set('watchlistOnly', on)}
      />
      <LayerRow
        label="Updated last 6 hours"
        checked={filters.recent6h}
        onChange={(on) => set('recent6h', on)}
      />
      <div className="panel-kicker">Category · marker colour</div>
      {CATEGORY_KEYS.map((key) => (
        <LayerRow
          key={key}
          label={CATEGORY_LABELS[key]}
          marker={<TriangleMarker color={HEADER_COLORS[key]} />}
          count={counts.category[key]}
          checked={filters[key]}
          onChange={(on) => set(key, on)}
        />
      ))}

      <button
        type="button"
        className={`disclaimer-toggle filter-subtoggle ${typesOpen ? 'open' : ''}`}
        onClick={() => setTypesOpen((v) => !v)}
        aria-expanded={typesOpen}
      >
        Ship type · {typeSummary}
      </button>
      {typesOpen && (
        <>
          <p className="panel-note">Civilian vessels only — military and research follow their category.</p>
          {SHIP_CLASS_KEYS.map((key) => (
            <LayerRow
              key={key}
              label={SHIP_CLASS_LABELS[key]}
              count={counts.shipClass[key]}
              checked={filters[key]}
              onChange={(on) => set(key, on)}
            />
          ))}
        </>
      )}

    </>
  );
}
