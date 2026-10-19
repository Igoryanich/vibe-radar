import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrending } from "../src/collectors/github.ts";
import { parseHf, parseHn, parseReddit } from "../src/collectors/social.ts";
import { computeDelta, growthRatio } from "../src/metrics.ts";
import { itemProjectKey, looksAiRelated, nameMentioned, projectKeyOf } from "../src/projects.ts";
import { checkPost, cyrillicShare, figuresIn, htmlProblems, unknownFigures, visibleLength } from "../src/textcheck.ts";

const H = 3600_000;

test("projectKeyOf: repos, Spaces, sites; social and press are not projects", () => {
  assert.equal(projectKeyOf("https://github.com/BilawalSidhu/gods-eye-view/tree/main"), "gh:bilawalsidhu/gods-eye-view");
  assert.equal(projectKeyOf("https://github.com/trending?since=daily"), null);
  assert.equal(projectKeyOf("https://huggingface.co/spaces/Owner/Cool-Demo"), "hf:spaces/owner/cool-demo");
  assert.equal(projectKeyOf("https://huggingface.co/papers/2501.00001"), null);
  assert.equal(projectKeyOf("https://www.producthunt.com/products/croft-2"), "ph:croft-2");
  assert.equal(projectKeyOf("https://my-app.lovable.app/"), "web:my-app.lovable.app");
  assert.equal(projectKeyOf("https://x.com/someone/status/1"), null);
  assert.equal(projectKeyOf("https://www.theverge.com/ai/123/story"), null);
});

test("itemProjectKey: a post linking to exactly one repo is about that repo", () => {
  assert.equal(
    itemProjectKey({ url: "https://www.reddit.com/r/x/comments/1", link: undefined, links: ["https://github.com/a/b", "https://x.com/q"] }),
    "gh:a/b",
  );
  assert.equal(
    itemProjectKey({ url: "https://www.reddit.com/r/x/comments/1", links: ["https://github.com/a/b", "https://github.com/c/d"] }),
    null,
  );
  assert.equal(itemProjectKey({ url: "https://news.ycombinator.com/item?id=1", link: "https://coolthing.dev/", links: [] }), "web:coolthing.dev");
});

test("AI relevance: word-anchored, short terms need a word end", () => {
  assert.ok(looksAiRelated("An open-source agentic browser"));
  assert.ok(looksAiRelated("Local LLM runner for Mac"));
  assert.ok(looksAiRelated("Нейросеть рисует комиксы"));
  assert.ok(looksAiRelated("AI-powered spreadsheet"));
  assert.equal(looksAiRelated("Aim trainer for FPS games"), false);
  assert.equal(looksAiRelated("A fast JSON parser in Rust"), false);
});

test("nameMentioned ignores generic names and matches whole words", () => {
  assert.ok(nameMentioned("gods-eye-view", "Everyone is talking about God's Eye View… gods eye view repo"));
  assert.equal(nameMentioned("agent", "a new agent framework"), false);
  assert.equal(nameMentioned("croft", "microfts"), false);
});

test("computeDelta: exact, since creation, partial observation, unknown", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const iso = (h: number) => new Date(now - h * H).toISOString();
  assert.deepEqual(computeDelta([{ at: iso(30), value: 100 }, { at: iso(10), value: 900 }], 1500, null, 24, now), { value: 1400, hours: 24, basis: "snapshot" });
  assert.deepEqual(computeDelta([], 3000, iso(20), 24, now), { value: 3000, hours: 20, basis: "since_creation" });
  assert.deepEqual(computeDelta([{ at: iso(12), value: 500 }], 1100, iso(500), 24, now), { value: 600, hours: 12, basis: "snapshot" });
  assert.equal(computeDelta([{ at: iso(2), value: 500 }], 1100, iso(500), 24, now), null);
  assert.equal(computeDelta([], 1100, null, 24, now), null);
});

test("growthRatio takes the best counter", () => {
  assert.equal(growthRatio({ stars: 1000, points: 100 }, { stars: 3500, points: 120 }), 3.5);
  assert.equal(growthRatio({}, { stars: 10 }), 1);
});

test("GitHub Trending parser reads repo, totals and the 'stars today' delta", () => {
  const html = `
  <article class="Box-row">
    <h2 class="h3 lh-condensed"><a href="/bilawalsidhu/gods-eye-view" class="Link">bilawalsidhu / gods-eye-view</a></h2>
    <p class="col-9 color-fg-muted my-1 pr-4">Spy satellite simulator in your browser, real data</p>
    <div class="f6 color-fg-muted mt-2">
      <span itemprop="programmingLanguage">TypeScript</span>
      <a href="/bilawalsidhu/gods-eye-view/stargazers" class="Link">8,258</a>
      <a href="/bilawalsidhu/gods-eye-view/forks" class="Link">1,843</a>
      <span class="d-inline-block float-sm-right">2,104 stars today</span>
    </div>
  </article>
  <article class="Box-row"><h2><a href="/sponsors/x">x</a></h2></article>`;
  const items = parseTrending(html, "daily");
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://github.com/bilawalsidhu/gods-eye-view");
  assert.deepEqual(items[0].metrics, { stars: 8258, forks: 1843, stars_today: 2104 });
  assert.match(items[0].text, /Spy satellite.*TypeScript/);
});

test("HN, Reddit and HF parsers keep counters and outbound links", () => {
  const hn = parseHn(JSON.stringify({ hits: [{ objectID: "42", title: "Show HN: Thing", url: "https://thing.dev", author: "a", points: 250, num_comments: 80, created_at: "2026-10-19T08:00:00Z" }] }));
  assert.deepEqual(hn[0].metrics, { points: 250, comments: 80 });
  assert.equal(hn[0].url, "https://news.ycombinator.com/item?id=42");
  assert.equal(hn[0].link, "https://thing.dev");
  const rd = parseReddit(JSON.stringify({ data: { children: [
    { data: { title: "I built X", permalink: "/r/vibecoding/comments/abc/x/", is_self: true, selftext: "repo: https://github.com/me/x", ups: 1200, num_comments: 90, created_utc: 1760860800 } },
    { data: { title: "Rules", permalink: "/r/vibecoding/comments/r/", stickied: true } },
  ] } }));
  assert.equal(rd.length, 1);
  assert.deepEqual(rd[0].links, ["https://github.com/me/x"]);
  assert.equal(rd[0].metrics.upvotes, 1200);
  const hf = parseHf(JSON.stringify([{ id: "owner/demo", likes: 683, trendingScore: 153, createdAt: "2026-07-15T00:00:00Z", sdk: "gradio", tags: ["region:us", "mcp-server"] }]), "spaces");
  assert.equal(hf[0].url, "https://huggingface.co/spaces/owner/demo");
  assert.equal(hf[0].metrics.likes, 683);
  assert.doesNotMatch(hf[0].text, /region:/);
});

test("HTML checks: whitelist, balance, escaping, Markdown", () => {
  assert.deepEqual(htmlProblems('<b>Заголовок</b>\n<a href="https://x.dev">ссылка</a> &amp; ещё'), []);
  assert.ok(htmlProblems("<b>без закрытия").length);
  assert.ok(htmlProblems("<br>").some((p) => p.includes("недопустимый")));
  assert.ok(htmlProblems("1 < 2").length);
  assert.ok(htmlProblems("A & B").length);
  assert.ok(htmlProblems("**жирный**").length);
  assert.equal(visibleLength('<b>Ab</b> <a href="https://x.dev">&amp;</a>'), 4);
});

test("figures: multipliers, grouping, years ignored; unknown figures detected with ±5%", () => {
  assert.deepEqual(figuresIn("8 258 звёзд, 38 тыс. к сентябрю, 2,3 млн просмотров, в 2026 году, 12 часов"), [8258, 38000, 2300000]);
  assert.deepEqual(figuresIn('<a href="https://github.com/a/b?x=12345">репо</a> — 1,843 форка'), [1843]);
  const data = { items: [{ metrics: { current: { stars: 38213 }, delta_24h: { stars: 2104 } } }] };
  assert.deepEqual(unknownFigures("уже 38 тыс. звёзд, +2 104 за сутки", data), []);
  assert.deepEqual(unknownFigures("уже 50 000 звёзд", data), [50000]);
});

test("checkPost: length, Russian, links only from the input", () => {
  const text = `<b>Шпионский спутник в браузере</b>\n\nПроект показывает настоящие данные о самолётах и спутниках на трёхмерном глобусе, всё работает прямо в браузере.\n\n👉 <a href="https://github.com/a/b">Посмотреть</a>`;
  assert.deepEqual(checkPost(text, { maxChars: 1800, allowedLinks: new Set(["https://github.com/a/b"]), data: {} }), []);
  const bad = checkPost(text.replace("https://github.com/a/b", "https://evil.example"), { maxChars: 50, allowedLinks: new Set(["https://github.com/a/b"]), data: {} });
  assert.ok(bad.some((p) => p.includes("длина")));
  assert.ok(bad.some((p) => p.includes("evil.example")));
  assert.ok(cyrillicShare("<b>Hello world</b>") < 0.5);
});
