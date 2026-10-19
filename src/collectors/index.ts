import { githubSearchCollector, githubTrendingCollector } from "./github.ts";
import { rssCollector, telegramCollector } from "./rss.ts";
import { blueskyCollector, hnCollector, huggingfaceCollector, redditCollector } from "./social.ts";
import type { Collector, SourceKind } from "./types.ts";

export const collectors: Record<SourceKind, Collector> = {
  github_trending: githubTrendingCollector,
  github_search: githubSearchCollector,
  hn: hnCollector,
  reddit: redditCollector,
  huggingface: huggingfaceCollector,
  rss: rssCollector,
  telegram: telegramCollector,
  bluesky: blueskyCollector,
};
