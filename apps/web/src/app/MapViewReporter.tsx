'use client';

import { useEffect, useRef } from 'react';
import { useMap } from '@svalmap/ui';

export type MapView = { lat: number; lon: number; zoom: number };

/** Tells the page where the map is after each pan or zoom (for links that open "this area"). */
export default function MapViewReporter({ onChange }: { onChange: (view: MapView) => void }) {
  const map = useMap();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!map) return;
    const report = () => {
      const c = map.getCenter();
      onChangeRef.current({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    };
    report();
    map.on('moveend', report);
    return () => {
      map.off('moveend', report);
    };
  }, [map]);

  return null;
}
