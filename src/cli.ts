import { config } from "./config.ts";
import { runCycle } from "./cycle.ts";
import { Db } from "./db.ts";
import { Llm } from "./llm.ts";
import { log } from "./log.ts";
import { buildCandidates } from "./pipeline/candidates.ts";
import { collectAll, refreshTrackedRepos } from "./pipeline/collect.ts";
import { maybeDigest } from "./pipeline/digest.ts";
import { queuePosts } from "./pipeline/editorial.ts";
import { drain } from "./pipeline/publish.ts";
import { scan } from "./pipeline/scan.ts";
import { systemPrompt } from "./prompt.ts";
import { loadSeeds, syncSeeds } from "./sources.ts";
import { Telegram } from "./telegram.ts";

const HELP = `Usage: node src/cli.ts <command>
  cycle               full cycle (what the scheduler runs hourly)
  collect [keys...]   fetch sources (optionally only the given source keys)
  candidates [n]      print what the next scan would see (top n projects with measured velocity)
  scan                run the AI scan on current candidates
  posts-queue         choose and write this run's posts
  digest              build today's digest now (ignores the hour)
  publish             deliver pending publications
  posts [n]           print the latest n generated texts
  projects [n]        print the latest scan verdicts
  prompt [mode]       print the filled system prompt (scan | single_post | daily_digest)
  sources             source health table`;

const [cmd = "help", ...args] = process.argv.slice(2);

const db = new Db(config.DATABASE_PATH);
syncSeeds(db, loadSeeds(config.SOURCES_FILE));
const llm = new Llm(db, config);
const tg = () => (config.TELEGRAM_BOT_TOKEN ? new Telegram(config.TELEGRAM_BOT_TOKEN) : null);

try {
  switch (cmd) {
    case "cycle":
      console.log(JSON.stringify(await runCycle(db, config), null, 1));
      break;
    case "collect":
      console.log(await collectAll(db, config, args), await refreshTrackedRepos(db, config));
      break;
    case "candidates":
      console.log(JSON.stringify(buildCandidates(db, config).slice(0, Number(args[0] ?? 10)), null, 1));
      break;
    case "scan":
      console.log(await scan(db, llm, config));
      break;
    case "posts-queue":
      console.log(await queuePosts(db, llm, config));
      break;
    case "digest":
      console.log(await maybeDigest(db, llm, config, true));
      break;
    case "publish":
      console.log(await drain(db, config, tg()));
      break;
    case "posts": {
      const rows = db.all<{ id: number; status: string; kind: string; channel: string; text: string }>(
        "SELECT id, status, kind, channel, text FROM publications ORDER BY id DESC LIMIT ?",
        Number(args[0] ?? 10),
      );
      for (const r of rows.reverse()) console.log(`\n──── #${r.id} [${r.kind} · ${r.status} · ${r.channel}] ────\n${r.text}`);
      break;
    }
    case "projects":
      console.table(
        db.all(
          `SELECT key, name, hype_score AS hype, stage, status, post_count AS posts, substr(last_scan_at, 1, 16) AS scanned
           FROM projects WHERE last_scan_at IS NOT NULL AND merged_into IS NULL ORDER BY last_scan_at DESC, hype_score DESC LIMIT ?`,
          Number(args[0] ?? 30),
        ),
      );
      break;
    case "prompt":
      console.log(systemPrompt(config, (args[0] as "scan") ?? "scan"));
      break;
    case "sources":
      console.table(db.all("SELECT key, kind, enabled, total_items AS items, consecutive_failures AS fails, substr(last_error, 1, 60) AS error FROM sources ORDER BY id"));
      break;
    default:
      console.log(HELP);
  }
} catch (e) {
  log.error("command failed", { cmd, err: e instanceof Error ? e.stack : String(e) });
  process.exitCode = 1;
} finally {
  db.close();
}
