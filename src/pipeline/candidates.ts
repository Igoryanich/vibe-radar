import type { Metrics, Platform } from "../collectors/types.ts";
import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import { growthRatio, itemDeltas, projectHeadline } from "../metrics.ts";
import { nameMentioned, projectKeyOf } from "../projects.ts";
import { hoursAgo } from "../util.ts";
// Used at call time only, so the scan.ts ↔ candidates.ts import cycle is harmless.
import { SCAN_VERSION } from "./scan.ts";

interface ItemRow {
  id: number;
  url: string;
  platform: Platform;
  title: string;
  text: string;
  author: string | null;
  link: string | null;
  links: string;
  item_created_at: string | null;
  last_seen: string;
  metrics: string;
}

export interface InputItem {
  source: Platform;
  url: string;
  title: string;
  text: string;
  author?: string;
  fetched_at: string;
  metrics: {
    current: Metrics;
    delta_24h?: Record<string, unknown>;
    delta_72h?: Record<string, unknown>;
    item_created_at: string | null;
  };
}

export interface ProjectInput {
  project_key: string;
  project_url: string;
  items: InputItem[];
  mentions: { source: Platform; url: string; title: string; created_at: string | null; metrics?: Metrics }[];
  previous?: { hype_score: number | null; stage: string | null; status: string; post_count: number; last_post_at: string | null; metrics_at_last_post: Record<string, number> };
  /** Code-side velocity summary (what the "anomalous speed" rule checks). */
  velocity: Velocity;
}

export interface Velocity {
  stars_24h: number;
  stars_week: number; // GitHub Trending weekly figure — ranking only, never "anomalous speed"
  hn_points: number;
  reddit_upvotes: number;
  hf_likes_24h: number;
  platforms: number;
  mentions: number;
  measured: boolean; // at least one real counter delta (not just a list position)
}

/** Heuristic pre-ranking so the model sees the 30 most promising projects, not 600. Not the hype score. */
export function preScore(v: Velocity): number {
  return Math.max(v.stars_24h, v.stars_week / 7) / 250 + v.hn_points / 80 + v.reddit_upvotes / 250 + v.hf_likes_24h / 40 + (v.platforms - 1) * 1.5 + Math.min(v.mentions, 5);
}

export function isAnomalous(v: Velocity, cfg: Config): boolean {
  return (
    v.measured &&
    (v.stars_24h >= cfg.ANOMALY_STARS_24H ||
      v.hn_points >= cfg.ANOMALY_HN_POINTS_24H ||
      v.reddit_upvotes >= cfg.ANOMALY_REDDIT_24H ||
      v.hf_likes_24h >= cfg.ANOMALY_HF_LIKES_24H)
  );
}

const num = (x: unknown) => (typeof x === "number" ? x : 0);

export function buildCandidates(db: Db, cfg: Config): ProjectInput[] {
  const since = hoursAgo(cfg.ITEM_WINDOW_HOURS);
  const projects = db.all<{
    key: string; url: string; last_scan_at: string | null; last_scan_metrics: string | null; hype_score: number | null;
    stage: string | null; status: string; post_count: number; last_post_at: string | null; published_metrics: string | null; version: number | null;
  }>(
    `SELECT key, url, json_extract(scan, '$.version') AS version, last_scan_at, last_scan_metrics, hype_score, stage, status, post_count, last_post_at, published_metrics
     FROM projects WHERE merged_into IS NULL AND last_seen >= ?`,
    since,
  );
  // Context mentions: press, Telegram, Bluesky, posts that link nowhere specific.
  const loose = db.all<ItemRow>(
    `SELECT id, url, platform, title, text, author, link, links, item_created_at, last_seen, metrics FROM items
     WHERE project_key IS NULL AND last_seen >= ? AND (item_created_at IS NULL OR item_created_at >= ?)`,
    since, since,
  );
  const out: (ProjectInput & { pre: number })[] = [];
  for (const p of projects) {
    // The project exists because one sighting was AI-related; its other sightings count even without keywords
    // ("Show HN: spy satellite sim" about an AI repo).
    const rows = db.all<ItemRow>(
      `SELECT id, url, platform, title, text, author, link, links, item_created_at, last_seen, metrics FROM items
       WHERE project_key = ? AND last_seen >= ? ORDER BY last_seen DESC LIMIT 8`,
      p.key, since,
    );
    if (!rows.length) continue;
    const name = p.key.slice(p.key.indexOf(":") + 1).split("/").pop() ?? "";
    const mentions = loose
      .filter((m) => json<string[]>(m.links, []).some((l) => projectKeyOf(l) === p.key) || nameMentioned(name, `${m.title} ${m.text}`))
      .slice(0, 8);
    const items: InputItem[] = rows.map((r) => {
      const current = json<Metrics>(r.metrics, {});
      return {
        source: r.platform,
        url: r.url,
        title: r.title,
        text: r.text.slice(0, 400),
        ...(r.author ? { author: r.author } : {}),
        fetched_at: r.last_seen,
        metrics: { current, ...itemDeltas(db, r.id, r.platform, current, r.item_created_at), item_created_at: r.item_created_at },
      };
    });
    const v: Velocity = { stars_24h: 0, stars_week: 0, hn_points: 0, reddit_upvotes: 0, hf_likes_24h: 0, platforms: 0, mentions: mentions.length, measured: false };
    const platforms = new Set<string>([...items.map((i) => i.source), ...mentions.map((m) => m.platform)]);
    v.platforms = platforms.size;
    for (const it of items) {
      const d = it.metrics.delta_24h ?? {};
      const fresh = it.metrics.item_created_at && it.metrics.item_created_at >= hoursAgo(24);
      if (it.source === "github") {
        const s = Math.max(num(d.stars), num(it.metrics.current.stars_today));
        if (s > v.stars_24h) v.stars_24h = s;
        v.stars_week = Math.max(v.stars_week, num(it.metrics.current.stars_week), num((it.metrics.delta_72h ?? {}).stars));
        if (num(d.stars) > 0 || num(it.metrics.current.stars_today) > 0) v.measured = true;
      } else if (it.source === "hn") {
        const pts = d.points !== undefined ? num(d.points) : fresh ? num(it.metrics.current.points) : 0;
        v.hn_points = Math.max(v.hn_points, pts);
        if (pts > 0) v.measured = true;
      } else if (it.source === "reddit") {
        const up = d.upvotes !== undefined ? num(d.upvotes) : fresh ? num(it.metrics.current.upvotes) : 0;
        v.reddit_upvotes = Math.max(v.reddit_upvotes, up);
        if (up > 0) v.measured = true;
      } else if (it.source === "huggingface") {
        const l = num(d.likes);
        v.hf_likes_24h = Math.max(v.hf_likes_24h, l);
        if (l > 0) v.measured = true;
      }
    }
    const headline = projectHeadline(db, p.key);
    // Rescan throttle: a project already judged recently is shown again only if it grew noticeably.
    // A verdict from an older prompt version is redone at once.
    const stale = p.last_scan_at !== null && p.version !== SCAN_VERSION;
    if (!stale && p.last_scan_at && p.last_scan_at >= hoursAgo(cfg.RESCAN_HOURS) && growthRatio(json(p.last_scan_metrics, {}), headline) < cfg.RESCAN_GROWTH)
      continue;
    if (!stale && p.status === "skip" && growthRatio(json(p.last_scan_metrics, {}), headline) < cfg.UPDATE_GROWTH) continue;
    const pre = preScore(v);
    if (pre < 1) continue;
    out.push({
      project_key: p.key,
      project_url: p.url,
      items,
      mentions: mentions.map((m) => ({
        source: m.platform, url: m.url, title: m.title, created_at: m.item_created_at,
        ...(Object.keys(json<Metrics>(m.metrics, {})).length ? { metrics: json<Metrics>(m.metrics, {}) } : {}),
      })),
      ...(p.last_scan_at || p.post_count
        ? { previous: { hype_score: p.hype_score, stage: p.stage, status: p.status, post_count: p.post_count, last_post_at: p.last_post_at, metrics_at_last_post: json(p.published_metrics, {}) } }
        : {}),
      velocity: v,
      pre,
    });
  }
  return out
    .sort((a, b) => b.pre - a.pre)
    .slice(0, cfg.MAX_SCAN_CANDIDATES)
    .map(({ pre: _pre, ...rest }) => rest);
}
