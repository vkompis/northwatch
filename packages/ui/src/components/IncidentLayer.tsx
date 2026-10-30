'use client';

import React, { useEffect, useRef } from 'react';
import { useMap } from '../hooks/useMap';
import axios from 'axios';
import { mapStyleReady, safeGetLayer, safeGetSource } from '../utils/mapSafe';
import { MAP_FONT_REGULAR } from '../utils/mapFonts';

export type NavWarningProps = {
  kind: 'navarea' | 'coastal' | string;
  eventid: string | number | null;
  status: string;
  warningnumber: string | null;
  title: string;
  message: string | null;
  location: string | null;
  issued: string | null;
  updated_at: string | null;
  recent?: boolean;
  /** Coastal warnings: original Norwegian text */
  messageNo?: string | null;
  /** Norwegian chart number (coastal) */
  chart?: string | null;
  /** In force but not drawn: Kystverket's whole-NAVAREA "general position" */
  areaWide?: boolean;
  /** False for warnings listed beside the map (area-wide or no position) */
  onMap?: boolean;
  /** What the drawn part is: area, circle, route or points */
  shape?: string | null;
  /** 'text' when the shape was read from the message, 'kystverket' when taken as given */
  shapeFrom?: string | null;
};

type Props = {
  /** Show all currently in-force warnings */
  showActive?: boolean;
  /** Show warnings issued within the last 30 days (subset of active from public API) */
  showRecent30d?: boolean;
  interactive?: boolean;
  onWarningSelect?: (warning: NavWarningProps) => void;
  /** After each load: how many are drawn, and the in-force ones with no map position. */
  onData?: (data: { onMap: number; notices: NavWarningProps[] }) => void;
  /** Screen space covered by panels, kept clear when the map fits to a clicked warning. */
  fitPadding?: { top: number; right: number; bottom: number; left: number };
  /** Basemap theme: warning labels in light red on the dark map, dark red on the light one */
  theme?: 'dark' | 'light';
};

const LABEL_COLOURS = {
  dark: { text: '#fecaca', halo: 'rgba(0,0,0,0.75)' },
  light: { text: '#991b1b', halo: 'rgba(255,255,255,0.9)' },
};

const LAYER_IDS = [
  'nav-warnings-fill',
  'nav-warnings-line',
  'nav-warnings-route',
  'nav-warnings-point',
  'nav-warnings-area-marker',
  'nav-warnings-label',
] as const;

type Extent = [number, number, number, number];

const warningKey = (p: any) => `${p?.kind}:${p?.eventid ?? p?.warningnumber ?? p?.title}`;

function extendExtent(e: Extent | undefined, coords: any): Extent | undefined {
  if (typeof coords?.[0] === 'number') {
    const [x, y] = coords;
    return e ? [Math.min(e[0], x), Math.min(e[1], y), Math.max(e[2], x), Math.max(e[3], y)] : [x, y, x, y];
  }
  let out = e;
  for (const c of coords || []) out = extendExtent(out, c);
  return out;
}

/** Largest side of an extent in km (rough, enough to tell a 3 km range from a 300 km one). */
function extentKm([w, s, e, n]: Extent): number {
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  return Math.max((e - w) * 111.32 * Math.cos(midLat), (n - s) * 110.57);
}

function propsFromFeature(f: any): NavWarningProps | null {
  const w = warningFromProps(f?.properties || {});
  return w && { ...w, onMap: true };
}

function warningFromProps(p: any): NavWarningProps | null {
  const title = String(p.title || '').trim();
  if (!title && p.eventid == null) return null;
  return {
    kind: String(p.kind || 'navarea'),
    eventid: p.eventid != null && String(p.eventid) !== '' ? p.eventid : null,
    status: String(p.status || 'active'),
    warningnumber: p.warningnumber != null ? String(p.warningnumber) : null,
    title: title || `Warning ${p.eventid || ''}`.trim(),
    message: p.message != null && String(p.message) !== '' ? String(p.message) : null,
    location: p.location != null && String(p.location) !== '' ? String(p.location) : null,
    issued: p.issued != null ? String(p.issued) : null,
    updated_at: p.updated_at != null ? String(p.updated_at) : null,
    recent: Number(p.recent) === 1 || p.recent === true,
    messageNo: p.messageNo != null && String(p.messageNo) !== '' ? String(p.messageNo) : null,
    chart: p.chart != null && String(p.chart) !== '' ? String(p.chart) : null,
    areaWide: p.areaWide === true || p.areaWide === 'true',
    shape: p.shape != null && String(p.shape) !== '' ? String(p.shape) : null,
    shapeFrom: p.shapeFrom != null && String(p.shapeFrom) !== '' ? String(p.shapeFrom) : null,
  };
}

/**
 * Kystverket NAVAREA XIX + coastal warnings.
 * Public API only returns in-force warnings; "30 days" filters by issue date.
 */
export default function IncidentLayer({
  showActive = false,
  showRecent30d = false,
  interactive = true,
  onWarningSelect,
  onData,
  fitPadding,
  theme = 'dark',
}: Props) {
  const map = useMap();
  const apiBase =
    (process.env.NEXT_PUBLIC_API_BASE_URL as string) || 'http://localhost:8787';
  const showActiveRef = useRef(showActive);
  showActiveRef.current = showActive;
  const showRecentRef = useRef(showRecent30d);
  showRecentRef.current = showRecent30d;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const onSelectRef = useRef(onWarningSelect);
  onSelectRef.current = onWarningSelect;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const fitPaddingRef = useRef(fitPadding);
  fitPaddingRef.current = fitPadding;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const applyVisibilityAndFilter = () => {
    if (!mapStyleReady(map)) return;
    const active = showActiveRef.current;
    const recent = showRecentRef.current;
    const any = active || recent;
    const v = any ? 'visible' : 'none';

    // Active = all in-force; 30d = recent only; both = all (union).
    const dateFilter =
      recent && !active ? (['==', ['get', 'recent'], 1] as any) : null;

    for (const lid of LAYER_IDS) {
      if (!safeGetLayer(map, lid)) continue;
      map.setLayoutProperty(lid, 'visibility', v);
      try {
        if (dateFilter) {
          // Keep geometry filter from layer def by combining — setFilter replaces entirely,
          // so rebuild per layer type below via paint-only visibility when possible.
          map.setFilter(lid, buildLayerFilter(lid, dateFilter));
        } else {
          map.setFilter(lid, buildLayerFilter(lid, null));
        }
      } catch {
        /* ignore */
      }
    }
  };

  useEffect(() => {
    const id = 'nav-warnings';
    let cancelled = false;
    let clickHandler: ((e: any) => void) | undefined;
    let enterHandler: (() => void) | undefined;
    let leaveHandler: (() => void) | undefined;
    /** Extent of every part of each warning (an area plus its loose points, say). */
    const extents = new Map<string, Extent>();

    /** A warning that is only a few pixels across gets the map fitted to it on click. */
    function zoomToWarning(props: any) {
      const e = extents.get(warningKey(props));
      if (!e || (e[0] === e[2] && e[1] === e[3])) return;
      const a = map.project([e[0], e[3]]);
      const b = map.project([e[2], e[1]]);
      if (Math.abs(b.x - a.x) > 80 || Math.abs(b.y - a.y) > 80) return;
      const { width } = map.getCanvas().getBoundingClientRect();
      const pad = fitPaddingRef.current ?? { top: 0, right: 0, bottom: 0, left: 0 };
      // On a narrow screen the panels cover the map; then just fit to the whole canvas
      const clear = width - pad.left - pad.right - 48 >= 160;
      map.fitBounds(
        [
          [e[0], e[1]],
          [e[2], e[3]],
        ],
        {
          padding: clear
            ? { top: pad.top + 24, right: pad.right + 24, bottom: pad.bottom + 24, left: pad.left + 24 }
            : 40,
          maxZoom: 12,
          duration: 700,
        }
      );
    }

    function bindClicks() {
      if (!mapStyleReady(map) || clickHandler) return;
      clickHandler = (e: any) => {
        if (!interactiveRef.current || !onSelectRef.current) return;
        const f = e?.features?.[0];
        if (!f) return;
        e.originalEvent?.stopPropagation?.();
        const warning = propsFromFeature(f);
        if (warning) onSelectRef.current(warning);
        zoomToWarning(f.properties);
      };
      enterHandler = () => {
        if (!interactiveRef.current) return;
        map.getCanvas().style.cursor = 'pointer';
      };
      leaveHandler = () => {
        map.getCanvas().style.cursor = '';
      };
      for (const lid of LAYER_IDS) {
        if (!safeGetLayer(map, lid)) continue;
        map.on('click', lid, clickHandler);
        map.on('mouseenter', lid, enterHandler);
        map.on('mouseleave', lid, leaveHandler);
      }
    }

    async function load() {
      if (!mapStyleReady(map) || cancelled) return;
      try {
        const { data } = await axios.get(`${apiBase}/api/navwarnings?scope=all`, {
          timeout: 25000,
        });
        if (cancelled) return;
        const payload = data?.data ?? data ?? {};
        const features = Array.isArray(payload?.features)
          ? payload.features
          : Array.isArray(payload)
            ? payload
            : [];
        const drawn = features.filter((f: any) => f?.geometry);
        extents.clear();
        for (const f of drawn) {
          const key = warningKey(f.properties);
          const e = extendExtent(extents.get(key), f.geometry.coordinates);
          if (e) extents.set(key, e);
        }
        // Small areas are a few pixels at country zoom: mark them with a ring until they show
        const areaMarkers = drawn
          .filter((f: any) => f.geometry.type === 'Polygon')
          .map((f: any) => {
            const [w, s, e, n] = extendExtent(undefined, f.geometry.coordinates) as Extent;
            return {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [(w + e) / 2, (s + n) / 2] },
              properties: { ...f.properties, areaMarker: 1, primary: 0, sizeKm: extentKm([w, s, e, n]) },
            };
          })
          .filter((f: any) => f.properties.sizeKm < 40);
        const gj = { type: 'FeatureCollection', features: [...drawn, ...areaMarkers] } as any;

        if (!safeGetSource(map, id)) {
          map.addSource(id, { type: 'geojson', data: gj });
          // Areas styled like the EEZ / FPZ overlays: faint fill, solid outline
          map.addLayer({
            id: `${id}-fill`,
            type: 'fill',
            source: id,
            filter: buildLayerFilter(`${id}-fill`, null),
            paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.08 },
            layout: { visibility: 'none' },
          });
          map.addLayer({
            id: `${id}-line`,
            type: 'line',
            source: id,
            filter: buildLayerFilter(`${id}-line`, null),
            paint: { 'line-color': '#f87171', 'line-width': 2, 'line-opacity': 0.9 },
            layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
          });
          map.addLayer({
            id: `${id}-route`,
            type: 'line',
            source: id,
            filter: buildLayerFilter(`${id}-route`, null),
            paint: {
              'line-color': '#f87171',
              'line-width': 2.5,
              'line-opacity': 0.9,
              'line-dasharray': [2, 1.5],
            },
            layout: { visibility: 'none', 'line-join': 'round' },
          });
          map.addLayer({
            id: `${id}-point`,
            type: 'circle',
            source: id,
            filter: buildLayerFilter(`${id}-point`, null),
            paint: {
              'circle-radius': 7,
              'circle-color': '#ef4444',
              'circle-stroke-width': 1.5,
              'circle-stroke-color': '#fff',
              'circle-opacity': 0.5,
              'circle-stroke-opacity': 0.5,
            },
            layout: { visibility: 'none' },
          });
          map.addLayer({
            id: `${id}-area-marker`,
            type: 'circle',
            source: id,
            maxzoom: 9.5,
            filter: buildLayerFilter(`${id}-area-marker`, null),
            paint: {
              'circle-radius': 10,
              'circle-color': 'rgba(239, 68, 68, 0.08)',
              'circle-stroke-color': '#f87171',
              'circle-stroke-width': 2,
              'circle-opacity': ['interpolate', ['linear'], ['zoom'], 8, 1, 9.5, 0],
              'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.9, 9.5, 0],
            },
            layout: { visibility: 'none' },
          });
          map.addLayer({
            id: `${id}-label`,
            type: 'symbol',
            source: id,
            filter: buildLayerFilter(`${id}-label`, null),
            layout: {
              visibility: 'none',
              'text-field': ['get', 'title'],
              'text-font': MAP_FONT_REGULAR,
              'text-size': 11,
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
              'text-optional': true,
            },
            paint: {
              'text-color': LABEL_COLOURS[themeRef.current].text,
              'text-halo-color': LABEL_COLOURS[themeRef.current].halo,
              'text-halo-width': 1.2,
              'text-opacity': 0.5,
            },
          });
          bindClicks();
        } else {
          const src: any = safeGetSource(map, id);
          src?.setData?.(gj);
          bindClicks();
        }
        applyVisibilityAndFilter();
        onDataRef.current?.({
          // A warning drawn as an area plus loose points is several features; count it once
          onMap: gj.features.filter((f: any) => f.properties?.primary !== 0).length,
          notices: (Array.isArray(payload?.notices) ? payload.notices : [])
            .map(warningFromProps)
            .filter((w: NavWarningProps | null): w is NavWarningProps => !!w)
            .map((w: NavWarningProps) => ({ ...w, onMap: false })),
        });
      } catch (e) {
        console.warn('[IncidentLayer] nav warnings failed', e);
      }
    }

    load();
    map.once('idle', load);
    const interval = setInterval(load, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      map.off('idle', load);
      if (clickHandler) {
        for (const lid of LAYER_IDS) {
          map.off('click', lid, clickHandler);
          if (enterHandler) map.off('mouseenter', lid, enterHandler);
          if (leaveHandler) map.off('mouseleave', lid, leaveHandler);
        }
      }
      if (!mapStyleReady(map)) return;
      try {
        for (const lid of [...LAYER_IDS].reverse()) {
          if (safeGetLayer(map, lid)) map.removeLayer(lid);
        }
        if (safeGetSource(map, id)) map.removeSource(id);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, apiBase]);

  useEffect(() => {
    applyVisibilityAndFilter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, showActive, showRecent30d]);

  useEffect(() => {
    if (!mapStyleReady(map) || !safeGetLayer(map, 'nav-warnings-label')) return;
    map.setPaintProperty('nav-warnings-label', 'text-color', LABEL_COLOURS[theme].text);
    map.setPaintProperty('nav-warnings-label', 'text-halo-color', LABEL_COLOURS[theme].halo);
  }, [map, theme]);

  return null;
}

function buildLayerFilter(layerId: string, recentFilter: any | null): any {
  let geom: any = null;
  if (layerId.endsWith('-fill')) {
    geom = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
  } else if (layerId.endsWith('-line')) {
    geom = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
  } else if (layerId.endsWith('-route')) {
    geom = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];
  } else if (layerId.endsWith('-point')) {
    geom = [
      'all',
      ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]],
      ['!=', ['get', 'areaMarker'], 1],
    ];
  } else if (layerId.endsWith('-area-marker')) {
    geom = ['==', ['get', 'areaMarker'], 1];
  } else if (layerId.endsWith('-label')) {
    // One label per warning, on its main part
    geom = ['!=', ['get', 'primary'], 0];
  }
  if (!geom && !recentFilter) return null;
  if (!geom) return recentFilter;
  if (!recentFilter) return geom;
  return ['all', geom, recentFilter];
}
