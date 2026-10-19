# CLAUDE.md — contract for AI coding sessions

Autonomous Russian-language Telegram channel about viral AI / vibe-coding projects. Sister project of
`russia-nato-monitor` (same stack and conventions). Owner is a non-developer; optimise for correctness,
traceability, €0 running cost and being understandable by one person. Product docs: `README.md` (Russian);
editorial rules: `prompts/system.md`.

## Stack and conventions

- Node 24, TypeScript run **directly** by Node (type stripping) — no build step. Only erasable syntax:
  no `enum`, no constructor parameter properties, no namespaces. Relative imports end in `.ts`.
- SQLite via `node:sqlite` (`src/db.ts`). Migrations are an append-only array; never edit an existing one.
- Gemini over REST (`src/llm.ts`, shared with russia-nato-monitor): model chain with fallback on quota,
  per-run / per-day caps in `llm_usage`, optional capped paid editor key. Every LLM output is zod-validated.
- Config only through `src/config.ts`. Logs are NDJSON; the logger redacts bot tokens.

## Pipeline (src/cycle.ts)

collect (`pipeline/collect.ts`, `collectors/*`) → refresh tracked repos → `candidates.ts` (group by project,
deltas from `snapshots`, pre-rank) → `scan.ts` (model verdicts) → `editorial.ts` (code thresholds, write,
check, queue) → `digest.ts` (daily, after DIGEST_HOUR_LOCAL) → `publish.ts` (Telegram queue) → prune.

## Editorial invariants (do not weaken without the owner's say)

- Velocity comes only from measured counters (`metrics.ts`); never extrapolated.
- No figure in a published text that is not in measured data (±5%) — `textcheck.unknownFigures`.
- No link in a published text that collectors did not see — `editorial.allowedLinks` (model URLs are untrusted).
- Post thresholds are re-checked in code (`postDecision`); a repeat needs ≥3× growth or news after a cooldown.
- Scam is never posted (model status `skip`); `needs_check` is never posted.
- Telegram delivery: `sending` is committed before the request; ambiguous outcomes become `uncertain`, never auto-retried.

## Commands

| Command | What |
|---|---|
| `npm run cycle` | one full cycle (what Actions runs hourly) |
| `node src/cli.ts candidates [n]` | what the next scan would see |
| `node src/cli.ts projects` | latest verdicts |
| `npm run posts -- 10` | latest generated texts |
| `node src/cli.ts prompt scan` | the filled system prompt |
| `node scripts/sql.ts "SELECT …"` | read-only ad-hoc query (`DATABASE_PATH=data/radar.db`) |
| `npm run check` | typecheck + tests — must pass before a commit |

## When you change things

- Prompt changes: bump `SCAN_VERSION` in `pipeline/scan.ts` and look at real output (`scan`, `posts-queue`, `posts`).
- New source: add to `config/sources.yaml` and check it with `node src/cli.ts collect <key>` + `sources`.
