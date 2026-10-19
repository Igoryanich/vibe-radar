import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// Schema migrations: append only. PRAGMA user_version tracks the applied count.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,             -- github_trending | github_search | hn | reddit | huggingface | rss | telegram | bluesky
    url TEXT NOT NULL,
    platform TEXT NOT NULL,         -- github | hn | reddit | huggingface | producthunt | bluesky | press | telegram | blog
    focused INTEGER NOT NULL DEFAULT 0,  -- 1 = AI-only source, no keyword pre-filter
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_fetch_at TEXT, last_success_at TEXT, last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0
  );
  -- One row per thing seen on a platform: a repo, an HN story, a Reddit post, a Space, an article.
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    platform TEXT NOT NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    author TEXT,
    link TEXT,                      -- the outbound link (project site / repo) if the item points elsewhere
    links TEXT NOT NULL DEFAULT '[]',
    project_key TEXT,               -- gh:owner/repo | hf:spaces/owner/name | web:host | ph:slug — NULL = context mention
    relevant INTEGER NOT NULL DEFAULT 1,
    item_created_at TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    metrics TEXT NOT NULL DEFAULT '{}'   -- latest observed counters
  );
  CREATE INDEX items_project ON items(project_key);
  CREATE INDEX items_last_seen ON items(last_seen);
  -- Counter history: the basis of every 24h / 72h delta. Velocity is computed here, never guessed by the model.
  CREATE TABLE snapshots (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    metrics TEXT NOT NULL
  );
  CREATE INDEX snapshots_item_at ON snapshots(item_id, at);
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    merged_into TEXT,               -- the scan said this is the same project as another key
    last_scan_at TEXT,
    last_scan_metrics TEXT,         -- headline metrics at the last scan (rescan throttle)
    scan TEXT,                      -- last scan candidate JSON
    hype_score INTEGER,
    stage TEXT,
    status TEXT NOT NULL DEFAULT 'new',  -- new | publish_post | digest_only | skip | needs_check
    post_count INTEGER NOT NULL DEFAULT 0,
    last_post_at TEXT,
    last_post_message_id INTEGER,
    published_metrics TEXT          -- headline metrics at the last post (for "≥3× growth" updates)
  );
  CREATE TABLE scans (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    mode TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT
  );
  CREATE TABLE publications (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    channel TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id),
    kind TEXT NOT NULL,             -- post | update | digest
    text TEXT NOT NULL,
    extra TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed | uncertain | cancelled
    message_id INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    error TEXT,
    UNIQUE(key, channel)
  );
  CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, stats TEXT);
  CREATE TABLE llm_usage (
    day TEXT NOT NULL, model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(day, model)
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export type Row = Record<string, SQLInputValue>;

export class Db {
  raw: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    const v = (this.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.raw.exec("BEGIN");
      this.raw.exec(MIGRATIONS[i]);
      this.raw.exec(`PRAGMA user_version = ${i + 1}`);
      this.raw.exec("COMMIT");
    }
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...params);
  }
  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN");
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  kvGet(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value;
  }
  kvSet(key: string, value: string) {
    this.run("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  close() {
    // Fold the WAL back so the single .db file is complete before it is committed to git.
    this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.raw.close();
  }
}

export const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
