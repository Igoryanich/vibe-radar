import type { Config } from "../config.ts";
import { type Db, json } from "../db.ts";
import { errMsg, log } from "../log.ts";
import { projectHeadline } from "../metrics.ts";
import { Telegram, TelegramAmbiguous, TelegramRejected } from "../telegram.ts";
import { nowIso, sleep } from "../util.ts";

interface PubRow {
  id: number;
  channel: string;
  project_id: number | null;
  kind: string;
  text: string;
  attempts: number;
  extra: string | null;
}

/** Keep exactly one digest pinned (silently); a failed pin never fails delivery. */
export async function pinDigest(db: Db, tg: Telegram, channel: string, messageId: number) {
  const key = `pinned_digest:${channel}`;
  const previous = Number(db.kvGet(key) ?? 0);
  try {
    await tg.call("pinChatMessage", { chat_id: channel, message_id: messageId, disable_notification: true });
    db.kvSet(key, String(messageId));
  } catch (e) {
    log.warn("digest pin failed", { err: errMsg(e) });
    return;
  }
  if (previous && previous !== messageId)
    await tg.call("unpinChatMessage", { chat_id: channel, message_id: previous }).catch((e) => log.warn("digest unpin failed", { err: errMsg(e) }));
}

/**
 * Deliver pending publications (auto-posting). Telegram has no idempotency key, so a send
 * that might have gone through is marked `uncertain` and never blindly retried.
 */
export async function drain(db: Db, cfg: Config, tg: Telegram | null): Promise<{ sent: number; failed: number }> {
  db.run("UPDATE publications SET status = 'uncertain', error = 'interrupted while sending' WHERE status = 'sending'");
  if (cfg.DRY_RUN || !tg) return { sent: 0, failed: 0 };
  const rows = db.all<PubRow>(
    `SELECT id, channel, project_id, kind, text, attempts, extra FROM publications
     WHERE status = 'pending' AND channel != 'dry-run' AND (retry_at IS NULL OR retry_at <= ?)
     ORDER BY priority DESC, id`,
    nowIso(),
  );
  let sent = 0;
  let failed = 0;
  for (const p of rows) {
    db.run("UPDATE publications SET status = 'sending', attempts = attempts + 1 WHERE id = ?", p.id);
    try {
      const messageId = await tg.send(p.channel, p.text, json(p.extra, {}));
      db.run("UPDATE publications SET status = 'sent', message_id = ?, sent_at = ?, error = NULL WHERE id = ?", messageId, nowIso(), p.id);
      if (p.kind === "digest") await pinDigest(db, tg, p.channel, messageId);
      if (p.project_id) {
        const key = db.get<{ key: string }>("SELECT key FROM projects WHERE id = ?", p.project_id)?.key ?? "";
        db.run(
          `UPDATE projects SET post_count = post_count + 1, last_post_at = ?, last_post_message_id = ?, published_metrics = ? WHERE id = ?`,
          nowIso(), messageId, JSON.stringify(projectHeadline(db, key)), p.project_id,
        );
      }
      sent++;
    } catch (e) {
      failed++;
      if (e instanceof TelegramRejected) {
        if (e.code === 429) {
          db.run("UPDATE publications SET status = 'pending', retry_at = ?, error = ? WHERE id = ?",
            new Date(Date.now() + Math.max(60, e.retryAfter) * 1000).toISOString(), errMsg(e), p.id);
          break;
        }
        db.run("UPDATE publications SET status = 'failed', error = ? WHERE id = ?", errMsg(e), p.id);
      } else if (e instanceof TelegramAmbiguous) {
        db.run("UPDATE publications SET status = 'uncertain', error = ? WHERE id = ?", errMsg(e), p.id);
      } else {
        db.run("UPDATE publications SET status = ?, retry_at = ?, error = ? WHERE id = ?",
          p.attempts + 1 >= 5 ? "failed" : "pending", new Date(Date.now() + 15 * 60_000).toISOString(), errMsg(e), p.id);
      }
      log.warn("telegram send failed", { pub: p.id, err: errMsg(e) });
    }
    await sleep(1500);
  }
  return { sent, failed };
}
