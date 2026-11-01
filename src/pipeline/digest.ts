import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import type { Llm } from "../llm.ts";
import { hoursAgo, localDate, localHour, nowIso } from "../util.ts";
import { allowedLinks, channelPostLink, currentScan, type ProjectRow, selectedItem, trustedFacts, writeChecked } from "./editorial.ts";
import { type Candidate, CONCEPT_VERSION, conceptSkip } from "./scan.ts";

const COLS = "id, key, name, url, scan, hype_score, stage, status, post_count, last_post_at, last_post_message_id, published_metrics";

/** Projects for today's digest: main list (by hype) and up to three early signals "on the radar". */
export function digestSelection(db: Db, cfg: Config) {
  const since = hoursAgo(24);
  const main = db.all<ProjectRow>(
    `SELECT ${COLS} FROM projects WHERE merged_into IS NULL AND last_scan_at >= ? AND status IN ('publish_post','digest_only')
       AND hype_score >= ? ORDER BY hype_score DESC, last_scan_at DESC LIMIT ?`,
    since, cfg.DIGEST_THRESHOLD, cfg.DIGEST_MAX_ITEMS * 3,
  ).filter(currentScan).slice(0, cfg.DIGEST_MAX_ITEMS);
  const ids = new Set(main.map((p) => p.id));
  const radar = db
    .all<ProjectRow>(
      `SELECT ${COLS} FROM projects WHERE merged_into IS NULL AND last_scan_at >= ? AND status IN ('publish_post','digest_only')
         AND stage = 'ранний сигнал' AND hype_score >= 3 ORDER BY hype_score DESC, last_scan_at DESC LIMIT 6`,
      since,
    )
    .filter((p) => !ids.has(p.id) && currentScan(p))
    .slice(0, 3);
  return { main, radar };
}

/**
 * Which day an evening digest is due for: today after DIGEST_HOUR_LOCAL, or — if the evening one failed or no run
 * came before midnight — yesterday, until DIGEST_CATCHUP_HOUR. `promptNow` dates the header.
 */
function dueDay(db: Db, cfg: Config, doneKey: string, force: boolean, now: number): { day: string; promptNow: Date } | { skipped: string } {
  const hour = localHour(cfg.TIMEZONE, new Date(now));
  const last = db.kvGet(doneKey);
  let day = localDate(cfg.TIMEZONE, new Date(now));
  let promptNow = new Date(now);
  if (!force && hour < cfg.DIGEST_HOUR_LOCAL) {
    const yesterday = localDate(cfg.TIMEZONE, new Date(now - 24 * 3600_000));
    if (hour >= cfg.DIGEST_CATCHUP_HOUR || !last || last >= yesterday) return { skipped: "not yet" };
    day = yesterday;
    promptNow = new Date(now - (hour + 1) * 3600_000); // late yesterday evening
  }
  if (!force && last === day) return { skipped: "already done today" };
  return { day, promptNow };
}

/** Once a day after DIGEST_HOUR_LOCAL: build and queue "what blew up the AI internet today". */
export async function maybeDigest(db: Db, llm: Llm, cfg: Config, force = false, now = Date.now()) {
  // Tracked per mode: a test-mode digest must not stop the real one on the day publishing is switched on.
  const doneKey = `digest:last:${cfg.DRY_RUN ? "dry-run" : "live"}`;
  const due = dueDay(db, cfg, doneKey, force, now);
  if ("skipped" in due) return due;
  const { day, promptNow } = due;
  const { main, radar } = digestSelection(db, cfg);
  if (main.length < cfg.DIGEST_MIN_ITEMS) {
    db.kvSet(doneKey, day);
    return { skipped: `only ${main.length} projects ≥ ${cfg.DIGEST_THRESHOLD} today` };
  }
  const recentPost = (p: ProjectRow) =>
    p.last_post_at && p.last_post_at >= hoursAgo(24) ? channelPostLink(cfg.TELEGRAM_CHANNEL_ID, p.last_post_message_id) : null;
  const toItem = (p: ProjectRow) => {
    const s = selectedItem(db, p, cfg);
    const post = recentPost(p);
    return { ...s, ...(post ? { our_post_today: post } : {}) };
  };
  const selected = main.map(toItem);
  const onRadar = radar.map(toItem);
  const history = main
    .filter((p) => recentPost(p))
    .map((p) => ({ name: p.name, url: recentPost(p), published_at: p.last_post_at, format: "post" }));
  const all = [...selected, ...onRadar];
  const links = allowedLinks(all.map((s) => ({ ...s, previous_post: { url: s.our_post_today ?? null } })));
  const res = await writeChecked(
    llm, cfg, "daily_digest",
    `SELECTED_ITEMS (основной список):\n${JSON.stringify(selected)}\n\nНА РАДАРЕ (ранние сигналы, по одной строке):\n${JSON.stringify(onRadar)}\n\nPUBLISHED_HISTORY (отдельные посты за сутки — в дайджесте одной строкой со ссылкой на наш пост или пропусти):\n${JSON.stringify(history)}`,
    trustedFacts(all), links, cfg.DIGEST_MAX_CHARS, promptNow,
  );
  if ("error" in res) return { error: res.error };
  const channel = cfg.DRY_RUN ? "dry-run" : cfg.TELEGRAM_CHANNEL_ID;
  db.run(
    `INSERT INTO publications(key, channel, kind, text, extra, status, priority, created_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(key, channel) DO NOTHING`,
    `digest:${day}`, channel, "digest", res.text, JSON.stringify({ link_preview_options: { is_disabled: true } }), "pending", 100, nowIso(),
  );
  db.kvSet(doneKey, day);
  return { queued: true, items: selected.length, radar: onRadar.length };
}

type Scan = Candidate & { version?: number };

/** Biggest measured 7-day growth of a project's headline counter (stars / points / upvotes / likes). */
function weekGrowth(item: { items: { metrics: Record<string, unknown> }[] }): number {
  let best = 0;
  for (const it of item.items) {
    const d = it.metrics.delta_7d as Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(d ?? {})) if (k !== "observed_hours" && typeof v === "number") best = Math.max(best, v);
  }
  return best;
}

/**
 * The week's top projects: everything judged worth a digest in the last 7 days, plus projects we posted about
 * (a rescan after our post turns them into "skip: no news", but they still belong in the week's top).
 * Ranked by hype score, then by measured 7-day growth.
 */
export function weeklySelection(db: Db, cfg: Config) {
  const since = hoursAgo(24 * 7);
  return db
    .all<ProjectRow>(
      `SELECT ${COLS} FROM projects WHERE merged_into IS NULL AND last_scan_at >= ? AND hype_score >= ?
         AND (status IN ('publish_post','digest_only') OR (post_count > 0 AND last_post_at >= ? AND status != 'needs_check'))
       ORDER BY hype_score DESC, last_scan_at DESC LIMIT 60`,
      since, cfg.DIGEST_THRESHOLD, since,
    )
    .filter((p) => {
      const s = json<Scan | null>(p.scan, null);
      return !!s && (s.version ?? 0) >= CONCEPT_VERSION && conceptSkip(s, [p.key]) === null;
    })
    .map((p) => ({ p, item: selectedItem(db, p, cfg, { windowHours: 24 * 7, withWeek: true }) }))
    .map((x) => ({ ...x, growth: weekGrowth(x.item) }))
    .sort((a, b) => (b.p.hype_score ?? 0) - (a.p.hype_score ?? 0) || b.growth - a.growth)
    .slice(0, cfg.WEEKLY_MAX_ITEMS);
}

/** Every evening, right after the daily digest: "top projects of the last 7 days". */
export async function maybeWeekly(db: Db, llm: Llm, cfg: Config, force = false, now = Date.now()) {
  if (!cfg.WEEKLY_DIGEST && !force) return { skipped: "disabled" };
  const doneKey = `weekly:last:${cfg.DRY_RUN ? "dry-run" : "live"}`;
  const due = dueDay(db, cfg, doneKey, force, now);
  if ("skipped" in due) return due;
  const { day, promptNow } = due;
  const top = weeklySelection(db, cfg);
  if (top.length < cfg.WEEKLY_MIN_ITEMS) {
    db.kvSet(doneKey, day);
    return { skipped: `only ${top.length} projects this week` };
  }
  // The link to our own post, spelled out so the writer cannot confuse it with the project link.
  const selected = top.map((x) => ({ ...x.item, ...(x.item.previous_post?.url ? { our_post_url: x.item.previous_post.url } : {}) }));
  const res = await writeChecked(
    llm, cfg, "weekly_digest",
    `SELECTED_ITEMS (топ недели, уже отсортирован: балл, затем измеренный рост за 7 дней; our_post_url — ссылка на наш пост о проекте, если он был):\n${JSON.stringify(selected)}`,
    trustedFacts(selected), allowedLinks(selected), cfg.DIGEST_MAX_CHARS, promptNow,
  );
  if ("error" in res) return { error: res.error };
  const channel = cfg.DRY_RUN ? "dry-run" : cfg.TELEGRAM_CHANNEL_ID;
  db.run(
    `INSERT INTO publications(key, channel, kind, text, extra, status, priority, created_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(key, channel) DO NOTHING`,
    // Priority just below the daily digest (100), so it goes out right after it.
    `weekly:${day}`, channel, "weekly", res.text, JSON.stringify({ link_preview_options: { is_disabled: true } }), "pending", 99, nowIso(),
  );
  db.kvSet(doneKey, day);
  return { queued: true, items: selected.length };
}
