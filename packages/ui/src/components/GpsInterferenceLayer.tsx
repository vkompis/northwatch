'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useMap } from '../hooks/useMap';
import { mapStyleReady, safeGetLayer, safeGetSource } from '../utils/mapSafe';

const SOURCE = 'gps-interference';
const FILL = `${SOURCE}-fill`;
/** Dash patterns cannot vary by feature, so one outline layer per level */
const LINE_HIGH = `${SOURCE}-line-high`;
const LINE_MEDIUM = `${SOURCE}-line-medium`;
const LAYERS = [FILL, LINE_MEDIUM, LINE_HIGH];

/** The violet of the "Possible AIS spoofing" marker, so jammed areas and spoofed ships read together */
const VIOLET = '#c026d3';
const VIOLET_LINE = '#e879f9';

const SHARE: Record<string, string> = {
  high: 'Over 10 %',
  medium: '2–10 %',
};

/** Under the other overlays, warnings and ships */
function beforeId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle()?.layers || [];
  const above = layers.find(
    (l) =>
      (l.id.startsWith('overlay-') && !l.id.startsWith('overlay-seabed') && !l.id.startsWith('overlay-bathymetry')) ||
      l.id.startsWith('nav-warnings') ||
      l.id.startsWith('vessel') ||
      l.id.startsWith('ships')
  );
  return above?.id ?? layers.find((l) => l.type === 'symbol')?.id;
}

const dayLabel = (date: unknown) => {
  const t = Date.parse(`${String(date)}T00:00:00Z`);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : '';
};

/**
 * GPS interference areas from GPSJam.org for the last full day (scripts-runner/gpsJam.ts),
 * drawn like the warning areas: a faint fill and an outline, stronger where more aircraft
 * had poor GPS. Fetched the first time the layer is switched on.
 */
export default function GpsInterferenceLayer({ visible = false }: { visible?: boolean }) {
  const map = useMap();
  const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL as string) || 'http://localhost:8787';
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const loadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    let popup: maplibregl.Popup | null = null;

    const show = () => {
      for (const id of LAYERS) {
        if (safeGetLayer(map, id)) map.setLayoutProperty(id, 'visibility', visibleRef.current ? 'visible' : 'none');
      }
      if (!visibleRef.current) popup?.remove();
    };

    const enter = (e: any) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      if (!popup) {
        popup = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 8,
          className: 'svalmap-ship-hover-popup',
          maxWidth: 'none',
        });
      }
      popup
        .setLngLat(e.lngLat)
        // Card in the style of the ship hover card (vesselHover.ts)
        .setHTML(
          `<div class="svalmap-ship-hover gps-hover">` +
            `<div class="ssh-head">` +
            `<span class="gps-swatch ${p.level === 'high' ? 'high' : 'medium'}"></span>` +
            `<div class="ssh-title"><div class="ssh-name">GPS interference</div>` +
            `<div class="ssh-meta">${dayLabel(p.date)} · GPSJam.org</div></div>` +
            `</div>` +
            `<div class="gps-body">${SHARE[p.level] || ''} of the aircraft passing here reported poor GPS ` +
            `accuracy, a sign of jamming or spoofing. Ships here may report wrong positions.</div>` +
            `</div>`
        )
        .addTo(map);
    };
    const move = (e: any) => popup?.setLngLat(e.lngLat);
    const leave = () => popup?.remove();

    async function load() {
      if (loaded || cancelled || !visibleRef.current || !mapStyleReady(map)) return;
      loaded = true;
      try {
        const res = await fetch(`${apiBase}/api/gps-interference`);
        const data = await res.json();
        if (cancelled || !mapStyleReady(map) || safeGetSource(map, SOURCE)) return;
        map.addSource(SOURCE, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: Array.isArray(data?.features) ? data.features : [] },
          attribution: 'GPS interference: <a href="https://gpsjam.org/" target="_blank" rel="noopener">GPSJam.org</a>',
        } as any);
        const below = beforeId(map);
        // Like the warning areas: faint fill, solid outline; weaker where fewer aircraft were hit
        map.addLayer(
          {
            id: FILL,
            type: 'fill',
            source: SOURCE,
            paint: {
              'fill-color': VIOLET,
              'fill-opacity': ['match', ['get', 'level'], 'high', 0.16, 0.07],
            },
          },
          below
        );
        map.addLayer(
          {
            id: LINE_MEDIUM,
            type: 'line',
            source: SOURCE,
            filter: ['==', ['get', 'level'], 'medium'],
            paint: { 'line-color': VIOLET_LINE, 'line-width': 1.2, 'line-opacity': 0.55, 'line-dasharray': [3, 2] },
            layout: { 'line-join': 'round' },
          },
          below
        );
        map.addLayer(
          {
            id: LINE_HIGH,
            type: 'line',
            source: SOURCE,
            filter: ['==', ['get', 'level'], 'high'],
            paint: { 'line-color': VIOLET_LINE, 'line-width': 1.8, 'line-opacity': 0.9 },
            layout: { 'line-join': 'round' },
          },
          below
        );
        map.on('mouseenter', FILL, enter);
        map.on('mousemove', FILL, move);
        map.on('mouseleave', FILL, leave);
        show();
      } catch (e) {
        loaded = false;
        console.warn('[GpsInterferenceLayer] load failed', e);
      }
    }
    const start = () => loadRef.current?.();
    loadRef.current = () => {
      show();
      void load();
    };
    loadRef.current();
    // The style may not be ready on the first try
    map.once('idle', start);

    return () => {
      cancelled = true;
      map.off('idle', start);
      loadRef.current = null;
      popup?.remove();
      map.off('mouseenter', FILL, enter);
      map.off('mousemove', FILL, move);
      map.off('mouseleave', FILL, leave);
      if (!mapStyleReady(map)) return;
      try {
        for (const id of [...LAYERS].reverse()) if (safeGetLayer(map, id)) map.removeLayer(id);
        if (safeGetSource(map, SOURCE)) map.removeSource(SOURCE);
      } catch {
        /* ignore */
      }
    };
  }, [map, apiBase]);

  useEffect(() => {
    loadRef.current?.();
  }, [visible]);

  return null;
}
