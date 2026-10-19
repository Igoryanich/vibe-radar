const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

const threshold = levels[(process.env.LOG_LEVEL as Level) ?? "info"] ?? levels.info;

// Never print secrets: bot tokens live inside Telegram URLs, API keys in headers.
const redact = (s: string) =>
  s.replace(/bot\d+:[\w-]+/g, "bot<redacted>").replace(/key=[\w-]+/g, "key=<redacted>");

function write(level: Level, msg: string, data?: Record<string, unknown>) {
  if (levels[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(redact(line) + "\n");
}

export const log = {
  debug: (m: string, d?: Record<string, unknown>) => write("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => write("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => write("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => write("error", m, d),
};

export const errMsg = (e: unknown) => redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
