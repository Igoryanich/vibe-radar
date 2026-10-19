import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawItem } from "../src/collectors/types.ts";
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import type { Llm } from "../src/llm.ts";
import { buildCandidates } from "../src/pipeline/candidates.ts";
import { storeItem } from "../src/pipeline/collect.ts";
import { maybeDigest } from "../src/pipeline/digest.ts";
import { postDecision, queuePosts, type ProjectRow, updateAllowed } from "../src/pipeline/editorial.ts";
import { applyScan, type Candidate } from "../src/pipeline/scan.ts";
import { systemPrompt } from "../src/prompt.ts";

const H = 3600_000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();

const cfg = loadConfig({
  DATABASE_PATH: ":memory:",
  DRY_RUN: "true",
  TELEGRAM_CHANNEL_ID: "@vibe_radar",
  DIGEST_MIN_ITEMS: "1",
  LLM_MIN_INTERVAL_MS: "0",
});

function setup() {
  const db = new Db(":memory:");
  const src = (key: string, kind: string, platform: string, focused = 0) =>
    Number(db.run("INSERT INTO sources(key, name, kind, platform, url, focused, created_at) VALUES(?,?,?,?,?,?,?)", key, key, kind, platform, "https://example.org", focused, ago(0)).lastInsertRowid);
  const gh = { id: src("gh", "github_trending", "github"), platform: "github" as const, focused: 0 };
  const hn = { id: src("hn", "hn", "hn"), platform: "hn" as const, focused: 0 };
  const press = { id: src("press", "rss", "press", 1), platform: "press" as const, focused: 1 };
  const repo: RawItem = {
    url: "https://github.com/bilawalsidhu/gods-eye-view", title: "bilawalsidhu/gods-eye-view",
    text: "AI spy satellite simulator with a voice agent", link: "https://github.com/bilawalsidhu/gods-eye-view", links: [],
    createdAt: ago(20), metrics: { stars: 3000, forks: 400 },
  };
  storeItem(db, gh, repo, cfg);
  storeItem(db, hn, {
    url: "https://news.ycombinator.com/item?id=1", title: "Show HN: God's Eye View – spy satellite sim with real data",
    text: "", link: "https://github.com/bilawalsidhu/gods-eye-view", links: [], createdAt: ago(10), metrics: { points: 420, comments: 150 },
  }, cfg);
  storeItem(db, press, {
    url: "https://press.example/story", title: "Everyone is playing with gods-eye-view", text: "The open-source AI globe…",
    links: [], createdAt: ago(5), metrics: {},
  }, cfg);
  // Not AI → never a project.
  storeItem(db, gh, { url: "https://github.com/x/json-parser", title: "x/json-parser", text: "Fast JSON parser", links: [], createdAt: ago(5), metrics: { stars: 5000 } }, cfg);
  return { db, repo };
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  project_keys: ["gh:bilawalsidhu/gods-eye-view"], name: "God's Eye View", url: "https://github.com/bilawalsidhu/gods-eye-view",
  author: "Bilawal Sidhu", category: "opensource", summary: "Шпионский спутник в браузере", hype_score: 8, stage: "взлетает",
  evidence: [], first_seen_at: "", source_of_first_signal: "github", why_viral: "вау-эффект", risks: "", availability: "доступно",
  media_suggestion: "", is_update: false, update_reason: "", status: "publish_post", skip_reason: "", ...over,
});

function stubLlm(texts: string[]): Llm & { calls: number } {
  let i = 0;
  return {
    enabled: true,
    get calls() {
      return i;
    },
    async json() {
      return { text: texts[Math.min(i++, texts.length - 1)] };
    },
  } as unknown as Llm & { calls: number };
}

const GOOD_POST = `<b>Шпионский спутник прямо в браузере</b>

God's Eye View показывает на трёхмерном глобусе настоящие данные: самолёты, спутники, погоду. Автор — Bilawal Sidhu.

🔥 <b>Почему взлетело:</b>
• 3 000 звёзд на GitHub меньше чем за сутки
• 420 очков на Hacker News

👉 <a href="https://github.com/bilawalsidhu/gods-eye-view">Посмотреть</a>

#опенсорс #github`;

test("candidates: one project across platforms, measured velocity, press mention attached, non-AI dropped", () => {
  const { db } = setup();
  const c = buildCandidates(db, cfg);
  assert.equal(c.length, 1);
  assert.equal(c[0].project_key, "gh:bilawalsidhu/gods-eye-view");
  assert.equal(c[0].items.length, 2);
  assert.equal(c[0].mentions.length, 1);
  assert.equal(c[0].velocity.stars_24h, 3000);
  assert.equal(c[0].velocity.hn_points, 420);
  assert.equal(c[0].velocity.measured, true);
  const repoItem = c[0].items.find((i) => i.source === "github")!;
  assert.equal((repoItem.metrics.delta_24h as { basis: string }).basis, "since_creation");
});

test("scan verdicts are applied; merges follow the primary key; rescan is throttled", () => {
  const { db } = setup();
  db.run("INSERT INTO projects(key, name, url, first_seen, last_seen) VALUES('web:godseye.app','godseye.app','https://godseye.app',?,?)", ago(1), ago(0));
  db.run("INSERT INTO items(url, source_id, platform, title, project_key, first_seen, last_seen, metrics) VALUES('https://godseye.app', 1, 'github', 'site', 'web:godseye.app', ?, ?, '{\"stars\":10}')", ago(1), ago(0));
  const inputs = buildCandidates(db, cfg);
  const fake = { ...inputs[0], project_key: "web:godseye.app" };
  applyScan(db, [...inputs, fake], [candidate({ project_keys: ["web:godseye.app", "gh:bilawalsidhu/gods-eye-view"] })]);
  const p = db.get<{ status: string; hype_score: number }>("SELECT status, hype_score FROM projects WHERE key = 'gh:bilawalsidhu/gods-eye-view'")!;
  assert.deepEqual({ ...p }, { status: "publish_post", hype_score: 8 });
  assert.equal(db.get<{ m: string }>("SELECT merged_into AS m FROM projects WHERE key = 'web:godseye.app'")!.m, "gh:bilawalsidhu/gods-eye-view");
  assert.equal(buildCandidates(db, cfg).length, 0, "just scanned and not grown → not shown again");
});

test("post thresholds are enforced in code, not by the model's word", () => {
  const base: ProjectRow = { id: 1, key: "gh:a/b", name: "b", url: "https://github.com/a/b", scan: null, hype_score: 6, stage: "ранний сигнал", status: "publish_post", post_count: 0, last_post_at: null, last_post_message_id: null, published_metrics: null };
  const slow = { stars_24h: 200, stars_week: 0, hn_points: 0, reddit_upvotes: 0, hf_likes_24h: 0, platforms: 1, mentions: 0, measured: true };
  const fast = { ...slow, stars_24h: 1500 };
  const row = (c: Partial<Candidate>, velocity = slow, extra: Partial<ProjectRow> = {}) => ({ ...base, ...extra, scan: JSON.stringify({ ...candidate(c), velocity }) });
  assert.equal(postDecision(row({ hype_score: 6, stage: "ранний сигнал" }), cfg).ok, false);
  assert.equal(postDecision(row({ hype_score: 6, stage: "ранний сигнал" }, fast), cfg).ok, true);
  assert.equal(postDecision(row({ hype_score: 6, stage: "взлетает" }, fast), cfg).ok, false);
  assert.equal(postDecision(row({ hype_score: 9, status: "digest_only" }), cfg).ok, false);
  assert.equal(postDecision(row({ hype_score: 8 }, slow, { post_count: 1 }), cfg).ok, false, "repeat without news");
  assert.deepEqual(postDecision(row({ hype_score: 8, is_update: true }, slow, { post_count: 1 }), cfg), { ok: true, update: true });
});

test("update rule: ≥3× growth, or news after the cooldown", () => {
  const { db } = setup();
  const p = (published: Record<string, number>, lastPostH: number, reason: string): ProjectRow => ({
    id: 1, key: "gh:bilawalsidhu/gods-eye-view", name: "x", url: "", hype_score: 8, stage: "мейнстрим", status: "publish_post", post_count: 1,
    last_post_at: ago(lastPostH), last_post_message_id: 5, published_metrics: JSON.stringify(published),
    scan: JSON.stringify(candidate({ is_update: true, update_reason: reason })),
  });
  assert.equal(updateAllowed(db, p({ stars: 900 }, 2, ""), cfg), true, "3000 / 900 ≥ 3");
  assert.equal(updateAllowed(db, p({ stars: 2000 }, 2, "вышла v2"), cfg), false, "news but within cooldown");
  assert.equal(updateAllowed(db, p({ stars: 2000 }, 60, "вышла v2"), cfg), true);
  assert.equal(updateAllowed(db, p({ stars: 2000 }, 60, ""), cfg), false);
});

test("queuePosts: a checked post is queued once; invented figures are rejected after one retry", async () => {
  const { db } = setup();
  applyScan(db, buildCandidates(db, cfg), [candidate()]);
  const ok = await queuePosts(db, stubLlm([GOOD_POST]), cfg);
  assert.equal(ok.queued, 1);
  const pub = db.get<{ channel: string; kind: string; extra: string }>("SELECT channel, kind, extra FROM publications")!;
  assert.equal(pub.channel, "dry-run");
  assert.equal(JSON.parse(pub.extra).link_preview_options.url, "https://github.com/bilawalsidhu/gods-eye-view");
  assert.equal((await queuePosts(db, stubLlm([GOOD_POST]), cfg)).queued, 0, "same project, same version → no duplicate");

  const fresh = setup().db;
  applyScan(fresh, buildCandidates(fresh, cfg), [candidate()]);
  const llm = stubLlm([GOOD_POST.replace("3 000", "50 000")]);
  const bad = await queuePosts(fresh, llm, cfg);
  assert.equal(bad.queued, 0);
  assert.equal(llm.calls, 2);
  assert.match(bad.rejected[0], /50000/);
});

test("digest: built once a day from scanned projects", async () => {
  const { db } = setup();
  applyScan(db, buildCandidates(db, cfg), [candidate({ status: "digest_only", hype_score: 5 })]);
  const digest = `<b>📡 Что взорвало AI-интернет сегодня</b>

1. <b>God's Eye View</b> — шпионский спутник в браузере на открытых данных
🔥 3 000 звёзд на GitHub меньше чем за сутки
<a href="https://github.com/bilawalsidhu/gods-eye-view">→ ссылка</a>`;
  const r = await maybeDigest(db, stubLlm([digest]), cfg, true);
  assert.equal((r as { queued?: boolean }).queued, true);
  assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM publications WHERE kind = 'digest'")!.n, 1);
});

test("system prompt: every variable is filled", () => {
  for (const mode of ["scan", "single_post", "daily_digest"] as const) {
    const p = systemPrompt(cfg, mode);
    assert.doesNotMatch(p, /\{\{/);
    assert.match(p, /God's Eye View/);
    assert.match(p, new RegExp(`Текущий режим: \\*\\*${mode}\\*\\*`));
  }
});
