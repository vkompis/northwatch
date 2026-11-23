/**
 * Build-time switches for the static GitHub Pages copy of the map
 * (`.github/workflows/pages.yml`). A normal build leaves all of them unset.
 */

/** Path prefix of a GitHub Pages project site, e.g. `/svalmap`; empty when served from the root. */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/**
 * True when the map reads saved API responses instead of a live API, so
 * features that query the API on demand (search, tracks, alerts) are hidden.
 */
export const SNAPSHOT_MODE = process.env.NEXT_PUBLIC_SNAPSHOT === '1';

/** When the snapshot was taken (ISO time), or null outside snapshot mode. */
export const SNAPSHOT_AT = SNAPSHOT_MODE ? process.env.NEXT_PUBLIC_SNAPSHOT_AT || null : null;
