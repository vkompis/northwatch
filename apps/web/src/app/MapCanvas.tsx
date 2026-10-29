'use client';

import {
  MapContainer,
  VesselLayer,
  OverlayLayers,
  GfwLayers,
  IncidentLayer,
  AoiDrawLayer,
  type OverlayVisibility,
  type GfwVisibility,
  type VesselFeatureProps,
  type GfwEventProps,
  type VesselLayerStatus,
  type VesselTrack,
  type VesselScrub,
  type CableFeatureProps,
  type PortFeatureProps,
  type RigFeatureProps,
  type PipelineFeatureProps,
  type NavWarningProps,
  type AlertPolygon,
  type VesselFilterFlags,
} from '@svalmap/ui';

type Props = {
  mapStyle: string;
  attribution: string;
  maptilerKey?: string;
  overlays: OverlayVisibility;
  gfw: GfwVisibility;
  shipsVisible: boolean;
  selectedMmsi?: string | null;
  selectedFallback?: { mmsi: string; label?: string | null; lon: number | null; lat: number | null } | null;
  vesselFilters?: VesselFilterFlags;
  trackDays?: number;
  watchlistMmsis?: ReadonlySet<string> | string[];
  drawingAoi?: boolean;
  draftRing?: number[][];
  alertPolygons?: { id: string; polygon: AlertPolygon; label?: string }[];
  onDraftChange?: (ring: number[][]) => void;
  onDrawFinish?: () => void;
  onDrawCancel?: () => void;
  onVesselSelect?: (vessel: VesselFeatureProps) => void;
  onGfwEventSelect?: (event: GfwEventProps) => void;
  onCableSelect?: (cable: CableFeatureProps) => void;
  onPortSelect?: (port: PortFeatureProps) => void;
  onRigSelect?: (rig: RigFeatureProps) => void;
  onPipelineSelect?: (pipeline: PipelineFeatureProps) => void;
  onNavWarningSelect?: (warning: NavWarningProps) => void;
  onDeselect?: () => void;
  onVesselStatus?: (status: VesselLayerStatus) => void;
  onVesselsChange?: (vessels: VesselFeatureProps[]) => void;
  onTrack?: (track: VesselTrack | null) => void;
  onNavWarningsData?: (data: { onMap: number; notices: NavWarningProps[] }) => void;
  scrub?: VesselScrub | null;
  /** Panels over the map, kept clear when fitting to a clicked warning. */
  warningPadding?: { top: number; right: number; bottom: number; left: number };
};

export default function MapCanvas({
  mapStyle,
  attribution,
  maptilerKey,
  overlays,
  gfw,
  shipsVisible,
  selectedMmsi,
  selectedFallback,
  vesselFilters,
  trackDays = 1,
  watchlistMmsis,
  drawingAoi = false,
  draftRing = [],
  alertPolygons = [],
  onDraftChange,
  onDrawFinish,
  onDrawCancel,
  onVesselSelect,
  onGfwEventSelect,
  onCableSelect,
  onPortSelect,
  onRigSelect,
  onPipelineSelect,
  onNavWarningSelect,
  onDeselect,
  onVesselStatus,
  onVesselsChange,
  onTrack,
  onNavWarningsData,
  scrub = null,
  warningPadding,
}: Props) {
  return (
    <MapContainer
      center={{ latitude: 62, longitude: -15 }}
      zoom={2.8}
      fitNorway
      mapStyle={mapStyle}
      attribution={attribution}
      maptilerKey={maptilerKey}
    >
      <OverlayLayers
        visibility={overlays}
        onCableSelect={onCableSelect}
        onPortSelect={onPortSelect}
        onRigSelect={onRigSelect}
        onPipelineSelect={onPipelineSelect}
      />
      <IncidentLayer
        // The feed only has in-force warnings, so "last 30 days" was the same set — one toggle
        showActive={overlays.navwarnings || overlays['navwarnings-30d']}
        onData={onNavWarningsData}
        fitPadding={warningPadding}
        interactive={!drawingAoi}
        onWarningSelect={drawingAoi ? undefined : onNavWarningSelect}
      />
      <VesselLayer
        visible={shipsVisible && !drawingAoi}
        interactive={!drawingAoi}
        selectedMmsi={selectedMmsi}
        selectedFallback={selectedFallback}
        filters={vesselFilters}
        trackDays={trackDays}
        watchlistMmsis={watchlistMmsis}
        onVesselSelect={drawingAoi ? undefined : onVesselSelect}
        onDeselect={drawingAoi ? undefined : onDeselect}
        onStatus={onVesselStatus}
        onVesselsChange={onVesselsChange}
        onTrack={onTrack}
        scrub={scrub}
      />
      <GfwLayers
        visibility={gfw}
        onEventSelect={drawingAoi ? undefined : onGfwEventSelect}
      />
      <AoiDrawLayer
        active={drawingAoi}
        draftRing={draftRing}
        polygons={alertPolygons}
        onDraftChange={onDraftChange}
        onFinish={onDrawFinish}
        onCancel={onDrawCancel}
      />
    </MapContainer>
  );
}
