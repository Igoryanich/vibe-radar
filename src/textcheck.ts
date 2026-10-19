// Hard checks on model-written Telegram HTML before anything is queued.

const ALLOWED_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "a", "code", "pre", "blockquote"]);

export function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** What the reader sees: tags removed, entities decoded, counted in UTF-16 units like Telegram does. */
export function visibleLength(html: string): number {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).length;
}

export function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\s+href="([^"]*)"\s*>/gi)].map((m) => decodeEntities(m[1]));
}

/** Tag whitelist, balanced nesting, no stray "<" or unescaped "&". Returns problems (empty = OK). */
export function htmlProblems(html: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const tagRe = /<\/?([a-zA-Z0-9-]+)([^>]*)>/g;
  let m: RegExpExecArray | null;
  for (m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    const name = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) {
      problems.push(`недопустимый тег <${name}>`);
      continue;
    }
    if (m[0].startsWith("</")) {
      if (stack.pop() !== name) problems.push(`несбалансированный тег </${name}>`);
    } else {
      if (name === "a" && !/^\s+href="https?:\/\/[^"\s]+"\s*$/i.test(m[2])) problems.push("ссылка <a> без корректного href");
      if (name !== "a" && m[2].trim()) problems.push(`атрибуты у <${name}>`);
      stack.push(name);
    }
  }
  if (stack.length) problems.push(`незакрытые теги: ${stack.join(", ")}`);
  const stripped = html.replace(tagRe, "");
  if (/[<>]/.test(stripped)) problems.push("в тексте есть неэкранированные < или >");
  if (/&(?!(amp|lt|gt|quot|#39);)/.test(stripped)) problems.push("в тексте есть неэкранированный &");
  if (/\*\*|__|^#{1,3}\s/m.test(stripped)) problems.push("в тексте есть Markdown");
  return problems;
}

/** Share of Cyrillic among letters (URLs, tags and hashtags excluded). */
export function cyrillicShare(html: string): number {
  const text = decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/https?:\/\/\S+/g, " ").replace(/#\S+/g, " ");
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length / letters.length;
}

/**
 * Numbers the reader sees (≥ 100, with "тыс."/"k"/"млн" multipliers applied), excluding years,
 * hashtags and anything inside link URLs. Used to make sure no figure is invented.
 */
export function figuresIn(html: string): number[] {
  const text = decodeEntities(html.replace(/<a\s+href="[^"]*"\s*>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/#\S+/g, " ");
  const out: number[] = [];
  const re = /(\d{1,3}(?:[   ]\d{3})+|\d+(?:[.,]\d+)?)\s*(тыс\.?|k\b|к\b|млн\.?|m\b)?/giu;
  for (const m of text.matchAll(re)) {
    const rawNum = m[1];
    const grouped = /[   ]/.test(rawNum);
    let n = grouped ? Number(rawNum.replace(/[   ]/g, "")) : Number(rawNum.replace(",", "."));
    // "8,258" written with a thousands comma
    if (!grouped && /^\d{1,3},\d{3}$/.test(rawNum)) n = Number(rawNum.replace(",", ""));
    const mult = (m[2] ?? "").toLowerCase();
    if (/^(тыс|k|к)/.test(mult)) n *= 1000;
    else if (/^(млн|m)/.test(mult)) n *= 1_000_000;
    if (!Number.isFinite(n) || n < 100) continue;
    if (!mult && n >= 1990 && n <= 2035 && Number.isInteger(n)) continue; // a year
    out.push(Math.round(n));
  }
  return out;
}

/** Every number that appears anywhere in the input data (incl. inside strings like "8 258 звёзд"). */
export function figuresInData(data: unknown): number[] {
  const nums = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === "number") nums.add(v);
    else if (typeof v === "string") {
      for (const n of figuresIn(v.replace(/[<>&]/g, " "))) nums.add(n);
      for (const m of v.matchAll(/\d+/g)) nums.add(Number(m[0]));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(data);
  return [...nums];
}

/** Figures in the text that match no input number within ±5% (rounding like "38 тыс." is tolerated). */
export function unknownFigures(html: string, data: unknown): number[] {
  const known = figuresInData(data);
  return figuresIn(html).filter((n) => !known.some((k) => k > 0 && Math.abs(k - n) / k <= 0.05));
}

/** Full gate for a model-written post. */
export function checkPost(html: string, opts: { maxChars: number; allowedLinks: Set<string>; data: unknown }): string[] {
  const problems = htmlProblems(html);
  const len = visibleLength(html);
  if (len > opts.maxChars) problems.push(`длина ${len} знаков, лимит ${opts.maxChars}`);
  if (len < 120) problems.push("слишком короткий текст");
  for (const h of hrefs(html)) if (!opts.allowedLinks.has(normalizeLink(h))) problems.push(`ссылки ${h} нет во входных данных`);
  if (cyrillicShare(html) < 0.5) problems.push("текст не на русском");
  const unknown = unknownFigures(html, opts.data);
  if (unknown.length) problems.push(`цифры, которых нет во входных данных: ${unknown.join(", ")}`);
  return problems;
}

export function normalizeLink(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    x.hostname = x.hostname.toLowerCase().replace(/^www\./, "");
    return x.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}
