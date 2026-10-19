import { existsSync } from "node:fs";
import { z } from "zod";

// All runtime settings come from the environment (.env locally, secrets/vars in Actions).
if (existsSync(".env")) process.loadEnvFile(".env");

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : /^(1|true|yes)$/i.test(v.trim())));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : Number.parseFloat(v)))
    .pipe(z.number().nonnegative());
const str = (def = "") =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : v.trim()));

const schema = z.object({
  CHANNEL_NAME: str("Вайб-радар"),
  DATABASE_PATH: str("data/radar.db"),
  SOURCES_FILE: str("config/sources.yaml"),
  PROMPT_FILE: str("prompts/system.md"),
  REFERENCE_FILE: str("prompts/reference.md"),
  ANCHORS_FILE: str("prompts/anchors.md"),

  // --- LLM (same scheme as russia-nato-monitor: free Gemini chain + optional capped paid editor key)
  GEMINI_API_KEY: str(),
  LLM_MODELS: str("gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-2.5-flash-lite,gemma-4-31b-it"),
  LLM_EDITOR_MODELS: str("gemini-flash-latest,gemini-3.5-flash,gemini-flash-lite-latest,gemma-4-31b-it"),
  EMBED_MODEL: str("gemini-embedding-001"),
  GEMINI_PAID_API_KEY: str(),
  PAID_EDITOR_MODEL: str("gemini-3.8-flash"),
  PAID_DAILY_BUDGET_EUR: num(0.24),
  PAID_PRICE_IN_PER_M: num(0.75),
  PAID_PRICE_OUT_PER_M: num(3.75),
  LLM_MIN_INTERVAL_MS: int(4500),
  LLM_MAX_CALLS_PER_RUN: int(25),
  LLM_MAX_CALLS_PER_DAY: int(400),

  // --- Collection
  // GitHub token raises the search/API limits (Actions passes its own GITHUB_TOKEN automatically).
  GITHUB_TOKEN: str(),
  // A repo younger than this many days is "young" for the GitHub search collector.
  GITHUB_YOUNG_DAYS: int(14),
  GITHUB_MIN_STARS: int(150),
  // How many already-tracked repos get a fresh star count per run (needed for 24h/72h deltas).
  GITHUB_REFRESH_PER_RUN: int(60),
  ITEM_WINDOW_HOURS: int(72),

  // --- Selection (code-side thresholds from the prompt)
  MAX_SCAN_CANDIDATES: int(30),
  // A project is rescanned at most this often unless its metrics grew ≥ RESCAN_GROWTH×.
  RESCAN_HOURS: int(6),
  RESCAN_GROWTH: num(1.5),
  POST_THRESHOLD: int(7),
  EARLY_POST_THRESHOLD: int(6),
  DIGEST_THRESHOLD: int(4),
  // "Anomalous velocity" (verified from collected metrics) that lets a 6/early-signal project get its own post.
  ANOMALY_STARS_24H: int(1000),
  ANOMALY_HN_POINTS_24H: int(300),
  ANOMALY_REDDIT_24H: int(800),
  ANOMALY_HF_LIKES_24H: int(150),
  // A repeat post needs ≥ this growth of the main metric since the previous post (or a non-metric news + cooldown).
  UPDATE_GROWTH: num(3),
  UPDATE_COOLDOWN_HOURS: int(48),
  MAX_POSTS_PER_RUN: int(2),
  MAX_POSTS_PER_DAY: int(6),
  POST_MAX_CHARS: int(1800),
  DIGEST_MAX_CHARS: int(3600),
  DIGEST_MIN_ITEMS: int(3),
  DIGEST_MAX_ITEMS: int(10),
  DIGEST_HOUR_LOCAL: int(21),
  TIMEZONE: str("Europe/Helsinki"),

  // --- Telegram (auto-posting: everything that passes the checks goes straight to the channel)
  DRY_RUN: bool.transform((v) => v ?? true),
  TELEGRAM_BOT_TOKEN: str(),
  TELEGRAM_CHANNEL_ID: str(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
