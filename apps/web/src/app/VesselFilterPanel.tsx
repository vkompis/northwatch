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

const CATEGORY_LABELS: Record<VesselCategory, string> = {
  norway: 'Norwegian',
  eu: 'EU',
  china: 'Chinese',
  russia: 'Russian',
  rest: 'Rest of world',
  military: 'Military & law enforcement',
  research: 'Research (Russian list)',
};

function FilterRow({
  label,
  checked,
  onChange,
  count,
  swatch,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  count?: number;
  swatch?: string;
}) {
  return (
    <label className="item item-toggle">
      <span className="label">
        {label}
        {count != null && <span className="filter-count">{count.toLocaleString()}</span>}
      </span>
      {swatch ? (
        <span className="filter-swatch" style={{ background: swatch }} aria-hidden />
      ) : (
        <span className="menu-icon-slot" aria-hidden />
      )}
      <span className="item-control">
        {/* Boolean(): state restored from an older prefs shape can lack newer keys */}
        <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} />
      </span>
    </label>
  );
}

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
  const [open, setOpen] = useState(true);
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
      if (watchlistMmsis.has(v.mmsi)) watchlist += 1;
    }
    return { category, shipClass, russian, sanctioned, shadow, watchlist };
  }, [vessels, watchlistMmsis, filters]);

  const set = (key: keyof VesselFilterFlags, on: boolean) => onChange({ ...filters, [key]: on });
  const active = anyFilterActive(filters);
  const hiddenTypes = SHIP_CLASS_KEYS.filter((k) => k !== 'device' && !filters[k]).length;
  const typeSummary =
    (hiddenTypes ? `${hiddenTypes} hidden` : 'all ships') + (filters.device ? ' + buoys' : '');

  return (
    <>
      <button
        type="button"
        className={`disclaimer-toggle ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Ship filters{active ? ' · on' : ''}
      </button>
      {open && (
        <div className="group">
          <div className="filter-presets" role="group" aria-label="Quick filters">
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
            <button
              type="button"
              className="text-btn"
              style={{ margin: '0 0 6px' }}
              onClick={() => onChange({ ...DEFAULT_VESSEL_FILTERS })}
            >
              Reset to all ships
            </button>
          )}

          <div className="item hint filter-group-hint">Category · marker colour</div>
          {CATEGORY_KEYS.map((key) => (
            <FilterRow
              key={key}
              label={CATEGORY_LABELS[key]}
              swatch={HEADER_COLORS[key]}
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
              <div className="item hint filter-group-hint">
                Civilian vessels only — military and research follow their category
              </div>
              {SHIP_CLASS_KEYS.map((key) => (
                <FilterRow
                  key={key}
                  label={SHIP_CLASS_LABELS[key]}
                  count={counts.shipClass[key]}
                  checked={filters[key]}
                  onChange={(on) => set(key, on)}
                />
              ))}
            </>
          )}

          <div className="item hint filter-group-hint">
            Show only · {anyFocusActive(filters) ? 'vessels matching any checked' : 'off'}
          </div>
          <FilterRow
            label="Russian flag"
            count={counts.russian}
            checked={filters.russianFlag}
            onChange={(on) => set('russianFlag', on)}
          />
          <FilterRow
            label="Sanctioned"
            count={counts.sanctioned}
            checked={filters.sanctioned}
            onChange={(on) => set('sanctioned', on)}
          />
          <FilterRow
            label="Shadow fleet"
            count={counts.shadow}
            checked={filters.shadow}
            onChange={(on) => set('shadow', on)}
          />
          <FilterRow
            label="Watchlist"
            count={counts.watchlist}
            checked={filters.watchlistOnly}
            onChange={(on) => set('watchlistOnly', on)}
          />
          <FilterRow
            label="Updated last 6 hours"
            checked={filters.recent6h}
            onChange={(on) => set('recent6h', on)}
          />
        </div>
      )}
    </>
  );
}
