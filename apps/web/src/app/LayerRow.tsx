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

export function DotMarker({ color }: { color: string }) {
  return (
    <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
      <circle r="4" fill={color} />
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
