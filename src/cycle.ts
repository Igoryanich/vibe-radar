import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { Llm } from "./llm.ts";
import { errMsg, log } from "./log.ts";
import { collectAll, refreshTrackedRepos } from "./pipeline/collect.ts";
import { maybeDigest } from "./pipeline/digest.ts";
import { queuePosts } from "./pipeline/editorial.ts";
import { prune, sourceHealth } from "./pipeline/maintenance.ts";
import { drain } from "./pipeline/publish.ts";
import { scan } from "./pipeline/scan.ts";
import { Telegram } from "./telegram.ts";
import { nowIso } from "./util.ts";

/** One cycle: collect → measure → scan → select → write → publish. Each stage is isolated. */
export async function runCycle(db: Db, cfg: Config): Promise<Record<string, unknown>> {
  const runId = Number(db.run("INSERT INTO runs(started_at) VALUES(?)", nowIso()).lastInsertRowid);
  const stats: Record<string, unknown> = {};
  const llm = new Llm(db, cfg);
  const tg = cfg.TELEGRAM_BOT_TOKEN ? new Telegram(cfg.TELEGRAM_BOT_TOKEN) : null;
  const stage = async (name: string, fn: () => Promise<unknown> | unknown) => {
    const t0 = Date.now();
    try {
      stats[name] = await fn();
    } catch (e) {
      stats[name] = { error: errMsg(e) };
      log.error(`stage ${name} failed`, { err: e instanceof Error ? e.stack : String(e) });
    }
    log.info(`stage ${name}`, { ms: Date.now() - t0 });
  };

  await stage("collect", async () => {
    const s = await collectAll(db, cfg);
    return { ...s, errors: Object.keys(s.errors) };
  });
  await stage("refresh", () => refreshTrackedRepos(db, cfg));
  if (llm.enabled) {
    await stage("scan", () => scan(db, llm, cfg));
    await stage("posts", () => queuePosts(db, llm, cfg));
    await stage("digest", () => maybeDigest(db, llm, cfg));
  } else stats.llm = "GEMINI_API_KEY not set — scan and writing skipped";
  await stage("publish", () => drain(db, cfg, tg));
  await stage("health", () => sourceHealth(db));
  await stage("prune", () => prune(db));
  stats.llm_calls = llm.calls;
  db.run("UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?", nowIso(), JSON.stringify(stats), runId);
  return stats;
}
