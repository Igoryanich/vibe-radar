import { type Db, json } from "./db.ts";
import type { Metrics, Platform } from "./collectors/types.ts";

/** The counter that best measures attention on a platform. */
export const HEADLINE: Partial<Record<Platform, keyof Metrics>> = {
  github: "stars",
  hn: "points",
  reddit: "upvotes",
  huggingface: "likes",
  bluesky: "likes",
};

export interface Delta {
  value: number;
  /** Hours actually covered by the observation (≤ the requested window). */
  hours: number;
  /** "snapshot" = difference between two of our observations; "since_creation" = the item is younger than the window. */
  basis: "snapshot" | "since_creation";
}

/**
 * Growth of one counter over the last `hours`. Never extrapolated:
 *  - a snapshot at least `hours` old → exact difference;
 *  - the item was created inside the window → everything it has was gained in the window;
 *  - only younger snapshots (we started watching recently) → difference over the observed span,
 *    if it covers at least a third of the window; the span is reported alongside.
 */
export function computeDelta(
  history: { at: string; value: number }[],
  current: number,
  createdAt: string | null,
  hours: number,
  now = Date.now(),
): Delta | null {
  const cutoff = now - hours * 3600_000;
  const sorted = [...history].sort((a, b) => a.at.localeCompare(b.at));
  const older = sorted.filter((s) => Date.parse(s.at) <= cutoff).pop();
  if (older) return { value: Math.max(0, current - older.value), hours, basis: "snapshot" };
  if (createdAt && Date.parse(createdAt) >= cutoff) {
    const h = Math.max(1, Math.round((now - Date.parse(createdAt)) / 3600_000));
    return { value: current, hours: Math.min(h, hours), basis: "since_creation" };
  }
  const first = sorted[0];
  if (first) {
    const span = (now - Date.parse(first.at)) / 3600_000;
    if (span >= hours / 3) return { value: Math.max(0, current - first.value), hours: Math.round(span), basis: "snapshot" };
  }
  return null;
}

export function itemDeltas(db: Db, itemId: number, platform: Platform, metrics: Metrics, createdAt: string | null) {
  const key = HEADLINE[platform];
  if (!key || metrics[key] === undefined) return {};
  const history = db
    .all<{ at: string; metrics: string }>("SELECT at, metrics FROM snapshots WHERE item_id = ? ORDER BY at", itemId)
    .map((s) => ({ at: s.at, value: json<Metrics>(s.metrics, {})[key] }))
    .filter((s): s is { at: string; value: number } => typeof s.value === "number");
  // The newest snapshot is the current value itself; compare against earlier ones.
  const past = history.slice(0, -1);
  const current = metrics[key] as number;
  const d24 = computeDelta(past, current, createdAt, 24);
  const d72 = computeDelta(past, current, createdAt, 72);
  return {
    ...(d24 ? { delta_24h: { [key]: d24.value, observed_hours: d24.hours, basis: d24.basis } } : {}),
    ...(d72 ? { delta_72h: { [key]: d72.value, observed_hours: d72.hours, basis: d72.basis } } : {}),
  };
}

/** Headline counters of a project for "≥3× since the last post" checks: the max per metric across its items. */
export function projectHeadline(db: Db, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.all<{ platform: Platform; metrics: string }>("SELECT platform, metrics FROM items WHERE project_key = ?", key)) {
    const m = json<Metrics>(r.metrics, {});
    const k = HEADLINE[r.platform];
    if (k && typeof m[k] === "number") out[k] = Math.max(out[k] ?? 0, m[k] as number);
  }
  return out;
}

/** Largest growth ratio of any headline counter between two observations (∞-safe). */
export function growthRatio(before: Record<string, number>, after: Record<string, number>): number {
  let best = 1;
  for (const [k, v] of Object.entries(after)) {
    const b = before[k];
    if (b && b > 0) best = Math.max(best, v / b);
  }
  return best;
}
