import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Db } from "./db.ts";
import { nowIso } from "./util.ts";

const seedSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  kind: z.enum(["github_trending", "github_search", "hn", "reddit", "huggingface", "rss", "telegram", "bluesky"]),
  platform: z.enum(["github", "hn", "reddit", "huggingface", "producthunt", "bluesky", "press", "telegram", "blog"]),
  url: z.string().url(),
  focused: z.boolean().default(false),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});

export type Seed = z.infer<typeof seedSchema>;

export function loadSeeds(file: string): Seed[] {
  const doc = parse(readFileSync(file, "utf8")) as { sources?: unknown[] };
  return z.array(seedSchema).parse(doc.sources ?? []);
}

/** The YAML file is the source of truth: rows are upserted, sources removed from the file are disabled. */
export function syncSeeds(db: Db, seeds: Seed[]) {
  db.tx(() => {
    for (const s of seeds) {
      db.run(
        `INSERT INTO sources(key, name, kind, platform, url, focused, enabled, config, created_at) VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, kind = excluded.kind, platform = excluded.platform, url = excluded.url,
           focused = excluded.focused, enabled = excluded.enabled, config = excluded.config`,
        s.key, s.name, s.kind, s.platform, s.url, s.focused ? 1 : 0, s.enabled ? 1 : 0, JSON.stringify(s.config), nowIso(),
      );
    }
    const keys = new Set(seeds.map((s) => s.key));
    for (const r of db.all<{ key: string }>("SELECT key FROM sources WHERE enabled = 1"))
      if (!keys.has(r.key)) db.run("UPDATE sources SET enabled = 0 WHERE key = ?", r.key);
  });
}
