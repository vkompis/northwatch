'use client';

import { useEffect, useRef, useState } from 'react';
import { useMap } from '../hooks/useMap';
import type { AlertPolygon } from '../utils/areaAlerts';
import { mapStyleReady, safeGetLayer, safeGetSource } from '../utils/mapSafe';

type Props = {
  active: boolean;
  draftRing: number[][];
  polygons: { id: string; polygon: AlertPolygon; label?: string }[];
  /** New ring after a corner is added or removed. */
  onDraftChange?: (ring: number[][]) => void;
  /** Shape closed (first point clicked, double-click or Enter) with ≥3 corners. */
  onFinish?: () => void;
  /** Esc — leave drawing mode and discard the draft. */
  onCancel?: () => void;
};

const DRAFT_POINTS = 'aoi-draft-points';
const DRAFT_LINE = 'aoi-draft-line';
const DRAFT_FILL = 'aoi-draft-fill';
const DRAFT_GUIDE = 'aoi-draft-guide';
const SAVED = 'aoi-saved';
/** Pixel radius around the first corner that closes the shape. */
const CLOSE_RADIUS_PX = 14;

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] as any[] };

/** Dashed preview from the last corner to the cursor, and back to the first corner. */
function buildGuide(ring: number[][], cursor: number[] | null) {
  if (!cursor || ring.length === 0) return EMPTY_FC;
  const coordinates = ring.length >= 2 ? [ring[ring.length - 1], cursor, ring[0]] : [ring[0], cursor];
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates },
        properties: {},
      },
    ],
  };
}

function drawHint(points: number): string {
  if (points === 0) return 'Click the map to place the first corner';
  if (points < 3) return `${points} corner${points === 1 ? '' : 's'} placed — keep clicking to add corners`;
  return 'Click the green first corner, double-click or press Enter to finish the area';
}

function buildDraftCollections(ring: number[][], closed: boolean) {
  const points = {
    type: 'FeatureCollection' as const,
    features: ring.map((coordinates, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates },
      properties: { i },
    })),
  };

  // Open path while drawing (the dashed guide shows the closing edge); closed once finished
  const lineCoords = ring.length >= 2 ? [...ring] : [];
  if (closed && ring.length >= 3) lineCoords.push(ring[0]);

  const line = {
    type: 'FeatureCollection' as const,
    features:
      lineCoords.length >= 2
        ? [
            {
              type: 'Feature' as const,
              geometry: { type: 'LineString' as const, coordinates: lineCoords },
              properties: {},
            },
          ]
        : [],
  };

  const fill = {
    type: 'FeatureCollection' as const,
    features:
      ring.length >= 3
        ? [
            {
              type: 'Feature' as const,
              geometry: {
                type: 'Polygon' as const,
                coordinates: [[...ring, ring[0]]],
              },
              properties: {},
            },
          ]
        : [],
  };

  return { points, line, fill };
}

/**
 * Shows draft AOI vertices/line while drawing, plus saved custom alert polygons.
 * Paints immediately on click (does not wait for React) so the preview feels instant.
 */
export default function AoiDrawLayer({
  active,
  draftRing,
  polygons,
  onDraftChange,
  onFinish,
  onCancel,
}: Props) {
  const map = useMap();
  const onChangeRef = useRef(onDraftChange);
  onChangeRef.current = onDraftChange;
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const draftRef = useRef(draftRing);
  draftRef.current = draftRing;
  const polygonsRef = useRef(polygons);
  polygonsRef.current = polygons;
  const activeRef = useRef(active);
  activeRef.current = active;
  const [points, setPoints] = useState(draftRing.length);

  const bringDraftToFront = () => {
    for (const id of [
      `${DRAFT_FILL}-fill`,
      `${DRAFT_LINE}-line`,
      `${DRAFT_GUIDE}-line`,
      `${DRAFT_POINTS}-circle`,
      `${SAVED}-fill`,
      `${SAVED}-line`,
    ]) {
      if (safeGetLayer(map, id)) {
        try {
          map.moveLayer(id);
        } catch {
          /* ignore */
        }
      }
    }
  };

  const paintDraft = (ring: number[][]) => {
    if (!mapStyleReady(map)) return false;
    ensureLayers();
    const { points, line, fill } = buildDraftCollections(ring, !activeRef.current);
    const pSrc = safeGetSource(map, DRAFT_POINTS) as any;
    const lSrc = safeGetSource(map, DRAFT_LINE) as any;
    const fSrc = safeGetSource(map, DRAFT_FILL) as any;
    if (!pSrc || !lSrc || !fSrc) return false;
    pSrc.setData(points);
    lSrc.setData(line);
    // A closed draft (not drawing any more) gets its fill; while drawing the guide shows the shape
    fSrc.setData(activeRef.current ? EMPTY_FC : fill);
    bringDraftToFront();
    return true;
  };

  const paintGuide = (cursor: number[] | null) => {
    const src = safeGetSource(map, DRAFT_GUIDE) as any;
    src?.setData?.(activeRef.current ? buildGuide(draftRef.current, cursor) : EMPTY_FC);
  };

  const paintSaved = () => {
    if (!mapStyleReady(map)) return;
    ensureLayers();
    const src = safeGetSource(map, SAVED) as any;
    src?.setData?.({
      type: 'FeatureCollection',
      features: polygonsRef.current.map((p) => ({
        type: 'Feature',
        geometry: p.polygon,
        properties: { id: p.id, label: p.label || 'AOI' },
      })),
    });
  };

  function ensureLayers() {
    if (!mapStyleReady(map)) return;

    if (!safeGetSource(map, DRAFT_POINTS)) {
      map.addSource(DRAFT_POINTS, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: `${DRAFT_POINTS}-circle`,
        type: 'circle',
        source: DRAFT_POINTS,
        paint: {
          // First corner is the "close here" target: larger and green
          'circle-radius': ['case', ['==', ['get', 'i'], 0], 9, 6],
          'circle-color': ['case', ['==', ['get', 'i'], 0], '#22c55e', '#38bdf8'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 1,
        },
      });
    }

    if (!safeGetSource(map, DRAFT_GUIDE)) {
      map.addSource(DRAFT_GUIDE, { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: `${DRAFT_GUIDE}-line`,
        type: 'line',
        source: DRAFT_GUIDE,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#38bdf8',
          'line-width': 2,
          'line-opacity': 0.8,
          'line-dasharray': [2, 2],
        },
      });
    }

    if (!safeGetSource(map, DRAFT_LINE)) {
      map.addSource(DRAFT_LINE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: `${DRAFT_LINE}-line`,
        type: 'line',
        source: DRAFT_LINE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#38bdf8',
          'line-width': 3,
          'line-opacity': 1,
        },
      });
    }

    if (!safeGetSource(map, DRAFT_FILL)) {
      map.addSource(DRAFT_FILL, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: `${DRAFT_FILL}-fill`,
        type: 'fill',
        source: DRAFT_FILL,
        paint: {
          'fill-color': '#38bdf8',
          'fill-opacity': 0.22,
        },
      });
    }

    if (!safeGetSource(map, SAVED)) {
      map.addSource(SAVED, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: `${SAVED}-fill`,
        type: 'fill',
        source: SAVED,
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.14 },
      });
      map.addLayer({
        id: `${SAVED}-line`,
        type: 'line',
        source: SAVED,
        paint: { 'line-color': '#f59e0b', 'line-width': 2.5 },
      });
    }
  }

  useEffect(() => {
    let cancelled = false;
    const boot = () => {
      if (cancelled) return;
      ensureLayers();
      paintDraft(draftRef.current);
      paintSaved();
    };
    boot();
    map.on('load', boot);
    return () => {
      cancelled = true;
      map.off('load', boot);
      if (!mapStyleReady(map)) return;
      try {
        for (const id of [
          `${DRAFT_POINTS}-circle`,
          `${DRAFT_LINE}-line`,
          `${DRAFT_GUIDE}-line`,
          `${DRAFT_FILL}-fill`,
          `${SAVED}-line`,
          `${SAVED}-fill`,
        ]) {
          if (safeGetLayer(map, id)) map.removeLayer(id);
        }
        for (const id of [DRAFT_POINTS, DRAFT_LINE, DRAFT_GUIDE, DRAFT_FILL, SAVED]) {
          if (safeGetSource(map, id)) map.removeSource(id);
        }
      } catch {
        /* map already torn down */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  useEffect(() => {
    draftRef.current = draftRing;
    setPoints(draftRing.length);
    paintDraft(draftRing);
    paintGuide(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, draftRing, active]);

  useEffect(() => {
    paintSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, polygons]);

  useEffect(() => {
    const restore = () => {
      try {
        map.dragPan.enable();
        map.boxZoom.enable();
        map.doubleClickZoom.enable();
        map.getCanvas().style.cursor = '';
      } catch {
        /* ignore */
      }
    };
    if (!active) {
      restore();
      return;
    }

    ensureLayers();
    try {
      // Empty-ocean "clicks" otherwise become tiny pans and never fire map click;
      // ship clicks are precise so they still registered — hence the asymmetry.
      map.dragPan.disable();
      map.boxZoom.disable();
      // Double-click finishes the shape instead of zooming
      map.doubleClickZoom.disable();
      map.getCanvas().style.cursor = 'crosshair';
    } catch {
      /* ignore */
    }

    const fromUi = (e: any) =>
      Boolean(
        (e.originalEvent?.target as HTMLElement | undefined)?.closest?.(
          '.alert-panel, .drawer, .app-chrome, #detail-drawer, .layers-fab, .alerts-fab, .alert-form, .aoi-draw-hint'
        )
      );

    const nearFirst = (point: { x: number; y: number }) => {
      const ring = draftRef.current;
      if (ring.length < 3) return false;
      const p = map.project(ring[0] as [number, number]);
      return Math.hypot(p.x - point.x, p.y - point.y) <= CLOSE_RADIUS_PX;
    };

    const commit = (next: number[][]) => {
      draftRef.current = next;
      setPoints(next.length);
      paintDraft(next);
      onChangeRef.current?.(next);
    };

    const finish = () => {
      if (draftRef.current.length < 3) return;
      paintGuide(null);
      onFinishRef.current?.();
    };

    const clickHandler = (e: any) => {
      if (fromUi(e)) return;
      if (nearFirst(e.point)) {
        finish();
        return;
      }
      commit([...draftRef.current, [e.lngLat.lng, e.lngLat.lat]]);
      paintGuide([e.lngLat.lng, e.lngLat.lat]);
    };

    const dblClickHandler = (e: any) => {
      if (fromUi(e)) return;
      e.preventDefault?.();
      // The two clicks of a double-click already added the same corner twice — keep one
      const ring = draftRef.current;
      if (ring.length >= 2) {
        const a = map.project(ring[ring.length - 1] as [number, number]);
        const b = map.project(ring[ring.length - 2] as [number, number]);
        if (Math.hypot(a.x - b.x, a.y - b.y) < 6) commit(ring.slice(0, -1));
      }
      finish();
    };

    const moveHandler = (e: any) => {
      map.getCanvas().style.cursor = nearFirst(e.point) ? 'pointer' : 'crosshair';
      paintGuide([e.lngLat.lng, e.lngLat.lat]);
    };

    const keyHandler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        paintGuide(null);
        onCancelRef.current?.();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish();
      } else if (e.key === 'Backspace' || (e.key === 'z' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        commit(draftRef.current.slice(0, -1));
      }
    };

    map.on('click', clickHandler);
    map.on('dblclick', dblClickHandler);
    map.on('mousemove', moveHandler);
    window.addEventListener('keydown', keyHandler);
    return () => {
      map.off('click', clickHandler);
      map.off('dblclick', dblClickHandler);
      map.off('mousemove', moveHandler);
      window.removeEventListener('keydown', keyHandler);
      paintGuide(null);
      restore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, active]);

  if (!active) return null;
  return (
    <div className="aoi-draw-hint" role="status" aria-live="polite">
      <strong>{drawHint(points)}</strong>
      <span>Backspace undoes the last corner · Esc cancels</span>
    </div>
  );
}
