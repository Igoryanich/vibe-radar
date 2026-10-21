import { z } from "zod";
import type { Metrics, Platform } from "../collectors/types.ts";
import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import type { Llm } from "../llm.ts";
import { errMsg, log } from "../log.ts";
import { growthRatio, itemDeltas, projectHeadline } from "../metrics.ts";
import { systemPrompt } from "../prompt.ts";
import { checkPost, normalizeLink } from "../textcheck.ts";
import { hoursAgo, localDate, nowIso } from "../util.ts";
import { isAnomalous, type Velocity } from "./candidates.ts";
import { type Candidate, SCAN_VERSION } from "./scan.ts";

export interface ProjectRow {
  id: number;
  key: string;
  name: string;
  url: string;
  scan: string | null;
  hype_score: number | null;
  stage: string | null;
  status: string;
  post_count: number;
  last_post_at: string | null;
  last_post_message_id: number | null;
  published_metrics: string | null;
}

type Scan = Candidate & { velocity?: Velocity; version?: number };

/** A verdict from an older prompt (other rules) is never acted on; the project is rescanned first. */
export function currentScan(p: { scan: string | null }): boolean {
  return json<{ version?: number } | null>(p.scan, null)?.version === SCAN_VERSION;
}

export const textSchema = z.object({ text: z.string().min(1) });

/** Code-side copy of the prompt's thresholds: the model's verdict alone never publishes anything. */
export function postDecision(p: ProjectRow, cfg: Config): { ok: true; update: boolean } | { ok: false; reason: string } {
  const s = json<Scan | null>(p.scan, null);
  if (!s) return { ok: false, reason: "no scan" };
  if (s.version !== SCAN_VERSION) return { ok: false, reason: `scan v${s.version ?? 0} is stale (v${SCAN_VERSION})` };
  // The model scores; the code applies the threshold. Its post/digest choice is advisory, skip/needs_check is final.
  if (s.status !== "publish_post" && s.status !== "digest_only") return { ok: false, reason: `status ${s.status}` };
  const v = s.velocity;
  // A 7+ means many platforms (prompt scale); a score from one GitHub list alone is not enough reach.
  const strong = s.hype_score >= cfg.POST_THRESHOLD && !!v && v.platforms >= cfg.POST_MIN_PLATFORMS;
  const early = s.hype_score >= cfg.EARLY_POST_THRESHOLD && s.stage === "ранний сигнал" && !!v && isAnomalous(v, cfg);
  if (!strong && !early) return { ok: false, reason: `hype ${s.hype_score} / ${s.stage} below post threshold (platforms: ${v?.platforms ?? 0})` };
  if (p.post_count === 0) return { ok: true, update: false };
  // A repeat is an update, and only with real news: multiple growth, or a non-metric event after a cooldown.
  if (!s.is_update) return { ok: false, reason: "already posted, model saw no news" };
  return { ok: true, update: true };
}

export function updateAllowed(db: Db, p: ProjectRow, cfg: Config, now = Date.now()): boolean {
  const s = json<Scan | null>(p.scan, null);
  const ratio = growthRatio(json(p.published_metrics, {}), projectHeadline(db, p.key));
  if (ratio >= cfg.UPDATE_GROWTH) return true;
  const cooled = !p.last_post_at || Date.parse(p.last_post_at) <= now - cfg.UPDATE_COOLDOWN_HOURS * 3600_000;
  return cooled && !!s?.update_reason?.trim();
}

export function channelPostLink(channel: string, messageId: number | null): string | null {
  if (!messageId || !channel) return null;
  if (channel.startsWith("@")) return `https://t.me/${channel.slice(1)}/${messageId}`;
  if (/^-100\d+$/.test(channel)) return `https://t.me/c/${channel.slice(4)}/${messageId}`;
  return null;
}

/** Facts the writer may use for one project: the scan verdict plus fresh counters of every sighting. */
export function selectedItem(db: Db, p: ProjectRow, cfg: Config) {
  const s = json<Scan>(p.scan, {} as Scan);
  const items = db
    .all<{ id: number; url: string; platform: Platform; title: string; link: string | null; links: string; metrics: string; item_created_at: string | null; last_seen: string }>(
      "SELECT id, url, platform, title, link, links, metrics, item_created_at, last_seen FROM items WHERE project_key = ? AND last_seen >= ? ORDER BY last_seen DESC LIMIT 8",
      p.key, hoursAgo(cfg.ITEM_WINDOW_HOURS),
    )
    .map((r) => {
      const current = json<Metrics>(r.metrics, {});
      const outbound = [...new Set([r.link, ...json<string[]>(r.links, [])].filter((x): x is string => !!x && x !== r.url))].slice(0, 5);
      return { source: r.platform, url: r.url, title: r.title, ...(outbound.length ? { links: outbound } : {}), fetched_at: r.last_seen, metrics: { current, ...itemDeltas(db, r.id, r.platform, current, r.item_created_at) } };
    });
  const prevLink = channelPostLink(cfg.TELEGRAM_CHANNEL_ID, p.last_post_message_id);
  return {
    ...s,
    project_url: p.url,
    items,
    ...(p.post_count
      ? { previous_post: { url: prevLink, published_at: p.last_post_at, metrics_at_publish: json(p.published_metrics, {}) } }
      : {}),
  };
}

/**
 * Links a post may contain: only what the collectors saw (project page, sightings, their outbound links)
 * and our own earlier posts — never a URL the model produced (its `url`/`evidence` fields are not trusted).
 */
export function allowedLinks(selected: { project_url?: string; items?: { url: string; links?: string[] }[]; previous_post?: { url: string | null } }[]): Set<string> {
  const out = new Set<string>();
  const add = (u: string | null | undefined) => {
    if (u && /^https?:\/\//.test(u)) out.add(normalizeLink(u));
  };
  for (const s of selected) {
    add(s.project_url);
    for (const it of s.items ?? []) {
      add(it.url);
      for (const l of it.links ?? []) add(l);
    }
    add(s.previous_post?.url);
  }
  return out;
}

/** Numbers a post may cite: only counters the collectors measured (not the model's own scan text). */
export function trustedFacts(selected: { items?: unknown; previous_post?: unknown; velocity?: unknown }[]) {
  return selected.map((s) => ({ items: s.items, previous_post: s.previous_post, velocity: s.velocity }));
}

/** Write a text with the model and run it through the hard checks; one corrective retry. */
export async function writeChecked(
  llm: Llm,
  cfg: Config,
  mode: "single_post" | "daily_digest",
  user: string,
  data: unknown,
  links: Set<string>,
  maxChars: number,
  now = new Date(),
): Promise<{ text: string } | { error: string }> {
  let note = "";
  // A digest is one text for ten projects, so a single stubborn figure must not cost the whole day: one more try.
  const attempts = mode === "daily_digest" ? 3 : 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const r = await llm.json({ system: systemPrompt(cfg, mode, now), user: user + note, schema: textSchema, tier: "editor", maxTokens: 4096, temperature: 0.5 });
    const text = r.text.trim();
    const problems = checkPost(text, { maxChars, allowedLinks: links, data });
    if (!problems.length) return { text };
    log.warn("draft failed checks", { mode, problems, attempt });
    if (attempt === attempts - 1) return { error: problems.join("; ") };
    const figures = problems.some((p) => p.startsWith("цифры"))
      ? " Неподтверждённые числа удали из текста совсем (даже если они есть в summary / why_viral / evidence — это не измерения) или замени на измеренные из items[].metrics."
      : "";
    note = `\n\nПрошлый вариант не прошёл проверку: ${problems.join("; ")}. Исправь это (если превышена длина — сократи до ${Math.round(maxChars * 0.85)} знаков) и верни JSON заново.${figures}`;
  }
  return { error: "unreachable" };
}

/** Choose this run's posts, write them, queue them. */
export async function queuePosts(db: Db, llm: Llm, cfg: Config, now = Date.now()) {
  const today = localDate(cfg.TIMEZONE, new Date(now));
  const recent = db.all<{ created_at: string }>(
    "SELECT created_at FROM publications WHERE kind IN ('post','update') AND channel = ? AND status NOT IN ('failed','cancelled') AND created_at >= ?",
    cfg.DRY_RUN ? "dry-run" : cfg.TELEGRAM_CHANNEL_ID, new Date(now - 26 * 3600_000).toISOString(),
  );
  const sentToday = recent.filter((r) => localDate(cfg.TIMEZONE, new Date(r.created_at)) === today).length;
  let room = Math.min(cfg.MAX_POSTS_PER_RUN, cfg.MAX_POSTS_PER_DAY - sentToday);
  // Spread the day's posts: at most one per MIN_POST_GAP_MINUTES instead of bursts that use up the daily cap early.
  if (cfg.MIN_POST_GAP_MINUTES > 0) {
    const last = Math.max(0, ...recent.map((r) => Date.parse(r.created_at)));
    room = now - last < cfg.MIN_POST_GAP_MINUTES * 60_000 ? 0 : Math.min(room, 1);
  }
  const stats = { considered: 0, queued: 0, rejected: [] as string[], room };
  if (room <= 0) return stats;
  const rows = db.all<ProjectRow>(
    `SELECT id, key, name, url, scan, hype_score, stage, status, post_count, last_post_at, last_post_message_id, published_metrics
     FROM projects WHERE merged_into IS NULL AND status IN ('publish_post','digest_only') AND hype_score >= ? AND last_scan_at >= ? ORDER BY hype_score DESC, last_scan_at DESC`,
    Math.min(cfg.POST_THRESHOLD, cfg.EARLY_POST_THRESHOLD), hoursAgo(cfg.RESCAN_HOURS),
  );
  const channel = cfg.DRY_RUN ? "dry-run" : cfg.TELEGRAM_CHANNEL_ID;
  for (const p of rows) {
    if (room <= 0) break;
    stats.considered++;
    const d = postDecision(p, cfg);
    if (!d.ok) continue;
    if (d.update && !updateAllowed(db, p, cfg)) continue;
    const key = `post:${p.key}:${p.post_count}`;
    // Test-mode drafts (channel 'dry-run') don't block the real post once DRY_RUN is switched off.
    if (db.get("SELECT 1 FROM publications WHERE key = ? AND channel = ? AND status NOT IN ('failed','cancelled')", key, channel)) continue;
    const selected = selectedItem(db, p, cfg);
    let res: { text: string } | { error: string };
    try {
      res = await writeChecked(
        llm, cfg, "single_post",
        `SELECTED_ITEMS (${d.update ? "апдейт: о проекте уже был пост, см. previous_post — подай как «Помните…? Теперь…»" : "первый пост о проекте"}):\n${JSON.stringify([selected])}`,
        trustedFacts([selected]), allowedLinks([selected]), cfg.POST_MAX_CHARS,
      );
    } catch (e) {
      stats.rejected.push(`${p.key}: ${errMsg(e)}`);
      continue;
    }
    if ("error" in res) {
      stats.rejected.push(`${p.key}: ${res.error}`);
      continue;
    }
    const preview = selected.url && allowedLinks([selected]).has(normalizeLink(selected.url)) ? selected.url : p.url;
    const extra = {
      link_preview_options: { url: preview, prefer_large_media: true },
      ...(d.update && p.last_post_message_id ? { reply_parameters: { message_id: p.last_post_message_id, allow_sending_without_reply: true } } : {}),
    };
    db.run(
      `INSERT INTO publications(key, channel, project_id, kind, text, extra, status, priority, created_at) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(key, channel) DO NOTHING`,
      key, channel, p.id, d.update ? "update" : "post", res.text, JSON.stringify(extra), "pending", p.hype_score ?? 0, nowIso(),
    );
    stats.queued++;
    room--;
  }
  return stats;
}
