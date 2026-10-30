'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export type MapMenuId = 'ships' | 'activity' | 'sea' | 'infra' | 'warnings';

export type MapMenuItem = {
  id: MapMenuId;
  label: string;
  icon: ReactNode;
  /** Short status beside the label: active layer count, quick view name, … */
  badge?: string | number | null;
  /** Badge colour: amber for "narrowed", red for warnings in force */
  tone?: 'accent' | 'alert';
  title: string;
  lede?: string;
  content: ReactNode;
};

const ICON = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const MENU_ICONS = {
  ships: (
    <svg {...ICON}>
      <path d="M4 15l1.6 4h12.8L20 15H4zM7 15V9h10v6M12 9V5" />
    </svg>
  ),
  activity: (
    <svg {...ICON}>
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </svg>
  ),
  sea: (
    <svg {...ICON}>
      <path d="M3 8c2 0 2-1.5 4.5-1.5S9.5 8 12 8s2.5-1.5 4.5-1.5S19 8 21 8M3 14l5-4 4 3 4-5 5 6v4H3z" />
    </svg>
  ),
  infra: (
    <svg {...ICON}>
      <path d="M4 18c3 0 4-12 8-12s5 12 8 12M12 6V3M8 21h8" />
    </svg>
  ),
  warnings: (
    <svg {...ICON}>
      <path d="M12 4l9 16H3zM12 10v4M12 17v.5" />
    </svg>
  ),
};

/**
 * Layer menus along the top of the map: one button per group, its panel drops down
 * under it. One panel at a time; Escape or a click outside closes it.
 */
export default function MapMenu({
  items,
  open,
  onOpenChange,
}: {
  items: MapMenuItem[];
  open: MapMenuId | null;
  onOpenChange: (id: MapMenuId | null) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const [panelLeft, setPanelLeft] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(null);
    };
    const onPointer = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) onOpenChange(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, onOpenChange]);

  const toggle = (id: MapMenuId, button: HTMLButtonElement) => {
    if (open === id) return onOpenChange(null);
    // Panel sits under its button; the button row may be scrolled sideways on a phone
    setPanelLeft(button.offsetLeft - (buttonsRef.current?.scrollLeft || 0));
    onOpenChange(id);
  };

  const current = items.find((i) => i.id === open);

  return (
    <nav ref={navRef} className="map-menu" aria-label="Map layers">
      <div ref={buttonsRef} className="map-menu-buttons">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`map-menu-btn ${open === item.id ? 'on' : ''}`}
            aria-expanded={open === item.id}
            aria-controls={`map-menu-${item.id}`}
            onClick={(e) => toggle(item.id, e.currentTarget)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge != null && item.badge !== '' && item.badge !== 0 && (
              <span className={`map-menu-badge ${item.tone || ''}`}>{item.badge}</span>
            )}
          </button>
        ))}
      </div>
      {current && (
        <section
          id={`map-menu-${current.id}`}
          // "panel" / "section": the list, toggle and note styles the layer rows already use
          className="map-menu-panel panel"
          style={{ ['--panel-left' as string]: `${panelLeft}px` }}
          aria-label={current.title}
        >
          <header className="map-menu-head">
            <h2 className="panel-h">{current.title}</h2>
            <button type="button" className="map-menu-close" aria-label="Close" onClick={() => onOpenChange(null)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
          {current.lede && <p className="panel-lede">{current.lede}</p>}
          <div className="map-menu-body section">{current.content}</div>
        </section>
      )}
    </nav>
  );
}
