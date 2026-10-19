import { existsSync, readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { localDate } from "./util.ts";

export type Mode = "scan" | "single_post" | "daily_digest";

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export function ruDate(isoDay: string): string {
  return `${Number(isoDay.slice(8, 10))} ${MONTHS[Number(isoDay.slice(5, 7)) - 1]}`;
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim() : "");

/** The channel prompt (prompts/system.md) with every {{VARIABLE}} filled. Unknown variables are an error, not silent text. */
export function systemPrompt(cfg: Config, mode: Mode, now = new Date()): string {
  const day = localDate(cfg.TIMEZONE, now);
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone: cfg.TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(now);
  const vars: Record<string, string> = {
    MODE: mode,
    CHANNEL_NAME: cfg.CHANNEL_NAME,
    CURRENT_DATETIME: `${day} ${time}`,
    TIMEZONE: cfg.TIMEZONE,
    REFERENCE_DESCRIPTION: read(cfg.REFERENCE_FILE) || "(описание эталона не задано)",
    SCORE_ANCHORS: read(cfg.ANCHORS_FILE) ? `Опорные примеры из истории канала:\n${read(cfg.ANCHORS_FILE)}` : "",
    POST_MAX_CHARS: String(cfg.POST_MAX_CHARS),
    DIGEST_MAX_CHARS: String(cfg.DIGEST_MAX_CHARS),
    DIGEST_TIME: `${String(cfg.DIGEST_HOUR_LOCAL).padStart(2, "0")}:00, ${cfg.TIMEZONE}`,
    DATE: ruDate(day),
  };
  const text = read(cfg.PROMPT_FILE).replace(/\{\{([A-Z_]+)\}\}/g, (m, name: string) => {
    if (!(name in vars)) throw new Error(`prompt variable ${m} has no value`);
    return vars[name];
  });
  return text.replace(/\n{3,}/g, "\n\n");
}
