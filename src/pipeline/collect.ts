import { fetchRepo } from "../collectors/github.ts";
import { collectors } from "../collectors/index.ts";
import type { Metrics, Platform, RawItem, SourceRow } from "../collectors/types.ts";
import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import { errMsg, log } from "../log.ts";
import { itemProjectKey, looksAiRelated, projectName, projectUrl } from "../projects.ts";
import { canonicalUrl, hoursAgo, nowIso, sleep } from "../util.ts";

// Platforms where an old item can suddenly take off (a repo from last year hitting Trending).
const EVERGREEN: Platform[] = ["github", "huggingface"];
// Platforms whose items are coverage of a project, never the project itself.
const CONTEXT_ONLY: Platform[] = ["press", "blog", "telegram", "bluesky"];

function sameMetrics(a: Metrics, b: Metrics) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Store one sighting: upsert the item, snapshot its counters, register its project. */
export function storeItem(db: Db, src: { id: number; platform: Platform; focused: number }, raw: RawItem, cfg: Config): "new" | "seen" | "skipped" {
  let url: string;
  try {
    url = canonicalUrl(raw.url);
  } catch {
    return "skipped";
  }
  const platform = raw.platform ?? src.platform;
  if (raw.createdAt && !EVERGREEN.includes(platform) && raw.createdAt < hoursAgo(cfg.ITEM_WINDOW_HOURS)) return "skipped";
  const now = nowIso();
  const relevant = src.focused || looksAiRelated(`${raw.title} ${raw.text}`) ? 1 : 0;
  const rawKey = itemProjectKey(raw, !CONTEXT_ONLY.includes(platform));
  // The scan may have decided two keys are one project; new sightings follow the merge.
  const key = rawKey ? (db.get<{ merged_into: string | null }>("SELECT merged_into FROM projects WHERE key = ?", rawKey)?.merged_into ?? rawKey) : null;
  const metrics = Object.fromEntries(Object.entries(raw.metrics).filter(([, v]) => typeof v === "number")) as Metrics;
  const existing = db.get<{ id: number; relevant: number }>("SELECT id, relevant FROM items WHERE url = ?", url);
  let id: number;
  if (existing) {
    id = existing.id;
    // Relevance only ever goes up: a repo first seen via an AI-only source stays relevant.
    db.run(
      `UPDATE items SET title = ?, text = CASE WHEN length(?) > 0 THEN ? ELSE text END, link = COALESCE(?, link), links = ?,
         project_key = COALESCE(project_key, ?), relevant = max(relevant, ?), item_created_at = COALESCE(item_created_at, ?),
         last_seen = ?, metrics = CASE WHEN ? = '{}' THEN metrics ELSE ? END WHERE id = ?`,
      raw.title, raw.text, raw.text, raw.link ?? null, JSON.stringify(raw.links), key, relevant, raw.createdAt, now,
      JSON.stringify(metrics), JSON.stringify(metrics), id,
    );
  } else {
    id = Number(
      db.run(
        `INSERT INTO items(url, source_id, platform, title, text, author, link, links, project_key, relevant, item_created_at, first_seen, last_seen, metrics)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        url, src.id, platform, raw.title, raw.text, raw.author ?? null, raw.link ?? null, JSON.stringify(raw.links), key, relevant,
        raw.createdAt, now, now, JSON.stringify(metrics),
      ).lastInsertRowid,
    );
  }
  if (Object.keys(metrics).length) {
    const last = db.get<{ metrics: string; at: string }>("SELECT metrics, at FROM snapshots WHERE item_id = ? ORDER BY at DESC LIMIT 1", id);
    // A Trending "stars today" figure from the daily page and a weekly figure must not overwrite each other.
    const merged = { ...json<Metrics>(last?.metrics, {}), ...metrics };
    if (!last || !sameMetrics(json<Metrics>(last.metrics, {}), merged)) db.run("INSERT INTO snapshots(item_id, at, metrics) VALUES(?,?,?)", id, now, JSON.stringify(merged));
    db.run("UPDATE items SET metrics = ? WHERE id = ?", JSON.stringify(merged), id);
  }
  const finalKey = db.get<{ project_key: string | null; relevant: number }>("SELECT project_key, relevant FROM items WHERE id = ?", id);
  if (finalKey?.project_key && finalKey.relevant) {
    db.run(
      `INSERT INTO projects(key, name, url, first_seen, last_seen) VALUES(?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET last_seen = excluded.last_seen`,
      finalKey.project_key, projectName(finalKey.project_key), projectUrl(finalKey.project_key), now, now,
    );
  }
  return existing ? "seen" : "new";
}

export async function collectAll(db: Db, cfg: Config, only: string[] = []) {
  const sources = db.all<SourceRow>(
    "SELECT id, key, name, kind, url, platform, focused, config FROM sources WHERE enabled = 1 ORDER BY id",
  ).filter((s) => !only.length || only.includes(s.key));
  const stats = { sources: sources.length, items: 0, new: 0, errors: {} as Record<string, string> };
  // Sources on the same host run one after another with a pause (Reddit answers 429 to parallel or rapid
  // anonymous requests); different hosts run in parallel.
  const byHost = new Map<string, SourceRow[]>();
  for (const s of sources) {
    const h = hostOf(s.url);
    byHost.set(h, [...(byHost.get(h) ?? []), s]);
  }
  await Promise.all(
    [...byHost.entries()].map(async ([host, group]) => {
      for (const [i, src] of group.entries()) {
        if (i > 0) await sleep(HOST_PAUSE_MS[host] ?? 1000);
        db.run("UPDATE sources SET last_fetch_at = ? WHERE id = ?", nowIso(), src.id);
        try {
          const raw = await collectors[src.kind].collect(src, cfg);
          let n = 0;
          db.tx(() => {
            for (const r of raw) {
              const res = storeItem(db, src, r, cfg);
              if (res !== "skipped") n++;
              if (res === "new") stats.new++;
            }
          });
          stats.items += n;
          db.run(
            "UPDATE sources SET last_success_at = ?, last_error = NULL, consecutive_failures = 0, total_items = total_items + ? WHERE id = ?",
            nowIso(), n, src.id,
          );
        } catch (e) {
          stats.errors[src.key] = errMsg(e);
          db.run("UPDATE sources SET last_error = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?", errMsg(e), src.id);
          log.warn("source failed", { source: src.key, err: errMsg(e) });
        }
      }
    }),
  );
  return stats;
}

const HOST_PAUSE_MS: Record<string, number> = { "www.reddit.com": 7000, "reddit.com": 7000 };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Re-read star counts of recently active repos that no list returned this run,
 * so a repo that dropped off Trending still has a measured 24h/72h delta.
 */
export async function refreshTrackedRepos(db: Db, cfg: Config) {
  const internal = ensureInternalSource(db);
  const repos = db.all<{ key: string }>(
    `SELECT p.key FROM projects p WHERE p.key LIKE 'gh:%' AND p.merged_into IS NULL AND p.last_seen >= ?
       AND p.status != 'skip'
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.project_key = p.key AND i.platform = 'github' AND i.last_seen >= ?)
     ORDER BY COALESCE(p.hype_score, 0) DESC, p.last_seen DESC LIMIT ?`,
    hoursAgo(cfg.ITEM_WINDOW_HOURS), hoursAgo(0.5), cfg.GITHUB_REFRESH_PER_RUN,
  );
  let refreshed = 0;
  for (const r of repos) {
    const item = await fetchRepo(r.key.slice(3), cfg);
    if (!item) continue;
    db.tx(() => storeItem(db, internal, item, cfg));
    refreshed++;
  }
  return { candidates: repos.length, refreshed };
}

function ensureInternalSource(db: Db) {
  db.run(
    `INSERT INTO sources(key, name, kind, platform, url, focused, enabled, created_at)
     VALUES('_github_refresh', 'GitHub API (refresh of tracked repos)', 'github_search', 'github', 'https://api.github.com/repos', 0, 0, ?)
     ON CONFLICT(key) DO NOTHING`,
    nowIso(),
  );
  return db.get<{ id: number; platform: Platform; focused: number }>("SELECT id, platform, focused FROM sources WHERE key = '_github_refresh'")!;
}
