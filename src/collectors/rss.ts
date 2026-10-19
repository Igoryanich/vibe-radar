import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { fetchText } from "../http.ts";
import { htmlToText, parseDate } from "../util.ts";
import type { Collector, RawItem } from "./types.ts";

const parser = new Parser({ customFields: { item: [["content:encoded", "contentEncoded"], ["dc:date", "dcDate"]] } });

export function linksIn(html: string, base?: string): string[] {
  if (!html || !html.includes("href")) return [];
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      const u = new URL(href, base);
      if (/^https?:$/.test(u.protocol)) out.add(u.toString());
    } catch {
      /* ignore */
    }
  });
  return [...out].slice(0, 40);
}

export async function parseFeed(xml: string, limit = 60): Promise<RawItem[]> {
  const feed = await parser.parseString(xml);
  const items: RawItem[] = [];
  for (const it of feed.items.slice(0, limit)) {
    const link = it.link ?? (typeof it.guid === "string" && /^https?:/.test(it.guid) ? it.guid : undefined);
    if (!link || !it.title) continue;
    const any = it as unknown as Record<string, unknown>;
    const html = String(any.contentEncoded ?? it.content ?? it.summary ?? "");
    items.push({
      url: link.trim(),
      title: htmlToText(it.title).slice(0, 400),
      text: htmlToText(html || it.contentSnippet || "").slice(0, 3000),
      createdAt: parseDate(it.isoDate ?? it.pubDate ?? any.dcDate),
      author: it.creator ?? (any.author as string | undefined),
      links: linksIn(html, link),
      metrics: {},
    });
  }
  return items;
}

export const rssCollector: Collector = {
  async collect(source) {
    const { text } = await fetchText(source.url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    });
    return parseFeed(text);
  },
};

/** Public Telegram channels via the web preview https://t.me/s/<channel> — no API key, read-only. */
export function parseTelegramPreview(html: string, channel: string): RawItem[] {
  const $ = cheerio.load(html);
  const items: RawItem[] = [];
  $(".tgme_widget_message").each((_, el) => {
    const post = $(el).attr("data-post");
    if (!post) return;
    const textEl = $(el).find(".tgme_widget_message_text").first();
    textEl.find("br").replaceWith("\n");
    const text = textEl.text().replace(/[ \t]+/g, " ").trim();
    if (text.length < 40) return;
    const time = $(el).find("time[datetime]").first().attr("datetime");
    const links: string[] = [];
    textEl.find("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      if (href && /^https?:/.test(href)) links.push(href);
    });
    const firstLine = text.split("\n").find((l) => l.trim().length > 15) ?? text;
    items.push({
      url: `https://t.me/${post}`,
      title: firstLine.slice(0, 200).trim(),
      text: text.slice(0, 3000),
      createdAt: parseDate(time),
      author: channel,
      links: links.slice(0, 20),
      metrics: {},
    });
  });
  return items.reverse();
}

export const telegramCollector: Collector = {
  async collect(source) {
    const channel = source.url.replace(/^https?:\/\/t\.me\/(s\/)?/, "").replace(/\/.*$/, "");
    const { text } = await fetchText(`https://t.me/s/${channel}`);
    return parseTelegramPreview(text, channel);
  },
};
