'use client';

import { useEffect } from 'react';
import { useMap } from '../hooks/useMap';
import { mapStyleReady } from '../utils/mapSafe';
import type { MapTheme } from '../utils/kartverketRelief';

const styleCache = new Map<string, Promise<any>>();

function loadStyle(url: string): Promise<any> {
  if (!styleCache.has(url)) {
    styleCache.set(
      url,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Map style ${url}: HTTP ${r.status}`);
        return r.json();
      })
    );
  }
  return styleCache.get(url)!;
}

/**
 * Light / dark basemap without reloading the map: the two styles share layer ids, so a
 * switch only repaints the basemap layers and every overlay, ship and track stays put.
 */
export default function BasemapTheme({
  theme,
  styleUrl = (t: MapTheme) => `/styles/svalmap-${t}.json`,
}: {
  theme: MapTheme;
  styleUrl?: (theme: MapTheme) => string;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    let cancelled = false;
    const apply = async () => {
      try {
        const style = await loadStyle(styleUrl(theme));
        if (cancelled || !mapStyleReady(map)) return;
        for (const layer of style.layers || []) {
          if (!map.getLayer(layer.id)) continue;
          for (const [prop, value] of Object.entries(layer.paint || {})) {
            map.setPaintProperty(layer.id, prop, value as any);
          }
        }
      } catch (e) {
        console.warn('[BasemapTheme]', e);
      }
    };
    if (mapStyleReady(map)) apply();
    else map.once('load', apply);
    return () => {
      cancelled = true;
      map.off('load', apply);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, theme]);

  return null;
}
