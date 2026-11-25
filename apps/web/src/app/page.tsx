'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type {
  OverlayVisibility,
  GfwVisibility,
  VesselFeatureProps,
  GfwEventProps,
  VesselLayerStatus,
  CableFeatureProps,
  PortFeatureProps,
  RigFeatureProps,
  PipelineFeatureProps,
  NavWarningProps,
  AreaAlertRule,
  VesselFilterFlags,
  VesselTrack,
  VesselScrub,
  WatchlistState,
  SpoofReason,
} from '@svalmap/ui';
import {
  AlertPanel,
  VesselSearch,
  WatchlistPanel,
  LiveIncidentsPanel,
  DEFAULT_VESSEL_FILTERS,
  SAR_MATCHED_FLAG_OPTIONS,
  mmsiCategory,
  mmsiFlagCountry,
  countryInfoFromMmsi,
  loadWatchlist,
  saveWatchlist,
  upsertWatchEntry,
  removeWatchEntry,
  setVesselNote,
  exportVesselPack,
  exportGeoJSONSnapshot,
  parseUrlState,
  writeUrlState,
  copyShareUrl,
  mergeVesselFilters,
  vesselFiltersToUrlTokens,
  vesselFiltersFromUrlTokens,
  resolveShipClass,
  vesselPassesFilter,
  VESSEL_FILTER_PRESETS,
  sameFilters,
  type MapTheme,
  isRussianResearchVessel,
  RUSSIAN_RESEARCH_VESSELS,
  BASE_PATH,
  SNAPSHOT_MODE,
  SNAPSHOT_AT,
  loadSnapshotTrack,
} from '@svalmap/ui';
import VesselFilterPanel from './VesselFilterPanel';
import MapMenu, { MENU_ICONS, type MapMenuId, type MapMenuItem } from './MapMenu';
import type { MapView } from './MapViewReporter';
import DarkLeads from './DarkLeads';
import HowToUse from './HowToUse';

/** Copernicus Browser on Sentinel-2 true colour over the current map view (its own default date: latest). */
/** Snapshot list entries by MMSI, read once and shared by every dossier opened */
let snapshotLookups: Promise<Record<string, any>> | null = null;
function loadSnapshotLookups(apiBase: string): Promise<Record<string, any>> {
  snapshotLookups ??= fetch(`${apiBase}/api/sanctions/lookups`)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return snapshotLookups;
}

function copernicusAreaUrl(view: MapView | null): string {
  const params = new URLSearchParams({
    themeId: 'DEFAULT-THEME',
    datasetId: 'S2_L2A_CDAS',
    layerId: '1_TRUE_COLOR',
    cloudCoverage: '30',
  });
  if (view) {
    // Copernicus shows little below z7; zoom out no further than that
    params.set('zoom', String(Math.max(7, Math.min(14, Math.round(view.zoom)))));
    params.set('lat', view.lat.toFixed(5));
    params.set('lng', view.lon.toFixed(5));
  }
  return `https://browser.dataspace.copernicus.eu/?${params}`;
}
import LayerRow, { AreaMarker, DotMarker, LineMarker, RingMarker } from './LayerRow';
import VesselDossier from './VesselDossier';
import VesselTimeline from './VesselTimeline';

const MapCanvas = dynamic(() => import('./MapCanvas'), { ssr: false });

const PREFS_KEY = 'svalmap.layerPrefs.v10';

const DEFAULT_OVERLAYS: OverlayVisibility = {
  'eez-norway': false,
  'eez-janmayen': false,
  'eez-svalbard': false,
  cables: false,
  'cables-telegeography': false,
  pipelines: false,
  'pipelines-old': false,
  'power-cables': false,
  'chart-cables': false,
  'chart-pipelines': false,
  'chart-spans': false,
  petroleum: false,
  bathymetry: false,
  'seabed-relief': false,
  nsm: false,
  skytefelt: false,
  ports: false,
  airports: false,
  'ice-edge': false,
  'gps-interference': false,
  navwarnings: false,
  'navwarnings-30d': false,
};

const DEFAULT_GFW: GfwVisibility = {
  loitering: false,
  encounters: false,
  aisoff: false,
  port: false,
  sarUnmatched: false,
  sarMatched: false,
  sarMatchedFlags: [],
  viirs: false,
};

const GFW_HEADER_COLORS: Record<string, string> = {
  loitering: '#f6a21a',
  encounter: '#ff3b30',
  ais_off: '#a855f7',
  port_visit: '#22c55e',
  sar: '#f59e0b',
  sar_matched: '#4ade80',
  viirs: '#c9a000',
};

type DetailSelection =
  | { kind: 'vessel'; vessel: VesselFeatureProps }
  | { kind: 'gfw'; event: GfwEventProps }
  | { kind: 'cable'; cable: CableFeatureProps }
  | { kind: 'port'; port: PortFeatureProps }
  | { kind: 'rig'; rig: RigFeatureProps }
  | { kind: 'pipeline'; pipeline: PipelineFeatureProps }
  | { kind: 'navwarning'; warning: NavWarningProps };

/** Maritime convention: show warning times in UTC. */
function formatUtc(iso: string | null | undefined) {
  if (!iso) return 'Not available';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatWhen(iso: string | null | undefined) {
  if (!iso) return 'Not available';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function HomePage() {
  const [menuOpen, setMenuOpen] = useState<MapMenuId | null>(null);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [selection, setSelection] = useState<DetailSelection | null>(null);
  const [shipsVisible, setShipsVisible] = useState(true);
  const [overlays, setOverlays] = useState<OverlayVisibility>(DEFAULT_OVERLAYS);
  const [gfw, setGfw] = useState<GfwVisibility>(DEFAULT_GFW);
  const [prefsReady, setPrefsReady] = useState(false);
  const [aisStatus, setAisStatus] = useState<VesselLayerStatus>({
    vesselCount: 0,
    lastUpdate: null,
    error: null,
    trackStatus: 'idle',
    trackError: null,
  });
  const [alertDraft, setAlertDraft] = useState<{ mmsi: string; name: string } | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [drawingAoi, setDrawingAoi] = useState(false);
  const [draftRing, setDraftRing] = useState<number[][]>([]);
  const [alertRules, setAlertRules] = useState<AreaAlertRule[]>([]);
  const [alertsExpanded, setAlertsExpanded] = useState(false);
  const [vesselFilters, setVesselFilters] = useState<VesselFilterFlags>(DEFAULT_VESSEL_FILTERS);
  const [trackDays, setTrackDays] = useState(1);
  /** The ship the dossier was last opened for; a different one starts on 24 h again */
  const openedMmsiRef = useRef<string | null>(null);
  const [track, setTrack] = useState<VesselTrack | null>(null);
  const [scrub, setScrub] = useState<VesselScrub | null>(null);
  const [navData, setNavData] = useState<{ onMap: number; notices: NavWarningProps[] } | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistState>({ entries: [], notes: {} });
  const [liveVessels, setLiveVessels] = useState<VesselFeatureProps[]>([]);
  const [showIncidents, setShowIncidents] = useState(false);
  const [healthMeta, setHealthMeta] = useState<any>(null);
  const [sanctionsInfo, setSanctionsInfo] = useState<any>(null);
  const [gfwLastSeen, setGfwLastSeen] = useState<any>(null);
  const [shareHint, setShareHint] = useState<string | null>(null);
  // Light / dark map; layout.tsx sets data-theme before first paint from the same key
  const [theme, setTheme] = useState<MapTheme>('dark');
  // Full screen where the browser allows it; iPhone Safari only allows it for video,
  // so there the button stays hidden and "Add to Home Screen" gives the full-screen app
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    setCanFullscreen(Boolean(document.fullscreenEnabled));
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  /** Where the map is — for "satellite images of this area" */
  const [mapView, setMapView] = useState<MapView | null>(null);
  const [pendingMmsi, setPendingMmsi] = useState<string | null>(null);

  const mapStyle =
    process.env.NEXT_PUBLIC_MAP_STYLE || `${BASE_PATH}/styles/svalmap-dark.json`;
  const attribution =
    process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ||
    // Default set in next.config.js; the basemap credit (OpenFreeMap · OpenMapTiles ·
    // OpenStreetMap) comes from the style source
    '';
  const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_KEY || '';
  // If style URL is MapTiler without ?key=, append it
  const mapStyleWithKey =
    maptilerKey &&
    mapStyle.includes('api.maptiler.com') &&
    !/[?&]key=/.test(mapStyle)
      ? `${mapStyle}${mapStyle.includes('?') ? '&' : '?'}key=${maptilerKey}`
      : mapStyle;
  const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8787';

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.overlays) {
          const legacyPet = p.overlays.petroleum === true;
          const hasSplit =
            typeof p.overlays.pipelines === 'boolean' ||
            typeof p.overlays['pipelines-old'] === 'boolean';
          setOverlays({
            ...DEFAULT_OVERLAYS,
            ...p.overlays,
            // v4 combined "Pipelines & oil rigs" → split toggles
            pipelines: hasSplit
              ? Boolean(p.overlays.pipelines)
              : legacyPet,
            petroleum: Boolean(p.overlays.petroleum),
            'pipelines-old': Boolean(p.overlays['pipelines-old']),
            // "Bathymetry" used to be relief + contours in one toggle
            'seabed-relief':
              typeof p.overlays['seabed-relief'] === 'boolean'
                ? p.overlays['seabed-relief']
                : Boolean(p.overlays.bathymetry),
            airports: false,
            // Always start with nav warnings off (enable in session as needed)
            navwarnings: false,
            'navwarnings-30d': false,
          });
        }
        if (p.gfw) {
          const legacySar = (p.gfw as { sar?: boolean }).sar;
          const rawFlags = (p.gfw as { sarMatchedFlags?: unknown }).sarMatchedFlags;
          setGfw({
            ...DEFAULT_GFW,
            ...p.gfw,
            viirs: false,
            aisoff: Boolean(p.gfw.aisoff),
            sarUnmatched:
              typeof p.gfw.sarUnmatched === 'boolean'
                ? p.gfw.sarUnmatched
                : Boolean(legacySar),
            sarMatched:
              typeof p.gfw.sarMatched === 'boolean'
                ? p.gfw.sarMatched
                : Boolean(legacySar),
            sarMatchedFlags: Array.isArray(rawFlags)
              ? rawFlags
                  .map((f) => String(f || '').trim().toUpperCase())
                  .filter((f) => /^[A-Z]{3}$/.test(f))
              : [],
          });
        }
        if (typeof p.shipsVisible === 'boolean') setShipsVisible(p.shipsVisible);
        if (p.vesselFilters) setVesselFilters(mergeVesselFilters(p.vesselFilters));
        if (typeof p.trackDays === 'number') setTrackDays(Math.max(1, Math.min(14, p.trackDays)));
        if (typeof p.showIncidents === 'boolean') setShowIncidents(p.showIncidents);
      }
      setWatchlist(loadWatchlist());
      setLegendOpen(false);
      const url = parseUrlState();
      if (url.mmsi) {
        setPendingMmsi(url.mmsi);
        // A shared link keeps its own track range when the ship opens
        openedMmsiRef.current = url.mmsi;
      }
      if (typeof url.ships === 'boolean') setShipsVisible(url.ships);
      if (url.trackDays) setTrackDays(url.trackDays);
      // A link's filters win over saved ones, first visit included, so a shared
      // ?filter= link opens as it was sent: with the ships showing, even for a
      // visitor who last turned them off (unless the link itself says ships=0)
      if (url.filters?.length) {
        setVesselFilters(vesselFiltersFromUrlTokens(url.filters));
        if (url.ships !== false) setShipsVisible(true);
      }
      if (url.navActive) {
        setOverlays((o) => ({ ...o, navwarnings: true }));
      }
      if (url.nav30d) {
        setOverlays((o) => ({ ...o, 'navwarnings-30d': true }));
      }
    } catch {
      /* ignore */
    }
    setPrefsReady(true);
  }, []);

  useEffect(() => {
    if (!prefsReady) return;
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          overlays,
          gfw,
          shipsVisible,
          vesselFilters,
          trackDays,
          showIncidents,
        })
      );
    } catch {
      /* ignore */
    }
  }, [overlays, gfw, shipsVisible, vesselFilters, trackDays, showIncidents, prefsReady]);

  useEffect(() => {
    try {
      if (localStorage.getItem('svalmap.theme') === 'light') setTheme('light');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!prefsReady) return;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('svalmap.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme, prefsReady]);

  useEffect(() => {
    // Until the stored list is loaded, `watchlist` is the empty initial state; saving it would
    // wipe the list (React runs mount effects twice in dev, so the reload then reads it empty)
    if (!prefsReady) return;
    saveWatchlist(watchlist);
  }, [watchlist, prefsReady]);

  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        const r = await fetch(`${apiBase}/api/health`, { cache: 'no-store' });
        if (!cancelled) {
          setApiOk(r.ok);
          if (r.ok) {
            const j = await r.json();
            setHealthMeta(j);
          }
        }
      } catch {
        if (!cancelled) setApiOk(false);
      }
    };
    ping();
    const t = setInterval(ping, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [apiBase]);

  const setOverlay = (key: keyof OverlayVisibility, on: boolean) => {
    setOverlays((prev) => ({ ...prev, [key]: on }));
  };
  const setGfwFlag = (
    key: Exclude<keyof GfwVisibility, 'sarMatchedFlags'>,
    on: boolean
  ) => {
    setGfw((prev) => ({ ...prev, [key]: on }));
  };

  const toggleSarMatchedFlag = (code: string) => {
    const c = code.toUpperCase();
    setGfw((prev) => {
      const cur = new Set(prev.sarMatchedFlags || []);
      if (cur.has(c)) cur.delete(c);
      else cur.add(c);
      return { ...prev, sarMatchedFlags: [...cur] };
    });
  };

  const closeDetail = useCallback(() => {
    openedMmsiRef.current = null;
    setDetailDrawerOpen(false);
    setSelection(null);
    setPendingMmsi(null);
    setSanctionsInfo(null);
  }, []);

  const openGfwEvent = (event: GfwEventProps) => {
    setSelection({ kind: 'gfw', event });
    setDetailDrawerOpen(true);
    setAlertsExpanded(false);
  };
  const openCable = (cable: CableFeatureProps) => {
    setSelection({ kind: 'cable', cable });
    setDetailDrawerOpen(true);
    setAlertsExpanded(false);
  };
  const openPort = (port: PortFeatureProps) => {
    setSelection({ kind: 'port', port });
    setDetailDrawerOpen(true);
    setAlertsExpanded(false);
  };
  const openRig = (rig: RigFeatureProps) => {
    setSelection({ kind: 'rig', rig });
    setDetailDrawerOpen(true);
    setAlertsExpanded(false);
  };
  const openPipeline = (pipeline: PipelineFeatureProps) => {
    setSelection({ kind: 'pipeline', pipeline });
    setDetailDrawerOpen(true);
    setAlertsExpanded(false);
  };
  const openNavWarning = (warning: NavWarningProps) => {
    setSelection({ kind: 'navwarning', warning });
    setDetailDrawerOpen(true);
    setAlertsExpanded(false);
  };

  // Each ship you open starts on the last 24 h; a longer range only sticks while you stay on it
  const startOnLastDay = useCallback((mmsi: string) => {
    if (openedMmsiRef.current !== mmsi) setTrackDays(1);
    openedMmsiRef.current = mmsi;
  }, []);

  const openVessel = useCallback((vessel: VesselFeatureProps) => {
    startOnLastDay(vessel.mmsi);
    setSelection({ kind: 'vessel', vessel });
    setDetailDrawerOpen(true);
    setAlertsExpanded(false);
    setPendingMmsi(null);
  }, [startOnLastDay]);

  /**
   * Open a vessel by MMSI from anywhere (search, watchlist, GFW, incidents).
   * Uses the live record when present; otherwise shows a stub that upgrades
   * itself once the vessel shows up in the live feed.
   */
  const openVesselByMmsi = useCallback(
    (
      mmsi: string,
      opts?: {
        name?: string | null;
        imo?: string | null;
        shipType?: string | null;
        russian?: boolean;
        sanctioned?: boolean;
        shadowfleet?: boolean;
        sanctionedMaster?: boolean;
        /** Spoofing evidence from the server (search hits) */
        spoofing?: SpoofReason[] | null;
        military?: boolean;
        research?: boolean;
        lon?: number;
        lat?: number;
        /** Latest fix when the caller has one (search hits outside the map's coverage) */
        speed?: number | null;
        course?: number | null;
        heading?: number | null;
        status?: string | number | null;
        destination?: string | null;
        eta?: string | null;
        timestamp?: string | null;
      }
    ) => {
      const id = String(mmsi || '').replace(/\D/g, '').padStart(9, '0').slice(-9);
      if (!id || id === '000000000') return;
      setShipsVisible(true);
      const hit = liveVessels.find((v) => v.mmsi === id);
      if (hit) {
        openVessel(hit);
        return;
      }
      const country = countryInfoFromMmsi(id);
      const name = (opts?.name && opts.name.trim()) || `MMSI ${id}`;
      const imo = opts?.imo || null;
      const shipType = opts?.shipType || null;
      const category = opts?.research
        ? 'research'
        : mmsiCategory(id, shipType, imo, opts?.military);
      // Keep pending so the stub upgrades when the vessel appears live
      startOnLastDay(id);
      setPendingMmsi(id);
      setSelection({
        kind: 'vessel',
        vessel: {
          mmsi: id,
          name,
          label: name,
          category: opts?.russian && category === 'rest' ? 'russia' : category,
          flagCountry: mmsiFlagCountry(id),
          shipClass: resolveShipClass(shipType),
          speed: opts?.speed ?? null,
          imo,
          course: opts?.course ?? null,
          heading: opts?.heading != null && opts.heading !== 511 ? opts.heading : null,
          destination: opts?.destination || null,
          shipType,
          status: opts?.status ?? null,
          eta: opts?.eta || null,
          timestamp: opts?.timestamp || null,
          source: null,
          sanctioned: opts?.sanctioned ? 1 : 0,
          shadowfleet: opts?.shadowfleet ? 1 : 0,
          sanctionedMaster: opts?.sanctionedMaster ? 1 : 0,
          spoofing: opts?.spoofing?.length ? 1 : 0,
          spoofingWhy: opts?.spoofing?.length ? JSON.stringify(opts.spoofing) : null,
          lastSeenOnly: 0,
          military: category === 'military' ? 1 : 0,
          research: category === 'research' ? 1 : 0,
          country: country.name,
          flag: country.iso,
          lon: Number.isFinite(opts?.lon) ? (opts!.lon as number) : null,
          lat: Number.isFinite(opts?.lat) ? (opts!.lat as number) : null,
        },
      });
      setDetailDrawerOpen(true);
      setAlertsExpanded(false);
    },
    [liveVessels, openVessel, startOnLastDay]
  );

  const selectedMmsi =
    selection?.kind === 'vessel' ? selection.vessel.mmsi : pendingMmsi;
  const selVessel = selection?.kind === 'vessel' ? selection.vessel : null;
  const selectedFallback = useMemo(
    () =>
      selVessel
        ? {
            mmsi: selVessel.mmsi,
            label: selVessel.name || selVessel.label,
            lon: selVessel.lon,
            lat: selVessel.lat,
          }
        : null,
    [selVessel?.mmsi, selVessel?.name, selVessel?.label, selVessel?.lon, selVessel?.lat]
  );

  useEffect(() => {
    if (!prefsReady) return;
    writeUrlState({
      mmsi: selectedMmsi,
      ships: shipsVisible,
      trackDays,
      filters: vesselFiltersToUrlTokens(vesselFilters),
      navActive: overlays.navwarnings,
      nav30d: overlays['navwarnings-30d'],
    });
  }, [
    prefsReady,
    selectedMmsi,
    shipsVisible,
    trackDays,
    vesselFilters,
    overlays.navwarnings,
    overlays['navwarnings-30d'],
  ]);

  // Resolve / upgrade deep-linked or GFW-handoff MMSI once live vessels arrive
  useEffect(() => {
    if (!pendingMmsi) return;
    const hit = liveVessels.find((v) => v.mmsi === pendingMmsi);
    if (hit) {
      openVessel(hit);
      return;
    }
    // A research ship may stay unheard for weeks, so its link opens the dossier without waiting
    if (selection || !liveVessels.length) return;
    const research = RUSSIAN_RESEARCH_VESSELS.find((v) => v.mmsi === pendingMmsi);
    if (research) openVesselByMmsi(research.mmsi, { name: research.name, imo: research.imo, research: true });
  }, [pendingMmsi, liveVessels, openVessel, openVesselByMmsi, selection]);

  // Keep the open detail card in step with the 2-minute live refresh
  useEffect(() => {
    setSelection((prev) => {
      if (prev?.kind !== 'vessel') return prev;
      const hit = liveVessels.find((v) => v.mmsi === prev.vessel.mmsi);
      return hit && hit !== prev.vessel ? { kind: 'vessel', vessel: hit } : prev;
    });
  }, [liveVessels]);

  // Timeline marker, kept clear of the chrome, the layers panel, the dossier and the timeline
  const mapScrub = useMemo(
    () =>
      selVessel && scrub
        ? {
            ...scrub,
            padding: {
              top: 56,
              right: detailDrawerOpen ? 380 : 0,
              bottom: 146,
              left: 0,
            },
          }
        : null,
    [selVessel, scrub, detailDrawerOpen]
  );

  // A clicked warning opens the detail card on the right; fit its shape beside it
  const warningPadding = useMemo(() => ({ top: 56, right: 380, bottom: 40, left: 0 }), []);

  const dossierMmsi = selection?.kind === 'vessel' ? selection.vessel.mmsi : null;
  const dossierImo = selection?.kind === 'vessel' ? selection.vessel.imo : null;

  // Sanctions dossier for selected vessel
  useEffect(() => {
    // Clear first so the previous vessel's "Yes (list hit)" never shows on the new one
    setSanctionsInfo(null);
    if (!dossierMmsi && !dossierImo) return;
    let cancelled = false;
    (async () => {
      try {
        if (SNAPSHOT_MODE) {
          // The snapshot carries the entries of every flagged ship (writeSiteSnapshot.ts)
          const all = await loadSnapshotLookups(apiBase);
          if (!cancelled) setSanctionsInfo((dossierMmsi && all[dossierMmsi]) || null);
          return;
        }
        const q = new URLSearchParams();
        if (dossierMmsi) q.set('mmsi', dossierMmsi);
        if (dossierImo) q.set('imo', dossierImo);
        const r = await fetch(`${apiBase}/api/sanctions/lookup?${q}`, { cache: 'no-store' });
        const j = await r.json();
        if (!cancelled) setSanctionsInfo(j);
      } catch {
        if (!cancelled) setSanctionsInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dossierMmsi, dossierImo, apiBase]);

  // Fallback "last seen" from Global Fishing Watch for research ships
  useEffect(() => {
    setGfwLastSeen(null);
    if (SNAPSHOT_MODE || !dossierMmsi || !isRussianResearchVessel(dossierMmsi)) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${apiBase}/api/gfw/vessel-last-seen?mmsi=${dossierMmsi}`, { cache: 'no-store' });
        const j = await r.json();
        if (!cancelled) setGfwLastSeen(j);
      } catch {
        if (!cancelled) setGfwLastSeen({ error: 'unreachable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dossierMmsi, apiBase]);

  const anyGfw =
    gfw.loitering ||
      gfw.encounters ||
      gfw.aisoff ||
      gfw.port ||
      gfw.sarUnmatched ||
      gfw.sarMatched;

  const watchlistMmsis = useMemo(
    () => new Set(watchlist.entries.map((e) => String(e.mmsi))),
    [watchlist.entries]
  );

  const statusLabel = useMemo(() => {
    if (aisStatus.error) return 'AIS error';
    if (aisStatus.lastUpdate) {
      const count = `${aisStatus.vesselCount} ${aisStatus.vesselCount === 1 ? 'vessel' : 'vessels'}`;
      if (SNAPSHOT_AT) {
        // No year: the snapshot is at most hours old, and the short form keeps the phone header on one line
        const at = new Date(SNAPSHOT_AT).toLocaleString([], {
          day: 'numeric',
          month: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        return `${count} · snapshot ${at}`;
      }
      return `${count} · ${new Date(aisStatus.lastUpdate).toLocaleTimeString()}`;
    }
    return 'Loading ships…';
  }, [aisStatus]);

  const freshnessHint = useMemo(() => {
    if (SNAPSHOT_MODE) return 'Reload the page for newer data';
    const parts: string[] = [];
    if (healthMeta?.sanctions?.cacheAgeMs != null) {
      const h = Math.round(healthMeta.sanctions.cacheAgeMs / 3600000);
      parts.push(`sanctions ~${h}h`);
    }
    if (healthMeta?.aisstream?.connected != null) {
      parts.push(healthMeta.aisstream.connected ? 'AISStream up' : 'AISStream down');
    }
    return parts.join(' · ');
  }, [healthMeta]);

  // Badges: what each group is doing right now, readable without opening it
  const shipsPreset = VESSEL_FILTER_PRESETS.find((p) => sameFilters(vesselFilters, p.filters));
  const PRESET_BADGE: Record<string, string> = { interest: 'Interest', sanctions: 'Sanctions', watchlist: 'Watchlist' };
  const activeCount = (flags: unknown[]) => flags.filter(Boolean).length;
  const navOn = overlays.navwarnings || overlays['navwarnings-30d'];
  const menuItems: MapMenuItem[] = [
    {
      id: 'ships',
      label: 'Ships',
      icon: MENU_ICONS.ships,
      badge: !shipsVisible ? 'Off' : shipsPreset ? PRESET_BADGE[shipsPreset.id] || null : 'Filtered',
      tone: 'accent',
      title: 'Ships',
      lede: 'What the map shows, and why.',
      content: (
        <>
            <LayerRow
              label="Live ships"
              sub="AISStream, BarentsWatch, Digitraffic · every 2 min"
              count={liveVessels.length || null}
              checked={shipsVisible}
              onChange={setShipsVisible}
            />
            <VesselFilterPanel
              filters={vesselFilters}
              onChange={setVesselFilters}
              vessels={liveVessels}
              watchlistMmsis={watchlistMmsis}
            />

            <WatchlistPanel
              state={watchlist}
              onOpen={(mmsi) => {
                const entry = watchlist.entries.find((e) => e.mmsi === mmsi);
                openVesselByMmsi(mmsi, { name: entry?.name, imo: entry?.imo });
              }}
              onRemove={(mmsi) => setWatchlist((s) => removeWatchEntry(s, mmsi))}
            />

            <button
              type="button"
              className="panel-link"
              onClick={() =>
                exportGeoJSONSnapshot({
                  vessels: liveVessels
                    .filter((v) => vesselPassesFilter(v, vesselFilters, { watchlistMmsis }))
                    .map((v) => ({
                    type: 'Feature',
                    geometry: {
                      type: 'Point',
                      coordinates: [v.lon ?? 0, v.lat ?? 0],
                    },
                    properties: v,
                  })),
                  label: 'visible vessels snapshot',
                })
              }
            >
              Export visible ships (GeoJSON)
            </button>

            <button
              type="button"
              className={`disclaimer-toggle ${coverageOpen ? 'open' : ''}`}
              onClick={() => setCoverageOpen((v) => !v)}
              aria-expanded={coverageOpen}
            >
              Data coverage
            </button>
            {coverageOpen && (
              <div className="disclaimer">
                Inside Norway EEZ, Jan Mayen EEZ, and the Svalbard Fisheries Protection Zone: all
                registered vessels except fishing under 15&nbsp;m and recreational under 45&nbsp;m
                (when length is known). Elsewhere in the North Atlantic north of 54°N and in the
                Baltic: Russian vessels, curated research vessels, shadow fleet, sanctioned vessels,
                and military / law enforcement. Live AIS via AISStream, BarentsWatch and Digitraffic (Finnish coastal
                stations: Gulf of Finland, Gulf of Bothnia). Fishing-gear
                buoys and other AIS beacons are hidden by default (Ship filters → Ship type).
              </div>
            )}
        </>
      ),
    },
    {
      id: 'activity',
      label: 'Activity',
      icon: MENU_ICONS.activity,
      badge: activeCount([showIncidents, gfw.aisoff, gfw.loitering, gfw.encounters, gfw.port, gfw.sarUnmatched, gfw.sarMatched]),
      title: 'Activity',
      lede: 'Behaviour worth a second look.',
      content: (
        <>
            <LayerRow
              label="Stopped, meeting or over cables"
              sub="Live AIS · ships of interest; any ship lingering over cables or pipelines"
              marker={<RingMarker color="#F0704A" />}
              checked={showIncidents}
              onChange={setShowIncidents}
            />
            <LiveIncidentsPanel
              apiBase={apiBase}
              enabled={showIncidents}
              onFocus={(inc) => openVesselByMmsi(inc.mmsi[0])}
            />
            <LayerRow
              label="AIS gaps"
              sub="Global Fishing Watch · 30 days"
              marker={<DotMarker color={GFW_HEADER_COLORS.ais_off} />}
              checked={gfw.aisoff}
              onChange={(on) => setGfwFlag('aisoff', on)}
            />
            <LayerRow
              label="Loitering"
              sub="Global Fishing Watch · 30 days"
              marker={<DotMarker color={GFW_HEADER_COLORS.loitering} />}
              checked={gfw.loitering}
              onChange={(on) => setGfwFlag('loitering', on)}
            />
            <LayerRow
              label="Encounters"
              sub="Global Fishing Watch · 30 days"
              marker={<DotMarker color={GFW_HEADER_COLORS.encounter} />}
              checked={gfw.encounters}
              onChange={(on) => setGfwFlag('encounters', on)}
            />
            <LayerRow
              label="Port visits"
              sub="Global Fishing Watch · 30 days"
              marker={<DotMarker color={GFW_HEADER_COLORS.port_visit} stroke="#fff" />}
              checked={gfw.port}
              onChange={(on) => setGfwFlag('port', on)}
            />
            <LayerRow
              label="Dark vessels (SAR)"
              sub="Radar, no AIS match · lags ~5 days"
              marker={<DotMarker color={GFW_HEADER_COLORS.sar} />}
              checked={gfw.sarUnmatched}
              onChange={(on) => setGfwFlag('sarUnmatched', on)}
            />
            <LayerRow
              label="Radar matched to AIS"
              sub="SAR with AIS match · lags ~5 days"
              marker={<DotMarker color={GFW_HEADER_COLORS.sar_matched} />}
              checked={gfw.sarMatched}
              onChange={(on) => setGfwFlag('sarMatched', on)}
            />
            {gfw.sarMatched && (
              <div className="flag-filter" role="group" aria-label="Flags of radar-matched vessels">
                <div className="panel-kicker flag-filter-head">
                  <span>
                    Flag ·{' '}
                    {gfw.sarMatchedFlags.length === 0
                      ? 'all countries'
                      : `${gfw.sarMatchedFlags.length} of ${SAR_MATCHED_FLAG_OPTIONS.length}`}
                  </span>
                  {gfw.sarMatchedFlags.length > 0 && (
                    <button
                      type="button"
                      className="flag-filter-clear"
                      onClick={() => setGfw((prev) => ({ ...prev, sarMatchedFlags: [] }))}
                    >
                      Show all
                    </button>
                  )}
                </div>
                <div className="flag-filter-list">
                  {SAR_MATCHED_FLAG_OPTIONS.map((opt) => {
                    const on = gfw.sarMatchedFlags.includes(opt.code);
                    return (
                      <label key={opt.code} className={`flag-option ${on ? 'on' : ''}`} title={opt.code}>
                        <input type="checkbox" checked={on} onChange={() => toggleSarMatchedFlag(opt.code)} />
                        {/* Tick first, so in two columns it never reads as the next country's */}
                        <svg className="flag-option-tick" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                        <img src={`${BASE_PATH}/flag-icons/${opt.iso2}.svg`} alt="" width={16} height={11} />
                        <span>{opt.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <p className="panel-note">
              Fishing Watch events cover Russian, sanctioned and shadow-fleet vessels; radar covers
              the Norwegian zones.
            </p>
        </>
      ),
    },
    {
      id: 'sea',
      label: 'Sea & seabed',
      icon: MENU_ICONS.sea,
      badge: activeCount([
        overlays['seabed-relief'],
        overlays.bathymetry,
        overlays['eez-svalbard'],
        overlays['eez-norway'],
        overlays['eez-janmayen'],
        overlays['ice-edge'],
      ]),
      title: 'Sea & seabed',
      content: (
        <>
            <LayerRow
              label="Seabed relief"
              sub="Kartverket 50–5 m · AWS terrain elsewhere"
              checked={overlays['seabed-relief']}
              onChange={(on) => setOverlay('seabed-relief', on)}
            />
            <LayerRow
              label="Depth contours"
              sub="Open Waters · Kartverket near the coast"
              marker={<LineMarker color="#4F7383" />}
              checked={overlays.bathymetry}
              onChange={(on) => setOverlay('bathymetry', on)}
            />
            <LayerRow
              label="Svalbard FPZ"
              marker={<LineMarker color="#4ade80" dashed />}
              checked={overlays['eez-svalbard']}
              onChange={(on) => setOverlay('eez-svalbard', on)}
            />
            <LayerRow
              label="Norway EEZ"
              marker={<LineMarker color="#38bdf8" dashed />}
              checked={overlays['eez-norway']}
              onChange={(on) => setOverlay('eez-norway', on)}
            />
            <LayerRow
              label="Jan Mayen EEZ"
              marker={<LineMarker color="#c4b5fd" dashed />}
              checked={overlays['eez-janmayen']}
              onChange={(on) => setOverlay('eez-janmayen', on)}
            />
            <LayerRow
              label="Ice edge"
              sub="Copernicus Marine · daily"
              marker={<LineMarker color="#7dd3fc" />}
              checked={overlays['ice-edge']}
              onChange={(on) => setOverlay('ice-edge', on)}
            />
            <a
              className="panel-link"
              href={copernicusAreaUrl(mapView)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Satellite images of this area (Copernicus) ↗
            </a>
            <p className="panel-note">
              Opens Sentinel-2 where the map is now, most recent images first. In the polar night
              or under cloud, switch to Sentinel-1 radar there.
            </p>
        </>
      ),
    },
    {
      id: 'infra',
      label: 'Infrastructure',
      icon: MENU_ICONS.infra,
      badge: activeCount([
        overlays.cables,
        overlays['cables-telegeography'],
        overlays.pipelines,
        overlays['pipelines-old'],
        overlays['power-cables'],
        overlays.petroleum,
        overlays.ports,
        overlays['chart-cables'],
        overlays['chart-pipelines'],
        overlays['chart-spans'],
      ]),
      title: 'Infrastructure',
      content: (
        <>
            <LayerRow
              label="Subsea cables"
              sub="Nkom"
              marker={<LineMarker color="#22d3ee" />}
              checked={overlays.cables}
              onChange={(on) => setOverlay('cables', on)}
            />
            <LayerRow
              label="Named cables"
              sub="TeleGeography"
              marker={<LineMarker color="#f472b6" />}
              checked={overlays['cables-telegeography']}
              onChange={(on) => setOverlay('cables-telegeography', on)}
            />
            <LayerRow
              label="Power cables"
              sub="NVE · high voltage in the sea, with owner"
              marker={<LineMarker color="#a3e635" />}
              checked={overlays['power-cables']}
              onChange={(on) => setOverlay('power-cables', on)}
            />
            <LayerRow
              label="Pipelines"
              sub="Sodir · in use"
              marker={<LineMarker color="#fbbf24" />}
              checked={overlays.pipelines}
              onChange={(on) => setOverlay('pipelines', on)}
            />
            <LayerRow
              label="Old pipelines"
              sub="GeoNorge · not in use"
              marker={<LineMarker color="#a8a29e" dashed />}
              checked={overlays['pipelines-old']}
              onChange={(on) => setOverlay('pipelines-old', on)}
            />
            <LayerRow
              label="Platforms & rigs"
              sub="Sodir · rigs placed by AIS"
              marker={<DotMarker color="#f97316" />}
              checked={overlays.petroleum}
              onChange={(on) => setOverlay('petroleum', on)}
            />
            <LayerRow
              label="Ports"
              marker={<DotMarker color="#94a3b8" />}
              checked={overlays.ports}
              onChange={(on) => setOverlay('ports', on)}
            />
            <div className="panel-kicker">From the sea charts · zoom in to see them</div>
            <LayerRow
              label="Cables"
              sub="Kartverket · from zoom 12"
              marker={<LineMarker color="#9ca3af" />}
              checked={overlays['chart-cables']}
              onChange={(on) => setOverlay('chart-cables', on)}
            />
            <LayerRow
              label="Pipelines"
              sub="Kartverket · from zoom 8"
              marker={<LineMarker color="#f43f5e" />}
              checked={overlays['chart-pipelines']}
              onChange={(on) => setOverlay('chart-pipelines', on)}
            />
            <LayerRow
              label="Overhead spans & bridges"
              sub="Kartverket · with sailing clearance"
              marker={<LineMarker color="#cbd5e1" dashed />}
              checked={overlays['chart-spans']}
              onChange={(on) => setOverlay('chart-spans', on)}
            />
        </>
      ),
    },
    {
      id: 'warnings',
      label: 'Warnings',
      icon: MENU_ICONS.warnings,
      // In force right now when navigation warnings are on; otherwise how many layers are on
      badge:
        navOn && navData
          ? navData.onMap + navData.notices.length
          : activeCount([overlays.nsm, overlays.skytefelt, overlays['gps-interference']]),
      tone: navOn && navData ? 'alert' : undefined,
      title: 'Restrictions & warnings',
      content: (
        <>
            <LayerRow
              label="NSM restrictions"
              checked={overlays.nsm}
              onChange={(on) => setOverlay('nsm', on)}
            />
            <LayerRow
              label="Firing ranges"
              checked={overlays.skytefelt}
              onChange={(on) => setOverlay('skytefelt', on)}
            />
            <LayerRow
              label="Navigation warnings"
              sub="Kystverket · NAVAREA XIX and coastal, in force"
              marker={<DotMarker color="#ef4444" />}
              count={navData ? navData.onMap + navData.notices.length : null}
              checked={overlays.navwarnings || overlays['navwarnings-30d']}
              onChange={(on) =>
                setOverlays((o) => ({ ...o, navwarnings: on, 'navwarnings-30d': false }))
              }
            />
            <LayerRow
              label="GPS interference"
              sub="GPSJam · aircraft with poor GPS, last full day"
              marker={<AreaMarker color="#c026d3" />}
              checked={overlays['gps-interference']}
              onChange={(on) => setOverlay('gps-interference', on)}
            />
            {(overlays.navwarnings || overlays['navwarnings-30d']) && !!navData?.notices.length && (
              <div className="nav-notices">
                <div className="panel-kicker">Not on the map · {navData.notices.length}</div>
                {navData.notices.map((n) => (
                  <button
                    key={`${n.kind}-${n.eventid}`}
                    type="button"
                    className="nav-notice"
                    onClick={() => openNavWarning(n)}
                  >
                    <span className="nav-notice-title">{n.title}</span>
                    <span className="nav-notice-text">
                      {(n.message || '').replace(/^NAVAREA XIX \S+\s*/i, '').split('\n').find((l) => l.trim()) ||
                        'No text'}
                    </span>
                  </button>
                ))}
              </div>
            )}
        </>
      ),
    },
    {
      id: 'guide',
      label: 'How to use',
      icon: MENU_ICONS.guide,
      title: 'How to use NorthWatch',
      content: <HowToUse />,
    },
  ];

  return (
    <div
      className={`relative w-full h-screen overflow-hidden ${selVessel ? 'has-timeline' : ''} ${
        detailDrawerOpen ? 'detail-open' : ''
      }`}
    >
      <header className="app-chrome" aria-label="NorthWatch status">
        <div className="brand">NorthWatch</div>
        {!SNAPSHOT_MODE && (
          <VesselSearch
            apiBase={apiBase}
            onSelect={(hit) =>
              openVesselByMmsi(hit.mmsi, {
                name: hit.vessel_name || hit.name,
                imo: hit.imo,
                shipType: hit.shipType,
                sanctioned: hit.sanctioned,
                shadowfleet: hit.shadowfleet,
                sanctionedMaster: hit.sanctionedMaster,
                spoofing: hit.spoofing,
                military: hit.military,
                research: hit.research,
                lon: hit.lon,
                lat: hit.lat,
                speed: hit.speed,
                course: hit.course,
                heading: hit.heading,
                status: hit.status,
                destination: hit.destination,
                eta: hit.eta,
                timestamp: hit.timestamp,
              })
            }
            onOpenMmsi={(mmsi) => openVesselByMmsi(mmsi)}
          />
        )}
        <MapMenu items={menuItems} open={menuOpen} onOpenChange={setMenuOpen} />
        <div className="chrome-meta">
          <span
            className={`status-dot ${apiOk === false ? 'bad' : apiOk ? 'ok' : ''}`}
            title={apiOk === false ? 'API unreachable' : 'API ok'}
          />
          <span className="chrome-status">{statusLabel}</span>
          {freshnessHint && <span className="chrome-hint">{freshnessHint}</span>}
          {aisStatus.trackStatus === 'loading' && (
            <span className="chrome-hint">Loading {trackDays}d track…</span>
          )}
          {aisStatus.trackStatus === 'error' && aisStatus.trackError && (
            <span className="chrome-hint warn">{aisStatus.trackError}</span>
          )}
          {aisStatus.trackStatus === 'none' && (
            <span className="chrome-hint">
              {/* writeSiteSnapshot.ts saves these ships' tracks; one position is not a track yet */}
              {selVessel &&
              (selVessel.sanctioned || selVessel.shadowfleet || selVessel.sanctionedMaster || selVessel.category === 'research')
                ? 'No track saved yet; it starts with the next update'
                : 'Tracks are kept for flagged ships only'}
            </span>
          )}
          {/* A home-screen app on iPhone has no browser reload, and the snapshot only changes on reload */}
          {SNAPSHOT_MODE && (
            <button
              type="button"
              className="chrome-btn theme-toggle"
              onClick={() => window.location.reload()}
              aria-label="Reload for newer data"
              title="Reload for newer data"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />
              </svg>
            </button>
          )}
          {canFullscreen && (
            <button
              type="button"
              className="chrome-btn theme-toggle"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else void document.documentElement.requestFullscreen().catch(() => {});
              }}
              aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
              title={isFullscreen ? 'Exit full screen' : 'Full screen'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path
                  d={
                    isFullscreen
                      ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5'
                      : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'
                  }
                />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="chrome-btn theme-toggle"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? 'Switch to light map' : 'Switch to dark map'}
            title={theme === 'dark' ? 'Light map' : 'Dark map'}
          >
            {theme === 'dark' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="chrome-btn"
            onClick={() => {
              copyShareUrl()
                .then(() => {
                  setShareHint('Link copied');
                  setTimeout(() => setShareHint(null), 2000);
                })
                .catch(() => setShareHint('Copy failed'));
            }}
          >
            {shareHint || 'Share'}
          </button>
        </div>
      </header>

      <div className="map-stage">
        <MapCanvas
          mapStyle={mapStyleWithKey}
          attribution={attribution}
          maptilerKey={maptilerKey}
          overlays={overlays}
          gfw={gfw}
          shipsVisible={shipsVisible}
          selectedMmsi={selectedMmsi}
          selectedFallback={selectedFallback}
          vesselFilters={vesselFilters}
          trackDays={trackDays}
          watchlistMmsis={watchlistMmsis}
          drawingAoi={drawingAoi}
          draftRing={draftRing}
          alertPolygons={alertRules
            .filter((r) => r.areaId === 'custom' && r.polygon && r.status === 'watching')
            .map((r) => ({ id: r.id, polygon: r.polygon!, label: r.areaLabel }))}
          onDraftChange={setDraftRing}
          onDrawFinish={() => setDrawingAoi(false)}
          onDrawCancel={() => {
            setDrawingAoi(false);
            setDraftRing([]);
          }}
          onVesselSelect={openVessel}
          onGfwEventSelect={openGfwEvent}
          onCableSelect={drawingAoi ? undefined : openCable}
          onPortSelect={drawingAoi ? undefined : openPort}
          onRigSelect={drawingAoi ? undefined : openRig}
          onPipelineSelect={drawingAoi ? undefined : openPipeline}
          onNavWarningSelect={drawingAoi ? undefined : openNavWarning}
          onDeselect={closeDetail}
          onVesselStatus={setAisStatus}
          onVesselsChange={setLiveVessels}
          onTrack={setTrack}
          onNavWarningsData={setNavData}
          scrub={mapScrub}
          warningPadding={warningPadding}
          theme={theme}
          onViewChange={setMapView}
        />
      </div>

      {selVessel && aisStatus.trackStatus !== 'none' && (
        <VesselTimeline
          apiBase={apiBase}
          mmsi={selVessel.mmsi}
          name={selVessel.name || `MMSI ${selVessel.mmsi}`}
          days={trackDays}
          onDaysChange={setTrackDays}
          track={track}
          loading={aisStatus.trackStatus === 'loading'}
          onScrub={setScrub}
          onShowDetails={detailDrawerOpen ? undefined : () => setDetailDrawerOpen(true)}
          className={detailDrawerOpen ? 'right-open' : ''}
        />
      )}

      {!SNAPSHOT_MODE && (
        <div
          className={`alerts-slot ${!alertsExpanded ? 'tucked' : ''}`}
        >
          <AlertPanel
            apiBase={apiBase}
            draftMmsi={alertDraft?.mmsi || null}
            draftName={alertDraft?.name || null}
            onDraftConsumed={() => setAlertDraft(null)}
            drawing={drawingAoi}
            onDrawingChange={setDrawingAoi}
            draftRing={draftRing}
            onDraftRingChange={setDraftRing}
            onRulesChange={setAlertRules}
            collapsed={!alertsExpanded}
            onExpand={() => setAlertsExpanded(true)}
            onCollapse={() => setAlertsExpanded(false)}
          />
        </div>
      )}

      <div
        id="detail-drawer"
        className={detailDrawerOpen ? 'open' : ''}
        role="dialog"
        aria-label="Selection details"
      >
        <div id="detail-card">
          {selection?.kind === 'vessel' && (() => {
            const selectedVessel = selection.vessel;
            return (
              <VesselDossier
                vessel={selectedVessel}
                trackSpoofing={track?.mmsi === selectedVessel.mmsi ? track.spoofing : undefined}
                sanctions={sanctionsInfo}
                gfwLastSeen={gfwLastSeen}
                note={watchlist.notes[selectedVessel.mmsi] || ''}
                onNoteChange={(text) =>
                  setWatchlist((s) => setVesselNote(s, selectedVessel.mmsi, text))
                }
                watched={watchlistMmsis.has(selectedVessel.mmsi)}
                onWatch={() =>
                  setWatchlist((s) =>
                    watchlistMmsis.has(selectedVessel.mmsi)
                      ? removeWatchEntry(s, selectedVessel.mmsi)
                      : upsertWatchEntry(s, {
                          mmsi: selectedVessel.mmsi,
                          name: selectedVessel.name || `MMSI ${selectedVessel.mmsi}`,
                          imo: selectedVessel.imo,
                        })
                  )
                }
                onAreaAlert={
                  SNAPSHOT_MODE
                    ? undefined
                    : () => {
                        setAlertDraft({
                          mmsi: selectedVessel.mmsi,
                          name: selectedVessel.name || `MMSI ${selectedVessel.mmsi}`,
                        });
                        setAlertsExpanded(true);
                      }
                }
                onExport={async () => {
                  let track: any = null;
                  try {
                    if (SNAPSHOT_MODE) {
                      track = await loadSnapshotTrack(apiBase, selectedVessel.mmsi, trackDays);
                    } else {
                      const r = await fetch(
                        `${apiBase}/api/tracks24h?mmsi=${encodeURIComponent(selectedVessel.mmsi)}&days=${trackDays}&interval=15`
                      );
                      track = await r.json();
                    }
                  } catch {
                    /* ignore */
                  }
                  exportVesselPack({
                    vessel: selectedVessel as any,
                    track,
                    sanctions: sanctionsInfo,
                    note: watchlist.notes[selectedVessel.mmsi] || null,
                  });
                }}
              />
            );
          })()}
          {selection?.kind === 'gfw' && (() => {
            const ev = selection.event;
            const headerBg = GFW_HEADER_COLORS[ev.subtype] || '#334155';
            return (
              <>
                <div className="head" data-kicker="Fishing Watch event" style={{ ['--kind' as string]: headerBg } as React.CSSProperties}>
                  {ev.title}
                  <div className="country" style={{ marginTop: 6, opacity: 0.95 }}>
                    Global Fishing Watch
                  </div>
                  {ev.russian && (
                    <div className="country" style={{ marginTop: 6 }}>
                      Russian vessel
                    </div>
                  )}
                  {ev.sanctioned && (
                    <div className="country" style={{ marginTop: 6 }}>
                      <img
                        src={`${BASE_PATH}/markers/Circles/Sanksjon.svg`}
                        alt=""
                        style={{ width: 16, height: 12 }}
                      />
                      Sanctioned vessel
                    </div>
                  )}
                  {ev.shadowfleet && (
                    <div className="country" style={{ marginTop: 6 }}>
                      <img
                        src={`${BASE_PATH}/markers/Circles/shadowtriangle.svg`}
                        alt=""
                        style={{ width: 16, height: 12 }}
                      />
                      Russian shadow fleet
                    </div>
                  )}
                </div>
                <div className="body">
                  <div className="row">
                    <span className="k">Vessel(s):</span>
                    <span className="v">{ev.vessels || 'Not available'}</span>
                  </div>
                  <div className="row">
                    <span className="k">Flag:</span>
                    <span className="v">{ev.flag || 'Not available'}</span>
                  </div>
                  <div className="row">
                    <span className="k">MMSI:</span>
                    <span className="v">{ev.mmsi || 'Not available'}</span>
                  </div>
                  {ev.partnerMmsi && (
                    <div className="row">
                      <span className="k">Partner MMSI:</span>
                      <span className="v">{ev.partnerMmsi}</span>
                    </div>
                  )}
                  <div className="row">
                    <span className="k">Start:</span>
                    <span className="v">{formatWhen(ev.time)}</span>
                  </div>
                  <div className="row">
                    <span className="k">End:</span>
                    <span className="v">{formatWhen(ev.end)}</span>
                  </div>
                  <div className="row">
                    <span className="k">Duration:</span>
                    <span className="v">{ev.duration || 'Not available'}</span>
                  </div>
                  {(ev.subtype === 'sar' ||
                    ev.subtype === 'sar_matched' ||
                    ev.matched != null) && (
                    <div className="row">
                      <span className="k">AIS match:</span>
                      <span className="v">
                        {ev.matched === true
                          ? 'Matched'
                          : ev.matched === false || ev.subtype === 'sar'
                            ? 'Unmatched (possible dark)'
                            : 'Not available'}
                      </span>
                    </div>
                  )}
                  {(ev.subtype === 'ais_off' || ev.intentionalDisabling != null) && (
                    <>
                      {/* GFW's API only returns gaps that pass its disabling filter, so every one is flagged */}
                      <div className="row">
                        <span className="k">Assessment:</span>
                        <span className="v">Possible intentional AIS disabling — Global Fishing Watch's flag</span>
                      </div>
                      <div className="row muted" style={{ display: 'block', lineHeight: 1.45 }}>
                        GFW counts a gap only when it lasts at least 12 hours, starts at least 50 nm from
                        shore in an area with good satellite reception (over 10 positions a day), and the
                        vessel sent at least 14 satellite positions in the 12 hours before. It is a pattern,
                        not proof: GFW calls the dataset a prototype, and its reception map is from
                        2017–2019. Gaps closer to the coast are left out, so most Norwegian coastal gaps
                        never show here.
                      </div>
                    </>
                  )}
                  {ev.note && (
                    <div className="row muted">{ev.note}</div>
                  )}
                  {!SNAPSHOT_MODE && (
                    <DarkLeads
                      apiBase={apiBase}
                      event={ev}
                      onOpenVessel={(mmsi, name) => openVesselByMmsi(mmsi, { name })}
                    />
                  )}
                  <div className="row">
                    <span className="k">Position:</span>
                    <span className="v">
                      {Math.abs(ev.lat).toFixed(4)}°{ev.lat >= 0 ? 'N' : 'S'},{' '}
                      {Math.abs(ev.lon).toFixed(4)}°{ev.lon >= 0 ? 'E' : 'W'}
                    </span>
                  </div>
                  {ev.mmsi && (
                    <div className="row detail-actions">
                      <button
                        type="button"
                        className="detail-action"
                        onClick={() =>
                          openVesselByMmsi(ev.mmsi!, {
                            name: ev.vessels,
                            russian: ev.russian,
                            sanctioned: ev.sanctioned,
                            shadowfleet: ev.shadowfleet,
                            lon: ev.lon,
                            lat: ev.lat,
                          })
                        }
                      >
                        Open live vessel
                      </button>
                      <button
                        type="button"
                        className="detail-action"
                        onClick={() => {
                          setWatchlist((s) =>
                            upsertWatchEntry(s, {
                              mmsi: ev.mmsi!,
                              name: ev.vessels || `MMSI ${ev.mmsi}`,
                            })
                          );
                        }}
                      >
                        Add to watchlist
                      </button>
                      {!SNAPSHOT_MODE && (
                        <button
                          type="button"
                          className="detail-action"
                          onClick={() => {
                            setAlertDraft({
                              mmsi: ev.mmsi!,
                              name: ev.vessels || `MMSI ${ev.mmsi}`,
                            });
                            setAlertsExpanded(true);
                          }}
                        >
                          Create area alert
                        </button>
                      )}
                    </div>
                  )}
                  {ev.partnerMmsi && (
                    <div className="row detail-actions">
                      <button
                        type="button"
                        className="detail-action"
                        onClick={() =>
                          openVesselByMmsi(ev.partnerMmsi!, {
                            name: `Partner ${ev.partnerMmsi}`,
                          })
                        }
                      >
                        Open partner vessel
                      </button>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
          {selection?.kind === 'cable' && (() => {
            const c = selection.cable;
            return (
              <>
                <div
                  className="head"
                  data-kicker={c.kind === 'landing' ? 'Cable landing' : c.kind === 'power' ? 'Power cable' : 'Subsea cable'}
                  style={
                    {
                      ['--kind' as string]:
                        c.color || (c.kind === 'nkom' ? '#0891b2' : c.kind === 'power' ? '#84cc16' : '#db2777'),
                    } as React.CSSProperties
                  }
                >
                  {c.name}
                  <div className="country" style={{ marginTop: 6 }}>
                    {c.kind === 'landing' ? 'Landing point' : c.kind === 'power' ? 'High-voltage sea cable' : 'Submarine cable'}
                  </div>
                </div>
                <div className="body">
                  <div className="row">
                    <span className="k">Source:</span>
                    <span className="v">{c.source}</span>
                  </div>
                  <div className="row">
                    <span className="k">Id:</span>
                    <span className="v">{c.id}</span>
                  </div>
                  {c.kabeltype && (
                    <div className="row">
                      <span className="k">Type:</span>
                      <span className="v">{c.kabeltype}</span>
                    </div>
                  )}
                  {c.kind === 'power' &&
                    ([
                      ['Owner:', c.owner],
                      ['Grid:', c.netLevel],
                      ['Voltage:', c.voltageKv != null ? `${c.voltageKv} kV` : null],
                      ['In service since:', c.year != null ? String(c.year) : null],
                    ] as [string, string | null | undefined][])
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <div className="row" key={k}>
                          <span className="k">{k}</span>
                          <span className="v">{v}</span>
                        </div>
                      ))}
                  {c.rfs_year != null && (
                    <div className="row">
                      <span className="k">RFS year:</span>
                      <span className="v">{c.rfs_year}</span>
                    </div>
                  )}
                  {c.is_planned && (
                    <div className="row">
                      <span className="k">Status:</span>
                      <span className="v">Planned</span>
                    </div>
                  )}
                  {c.kind === 'telegeography' && (
                    <div className="row muted">
                      © TeleGeography Submarine Cable Map (CC BY-NC-SA)
                    </div>
                  )}
                </div>
              </>
            );
          })()}
          {selection?.kind === 'port' && (() => {
            const p = selection.port;
            const rows: [string, string | null][] = [
              ['Harbour', p.harbour],
              ['Facility id', p.id],
              ['Owner', p.ownerType],
              ['Status', p.status],
              ['Functions', p.functions],
              ['Cruise', p.hasCruise],
              ['Safe loading', p.safeLoading],
              ['Approval valid to', p.approvalValidTo],
              ['Municipality', p.council],
              ['County', p.county],
            ];
            return (
              <>
                <div className="head" data-kicker="Port" style={{ ['--kind' as string]: '#94a3b8' } as React.CSSProperties}>
                  {p.name}
                  <div className="country" style={{ marginTop: 6 }}>
                    Port facility
                    {p.harbour ? ` · ${p.harbour}` : ''}
                  </div>
                </div>
                <div className="body">
                  {rows
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div className="row" key={k}>
                        <span className="k">{k}:</span>
                        <span className="v">{v}</span>
                      </div>
                    ))}
                  <div className="row muted">
                    Source: Kystverket PFSA port facilities (GeoNorge)
                  </div>
                </div>
              </>
            );
          })()}
          {selection?.kind === 'rig' && (() => {
            const r = selection.rig;
            const rows: [string, string | null][] = [
              ['Kind', r.kind],
              ['Phase', r.phase],
              ['Fixed / moveable', r.fixedOrMoveable],
              ['Operator', r.operator],
              ['Field / belongs to', r.belongsTo],
              ['Functions', r.functions],
              ['AOC status', r.status],
              [
                'Water depth',
                // Sodir reports 0 m for moveable units
                r.waterDepthM ? `${r.waterDepthM} m` : null,
              ],
              ['Id', r.id],
              ['Updated', r.updated ? formatWhen(r.updated) : null],
              ['AIS position', r.aisTimestamp ? formatWhen(r.aisTimestamp) : null],
              ['AIS name / MMSI', r.mmsi ? `${r.aisName || '–'} · ${r.mmsi}` : null],
            ];
            return (
              <>
                <div className="head" data-kicker={r.mmsi ? 'Moveable rig' : 'Installation'} style={{ ['--kind' as string]: '#f97316' } as React.CSSProperties}>
                  {r.name}
                  <div className="country" style={{ marginTop: 6 }}>
                    {r.mmsi ? 'Moveable rig (AIS position)' : 'Oil / gas installation'}
                    {r.phase ? ` · ${r.phase}` : ''}
                  </div>
                </div>
                <div className="body">
                  {rows
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div className="row" key={k}>
                        <span className="k">{k}:</span>
                        <span className="v">{v}</span>
                      </div>
                    ))}
                  {r.factPageUrl && (
                    <div className="row">
                      <a
                        href={r.factPageUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#fdba74', fontSize: 12 }}
                      >
                        Open Sodir fact page ↗
                      </a>
                    </div>
                  )}
                  {r.mmsi && (
                    <div className="row detail-actions">
                      <button
                        type="button"
                        className="detail-action"
                        onClick={() => openVesselByMmsi(r.mmsi!, { name: r.aisName || r.name })}
                      >
                        Open as vessel
                      </button>
                    </div>
                  )}
                  <div className="row muted">
                    {r.mmsi
                      ? 'Source: Sodir FactMaps register; position from AIS by vessel name'
                      : 'Source: Sodir FactMaps (facilities in place, surface)'}
                  </div>
                </div>
              </>
            );
          })()}
          {selection?.kind === 'pipeline' && (() => {
            const p = selection.pipeline;
            const rows: [string, string | null][] = [
              ['Status', p.inUse ? 'In use' : 'Not in use'],
              ['Medium', p.medium],
              ['Phase', p.phase],
              ['Chart type', p.source === 'geonorge' ? p.chartType : null],
              ['Operator', p.operator],
              ['Belongs to', p.belongsTo],
              ['From', p.fromFacility],
              ['To', p.toFacility],
              [
                'Dimension',
                p.dimensionInch != null ? `${p.dimensionInch}"` : null,
              ],
              [
                'Max water depth',
                p.waterDepthM != null ? `${p.waterDepthM} m` : null,
              ],
              ['Id', p.id],
              ['Updated', p.updated ? formatWhen(p.updated) : null],
            ];
            const headBg = p.inUse ? '#ea580c' : '#64748b';
            return (
              <>
                <div className="head" data-kicker="Pipeline" style={{ ['--kind' as string]: headBg } as React.CSSProperties}>
                  {p.name}
                  <div className="country" style={{ marginTop: 6 }}>
                    {p.inUse ? 'Petroleum pipeline' : 'Chart pipeline · not in use'}
                    {p.medium ? ` · ${p.medium}` : ''}
                  </div>
                </div>
                <div className="body">
                  {rows
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div className="row" key={k}>
                        <span className="k">{k}:</span>
                        <span className="v">{v}</span>
                      </div>
                    ))}
                  {p.factPageUrl && (
                    <div className="row">
                      <a
                        href={p.factPageUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#fdba74', fontSize: 12 }}
                      >
                        Open Sodir fact page ↗
                      </a>
                    </div>
                  )}
                  <div className="row muted">
                    {p.source === 'sodir'
                      ? 'Source: Sodir FactMaps (pipelines)'
                      : 'Source: GeoNorge chart rørledning (legacy, not in use)'}
                  </div>
                </div>
              </>
            );
          })()}
          {selection?.kind === 'navwarning' && (() => {
            const w = selection.warning;
            return (
              <>
                <div className="head" data-kicker="Navigation warning" style={{ ['--kind' as string]: '#ef4444' } as React.CSSProperties}>
                  {w.title}
                  <div className="country" style={{ marginTop: 6 }}>
                    {w.kind === 'coastal' ? 'Coastal warning' : 'NAVAREA XIX'}
                    {w.status ? ` · ${w.status}` : ''}
                  </div>
                </div>
                <div className="body">
                  {w.warningnumber && (
                    <div className="row">
                      <span className="k">Number:</span>
                      <span className="v">{w.warningnumber}</span>
                    </div>
                  )}
                  {w.location && (
                    <div className="row">
                      <span className="k">Location:</span>
                      <span className="v">{w.location}</span>
                    </div>
                  )}
                  {w.chart && (
                    <div className="row">
                      <span className="k">Chart:</span>
                      <span className="v">{w.chart}</span>
                    </div>
                  )}
                  <div className="row">
                    {/* NAVAREA DTGs are broadcast slots (06:30 / 18:30 UTC) and can lie ahead */}
                    <span className="k">DTG:</span>
                    <span className="v">{formatUtc(w.issued)}</span>
                  </div>
                  {w.updated_at && (
                    <div className="row">
                      <span className="k">Updated:</span>
                      <span className="v">{formatUtc(w.updated_at)}</span>
                    </div>
                  )}
                  {w.eventid != null && (
                    <div className="row">
                      <span className="k">Event id:</span>
                      <span className="v">{String(w.eventid)}</span>
                    </div>
                  )}
                  {w.message && (
                    <div className="row" style={{ display: 'block' }}>
                      <div className="k" style={{ marginBottom: 6 }}>
                        Message:
                      </div>
                      <div className="v" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
                        {w.message}
                      </div>
                    </div>
                  )}
                  {w.messageNo && w.messageNo !== w.message && (
                    <div className="row" style={{ display: 'block' }}>
                      <div className="k" style={{ marginBottom: 6 }}>
                        Norwegian original:
                      </div>
                      <div className="v" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
                        {w.messageNo}
                      </div>
                    </div>
                  )}
                  <div className="row muted">
                    {w.onMap === false
                      ? w.areaWide
                        ? 'Applies to the whole NAVAREA XIX — no specific position, so it is not drawn on the map.'
                        : 'No position given — not drawn on the map.'
                      : w.shapeFrom === 'joined'
                        ? 'Drawn as one area joining the positions in the message. Check against the text before relying on it.'
                        : w.shapeFrom === 'text'
                        ? 'Drawn from the positions in the message (Kystverket gives them only as loose points). Check against the text before relying on it.'
                        : 'Position from Kystverket; for some warnings it is extracted automatically from the text.'}
                  </div>
                  <div className="row muted">
                    Source: Kystverket navigational warnings. Not a substitute for NAVTEX / SafetyNET.
                  </div>
                </div>
              </>
            );
          })()}
          {/* Phones: the dossier covers the map and the timeline; this hides it and keeps the ship */}
          {selection?.kind === 'vessel' && (
            <button
              id="detail-hide"
              type="button"
              onClick={() => setDetailDrawerOpen(false)}
              aria-label="Show the map and timeline"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 17l5-5 4 4 8-9" />
                <path d="M14 7h6v6" />
              </svg>
              Timeline
            </button>
          )}
          <button
            id="detail-close"
            type="button"
            onClick={closeDetail}
            aria-label="Close details"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div id="legend" className={legendOpen ? 'open' : 'collapsed'}>
        <button
          type="button"
          className="legend-toggle"
          onClick={() => setLegendOpen((v) => !v)}
          aria-expanded={legendOpen}
        >
          Map key {legendOpen ? '▾' : '▴'}
        </button>
        {legendOpen && (
          <>
            {shipsVisible && (
              <>
                <div className="legend-section">Ships</div>
                <div className="indicators">
                  <div className="item">
                    <img
                      className="legend-icon shadow"
                      src={`${BASE_PATH}/markers/Circles/shadowtriangle.svg`}
                      alt=""
                    />
                    Shadow fleet
                  </div>
                  <div className="item">
                    <img className="legend-icon" src={`${BASE_PATH}/markers/Circles/Sanksjon.svg`} alt="" />
                    Sanctioned
                  </div>
                  <div className="item">
                    <img className="legend-icon" src={`${BASE_PATH}/markers/Circles/Militarycircle.svg`} alt="" />
                    Military
                  </div>
                  <div className="item">
                    <img className="legend-icon" src={`${BASE_PATH}/markers/Circles/Researchcircle.svg`} alt="" />
                    Research
                  </div>
                  <div className="item">
                    <img className="legend-icon" src={`${BASE_PATH}/markers/Circles/lastseenring.svg`} alt="" />
                    Research, last known position
                  </div>
                </div>
                <div className="row">
                  <div className="item">
                    <span className="swatch norway" />
                    Norway
                  </div>
                  <div className="item">
                    <span className="swatch russia" />
                    Russia
                  </div>
                  <div className="item">
                    <span className="swatch eu" />
                    EU
                  </div>
                  <div className="item">
                    <span className="swatch china" />
                    China
                  </div>
                  <div className="item">
                    <span className="swatch rest" />
                    Other
                  </div>
                </div>
              </>
            )}
            {(overlays['ice-edge'] ||
              overlays.bathymetry ||
              overlays.navwarnings ||
              overlays['navwarnings-30d'] ||
              overlays['cables-telegeography'] ||
              overlays.cables ||
              overlays.pipelines ||
              overlays['pipelines-old'] ||
              overlays.petroleum ||
              selection?.kind === 'vessel') && (
              <>
                <div className="legend-section">Overlays</div>
                <div className="row extras">
                  {overlays['ice-edge'] && (
                    <div className="item">
                      <span className="line ice" />
                      Ice edge
                    </div>
                  )}
                  {overlays.bathymetry && (
                    <div className="item">
                      <span className="line bathymetry" />
                      Bathymetry
                    </div>
                  )}
                  {(overlays.navwarnings || overlays['navwarnings-30d']) && (
                    <div className="item">
                      <span className="line nav" />
                      {overlays.navwarnings && overlays['navwarnings-30d']
                        ? 'Nav warnings'
                        : overlays.navwarnings
                          ? 'Active warnings'
                          : 'Warnings (30d)'}
                    </div>
                  )}
                  {overlays['cables-telegeography'] && (
                    <div className="item">
                      <span className="line tg-cable" />
                      Named cables
                    </div>
                  )}
                  {overlays.cables && (
                    <div className="item">
                      <span className="line nkom-cable" />
                      Nkom cables
                    </div>
                  )}
                  {overlays.pipelines && (
                    <div className="item">
                      <span className="line pipeline" />
                      Pipelines
                    </div>
                  )}
                  {overlays['pipelines-old'] && (
                    <div className="item">
                      <span className="line pipeline-unused" />
                      Old pipelines
                    </div>
                  )}
                  {overlays.petroleum && (
                    <div className="item">
                      <span className="swatch petroleum" />
                      Oil rigs
                    </div>
                  )}
                  {selection?.kind === 'vessel' && (
                    <div className="item">
                      <span className="line track" />
                      Track
                    </div>
                  )}
                </div>
              </>
            )}
            {anyGfw && (
              <>
                <div className="legend-section">Fishing Watch</div>
                <div className="row extras">
                  {gfw.loitering && (
                    <div className="item">
                      <span className="swatch gfw-loiter" />
                      Loitering
                    </div>
                  )}
                  {gfw.encounters && (
                    <div className="item">
                      <span className="swatch gfw-enc" />
                      Encounter
                    </div>
                  )}
                  {gfw.aisoff && (
                    <div className="item">
                      <span className="swatch gfw-off" />
                      AIS off
                    </div>
                  )}
                  {gfw.port && (
                    <div className="item">
                      <span className="swatch gfw-port" />
                      Port visit
                    </div>
                  )}
                  {gfw.sarUnmatched && (
                    <div className="item">
                      <span className="swatch gfw-sar" />
                      SAR · no AIS (dark?)
                    </div>
                  )}
                  {gfw.sarMatched && (
                    <div className="item">
                      <span className="swatch gfw-sar-matched" />
                      SAR · matched AIS
                      {gfw.sarMatchedFlags.length > 0
                        ? ` (${gfw.sarMatchedFlags.join(', ')})`
                        : ''}
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="legend-note">Zoom in for ship headings and names</div>
          </>
        )}
      </div>
    </div>
  );
}
