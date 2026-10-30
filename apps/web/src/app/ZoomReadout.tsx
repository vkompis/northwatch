'use client';

import { useEffect, useState } from 'react';
import { useMap } from '@svalmap/ui';

/** Current zoom level, bottom right — follows the map while it zooms. */
export default function ZoomReadout() {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map?.getZoom() ?? 0);

  useEffect(() => {
    if (!map) return;
    const update = () => setZoom(map.getZoom());
    update();
    map.on('zoom', update);
    return () => {
      map.off('zoom', update);
    };
  }, [map]);

  return (
    <div className="zoom-readout" aria-live="off" title="Map zoom level">
      Zoom {zoom.toFixed(1)}
    </div>
  );
}
