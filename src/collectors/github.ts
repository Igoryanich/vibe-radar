import * as cheerio from "cheerio";
import { z } from "zod";
import type { Config } from "../config.ts";
import { fetchText } from "../http.ts";
import { parseDate } from "../util.ts";
import type { Collector, RawItem } from "./types.ts";

const num = (s: string | undefined) => {
  const n = Number((s ?? "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) && (s ?? "").match(/\d/) ? n : undefined;
};

const RESERVED = new Set(["sponsors", "orgs", "topics", "trending", "collections", "features", "marketplace", "apps", "login", "settings"]);

/** github.com/trending page: each repo is an `article.Box-row`. "N stars today/this week" is GitHub's own delta. */
export function parseTrending(html: string, since: "daily" | "weekly"): RawItem[] {
  const $ = cheerio.load(html);
  const items: RawItem[] = [];
  $("article.Box-row").each((_, el) => {
    const href = $(el).find("h2 a[href], h1 a[href]").first().attr("href")?.trim();
    const m = href?.match(/^\/([\w.-]+)\/([\w.-]+)\/?$/);
    if (!m || RESERVED.has(m[1].toLowerCase())) return;
    const repo = `${m[1]}/${m[2]}`;
    const description = $(el).find("p").first().text().replace(/\s+/g, " ").trim();
    const language = $(el).find('[itemprop="programmingLanguage"]').first().text().trim();
    const stars = num($(el).find(`a[href$="/${repo}/stargazers"], a[href$="/stargazers"]`).first().text());
    const forks = num($(el).find(`a[href$="/${repo}/forks"], a[href$="/forks"]`).first().text());
    const delta = $(el).text().replace(/\s+/g, " ").match(/([\d,]+)\s+stars?\s+(today|this week|this month)/i);
    const url = `https://github.com/${repo}`;
    items.push({
      url,
      title: repo,
      text: [description, language && `Language: ${language}`].filter(Boolean).join(" · "),
      author: m[1],
      link: url,
      links: [],
      createdAt: null,
      metrics: {
        stars,
        forks,
        ...(delta ? (since === "daily" ? { stars_today: num(delta[1]) } : { stars_week: num(delta[1]) }) : {}),
      },
    });
  });
  return items;
}

export const githubTrendingCollector: Collector = {
  async collect(source) {
    const since = /weekly/.test(source.url) ? "weekly" : "daily";
    const { text } = await fetchText(source.url, { headers: { Accept: "text/html" } });
    const items = parseTrending(text, since);
    if (!items.length) throw new Error("trending page parsed to 0 repos (markup changed?)");
    return items;
  },
};

const repoSchema = z.object({
  full_name: z.string(),
  html_url: z.string(),
  description: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  stargazers_count: z.number(),
  forks_count: z.number().optional(),
  created_at: z.string().optional(),
  topics: z.array(z.string()).optional(),
  language: z.string().nullable().optional(),
  owner: z.object({ login: z.string() }).optional(),
});
type Repo = z.infer<typeof repoSchema>;

function ghHeaders(cfg: Config): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(cfg.GITHUB_TOKEN ? { Authorization: `Bearer ${cfg.GITHUB_TOKEN}` } : {}),
  };
}

export function repoToItem(r: Repo): RawItem {
  const homepage = r.homepage && /^https?:\/\//.test(r.homepage) ? r.homepage : undefined;
  return {
    url: r.html_url,
    title: r.full_name,
    text: [r.description ?? "", r.topics?.length ? `Topics: ${r.topics.join(", ")}` : "", r.language ? `Language: ${r.language}` : ""]
      .filter(Boolean)
      .join(" · "),
    author: r.owner?.login,
    link: r.html_url,
    links: homepage ? [homepage] : [],
    createdAt: parseDate(r.created_at),
    metrics: { stars: r.stargazers_count, forks: r.forks_count },
  };
}

/** Young repositories sorted by stars (Search API): catches fast risers before they reach Trending. */
export const githubSearchCollector: Collector = {
  async collect(source, cfg) {
    const since = new Date(Date.now() - cfg.GITHUB_YOUNG_DAYS * 86400_000).toISOString().slice(0, 10);
    const extra = (JSON.parse(source.config || "{}") as { query?: string }).query ?? "";
    const q = `created:>${since} stars:>${cfg.GITHUB_MIN_STARS} ${extra}`.trim();
    const { text } = await fetchText(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=60`,
      { headers: ghHeaders(cfg) },
    );
    const data = z.object({ items: z.array(repoSchema) }).parse(JSON.parse(text));
    return data.items.map(repoToItem);
  },
};

/** Fresh star counts for repos we already track, so 24h/72h deltas exist for them too. */
export async function fetchRepo(fullName: string, cfg: Config): Promise<RawItem | null> {
  try {
    const { text } = await fetchText(`https://api.github.com/repos/${fullName}`, { headers: ghHeaders(cfg), timeoutMs: 15_000 });
    return repoToItem(repoSchema.parse(JSON.parse(text)));
  } catch {
    return null;
  }
}
