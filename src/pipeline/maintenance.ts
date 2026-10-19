import type { Db } from "../db.ts";
import { hoursAgo } from "../util.ts";

/** Keep the state file small: it is committed to the `state` branch after every run. */
export function prune(db: Db) {
  const r = {
    snapshots: Number(db.run("DELETE FROM snapshots WHERE at < ?", hoursAgo(24 * 10)).changes),
    // Only items, not projects: projects carry the publication history that decides updates.
    items: Number(db.run(
      "DELETE FROM items WHERE last_seen < ? AND id NOT IN (SELECT item_id FROM snapshots)", hoursAgo(24 * 14),
    ).changes),
    texts: Number(db.run("UPDATE items SET text = substr(text, 1, 300) WHERE last_seen < ? AND length(text) > 300", hoursAgo(72)).changes),
    scans: Number(db.run("DELETE FROM scans WHERE at < ?", hoursAgo(24 * 7)).changes),
    runs: Number(db.run("DELETE FROM runs WHERE started_at < ?", hoursAgo(24 * 30)).changes),
    projects: Number(db.run(
      "DELETE FROM projects WHERE last_seen < ? AND post_count = 0 AND key NOT IN (SELECT DISTINCT project_key FROM items WHERE project_key IS NOT NULL)",
      hoursAgo(24 * 30),
    ).changes),
  };
  return r;
}

/** Sources that keep failing — surfaced in the run stats so a broken parser is noticed. */
export function sourceHealth(db: Db) {
  return db.all<{ key: string; consecutive_failures: number; last_error: string }>(
    "SELECT key, consecutive_failures, last_error FROM sources WHERE enabled = 1 AND consecutive_failures >= 3 ORDER BY consecutive_failures DESC",
  );
}
