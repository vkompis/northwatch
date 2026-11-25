'use client';

import type { ReactNode } from 'react';

/** Small glyphs used as row markers — the same shapes the map draws. */
export function TriangleMarker({ color }: { color: string }) {
  return (
    <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
      <path d="M0,-5.5 L4.2,4.6 L0,2.6 L-4.2,4.6 Z" fill={color} />
    </svg>
  );
}

export function RingMarker({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
      <circle
        r="5.2"
        fill="none"
        stroke={color}
        strokeWidth={dashed ? 1.4 : 1.6}
        strokeDasharray={dashed ? '2 2' : undefined}
      />
    </svg>
  );
}

/** Warning triangle the map draws over sanctioned (red edge) and shadow-fleet (dark edge) ships. */
export function WarningMarker({ edge }: { edge: string }) {
  return (
    <svg width="15" height="13" viewBox="0 0 255.12 225.46" aria-hidden="true">
      <path d="M238.25,208.59L127.56,16.87,16.87,208.59h221.39Z" fill="none" stroke={edge} strokeWidth="33.73" strokeLinejoin="round" />
      <path d="M228.68,203.07L127.56,27.92,26.44,203.07h202.24Z" fill="#fff" />
      <path d="M127.56 79.41v58.93M127.56 174.66v-8.86" stroke="#000" strokeWidth="17" strokeLinecap="round" />
    </svg>
  );
}

/** Map edge colours of the sanction / shadow-fleet badges (public/markers/Circles/*.svg). */
export const SANCTION_EDGE = '#dc0a14';
export const SHADOW_EDGE = '#000a14';

/** Badge the map puts over ships whose master is sanctioned (public/markers/Circles/masterbadge.svg). */
export function MasterMarker() {
  return (
    <svg width="14" height="14" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="27" fill="#fff" stroke="#e8590c" strokeWidth="7" />
      <path d="M13 30c0-7 9-12 19-12s19 5 19 12l-5 4H18z" fill="#0a1118" />
      <rect x="18" y="35.5" width="28" height="5" rx="1" fill="#0a1118" />
      <path d="M19 42h26c-3 5-8 6.5-13 6.5S22 47 19 42z" fill="#0a1118" />
    </svg>
  );
}

/** Star the map puts beside ships on the watchlist (public/markers/Circles/watchstar.svg). */
export function StarMarker() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.2l2.6 5.4 5.9.7-4.4 4 1.2 5.9L12 16.3l-5.3 2.9 1.2-5.9-4.4-4 5.9-.7z"
        fill="#E7A54A"
        stroke="#0a1118"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Dashed ring the map draws around ships whose AIS breaks the spoofing rules (public/markers/Circles/spoofring.svg). */
export function SpoofMarker() {
  return (
    <svg width="14" height="14" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="26" fill="none" stroke="#c026d3" strokeWidth="8" strokeDasharray="9 11.42" strokeLinecap="round" />
    </svg>
  );
}

/** Hollow ring for a research ship's last known position (public/markers/Circles/lastseenring.svg). */
export function LastSeenMarker() {
  return (
    <svg width="14" height="14" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="22" fill="none" stroke="#d946ef" strokeWidth="10" />
    </svg>
  );
}

/** `stroke` matches map layers drawn with an outline, which zoomed out mostly shows the outline */
export function DotMarker({ color, stroke }: { color: string; stroke?: string }) {
  return (
    <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
      <circle r="4" fill={color} stroke={stroke} strokeWidth={stroke ? 1.5 : undefined} />
    </svg>
  );
}

/** Light to dark red, like HELCOM's density maps */
export function DensityMarker() {
  return (
    <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
      <rect x="1" y="2" width="4.5" height="6" fill="#fcd4c8" />
      <rect x="5.5" y="2" width="4.5" height="6" fill="#ef6a4c" />
      <rect x="10" y="2" width="5" height="6" fill="#a50f15" />
    </svg>
  );
}

export function LineMarker({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
      <path d="M1 5h14" stroke={color} strokeWidth="1.6" strokeDasharray={dashed ? '4 3' : undefined} />
    </svg>
  );
}

/**
 * One layer per line: marker, what it is, where it comes from, how many, on/off.
 * The checkbox is a real input (styled as a switch) so keyboard and screen readers work.
 */
export default function LayerRow({
  label,
  sub,
  count,
  marker,
  checked,
  onChange,
}: {
  label: string;
  sub?: string;
  count?: number | string | null;
  marker?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="layer-row">
      <span className="layer-marker" aria-hidden>
        {marker}
      </span>
      <span className="layer-label">
        {label}
        {sub && <span className="layer-sub">{sub}</span>}
      </span>
      {count != null && count !== '' && (
        <span className="layer-count">
          {typeof count === 'number' ? count.toLocaleString('nb-NO') : count}
        </span>
      )}
      <input
        type="checkbox"
        role="switch"
        className="layer-switch"
        checked={Boolean(checked)}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
