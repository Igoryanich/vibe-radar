import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export const nowIso = () => new Date().toISOString();
export const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ocid$|cmpid$|at_|maca$|xtor$|ns_)/i;

export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error("bad url");
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  const keep = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(keep).toString();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  u.protocol = "https:";
  return u.toString();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Registrable-ish domain: last two labels, or three for known second-level suffixes. */
export function rootDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const sl = parts.slice(-2).join(".");
  if (/^(co|com|gov|org|ac|mil|net)\.[a-z]{2}$/.test(sl)) return parts.slice(-3).join(".");
  return sl;
}

export function htmlToText(html: string): string {
  if (!html) return "";
  if (!/[<&]/.test(html)) return html.replace(/\s+/g, " ").trim();
  const $ = cheerio.load(html);
  $("script,style,noscript,iframe").remove();
  return $.root().text().replace(/\s+/g, " ").trim();
}

export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function parseDate(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Local calendar date (YYYY-MM-DD) in an IANA timezone. */
export function localDate(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function localHour(tz: string, d = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d)) % 24;
}

/** Milliseconds until the next HH:00 in an IANA timezone today (≤ 0 if already past). */
export function msUntilLocalHour(tz: string, hour: number, now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const secondsToday = (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
  return (hour * 3600 - secondsToday) * 1000 - now.getMilliseconds();
}
