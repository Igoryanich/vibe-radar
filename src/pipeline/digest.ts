import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Llm } from "../llm.ts";
import { hoursAgo, localDate, localHour, nowIso } from "../util.ts";
import { allowedLinks, channelPostLink, type ProjectRow, selectedItem, trustedFacts, writeChecked } from "./editorial.ts";

const COLS = "id, key, name, url, scan, hype_score, stage, status, post_count, last_post_at, last_post_message_id, published_metrics";

/** Projects for today's digest: main list (by hype) and up to three early signals "on the radar". */
export function digestSelection(db: Db, cfg: Config) {
  const since = hoursAgo(24);
  const main = db.all<ProjectRow>(
    `SELECT ${COLS} FROM projects WHERE merged_into IS NULL AND last_scan_at >= ? AND status IN ('publish_post','digest_only')
       AND hype_score >= ? ORDER BY hype_score DESC, last_scan_at DESC LIMIT ?`,
    since, cfg.DIGEST_THRESHOLD, cfg.DIGEST_MAX_ITEMS,
  );
  const ids = new Set(main.map((p) => p.id));
  const radar = db
    .all<ProjectRow>(
      `SELECT ${COLS} FROM projects WHERE merged_into IS NULL AND last_scan_at >= ? AND status IN ('publish_post','digest_only')
         AND stage = 'ранний сигнал' AND hype_score >= 3 ORDER BY hype_score DESC, last_scan_at DESC LIMIT 6`,
      since,
    )
    .filter((p) => !ids.has(p.id))
    .slice(0, 3);
  return { main, radar };
}

/** Once a day after DIGEST_HOUR_LOCAL: build and queue "what blew up the AI internet today". */
export async function maybeDigest(db: Db, llm: Llm, cfg: Config, force = false) {
  const day = localDate(cfg.TIMEZONE);
  if (!force && localHour(cfg.TIMEZONE) < cfg.DIGEST_HOUR_LOCAL) return { skipped: "not yet" };
  if (!force && db.kvGet("digest:last") === day) return { skipped: "already done today" };
  const { main, radar } = digestSelection(db, cfg);
  if (main.length < cfg.DIGEST_MIN_ITEMS) {
    db.kvSet("digest:last", day);
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
    trustedFacts(all), links, cfg.DIGEST_MAX_CHARS,
  );
  if ("error" in res) return { error: res.error };
  const channel = cfg.DRY_RUN ? "dry-run" : cfg.TELEGRAM_CHANNEL_ID;
  db.run(
    `INSERT INTO publications(key, channel, kind, text, extra, status, priority, created_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(key, channel) DO NOTHING`,
    `digest:${day}`, channel, "digest", res.text, JSON.stringify({ link_preview_options: { is_disabled: true } }), "pending", 100, nowIso(),
  );
  db.kvSet("digest:last", day);
  return { queued: true, items: selected.length, radar: onRadar.length };
}
