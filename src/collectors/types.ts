import type { Config } from "../config.ts";

export type SourceKind = "github_trending" | "github_search" | "hn" | "reddit" | "huggingface" | "rss" | "telegram" | "bluesky";

export type Platform = "github" | "hn" | "reddit" | "huggingface" | "producthunt" | "bluesky" | "press" | "telegram" | "blog";

/** Counters a platform exposes. Only what the source really reports — never estimated. */
export interface Metrics {
  stars?: number;
  stars_today?: number; // GitHub Trending's own "N stars today/this week" (a direct delta)
  stars_week?: number;
  forks?: number;
  points?: number; // HN
  upvotes?: number; // Reddit
  comments?: number;
  likes?: number; // HF, Bluesky
  reposts?: number;
  trending_score?: number; // HF
}

/** A source row as the collectors see it (DB `sources` table). */
export interface SourceRow {
  id: number;
  key: string;
  name: string;
  kind: SourceKind;
  url: string;
  platform: Platform;
  focused: number;
  config: string; // JSON
}

export interface RawItem {
  url: string;
  title: string;
  text: string;
  author?: string;
  /** Where the item points (project site, repo). For a repo/Space it is the item itself. */
  link?: string;
  links: string[];
  createdAt: string | null;
  metrics: Metrics;
  /** Platform override (e.g. a Product Hunt RSS feed collected with the generic rss kind). */
  platform?: Platform;
}

export interface Collector {
  collect(source: SourceRow, cfg: Config): Promise<RawItem[]>;
}
