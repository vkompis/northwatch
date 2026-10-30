'use client';

import { useEffect, useRef } from 'react';
import { useMap } from '../hooks/useMap';
import { mapStyleReady, safeGetLayer } from '../utils/mapSafe';
import { MAP_FONT_BOLD, MAP_FONT_REGULAR } from '../utils/mapFonts';
import {
  SEABED_DEM_TILES,
  kartverketReliefTiles,
  cachedTileUrl,
  registerCachedTileProtocol,
  registerKartverketReliefProtocol,
  registerSeabedProtocol,
} from '../utils/seabedDem';
import type { MapTheme } from '../utils/kartverketRelief';
import { CLICK_PRIORITY, offerClick } from '../utils/clickPriority';

export type OverlayVisibility = {
  'eez-norway': boolean;
  'eez-janmayen': boolean;
  'eez-svalbard': boolean;
  cables: boolean;
  'cables-telegeography': boolean;
  /** Sodir petroleum transport pipelines (in use) */
  pipelines: boolean;
  /** Legacy GeoNorge chart pipelines (not in use) */
  'pipelines-old': boolean;
  'power-cables': boolean;
  /** Kartverket sea-chart infrastructure, one toggle per kind */
  'chart-cables': boolean;
  'chart-pipelines': boolean;
  'chart-spans': boolean;
  /** Sodir oil / gas facility points */
  petroleum: boolean;
  /** Depth contours, depth labels and soundings (Open Waters, Kartverket near the coast) */
  bathymetry: boolean;
  /** Hillshaded sea floor (land stays flat) */
  'seabed-relief': boolean;
  nsm: boolean;
  skytefelt: boolean;
  ports: boolean;
  airports: boolean;
  'ice-edge': boolean;
  /** All currently in-force Kystverket warnings */
  navwarnings: boolean;
  /** In-force warnings issued within the last 30 days */
  'navwarnings-30d': boolean;
};

type OverlayDef = {
  id: keyof OverlayVisibility;
  file: string;
  /** Outer maritime boundary only (LineString) — avoids fjord/hole stroke clutter */
  boundaryFile?: string;
  fill?: boolean;
  /** Stroke full polygon (all rings). Prefer boundaryFile for EEZs. */
  line?: boolean;
  circle?: boolean;
  fillColor: string;
  fillOpacity: number;
  lineColor: string;
  lineWidth: number;
  lineOpacity?: number;
};

const OVERLAYS: OverlayDef[] = [
  {
    id: 'eez-norway',
    file: 'norway-eez.geojson',
    boundaryFile: 'norway-eez-boundary.geojson',
    fill: true,
    line: false,
    fillColor: '#0ea5e9',
    fillOpacity: 0.05,
    lineColor: '#38bdf8',
    lineWidth: 2,
  },
  {
    id: 'eez-janmayen',
    file: 'janmayen-eez.geojson',
    boundaryFile: 'janmayen-eez-boundary.geojson',
    fill: true,
    line: false,
    fillColor: '#a78bfa',
    fillOpacity: 0.06,
    lineColor: '#c4b5fd',
    lineWidth: 2,
  },
  {
    id: 'eez-svalbard',
    file: 'svalbard-fpz.geojson',
    boundaryFile: 'svalbard-fpz-boundary.geojson',
    fill: true,
    line: false,
    fillColor: '#22c55e',
    fillOpacity: 0.06,
    lineColor: '#4ade80',
    lineWidth: 2.25,
  },
  {
    id: 'ice-edge',
    file: 'ice-edge.geojson',
    line: true,
    fillColor: '#e0f2fe',
    fillOpacity: 0,
    lineColor: '#7dd3fc',
    lineWidth: 2.5,
  },
  {
    id: 'cables',
    file: 'cables-all.geojson',
    line: true,
    fillColor: '#00e6ff',
    fillOpacity: 0,
    lineColor: '#00e6ff',
    lineWidth: 1.5,
  },
  {
    id: 'cables-telegeography',
    file: 'cables-telegeography-norway.geojson',
    line: true,
    fillColor: '#f472b6',
    fillOpacity: 0,
    lineColor: '#f472b6',
    lineWidth: 2.5,
  },
  {
    id: 'power-cables',
    file: 'power-cables-nve.geojson',
    line: true,
    fillColor: '#a3e635',
    fillOpacity: 0,
    lineColor: '#a3e635',
    lineWidth: 1.6,
  },
  {
    id: 'pipelines-old',
    file: 'pipelines-geonorge.geojson',
    line: true,
    fillColor: '#94a3b8',
    fillOpacity: 0,
    lineColor: '#94a3b8',
    lineWidth: 1.25,
    lineOpacity: 0.55,
  },
  {
    id: 'pipelines',
    file: 'pipelines.geojson',
    line: true,
    fillColor: '#f97316',
    fillOpacity: 0,
    lineColor: '#fb923c',
    lineWidth: 2,
  },
  {
    id: 'nsm',
    file: 'nsm.geojson',
    fill: true,
    line: true,
    fillColor: '#ef4444',
    fillOpacity: 0.12,
    lineColor: '#f87171',
    lineWidth: 1.5,
  },
  {
    id: 'skytefelt',
    file: 'skytefelt.geojson',
    fill: true,
    line: true,
    fillColor: '#eab308',
    fillOpacity: 0.12,
    lineColor: '#facc15',
    lineWidth: 1.5,
  },
  {
    id: 'ports',
    file: 'ports.geojson',
    circle: true,
    fill: true,
    line: true,
    fillColor: '#64748b',
    fillOpacity: 0.15,
    lineColor: '#94a3b8',
    lineWidth: 1,
  },
];

const PETROLEUM_POINTS_FILE = 'petroleum.geojson';
const TG_LANDINGS_FILE = 'cable-landings-telegeography-norway.geojson';

/** Open Waters Seascape — GEBCO + EMODnet mosaic, MapLibre-native tiles (CC BY 4.0). */
const SEASCAPE_BASE = 'https://tiles.openwaters.io/seascape';
const BATHY_DEM_SOURCE = 'overlay-bathymetry-dem';
const BATHY_VEC_SOURCE = 'overlay-bathymetry-vector';
const SEABED_DEM_SOURCE = 'overlay-seabed-dem';
const MOVEABLE_RIG_SOURCE = 'overlay-petroleum-moveable';
const SEABED_RELIEF_LAYER = 'overlay-seabed-relief';
/**
 * Kartverket's 50 / 25 / 5 m seabed hillshade where it has data (coast, MAREANO areas,
 * survey lines), drawn opaque over the DEM relief in the same colours; elsewhere it is
 * transparent and the DEM relief shows. Below z5 it adds nothing the DEM relief lacks.
 */
const KV_RELIEF_SOURCE = 'overlay-seabed-kartverket';
const KV_RELIEF_LAYER = 'overlay-seabed-relief-kartverket';
const SEABED_LAYERS = [SEABED_RELIEF_LAYER, KV_RELIEF_LAYER];

/**
 * On the light map the bright overlay colours (cyan, lavender, light green, yellow) wash out;
 * these darker, more saturated versions keep the same hues and their contrast.
 */
const LIGHT_OVERLAY: Partial<Record<keyof OverlayVisibility, { line: string; fill?: string }>> = {
  'eez-norway': { line: '#0369a1', fill: '#0284c7' },
  'eez-janmayen': { line: '#6d28d9', fill: '#7c3aed' },
  'eez-svalbard': { line: '#15803d', fill: '#16a34a' },
  'ice-edge': { line: '#0e7490' },
  cables: { line: '#0891b2' },
  'cables-telegeography': { line: '#be185d' },
  'pipelines-old': { line: '#64748b' },
  'power-cables': { line: '#4d7c0f' },
  pipelines: { line: '#c2410c' },
  nsm: { line: '#dc2626', fill: '#ef4444' },
  skytefelt: { line: '#a16207', fill: '#ca8a04' },
  ports: { line: '#475569', fill: '#475569' },
};
const lineColorFor = (def: OverlayDef, theme: MapTheme): any =>
  theme === 'light'
    ? LIGHT_OVERLAY[def.id]?.line ?? def.lineColor
    : def.id === 'cables-telegeography'
      ? ['coalesce', ['get', 'color'], def.lineColor]
      : def.lineColor;
const fillColorFor = (def: OverlayDef, theme: MapTheme) =>
  (theme === 'light' && LIGHT_OVERLAY[def.id]?.fill) || def.fillColor;

/** Depth contours, labels and soundings per theme; TeleGeography landing points too. */
const BATHY_THEME = {
  dark: { label: '#a8c0d4', halo: 'rgba(8, 15, 24, 0.85)', sounding: '#7f9bb5', major: '#8aa4bc', minor: '#6b849e' },
  light: { label: '#4f6b7c', halo: 'rgba(245, 247, 248, 0.9)', sounding: '#6b8597', major: '#7f94a4', minor: '#a6b5c0' },
};
const LANDING_THEME = {
  dark: { circle: '#f9a8d4', text: '#fbcfe8', halo: 'rgba(0,0,0,0.7)' },
  light: { circle: '#be185d', text: '#9d174d', halo: 'rgba(255,255,255,0.9)' },
};

/** DEM relief paint per map theme (Kartverket's tiles carry the same colours, see kartverketRelief.ts). */
const RELIEF_PAINT: Record<MapTheme, Record<string, string>> = {
  dark: {
    'hillshade-shadow-color': 'rgba(0, 4, 12, 0.9)',
    'hillshade-highlight-color': 'rgba(120, 160, 200, 0.35)',
    'hillshade-accent-color': 'rgba(0, 0, 0, 0.3)',
  },
  light: {
    'hillshade-shadow-color': 'rgba(60, 80, 100, 0.4)',
    'hillshade-highlight-color': 'rgba(255, 255, 255, 0.55)',
    'hillshade-accent-color': 'rgba(60, 80, 100, 0.1)',
  },
};
/** Earlier ids: a DEM of its own, then a relief on the land+sea basemap terrain. */
const LEGACY_BATHY_LAYERS = [
  'overlay-bathymetry-hillshade',
  'overlay-bathymetry-depth',
  'overlay-bathymetry-relief',
];
/**
 * Kartverket "Sjøkart – Dybdedata" WMS: charted contours with depth labels (from ~z14)
 * and soundings / shoals (from ~z15) in Norwegian waters. The service only draws
 * them at large scales, so the layer starts where Open Waters steps back.
 */
/**
 * Kartverket "Sjøkart – Maritim infrastruktur" WMS (CC BY 4.0): sea cables and pipelines,
 * overhead spans and bridges with their clearance, aquaculture moorings, platforms — as
 * reported for the nautical charts, coast, Svalbard and Jan Mayen. Drawn in chart symbology.
 */
/**
 * The service only draws each kind from a certain scale (cables from about z12). Cables and
 * spans are dark chart ink — inverted on the dark map so they show; pipelines are red and
 * stay red.
 */
const MARITIME_INFRA: {
  key: 'chart-cables' | 'chart-pipelines' | 'chart-spans';
  layers: string;
  minzoom: number;
  invertOnDark: boolean;
}[] = [
  { key: 'chart-cables', layers: 'kabel_l,kabel_a', minzoom: 12, invertOnDark: true },
  { key: 'chart-pipelines', layers: 'rorledning_l,rorledning_a', minzoom: 8, invertOnDark: false },
  { key: 'chart-spans', layers: 'Luftspenn,bro_l,bro_a,taubane', minzoom: 10, invertOnDark: true },
];
const chartInkPaint = (invert: boolean, theme: MapTheme) =>
  invert && theme === 'dark'
    ? { 'raster-brightness-min': 0.85, 'raster-brightness-max': 0.15 }
    : { 'raster-brightness-min': 0, 'raster-brightness-max': 1 };
const maritimeInfraTiles = (layers: string) =>
  'https://wms.geonorge.no/skwms1/wms.maritim_infrastruktur?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
  `&LAYERS=${layers}&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=512&HEIGHT=512` +
  '&FORMAT=image/png&TRANSPARENT=true';

const KV_DEPTH_SOURCE = 'overlay-bathymetry-kartverket';
const KV_DEPTH_MINZOOM = 13.5;
const KV_DEPTH_TILES =
  'https://wms.geonorge.no/skwms1/wms.dybdedata2?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
  '&LAYERS=Dybdekontur,Dybdepunkt,grunne,skjaer_punkt&STYLES=&CRS=EPSG:3857' +
  '&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true';
const BATHY_LAYER_IDS = [
  'overlay-bathymetry-contours',
  'overlay-bathymetry-labels',
  'overlay-bathymetry-soundings',
  'overlay-bathymetry-kartverket',
] as const;

/**
 * Seabed relief = MapLibre hillshade over the AWS terrarium DEM with land flattened
 * (see seabedDem.ts), drawn just above the water fill. Open Waters supplies contours,
 * depth labels and soundings. Its depth-area fills are still left out: semi-transparent
 * vector fills draw tile-grid seams in MapLibre.
 */
const BATHY_IS_MAJOR: any = [
  '==',
  ['%', ['coalesce', ['to-number', ['get', 'depth_abs_m']], -1], 500],
  0,
];

const BATHY_LINE_WIDTH: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  3,
  ['case', BATHY_IS_MAJOR, 1.0, 0.55],
  7,
  ['case', BATHY_IS_MAJOR, 1.4, 0.8],
  11,
  ['case', BATHY_IS_MAJOR, 1.8, 1.0],
];

const BATHY_LINE_OPACITY: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  3,
  0.45,
  6,
  0.6,
  10,
  0.75,
  // Kartverket's charted contours take over near the coast
  KV_DEPTH_MINZOOM,
  0.75,
  KV_DEPTH_MINZOOM + 1,
  0.25,
];

/** Depth labels — thin at z6 (500 m majors), denser from z8. */
const BATHY_LABEL_FILTER: any = [
  'all',
  ['!=', ['get', 'sys'], 'ft'],
  [
    'step',
    ['zoom'],
    [
      '==',
      ['%', ['coalesce', ['to-number', ['get', 'depth_abs_m']], -1], 500],
      0,
    ],
    8,
    [
      'any',
      [
        '==',
        ['%', ['coalesce', ['to-number', ['get', 'depth_abs_m']], -1], 200],
        0,
      ],
      [
        '==',
        ['%', ['coalesce', ['to-number', ['get', 'depth_abs_m']], -1], 500],
        0,
      ],
    ],
    10,
    ['has', 'depth_abs_m'],
  ],
];

const BATHY_LABEL_SIZE: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  6,
  9,
  8,
  10.5,
  10,
  12,
  12,
  13.5,
  14,
  15,
];


function applyBathymetryPaint(
  map: {
    setPaintProperty: (id: string, prop: string, value: unknown) => void;
    setLayoutProperty: (id: string, prop: string, value: unknown) => void;
    setFilter: (id: string, filter: any) => unknown;
    getLayer: (id: string) => unknown;
  },
  theme: MapTheme = 'dark'
) {
  const c = BATHY_THEME[theme];
  if (map.getLayer('overlay-bathymetry-contours')) {
    map.setPaintProperty('overlay-bathymetry-contours', 'line-color', ['case', BATHY_IS_MAJOR, c.major, c.minor]);
    map.setPaintProperty('overlay-bathymetry-contours', 'line-width', BATHY_LINE_WIDTH);
    map.setPaintProperty(
      'overlay-bathymetry-contours',
      'line-opacity',
      BATHY_LINE_OPACITY
    );
  }
  if (map.getLayer('overlay-bathymetry-labels')) {
    map.setLayoutProperty('overlay-bathymetry-labels', 'text-size', BATHY_LABEL_SIZE);
    map.setLayoutProperty('overlay-bathymetry-labels', 'text-field', [
      'to-string',
      [
        'abs',
        ['to-number', ['coalesce', ['get', 'depth_abs_m'], ['get', 'depth_m'], 0]],
      ],
    ]);
    map.setFilter('overlay-bathymetry-labels', BATHY_LABEL_FILTER);
    map.setPaintProperty('overlay-bathymetry-labels', 'text-color', c.label);
    map.setPaintProperty('overlay-bathymetry-labels', 'text-halo-color', c.halo);
    map.setPaintProperty('overlay-bathymetry-labels', 'text-halo-width', 1.25);
  }
}

function beforeIdForBathymetry(map: {
  getStyle: () => { layers?: { id: string; type: string }[] } | undefined;
}): string | undefined {
  const layers = map.getStyle()?.layers || [];
  // The seabed relief sits right above the water fill: going under it would hide the layer
  const overlay = layers.find(
    (l) => l.id.startsWith('overlay-') && !l.id.startsWith('overlay-bathymetry') && !l.id.startsWith('overlay-seabed')
  );
  if (overlay) return overlay.id;
  const symbol = layers.find((l) => l.type === 'symbol');
  return symbol?.id;
}

/** Directly above the basemap water fill, so the relief shades the sea under roads and labels. */
function beforeIdForSeabedRelief(map: {
  getStyle: () => { layers?: { id: string; type: string }[] } | undefined;
}): string | undefined {
  const layers = map.getStyle()?.layers || [];
  const water = layers.findIndex((l) => l.id === 'water-fill');
  if (water >= 0 && layers[water + 1]) return layers[water + 1].id;
  return beforeIdForBathymetry(map);
}

const EMPTY_GEOJSON = { type: 'FeatureCollection' as const, features: [] };

/** Files already asked for, per map, so each is fetched once. */
const REQUESTED_OVERLAYS = new WeakMap<object, Set<string>>();

/** Fetch an overlay's files the first time it is on. The big ones are often never needed. */
function loadOverlayData(map: any, apiBase: string, def: OverlayDef, visibility: OverlayVisibility) {
  if (!visibility[def.id]) return;
  let requested = REQUESTED_OVERLAYS.get(map);
  if (!requested) REQUESTED_OVERLAYS.set(map, (requested = new Set()));
  const seen = requested;
  const files: [string, string][] = [[`overlay-${def.id}`, def.file]];
  if (def.boundaryFile) files.push([`overlay-${def.id}-boundary`, def.boundaryFile]);
  for (const [sourceId, file] of files) {
    if (seen.has(sourceId) || !mapStyleReady(map) || !map.getSource(sourceId)) continue;
    seen.add(sourceId);
    fetch(`${apiBase}/overlays/${file}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${file}: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (mapStyleReady(map)) map.getSource(sourceId)?.setData(data);
      })
      .catch((e) => {
        // Switching the layer off and on tries again
        seen.delete(sourceId);
        console.error(e);
      });
  }
}

function vis(visible: boolean): 'visible' | 'none' {
  return visible ? 'visible' : 'none';
}

/**
 * Same zoom curve as SAR / AIS-off detections, but a notch smaller when zoomed in
 * so dense coastal clusters stay readable.
 */
const PORT_CIRCLE_RADIUS: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  2,
  1.25,
  3.5,
  1.75,
  5,
  2.75,
  7,
  4,
  9,
  5.5,
  11,
  6.5,
];
const PORT_STROKE_WIDTH: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  2,
  1,
  5,
  1.25,
  8,
  1.5,
  11,
  1.85,
];
const PORT_HIT_RADIUS: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  2,
  8,
  7,
  13,
  10,
  16,
];

export type CableFeatureProps = {
  id: string;
  name: string;
  source: string;
  kind: 'nkom' | 'telegeography' | 'landing' | 'power';
  is_planned?: boolean;
  /** NVE power cables */
  owner?: string | null;
  netLevel?: string | null;
  voltageKv?: number | null;
  year?: number | null;
  rfs_year?: number | null;
  color?: string | null;
  kabeltype?: string | null;
};

/** Norwegian PFSA port facility (Kystverket / GeoNorge). */
export type PortFeatureProps = {
  id: string;
  name: string;
  harbour: string | null;
  ownerType: string | null;
  status: string | null;
  functions: string | null;
  hasCruise: string | null;
  safeLoading: string | null;
  approvalValidTo: string | null;
  council: string | null;
  county: string | null;
};

/** Petroleum installation point (Sodir FactMaps facilities). */
export type RigFeatureProps = {
  id: string;
  name: string;
  kind: string | null;
  phase: string | null;
  fixedOrMoveable: string | null;
  operator: string | null;
  belongsTo: string | null;
  functions: string | null;
  status: string | null;
  waterDepthM: number | null;
  updated: string | null;
  factPageUrl: string | null;
  /** Moveable rigs only: the AIS vessel that places them (Sodir has no coordinates). */
  mmsi?: string | null;
  aisName?: string | null;
  aisTimestamp?: string | null;
};

/** Pipeline line (Sodir active or legacy GeoNorge chart). */
export type PipelineFeatureProps = {
  id: string;
  name: string;
  medium: string | null;
  phase: string | null;
  operator: string | null;
  belongsTo: string | null;
  fromFacility: string | null;
  toFacility: string | null;
  dimensionInch: number | null;
  waterDepthM: number | null;
  updated: string | null;
  factPageUrl: string | null;
  /** Chart pipeline type (GeoNorge), e.g. gass / olje / vann */
  chartType: string | null;
  inUse: boolean;
  source: 'sodir' | 'geonorge';
};

type Props = {
  visibility: OverlayVisibility;
  apiBase?: string;
  onCableSelect?: (cable: CableFeatureProps) => void;
  onPortSelect?: (port: PortFeatureProps) => void;
  onRigSelect?: (rig: RigFeatureProps) => void;
  onPipelineSelect?: (pipeline: PipelineFeatureProps) => void;
  /** Light or dark basemap: the seabed relief is drawn in matching colours */
  theme?: MapTheme;
};

function strProp(p: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = p[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function numProp(p: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = p[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export default function OverlayLayers({
  visibility,
  apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8787',
  onCableSelect,
  onPortSelect,
  onRigSelect,
  onPipelineSelect,
  theme = 'dark',
}: Props) {
  const map = useMap();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onCableRef = useRef(onCableSelect);
  onCableRef.current = onCableSelect;
  const onPortRef = useRef(onPortSelect);
  onPortRef.current = onPortSelect;
  const onRigRef = useRef(onRigSelect);
  onRigRef.current = onRigSelect;
  const onPipelineRef = useRef(onPipelineSelect);
  onPipelineRef.current = onPipelineSelect;
  const visibilityRef = useRef(visibility);
  visibilityRef.current = visibility;

  useEffect(() => {
    let cancelled = false;

    // The layers go on the map empty, to keep their order; the data comes when one is switched on
    function addOverlayLayers(def: OverlayDef) {
      if (!mapStyleReady(map)) return;
      const sourceId = `overlay-${def.id}`;
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: 'geojson', data: EMPTY_GEOJSON });

        if (def.fill) {
          map.addLayer({
            id: `${sourceId}-fill`,
            type: 'fill',
            source: sourceId,
            layout: { visibility: vis(visibility[def.id]) },
            paint: {
              'fill-color': fillColorFor(def, themeRef.current),
              'fill-opacity': def.fillOpacity,
            },
          });
        }
          if (def.line) {
          const paint: any = {
            'line-width': def.lineWidth,
            'line-opacity': def.lineOpacity ?? 0.9,
          };
          paint['line-color'] = lineColorFor(def, themeRef.current);
          map.addLayer({
            id: `${sourceId}-line`,
            type: 'line',
            source: sourceId,
            layout: {
              visibility: vis(visibility[def.id]),
              'line-cap': 'round',
              'line-join': 'round',
            },
            paint,
          });
          if (
            def.id === 'cables' ||
            def.id === 'cables-telegeography' ||
            def.id === 'power-cables' ||
            def.id === 'pipelines' ||
            def.id === 'pipelines-old'
          ) {
            map.addLayer({
              id: `${sourceId}-hit`,
              type: 'line',
              source: sourceId,
              layout: {
                visibility: vis(visibility[def.id]),
                'line-cap': 'round',
                'line-join': 'round',
              },
              paint: {
                'line-color': '#000',
                'line-width': 14,
                'line-opacity': 0,
              },
            });
          }
        }
        if (def.circle) {
          const isPorts = def.id === 'ports';
          map.addLayer({
            id: `${sourceId}-circle`,
            type: 'circle',
            source: sourceId,
            filter: ['==', ['geometry-type'], 'Point'],
            layout: { visibility: vis(visibility[def.id]) },
            paint: {
              'circle-radius': isPorts ? PORT_CIRCLE_RADIUS : 4,
              'circle-color': lineColorFor(def, themeRef.current),
              'circle-stroke-width': isPorts ? PORT_STROKE_WIDTH : 1,
              'circle-stroke-color': '#fff',
              'circle-opacity': 0.5,
              'circle-stroke-opacity': 0.5,
            },
          });
          if (isPorts) {
            map.addLayer({
              id: `${sourceId}-hit`,
              type: 'circle',
              source: sourceId,
              filter: ['==', ['geometry-type'], 'Point'],
              layout: { visibility: vis(visibility[def.id]) },
              paint: {
                'circle-radius': PORT_HIT_RADIUS,
                'circle-opacity': 0,
                'circle-stroke-width': 0,
              },
            });
          }
        }
      }

      if (def.boundaryFile) {
        const bId = `overlay-${def.id}-boundary`;
        if (map.getSource(bId)) return;
        map.addSource(bId, { type: 'geojson', data: EMPTY_GEOJSON });
        map.addLayer({
          id: `${bId}-line`,
          type: 'line',
          source: bId,
          layout: {
            visibility: vis(visibility[def.id]),
            'line-cap': 'round',
            'line-join': 'round',
          },
          paint: {
            'line-color': lineColorFor(def, themeRef.current),
            'line-width': def.lineWidth,
            'line-opacity': 0.95,
          },
        });
      }
    }

    async function loadPetroleumPoints() {
      const sourceId = 'overlay-petroleum-points';
      if (map.getSource(sourceId)) return;
      const res = await fetch(`${apiBase}/overlays/${PETROLEUM_POINTS_FILE}`);
      if (!res.ok) return;
      const data = await res.json();
      // boot() runs on both load and idle — another call may have added it meanwhile
      if (cancelled || map.getSource(sourceId)) return;
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: `${sourceId}-circle`,
        type: 'circle',
        source: sourceId,
        layout: { visibility: vis(visibility.petroleum) },
        paint: {
          'circle-radius': PORT_CIRCLE_RADIUS,
          'circle-color': '#f97316',
          'circle-stroke-width': PORT_STROKE_WIDTH,
          'circle-stroke-color': '#fff',
          'circle-opacity': 0.5,
          'circle-stroke-opacity': 0.5,
        },
      });
      map.addLayer({
        id: `${sourceId}-hit`,
        type: 'circle',
        source: sourceId,
        layout: { visibility: vis(visibility.petroleum) },
        paint: {
          'circle-radius': PORT_HIT_RADIUS,
          'circle-opacity': 0,
          'circle-stroke-width': 0,
        },
      });
    }

    /**
     * Seabed relief plus depth contours / labels / soundings (Open Waters, Kartverket).
     * Open Waters depth-area fills are omitted: they draw tile-grid seams in MapLibre.
     */
    async function loadBathymetry() {
      if (!mapStyleReady(map)) return;
      const beforeId = beforeIdForBathymetry(map);
      const v = vis(visibility.bathymetry);

      for (const legacyId of LEGACY_BATHY_LAYERS) {
        if (safeGetLayer(map, legacyId)) {
          try {
            map.removeLayer(legacyId);
          } catch {
            /* ignore */
          }
        }
      }
      if (map.getSource(BATHY_DEM_SOURCE)) {
        try {
          map.removeSource(BATHY_DEM_SOURCE);
        } catch {
          /* ignore */
        }
      }

      registerSeabedProtocol();
      if (!map.getSource(SEABED_DEM_SOURCE)) {
        map.addSource(SEABED_DEM_SOURCE, {
          type: 'raster-dem',
          tiles: [SEABED_DEM_TILES],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 12,
          // Same tiles as the basemap's land relief, which already credits Mapzen / AWS
        } as any);
      }

      if (!safeGetLayer(map, SEABED_RELIEF_LAYER)) {
        map.addLayer(
          {
            id: SEABED_RELIEF_LAYER,
            type: 'hillshade',
            source: SEABED_DEM_SOURCE,
            layout: { visibility: vis(visibility['seabed-relief']) },
            paint: {
              'hillshade-illumination-direction': 315,
              ...RELIEF_PAINT[themeRef.current],
              'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 2, 0.75, 8, 0.6, 12, 0.45],
            },
          } as any,
          beforeIdForSeabedRelief(map)
        );
      }

      registerKartverketReliefProtocol();
      if (!map.getSource(KV_RELIEF_SOURCE)) {
        map.addSource(KV_RELIEF_SOURCE, {
          type: 'raster',
          tiles: [kartverketReliefTiles(themeRef.current)],
          tileSize: 256,
          minzoom: 5,
          maxzoom: 14,
          attribution: 'Seabed relief: © <a href="https://kartverket.no/">Kartverket</a>',
        });
      }
      if (!safeGetLayer(map, KV_RELIEF_LAYER)) {
        // Directly above the DEM relief (which itself sits directly above the water fill)
        const layers = map.getStyle()?.layers || [];
        const relief = layers.findIndex((l) => l.id === SEABED_RELIEF_LAYER);
        const beforeKv = relief >= 0 ? layers[relief + 1]?.id : beforeIdForSeabedRelief(map);
        map.addLayer(
          {
            id: KV_RELIEF_LAYER,
            type: 'raster',
            source: KV_RELIEF_SOURCE,
            minzoom: 5,
            layout: { visibility: vis(visibility['seabed-relief']) },
            paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
          },
          beforeKv
        );
      }

      if (!map.getSource(BATHY_VEC_SOURCE)) {
        map.addSource(BATHY_VEC_SOURCE, {
          type: 'vector',
          url: `${SEASCAPE_BASE}/vector.json`,
          attribution:
            '© <a href="https://openwaters.io/charts/seascape#license">Open Waters</a> (GEBCO / EMODnet)',
        });
      }

      if (!safeGetLayer(map, 'overlay-bathymetry-contours')) {
        map.addLayer(
          {
            id: 'overlay-bathymetry-contours',
            type: 'line',
            source: BATHY_VEC_SOURCE,
            'source-layer': 'contours',
            filter: ['!=', ['get', 'sys'], 'ft'],
            // Open Waters tiles start at z4; below that the relief carries the seabed
            minzoom: 4,
            layout: {
              visibility: v,
              'line-cap': 'round',
              'line-join': 'round',
            },
            paint: {
              'line-color': ['case', BATHY_IS_MAJOR, BATHY_THEME[themeRef.current].major, BATHY_THEME[themeRef.current].minor],
              'line-width': BATHY_LINE_WIDTH,
              'line-opacity': BATHY_LINE_OPACITY,
            },
          } as any,
          beforeId
        );
      }

      if (!safeGetLayer(map, 'overlay-bathymetry-labels')) {
        map.addLayer(
          {
            id: 'overlay-bathymetry-labels',
            type: 'symbol',
            source: BATHY_VEC_SOURCE,
            'source-layer': 'contours',
            filter: BATHY_LABEL_FILTER,
            minzoom: 6,
            maxzoom: KV_DEPTH_MINZOOM + 0.5,
            layout: {
              visibility: v,
              'symbol-placement': 'line',
              'symbol-spacing': 60,
              'text-field': [
                'to-string',
                [
                  'abs',
                  [
                    'to-number',
                    ['coalesce', ['get', 'depth_abs_m'], ['get', 'depth_m'], 0],
                  ],
                ],
              ],
              'text-font': MAP_FONT_BOLD,
              'text-size': BATHY_LABEL_SIZE,
              'text-max-angle': 30,
              'text-padding': 28,
              'text-letter-spacing': 0.05,
              'text-optional': true,
              'text-allow-overlap': false,
              'text-ignore-placement': false,
            },
            paint: {
              'text-color': BATHY_THEME[themeRef.current].label,
              'text-halo-color': BATHY_THEME[themeRef.current].halo,
              'text-halo-width': 1.25,
              'text-opacity': [
                'interpolate',
                ['linear'],
                ['zoom'],
                6,
                0.75,
                9,
                0.9,
              ],
            },
          } as any,
          beforeId
        );
      }

      if (!safeGetLayer(map, 'overlay-bathymetry-soundings')) {
        map.addLayer(
          {
            id: 'overlay-bathymetry-soundings',
            type: 'symbol',
            source: BATHY_VEC_SOURCE,
            'source-layer': 'soundings',
            minzoom: 9,
            maxzoom: KV_DEPTH_MINZOOM + 0.5,
            layout: {
              visibility: v,
              'text-field': [
                'to-string',
                ['round', ['abs', ['to-number', ['get', 'depth_m'], 0]]],
              ],
              'text-font': MAP_FONT_REGULAR,
              'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9, 13, 11],
              'text-padding': 6,
              'text-allow-overlap': false,
            },
            paint: {
              'text-color': BATHY_THEME[themeRef.current].sounding,
              'text-halo-color': BATHY_THEME[themeRef.current].halo,
              'text-halo-width': 1,
            },
          } as any,
          beforeId
        );
      }

      if (!map.getSource(KV_DEPTH_SOURCE)) {
        map.addSource(KV_DEPTH_SOURCE, {
          type: 'raster',
          tiles: [KV_DEPTH_TILES],
          tileSize: 256,
          minzoom: 13,
          maxzoom: 18,
          attribution: '© <a href="https://kartverket.no">Kartverket</a> (Sjøkart – Dybdedata)',
        } as any);
      }
      if (!safeGetLayer(map, 'overlay-bathymetry-kartverket')) {
        map.addLayer(
          {
            id: 'overlay-bathymetry-kartverket',
            type: 'raster',
            source: KV_DEPTH_SOURCE,
            minzoom: KV_DEPTH_MINZOOM,
            layout: { visibility: v },
            paint: {
              'raster-opacity': [
                'interpolate',
                ['linear'],
                ['zoom'],
                KV_DEPTH_MINZOOM,
                0,
                KV_DEPTH_MINZOOM + 0.5,
                0.9,
              ],
              // Chart symbology is dark ink with white halos on paper; min > max inverts it
              // for the night map (light ink, dark halos)
              'raster-brightness-min': 0.85,
              'raster-brightness-max': 0.15,
              'raster-saturation': -1,
            },
          } as any,
          beforeId
        );
      }

      applyBathymetryPaint(map, themeRef.current);
    }

    async function loadTgLandings() {
      const sourceId = 'overlay-tg-landings';
      if (cancelled || map.getSource(sourceId)) return;
      const res = await fetch(`${apiBase}/overlays/${TG_LANDINGS_FILE}`);
      if (!res.ok) return;
      const data = await res.json();
      // boot() runs on both load and idle — another call may have added it meanwhile
      if (cancelled || map.getSource(sourceId)) return;
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: `${sourceId}-circle`,
        type: 'circle',
        source: sourceId,
        layout: { visibility: vis(visibility['cables-telegeography']) },
        paint: {
          'circle-radius': 4,
          'circle-color': LANDING_THEME[themeRef.current].circle,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#fff',
          'circle-opacity': 0.5,
          'circle-stroke-opacity': 0.5,
        },
      });
      map.addLayer({
        id: `${sourceId}-label`,
        type: 'symbol',
        source: sourceId,
        layout: {
          visibility: vis(visibility['cables-telegeography']),
          'text-field': ['get', 'name'],
          'text-font': MAP_FONT_REGULAR,
          'text-size': 10,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': LANDING_THEME[themeRef.current].text,
          'text-halo-color': LANDING_THEME[themeRef.current].halo,
          'text-halo-width': 1,
        },
      });
    }

    /** Rigs placed by AIS — they move, so the source is refreshed while the map is open. */
    async function loadMoveableRigs() {
      if (!mapStyleReady(map)) return;
      const res = await fetch(`${apiBase}/api/petroleum/moveable`);
      if (!res.ok) return;
      const data = await res.json();
      if (cancelled || !mapStyleReady(map)) return;
      const existing = map.getSource(MOVEABLE_RIG_SOURCE) as any;
      if (existing) {
        existing.setData(data);
        return;
      }
      const v = vis(visibilityRef.current.petroleum);
      map.addSource(MOVEABLE_RIG_SOURCE, { type: 'geojson', data });
      map.addLayer({
        id: `${MOVEABLE_RIG_SOURCE}-circle`,
        type: 'circle',
        source: MOVEABLE_RIG_SOURCE,
        layout: { visibility: v },
        // Hollow ring: same orange as fixed facilities, but reads as "positioned by AIS"
        paint: {
          'circle-radius': PORT_CIRCLE_RADIUS,
          'circle-color': '#1c1917',
          'circle-opacity': 0.85,
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#f97316',
        },
      });
      map.addLayer({
        id: `${MOVEABLE_RIG_SOURCE}-hit`,
        type: 'circle',
        source: MOVEABLE_RIG_SOURCE,
        layout: { visibility: v },
        paint: { 'circle-radius': PORT_HIT_RADIUS, 'circle-opacity': 0, 'circle-stroke-width': 0 },
      });
    }

    let booting = false;
    let booted = false;

    async function boot() {
      // Called from load, idle and a timer, but runs one at a time and only until it has worked
      if (booted || booting || cancelled || !mapStyleReady(map)) return;
      booting = true;
      // The map can be torn down while a step is loading; stop before touching it again
      try {
        for (const def of OVERLAYS) {
          addOverlayLayers(def);
          loadOverlayData(map, apiBase, def, visibilityRef.current);
        }
        await loadBathymetry().catch((e) => console.error('[bathymetry]', e));
        if (cancelled) return;
        await loadPetroleumPoints();
        if (cancelled) return;
        await loadMoveableRigs().catch((e) => console.error('[rigs]', e));
        if (cancelled) return;
        await loadTgLandings();
        if (cancelled) return;
        addMaritimeInfra();
        booted = true;
      } catch (e) {
        console.error('[OverlayLayers]', e);
      } finally {
        booting = false;
      }
    }

    // One WMS source per kind, so each toggle only fetches its own tiles
    function addMaritimeInfra() {
      for (const { key, layers, minzoom, invertOnDark } of MARITIME_INFRA) {
        const sourceId = `overlay-${key}`;
        if (!mapStyleReady(map) || map.getSource(sourceId)) continue;
        registerCachedTileProtocol();
        map.addSource(sourceId, {
          type: 'raster',
          tiles: [cachedTileUrl(maritimeInfraTiles(layers))],
          tileSize: 256,
          minzoom,
          maxzoom: 18,
          attribution: '© <a href="https://kartverket.no">Kartverket</a> (Sjøkart – Maritim infrastruktur)',
        } as any);
        map.addLayer(
          {
            id: `${sourceId}-raster`,
            type: 'raster',
            source: sourceId,
            minzoom,
            layout: { visibility: vis(visibilityRef.current[key]) },
            paint: {
              'raster-opacity': 0.95,
              'raster-fade-duration': 0,
              ...chartInkPaint(invertOnDark, themeRef.current),
            },
          },
          beforeIdForBathymetry(map)
        );
      }
    }

    const start = () => {
      boot();
    };

    const cableSelect = (e: any) => {
      const f = e.features?.[0];
      if (!f || !onCableRef.current) return;
      e.originalEvent?.stopPropagation?.();
      const p = f.properties || {};
      const layerId = String(f.layer?.id || '');
      const isTg = layerId.includes('telegeography') || layerId.includes('tg-landings');
      const isLanding = layerId.includes('tg-landings');
      if (layerId.includes('power-cables')) {
        onCableRef.current({
          id: String(p.id || 'power-cable'),
          name: String(p.name || (p.owner ? `${p.owner} sea cable` : 'Power cable')),
          source: String(p.source || 'NVE Nettanlegg'),
          kind: 'power',
          owner: p.owner ? String(p.owner) : null,
          netLevel: p.netLevel ? String(p.netLevel) : null,
          voltageKv: p.voltageKv != null && p.voltageKv !== '' ? Number(p.voltageKv) : null,
          year: p.year != null && p.year !== '' ? Number(p.year) : null,
        });
        return;
      }
      onCableRef.current({
        id: String(p.id || p.lokalid || p.name || 'cable'),
        name: String(p.name || p.navn || p.kabeltype || 'Undersea cable'),
        source: String(
          p.source ||
            (isTg
              ? 'TeleGeography Submarine Cable Map'
              : 'Nkom / GeoNorge')
        ),
        kind: isLanding ? 'landing' : isTg ? 'telegeography' : 'nkom',
        is_planned: p.is_planned === true || p.is_planned === 'true',
        rfs_year: p.rfs_year != null && p.rfs_year !== '' ? Number(p.rfs_year) : null,
        color: p.color ? String(p.color) : null,
        kabeltype: p.kabeltype ? String(p.kabeltype) : null,
      });
    };

    const portSelect = (e: any) => {
      const f = e.features?.[0];
      if (!f || !onPortRef.current) return;
      e.originalEvent?.stopPropagation?.();
      const p = (f.properties || {}) as Record<string, unknown>;
      const id = strProp(p, 'portfacilityno', 'id') || 'port';
      const name =
        strProp(p, 'locationnamenor', 'name', 'harbour') || `Port ${id}`;
      onPortRef.current({
        id,
        name,
        harbour: strProp(p, 'harbour'),
        ownerType: strProp(p, 'ownertypenor', 'ownertype'),
        status: strProp(p, 'portfacilitystatusnor', 'status'),
        functions: strProp(p, 'functionsnor', 'functions'),
        hasCruise: strProp(p, 'hascruisefunction'),
        safeLoading: strProp(p, 'issafeloadingcompliant'),
        approvalValidTo: strProp(p, 'pfsaapprovalperiodvalidto'),
        council: strProp(p, 'councilname'),
        county: strProp(p, 'countyname'),
      });
    };

    const rigSelect = (e: any) => {
      const f = e.features?.[0];
      if (!f || !onRigRef.current) return;
      e.originalEvent?.stopPropagation?.();
      const p = (f.properties || {}) as Record<string, unknown>;
      const id =
        strProp(p, 'id', 'fclNpdidFacility', 'lokalId', 'lokalid') || 'rig';
      const name =
        strProp(p, 'name', 'fclName') ||
        strProp(p, 'kind', 'fclKind') ||
        `Facility ${id}`;
      const depth = numProp(p, 'waterDepthM', 'fclWaterDepth');
      onRigRef.current({
        id,
        name,
        kind: strProp(p, 'kind', 'fclKind', 'petroleuminnretningtype'),
        phase: strProp(p, 'phase', 'fclPhase'),
        fixedOrMoveable: strProp(p, 'fixedOrMoveable', 'fclFixedOrMoveable'),
        operator: strProp(p, 'operator', 'fclCurrentOperatorName'),
        belongsTo: strProp(p, 'belongsTo', 'fclBelongsToName'),
        functions: strProp(p, 'functions', 'fclFunctions'),
        status: strProp(p, 'status', 'fclStatus'),
        waterDepthM: depth,
        updated: strProp(p, 'updated', 'fclDateUpdated', 'oppdateringsdato'),
        factPageUrl: strProp(p, 'factPageUrl', 'fclFactPageUrl'),
        mmsi: strProp(p, 'mmsi'),
        aisName: strProp(p, 'aisName'),
        aisTimestamp: strProp(p, 'aisTimestamp'),
      });
    };

    const pipelineSelect = (e: any) => {
      const f = e.features?.[0];
      if (!f || !onPipelineRef.current) return;
      e.originalEvent?.stopPropagation?.();
      const p = (f.properties || {}) as Record<string, unknown>;
      const layerId = String(f.layer?.id || '');
      const isUnused = layerId.includes('pipelines-old');
      const id =
        strProp(p, 'id', 'pplNpdidPipeline', 'lokalId', 'lokalid', 'gml_id') ||
        'pipeline';
      const name =
        strProp(p, 'name', 'pplName', 'mapLabel', 'pplMapLabel') ||
        strProp(p, 'type', 'rørledningstype', 'rorledningstype') ||
        `Pipeline ${id}`;
      const chartType = strProp(p, 'chartType', 'type', 'rørledningstype', 'rorledningstype');
      onPipelineRef.current({
        id,
        name,
        medium: strProp(p, 'medium', 'pplMedium') || chartType,
        phase: isUnused
          ? 'not in use'
          : strProp(p, 'phase', 'pplCurrentPhase'),
        operator: strProp(p, 'operator', 'cmpLongName'),
        belongsTo: strProp(p, 'belongsTo', 'pplBelongsToName'),
        fromFacility: strProp(p, 'fromFacility', 'fclNameFrom'),
        toFacility: strProp(p, 'toFacility', 'fclNameTo'),
        dimensionInch: numProp(p, 'dimensionInch', 'pplDimension'),
        waterDepthM: numProp(p, 'waterDepthM', 'pplWaterDepth'),
        updated: strProp(p, 'updated', 'pplDateUpdated', 'oppdateringsdato'),
        factPageUrl: strProp(p, 'factPageUrl', 'pplFactPageUrl'),
        chartType,
        inUse: isUnused
          ? false
          : !(p.inUse === false || p.inUse === 'false'),
        source: isUnused ? 'geonorge' : 'sodir',
      });
    };

    // Each offers its card; the arbiter opens the most specific thing under the click.
    // MapLibre deletes e.features once the handler returns, so the card gets a copy.
    const kept = (e: any) => ({ ...e, features: e.features });
    const cableClick = (e: any) => {
      const f = e.features?.[0];
      if (!f || !onCableRef.current) return;
      const landing = String(f.layer?.id || '').includes('tg-landings');
      const ev = kept(e);
      offerClick(e, landing ? CLICK_PRIORITY.point : CLICK_PRIORITY.cable, () => cableSelect(ev));
    };
    const portClick = (e: any) => {
      if (!e.features?.[0] || !onPortRef.current) return;
      const ev = kept(e);
      offerClick(e, CLICK_PRIORITY.point, () => portSelect(ev));
    };
    const rigClick = (e: any) => {
      if (!e.features?.[0] || !onRigRef.current) return;
      const ev = kept(e);
      offerClick(e, CLICK_PRIORITY.point, () => rigSelect(ev));
    };
    const pipelineClick = (e: any) => {
      const f = e.features?.[0];
      if (!f || !onPipelineRef.current) return;
      const old = String(f.layer?.id || '').includes('pipelines-old');
      const ev = kept(e);
      offerClick(e, old ? CLICK_PRIORITY.oldPipeline : CLICK_PRIORITY.pipeline, () => pipelineSelect(ev));
    };

    const cableLayers = [
      'overlay-cables-hit',
      'overlay-cables-telegeography-hit',
      'overlay-power-cables-hit',
      'overlay-tg-landings-circle',
    ];
    const portLayers = ['overlay-ports-hit', 'overlay-ports-circle'];
    const rigLayers = [
      'overlay-petroleum-points-hit',
      'overlay-petroleum-points-circle',
      `${MOVEABLE_RIG_SOURCE}-hit`,
      `${MOVEABLE_RIG_SOURCE}-circle`,
    ];
    const pipelineLayers = [
      'overlay-pipelines-hit',
      'overlay-pipelines-old-hit',
    ];

    const pointerOn = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const pointerOff = () => {
      map.getCanvas().style.cursor = '';
    };
    // Each layer once: the timer below used to add new hover listeners every two seconds
    const boundLayers = new Set<string>();
    const bindLayerClick = (lid: string, handler: (e: any) => void) => {
      if (boundLayers.has(lid) || !safeGetLayer(map, lid)) return;
      boundLayers.add(lid);
      map.on('click', lid, handler);
      map.on('mouseenter', lid, pointerOn);
      map.on('mouseleave', lid, pointerOff);
    };

    const bindClicks = () => {
      if (!mapStyleReady(map)) return;
      for (const lid of cableLayers) bindLayerClick(lid, cableClick);
      for (const lid of portLayers) bindLayerClick(lid, portClick);
      for (const lid of rigLayers) bindLayerClick(lid, rigClick);
      for (const lid of pipelineLayers) bindLayerClick(lid, pipelineClick);
    };

    start();
    map.once('load', start);
    map.once('idle', () => {
      start();
      bindClicks();
    });
    const bindTimer = setInterval(() => {
      void boot();
      bindClicks();
    }, 2000);
    const rigTimer = setInterval(() => {
      loadMoveableRigs().catch(() => undefined);
    }, 2 * 60_000);

    return () => {
      cancelled = true;
      clearInterval(bindTimer);
      clearInterval(rigTimer);
      map.off('load', start);
      map.off('idle', start);
      const unbind = (lids: string[], handler: (e: any) => void) => {
        for (const lid of lids) {
          map.off('click', lid, handler);
          map.off('mouseenter', lid, pointerOn);
          map.off('mouseleave', lid, pointerOff);
        }
      };
      unbind(cableLayers, cableClick);
      unbind(portLayers, portClick);
      unbind(rigLayers, rigClick);
      unbind(pipelineLayers, pipelineClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, apiBase]);

  // Basemap theme: recolour the DEM relief and fetch Kartverket's tiles in the other colours
  useEffect(() => {
    if (!mapStyleReady(map)) return;
    if (safeGetLayer(map, SEABED_RELIEF_LAYER)) {
      for (const [prop, value] of Object.entries(RELIEF_PAINT[theme])) {
        map.setPaintProperty(SEABED_RELIEF_LAYER, prop, value);
      }
    }
    const kv = map.getSource(KV_RELIEF_SOURCE) as any;
    kv?.setTiles?.([kartverketReliefTiles(theme)]);
    const paint = (id: string, prop: string, value: unknown) => {
      if (safeGetLayer(map, id)) map.setPaintProperty(id, prop, value);
    };
    for (const def of OVERLAYS) {
      const sourceId = `overlay-${def.id}`;
      paint(`${sourceId}-fill`, 'fill-color', fillColorFor(def, theme));
      paint(`${sourceId}-line`, 'line-color', lineColorFor(def, theme));
      paint(`${sourceId}-circle`, 'circle-color', lineColorFor(def, theme));
      paint(`${sourceId}-boundary-line`, 'line-color', lineColorFor(def, theme));
    }
    applyBathymetryPaint(map, theme);
    for (const { key, invertOnDark } of MARITIME_INFRA) {
      for (const [prop, value] of Object.entries(chartInkPaint(invertOnDark, theme))) {
        paint(`overlay-${key}-raster`, prop, value);
      }
    }
    paint('overlay-bathymetry-soundings', 'text-color', BATHY_THEME[theme].sounding);
    paint('overlay-bathymetry-soundings', 'text-halo-color', BATHY_THEME[theme].halo);
    paint('overlay-tg-landings-circle', 'circle-color', LANDING_THEME[theme].circle);
    paint('overlay-tg-landings-label', 'text-color', LANDING_THEME[theme].text);
    paint('overlay-tg-landings-label', 'text-halo-color', LANDING_THEME[theme].halo);
  }, [map, theme]);

  useEffect(() => {
    if (!mapStyleReady(map)) return;
    for (const def of OVERLAYS) {
      loadOverlayData(map, apiBase, def, visibility);
      const sourceId = `overlay-${def.id}`;
      const v = vis(visibility[def.id]);
      for (const suffix of ['fill', 'line', 'circle', 'hit']) {
        const layerId = `${sourceId}-${suffix}`;
        if (safeGetLayer(map, layerId)) {
          map.setLayoutProperty(layerId, 'visibility', v);
        }
      }
      const bLine = `overlay-${def.id}-boundary-line`;
      if (safeGetLayer(map, bLine)) {
        map.setLayoutProperty(bLine, 'visibility', v);
      }
    }
    // Keep ports / oil rigs on the SAR-style zoom curve even if created earlier
    if (safeGetLayer(map, 'overlay-ports-circle')) {
      try {
        map.setPaintProperty('overlay-ports-circle', 'circle-radius', PORT_CIRCLE_RADIUS);
        map.setPaintProperty('overlay-ports-circle', 'circle-stroke-width', PORT_STROKE_WIDTH);
      } catch {
        /* ignore */
      }
    }
    if (safeGetLayer(map, 'overlay-ports-hit')) {
      try {
        map.setPaintProperty('overlay-ports-hit', 'circle-radius', PORT_HIT_RADIUS);
      } catch {
        /* ignore */
      }
    }
    const petroPts = 'overlay-petroleum-points-circle';
    if (safeGetLayer(map, petroPts)) {
      map.setLayoutProperty(petroPts, 'visibility', vis(visibility.petroleum));
      try {
        map.setPaintProperty(petroPts, 'circle-radius', PORT_CIRCLE_RADIUS);
        map.setPaintProperty(petroPts, 'circle-stroke-width', PORT_STROKE_WIDTH);
      } catch {
        /* ignore */
      }
    }
    for (const lid of [`${MOVEABLE_RIG_SOURCE}-circle`, `${MOVEABLE_RIG_SOURCE}-hit`]) {
      if (safeGetLayer(map, lid)) map.setLayoutProperty(lid, 'visibility', vis(visibility.petroleum));
    }
    const petroHit = 'overlay-petroleum-points-hit';
    if (safeGetLayer(map, petroHit)) {
      map.setLayoutProperty(petroHit, 'visibility', vis(visibility.petroleum));
      try {
        map.setPaintProperty(petroHit, 'circle-radius', PORT_HIT_RADIUS);
      } catch {
        /* ignore */
      }
    }
    const tgVis = vis(visibility['cables-telegeography']);
    if (safeGetLayer(map, 'overlay-tg-landings-circle')) {
      map.setLayoutProperty('overlay-tg-landings-circle', 'visibility', tgVis);
    }
    if (safeGetLayer(map, 'overlay-tg-landings-label')) {
      map.setLayoutProperty('overlay-tg-landings-label', 'visibility', tgVis);
    }
    const bathyVis = vis(visibility.bathymetry);
    // Ensure legacy bathymetry layers stay gone even if the map was hot-reloaded
    for (const legacyId of LEGACY_BATHY_LAYERS) {
      if (safeGetLayer(map, legacyId)) {
        try {
          map.removeLayer(legacyId);
        } catch {
          /* ignore */
        }
      }
    }
    for (const lid of BATHY_LAYER_IDS) {
      if (safeGetLayer(map, lid)) {
        map.setLayoutProperty(lid, 'visibility', bathyVis);
      }
    }
    for (const { key } of MARITIME_INFRA) {
      if (safeGetLayer(map, `overlay-${key}-raster`)) {
        map.setLayoutProperty(`overlay-${key}-raster`, 'visibility', vis(visibility[key]));
      }
    }
    for (const lid of SEABED_LAYERS) {
      if (safeGetLayer(map, lid)) map.setLayoutProperty(lid, 'visibility', vis(visibility['seabed-relief']));
    }
    if (visibility.bathymetry) {
      try {
        applyBathymetryPaint(map, themeRef.current);
      } catch {
        /* ignore */
      }
    }
  }, [map, visibility]);

  return null;
}
