/**
 * One click on the map can hit several layers: a rig on the end of a pipeline, a cable inside a
 * warning area, a ship over a cable. Every layer has its own click handler and they all fire, so
 * the last one registered used to win. Instead each handler offers its selection with a
 * priority, and only the highest runs, once, after every handler for that click has had its turn.
 */
export const CLICK_PRIORITY = {
  ship: 100,
  /** Rigs, platforms, ports, cable landings, GFW events and radar detections */
  point: 80,
  /** A warning's marks, outlines and routes */
  warning: 60,
  cable: 50,
  pipeline: 40,
  oldPipeline: 30,
  /** Anywhere inside a warning's area */
  warningArea: 20,
  /** Nothing hit: close the card */
  background: 0,
} as const;

const pending = new WeakMap<object, { priority: number; run: () => void }>();

export function offerClick(e: { originalEvent?: object } | null | undefined, priority: number, run: () => void): void {
  const key = e?.originalEvent;
  if (!key) {
    run();
    return;
  }
  const best = pending.get(key);
  if (best) {
    // Ties go to the first offer
    if (priority > best.priority) {
      best.priority = priority;
      best.run = run;
    }
    return;
  }
  const entry = { priority, run };
  pending.set(key, entry);
  setTimeout(() => {
    pending.delete(key);
    entry.run();
  }, 0);
}
