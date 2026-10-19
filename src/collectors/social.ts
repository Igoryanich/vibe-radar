import { z } from "zod";
import { fetchText } from "../http.ts";
import { parseDate } from "../util.ts";
import { parseFeed } from "./rss.ts";
import type { Collector, RawItem } from "./types.ts";

// ── Hacker News (Algolia API: points and comments per story, no key) ─────────────────────────

const hnSchema = z.object({
  hits: z.array(
    z.object({
      objectID: z.string(),
      title: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      author: z.string().nullable().optional(),
      points: z.number().nullable().optional(),
      num_comments: z.number().nullable().optional(),
      created_at: z.string().optional(),
      story_text: z.string().nullable().optional(),
    }),
  ),
});

export function parseHn(jsonText: string): RawItem[] {
  return hnSchema.parse(JSON.parse(jsonText)).hits.flatMap((h) => {
    if (!h.title) return [];
    const own = `https://news.ycombinator.com/item?id=${h.objectID}`;
    const link = h.url && /^https?:\/\//.test(h.url) ? h.url : undefined;
    return [{
      url: own,
      title: h.title,
      text: (h.story_text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000),
      author: h.author ?? undefined,
      link,
      links: link ? [link] : [],
      createdAt: parseDate(h.created_at),
      metrics: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
    }];
  });
}

export const hnCollector: Collector = {
  async collect(source, cfg) {
    const since = Math.floor(Date.now() / 1000) - cfg.ITEM_WINDOW_HOURS * 3600;
    const u = new URL(source.url);
    u.searchParams.set("hitsPerPage", "60");
    const minPoints = Number((JSON.parse(source.config || "{}") as { min_points?: number }).min_points ?? 20);
    u.searchParams.set("numericFilters", `created_at_i>${since},points>${minPoints}`);
    const { text } = await fetchText(u.toString());
    return parseHn(text);
  },
};

// ── Reddit (public JSON with upvotes; RSS fallback without counters when JSON is blocked) ─────

const redditSchema = z.object({
  data: z.object({
    children: z.array(
      z.object({
        data: z.object({
          title: z.string(),
          permalink: z.string(),
          url: z.string().optional(),
          url_overridden_by_dest: z.string().optional(),
          is_self: z.boolean().optional(),
          selftext: z.string().optional(),
          author: z.string().optional(),
          ups: z.number().optional(),
          score: z.number().optional(),
          num_comments: z.number().optional(),
          created_utc: z.number().optional(),
          stickied: z.boolean().optional(),
        }),
      }),
    ),
  }),
});

const URL_RE = /https?:\/\/[^\s)\]>"']+/g;

export function parseReddit(jsonText: string): RawItem[] {
  return redditSchema.parse(JSON.parse(jsonText)).data.children.flatMap(({ data: d }) => {
    if (d.stickied) return [];
    const own = `https://www.reddit.com${d.permalink}`;
    const dest = d.url_overridden_by_dest ?? (d.is_self ? undefined : d.url);
    const bodyLinks = (d.selftext ?? "").match(URL_RE) ?? [];
    const links = [...new Set([dest, ...bodyLinks].filter((x): x is string => !!x))].slice(0, 20);
    return [{
      url: own,
      title: d.title,
      text: (d.selftext ?? "").replace(/\s+/g, " ").trim().slice(0, 2000),
      author: d.author,
      link: dest && !/reddit\.com|redd\.it|imgur\.com/.test(dest) ? dest : undefined,
      links,
      createdAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      metrics: { upvotes: d.ups ?? d.score ?? 0, comments: d.num_comments ?? 0 },
    }];
  });
}

export const redditCollector: Collector = {
  async collect(source) {
    try {
      const { text } = await fetchText(source.url, { headers: { Accept: "application/json" } });
      return parseReddit(text);
    } catch (e) {
      // Reddit often refuses JSON to datacenter IPs but still serves RSS (no counters — coverage signal only).
      const rss = source.url.replace(/\/(top|hot|new)\.json/, "/$1/.rss");
      if (rss === source.url) throw e;
      await new Promise((r) => setTimeout(r, 4000));
      const { text } = await fetchText(rss);
      return parseFeed(text, 30);
    }
  },
};

// ── Hugging Face trending Spaces / Models ────────────────────────────────────────────────────

const hfSchema = z.array(
  z.object({
    id: z.string(),
    likes: z.number().optional(),
    trendingScore: z.number().optional(),
    createdAt: z.string().optional(),
    sdk: z.string().optional(),
    pipeline_tag: z.string().optional(),
    tags: z.array(z.string()).optional(),
    author: z.string().optional(),
  }),
);

export function parseHf(jsonText: string, kind: "spaces" | "models"): RawItem[] {
  return hfSchema.parse(JSON.parse(jsonText)).map((r) => {
    const url = kind === "spaces" ? `https://huggingface.co/spaces/${r.id}` : `https://huggingface.co/${r.id}`;
    const tags = (r.tags ?? []).filter((t) => !/^(region:|license:|endpoints_compatible|autotrain|has_space|deploy:)/.test(t)).slice(0, 12);
    return {
      url,
      title: r.id,
      text: [r.pipeline_tag, r.sdk && `SDK: ${r.sdk}`, tags.length && `Tags: ${tags.join(", ")}`].filter(Boolean).join(" · "),
      author: r.author ?? r.id.split("/")[0],
      link: url,
      links: [],
      createdAt: parseDate(r.createdAt),
      metrics: { likes: r.likes ?? 0, trending_score: r.trendingScore },
    };
  });
}

export const huggingfaceCollector: Collector = {
  async collect(source) {
    const { text } = await fetchText(source.url, { headers: { Accept: "application/json" } });
    return parseHf(text, /\/api\/spaces/.test(source.url) ? "spaces" : "models");
  },
};

// ── Bluesky search (public AppView): likes/reposts, mostly a "mass reach" signal ─────────────

const bskySchema = z.object({
  posts: z.array(
    z.object({
      uri: z.string(),
      author: z.object({ handle: z.string() }),
      record: z.object({ text: z.string().default(""), createdAt: z.string().optional(), facets: z.any().optional() }).passthrough(),
      embed: z.any().optional(),
      likeCount: z.number().optional(),
      repostCount: z.number().optional(),
      replyCount: z.number().optional(),
    }),
  ),
});

export function parseBluesky(jsonText: string): RawItem[] {
  return bskySchema.parse(JSON.parse(jsonText)).posts.flatMap((p) => {
    const text = p.record.text.trim();
    if (text.length < 30) return [];
    const links = new Set<string>();
    const ext = p.embed?.external?.uri ?? p.embed?.media?.external?.uri;
    if (typeof ext === "string") links.add(ext);
    for (const f of (p.record.facets as { features?: { uri?: string }[] }[] | undefined) ?? [])
      for (const feat of f.features ?? []) if (feat.uri) links.add(feat.uri);
    const rkey = p.uri.split("/").pop();
    return [{
      url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
      title: text.split("\n")[0].slice(0, 200),
      text: text.slice(0, 1500),
      author: p.author.handle,
      links: [...links].slice(0, 10),
      createdAt: parseDate(p.record.createdAt),
      metrics: { likes: p.likeCount ?? 0, reposts: p.repostCount ?? 0, comments: p.replyCount ?? 0 },
    }];
  });
}

export const blueskyCollector: Collector = {
  async collect(source, cfg) {
    const since = new Date(Date.now() - cfg.ITEM_WINDOW_HOURS * 3600_000).toISOString();
    const q = (JSON.parse(source.config || "{}") as { query?: string }).query ?? source.name;
    const { text } = await fetchText(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=top&since=${since}&limit=50`,
    );
    return parseBluesky(text);
  },
};
