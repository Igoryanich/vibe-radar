// Turning platform items into "projects": one project, many sightings (repo + Show HN + Reddit + Space…).

const NOT_A_PROJECT = new Set([
  "twitter.com", "x.com", "youtube.com", "youtu.be", "reddit.com", "redd.it", "imgur.com", "news.ycombinator.com",
  "medium.com", "substack.com", "linkedin.com", "facebook.com", "instagram.com", "tiktok.com", "t.me", "bsky.app",
  "threads.net", "discord.gg", "discord.com", "google.com", "docs.google.com", "drive.google.com", "arxiv.org",
  "wikipedia.org", "en.wikipedia.org", "dev.to", "hackernoon.com", "producthunt.com", "archive.org", "web.archive.org",
  "nytimes.com", "theverge.com", "techcrunch.com", "wired.com", "arstechnica.com", "404media.co", "bloomberg.com",
  "reuters.com", "cnbc.com", "theguardian.com", "bbc.com", "bbc.co.uk", "forbes.com", "businessinsider.com",
  "gist.github.com", "raw.githubusercontent.com", "i.redd.it", "v.redd.it", "loom.com", "vimeo.com", "pastebin.com",
  "apps.apple.com", "play.google.com", "chrome.google.com", "chromewebstore.google.com", "npmjs.com", "pypi.org",
]);

const GH_RESERVED = new Set(["orgs", "topics", "trending", "collections", "features", "marketplace", "sponsors", "settings", "about", "search", "apps", "login", "enterprise", "pricing"]);

function host(u: URL) {
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Stable key for the thing a URL points to, or null when the URL is not a project page
 * (social posts, press, link shorteners). Keys: gh:owner/repo · hf:spaces/owner/name ·
 * hf:owner/model · ph:slug · web:host[/first-segment for *.github.io and similar].
 */
export function projectKeyOf(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = host(u);
  const seg = u.pathname.split("/").filter(Boolean);
  if (h === "github.com") {
    if (seg.length < 2 || GH_RESERVED.has(seg[0])) return null;
    return `gh:${seg[0].toLowerCase()}/${seg[1].toLowerCase().replace(/\.git$/, "")}`;
  }
  if (h === "huggingface.co") {
    if (seg[0] === "spaces" && seg.length >= 3) return `hf:spaces/${seg[1].toLowerCase()}/${seg[2].toLowerCase()}`;
    if (seg.length >= 2 && !["datasets", "papers", "blog", "docs", "posts", "collections", "learn", "models", "spaces"].includes(seg[0]))
      return `hf:${seg[0].toLowerCase()}/${seg[1].toLowerCase()}`;
    return null;
  }
  if (h === "producthunt.com" && (seg[0] === "posts" || seg[0] === "products") && seg[1]) return `ph:${seg[1].toLowerCase()}`;
  if (NOT_A_PROJECT.has(h) || [...NOT_A_PROJECT].some((d) => h.endsWith(`.${d}`))) return null;
  // Subdomains of app hosts (*.vercel.app, *.lovable.app, *.github.io…) are distinct projects; the host is the key.
  return `web:${h}`;
}

/**
 * Project key for an item: its own URL when it is a repo/Space/launch page, otherwise where it links to.
 * Articles and social posts (`ownIsProject = false`) are never projects themselves — a news site is not a launch.
 */
export function itemProjectKey(item: { url: string; link?: string | null; links: string[] }, ownIsProject = true): string | null {
  const own = ownIsProject ? projectKeyOf(item.url) : null;
  if (own) return own;
  const direct = projectKeyOf(item.link);
  if (direct) return direct;
  // A Reddit/HN/Bluesky post whose text links to exactly one GitHub repo is about that repo.
  const repos = new Set(item.links.map(projectKeyOf).filter((k): k is string => !!k && k.startsWith("gh:")));
  return repos.size === 1 ? [...repos][0] : null;
}

export function projectUrl(key: string): string {
  const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "gh") return `https://github.com/${rest}`;
  if (kind === "hf") return `https://huggingface.co/${rest}`;
  if (kind === "ph") return `https://www.producthunt.com/products/${rest}`;
  return `https://${rest}`;
}

export function projectName(key: string): string {
  const rest = key.slice(key.indexOf(":") + 1);
  return rest.split("/").pop() ?? rest;
}

// AI relevance for general sources (GitHub Trending, all of HN): cheap word-start keyword check.
// Prefix terms match at a word start ("agent" → "agentic"); short exact terms need a word end too ("ai" ≠ "aim").
const AI_PREFIX = [
  "llm", "gpt", "chatgpt", "openai", "anthropic", "claude", "gemini", "grok", "mistral", "llama", "qwen", "deepseek", "kimi",
  "gemma", "agent", "copilot", "cursor", "vibe", "lovable", "bolt\\.new", "replit", "windsurf", "codex", "prompt", "embedding",
  "transformer", "diffusion", "stable diffusion", "sora", "midjourney", "text-to", "speech", "voice clon", "whisper", "ollama",
  "lm studio", "vllm", "gguf", "model context protocol", "neural", "machine learning", "deep learning", "inference", "fine-tun",
  "chatbot", "generative", "genai", "multimodal", "vision model", "computer use", "нейросет", "нейронк", "искусственн",
];
const AI_EXACT = ["ai", "a\\.i\\.", "ии", "rag", "tts", "mcp", "lora", "flux", "veo", "v0", "ml", "slm", "vlm"];
const B = "(?:^|[^\\p{L}\\p{N}])";
const AI_RE = new RegExp(`${B}(?:${AI_PREFIX.join("|")})|${B}(?:${AI_EXACT.join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");

export function looksAiRelated(text: string): boolean {
  return AI_RE.test(text);
}

/** Lowercased word-ish tokens used to attach press/social mentions to a known project by name. */
export function nameMentioned(name: string, text: string): boolean {
  const n = name.toLowerCase().replace(/[-_.]+/g, " ").trim();
  if (n.length < 4 || /^(app|demo|agent|agents|chat|test|project|ai|llm|tool|tools|code|web|api|bot)$/.test(n)) return false;
  const t = text.toLowerCase().replace(/[-_.]+/g, " ");
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, "u");
  return re.test(t);
}
