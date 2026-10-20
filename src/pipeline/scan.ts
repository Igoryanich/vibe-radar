import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Llm } from "../llm.ts";
import { log } from "../log.ts";
import { projectHeadline } from "../metrics.ts";
import { bigCompanyOwner } from "../projects.ts";
import { systemPrompt } from "../prompt.ts";
import { nowIso } from "../util.ts";
import { buildCandidates, type ProjectInput } from "./candidates.ts";

export const SCAN_VERSION = 4;

const STAGES = ["ранний сигнал", "взлетает", "мейнстрим"] as const;
export type Stage = (typeof STAGES)[number];

const stage = z.string().transform((s, ctx) => {
  const t = s.toLowerCase().replace(/ё/g, "е").trim();
  if (/ранн|early/.test(t)) return "ранний сигнал" as Stage;
  if (/взлет|rising|takeoff/.test(t)) return "взлетает" as Stage;
  if (/мейнстрим|mainstream/.test(t)) return "мейнстрим" as Stage;
  ctx.addIssue({ code: "custom", message: `stage must be one of: ${STAGES.join(" | ")}` });
  return z.NEVER;
});

const CATEGORIES = ["indie", "opensource", "big_tech", "viral_demo", "vibe_tool"] as const;
type Category = (typeof CATEGORIES)[number];

const ANGLES = ["new_project", "growing", "new_feature", "news"] as const;
type Angle = (typeof ANGLES)[number];

const angle = z.string().transform((s, ctx) => {
  const t = s.toLowerCase().trim().replace(/[\s-]+/g, "_");
  if ((ANGLES as readonly string[]).includes(t)) return t as Angle;
  ctx.addIssue({ code: "custom", message: `angle must be one of: ${ANGLES.join(" | ")}` });
  return z.NEVER;
});

const evidence = z.object({
  source: z.string().catch(""),
  url: z.string().catch(""),
  metric: z.coerce.string().catch(""),
  metric_from_input: z.boolean().catch(false),
});

export const candidateSchema = z.object({
  project_keys: z.array(z.string()).min(1),
  name: z.string().min(1),
  url: z.string().catch(""),
  author: z.string().nullable().catch("").transform((s) => s ?? ""),
  // Required: it becomes the post hashtag, so a wrong value is a schema error (one repair retry), not a silent default.
  category: z.string().transform((s, ctx) => {
    const t = s.toLowerCase().trim().replace(/[\s-]+/g, "_");
    if ((CATEGORIES as readonly string[]).includes(t)) return t as Category;
    ctx.addIssue({ code: "custom", message: `category must be one of: ${CATEGORIES.join(" | ")}` });
    return z.NEVER;
  }),
  angle,
  summary: z.string().catch(""),
  hype_score: z.coerce.number().transform((n) => Math.max(1, Math.min(10, Math.round(n)))),
  stage,
  evidence: z.array(evidence).catch([]),
  first_seen_at: z.string().nullable().catch("").transform((s) => s ?? ""),
  source_of_first_signal: z.string().nullable().catch("").transform((s) => s ?? ""),
  why_viral: z.string().catch(""),
  risks: z.string().catch(""),
  availability: z.string().catch("неизвестно"),
  media_suggestion: z.string().nullable().catch("").transform((s) => s ?? ""),
  is_update: z.boolean().catch(false),
  update_reason: z.string().nullable().catch("").transform((s) => s ?? ""),
  status: z.enum(["publish_post", "digest_only", "skip", "needs_check"]),
  skip_reason: z.string().nullable().catch("").transform((s) => s ?? ""),
});
export type Candidate = z.infer<typeof candidateSchema>;

const scanSchema = z.object({ candidates: z.array(candidateSchema) });

const BATCH = 12;

/** Ask the model to judge the current candidates; store its verdict on each project. */
export async function scan(db: Db, llm: Llm, cfg: Config) {
  const inputs = buildCandidates(db, cfg);
  if (!inputs.length) return { candidates: 0 };
  let judged = 0;
  let merged = 0;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const scanId = Number(db.run("INSERT INTO scans(at, mode, input) VALUES(?, 'scan', ?)", nowIso(), JSON.stringify(batch)).lastInsertRowid);
    const res = await llm.json({
      system: systemPrompt(cfg, "scan"),
      user: `INPUT_ITEMS (${batch.length} проектов):\n${JSON.stringify(batch)}`,
      schema: scanSchema,
      tier: "editor",
      maxTokens: 16000,
      temperature: 0.2,
    });
    db.run("UPDATE scans SET output = ? WHERE id = ?", JSON.stringify(res), scanId);
    const r = applyScan(db, batch, res.candidates);
    judged += r.judged;
    merged += r.merged;
  }
  return { candidates: inputs.length, judged, merged };
}

/** Pick the key that best represents a merged project: a repo beats a Space beats a site beats a PH page. */
export function primaryKey(keys: string[]): string {
  const rank = (k: string) => (k.startsWith("gh:") ? 0 : k.startsWith("hf:") ? 1 : k.startsWith("web:") ? 2 : 3);
  return [...keys].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Channel concept, enforced in code: projects people built, not industry news. Big-company releases and
 * stories about events (incidents, money) are skipped whatever the model's status says.
 */
export function conceptSkip(c: Candidate, keys: string[]): string | null {
  if (c.category === "big_tech") return "релиз крупной компании — не тема канала";
  const owner = keys.map(bigCompanyOwner).find(Boolean);
  if (owner) return `репозиторий крупной компании (${owner}) — не тема канала`;
  if (c.angle === "news") return "новость вокруг проекта, а не сам проект — не тема канала";
  return null;
}

export function applyScan(db: Db, inputs: ProjectInput[], candidates: Candidate[]) {
  const known = new Map(inputs.map((p) => [p.project_key, p]));
  let judged = 0;
  let merged = 0;
  db.tx(() => {
    for (const raw of candidates) {
      const keys = [...new Set(raw.project_keys)].filter((k) => known.has(k));
      if (!keys.length) {
        log.warn("scan returned a candidate with no known project_key", { name: raw.name, keys: raw.project_keys });
        continue;
      }
      const off = conceptSkip(raw, keys);
      const c: Candidate = off && raw.status !== "skip" ? { ...raw, status: "skip", skip_reason: off } : raw;
      const primary = primaryKey(keys);
      for (const k of keys) {
        if (k === primary) continue;
        db.run("UPDATE projects SET merged_into = ? WHERE key = ?", primary, k);
        db.run("UPDATE items SET project_key = ? WHERE project_key = ?", primary, k);
        merged++;
      }
      // A merged project is as fast as its fastest sighting.
      const velocity = keys
        .map((k) => known.get(k)!.velocity)
        .reduce((a, v) => ({
          stars_24h: Math.max(a.stars_24h, v.stars_24h),
          stars_week: Math.max(a.stars_week, v.stars_week),
          hn_points: Math.max(a.hn_points, v.hn_points),
          reddit_upvotes: Math.max(a.reddit_upvotes, v.reddit_upvotes),
          hf_likes_24h: Math.max(a.hf_likes_24h, v.hf_likes_24h),
          platforms: Math.max(a.platforms, v.platforms),
          mentions: a.mentions + v.mentions,
          measured: a.measured || v.measured,
        }));
      db.run(
        `UPDATE projects SET name = ?, scan = ?, hype_score = ?, stage = ?, status = ?, last_scan_at = ?, last_scan_metrics = ? WHERE key = ?`,
        c.name.slice(0, 120), JSON.stringify({ ...c, velocity, version: SCAN_VERSION }), c.hype_score, c.stage, c.status, nowIso(),
        JSON.stringify(projectHeadline(db, primary)), primary,
      );
      judged++;
    }
  });
  return { judged, merged };
}
