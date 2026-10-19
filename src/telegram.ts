// Minimal Telegram Bot API client. The bot token only ever lives in the URL path,
// and the logger redacts `bot<token>` patterns.

export class TelegramRejected extends Error {
  code: number;
  retryAfter: number;
  constructor(code: number, description: string, retryAfter = 0) {
    super(`Telegram ${code}: ${description}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** 5xx / network after the request left: the message may or may not have been delivered. */
export class TelegramAmbiguous extends Error {}

export class Telegram {
  private token: string;
  constructor(token: string) {
    this.token = token;
  }

  async call<T = any>(method: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code ?? "";
      // Failed before connecting → safe to retry; anything later is ambiguous.
      if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT/.test(cause)) throw new Error(`connect failed: ${cause}`);
      throw new TelegramAmbiguous(`network error after send: ${cause || (e as Error).name}`);
    }
    if (res.status >= 500) throw new TelegramAmbiguous(`server ${res.status}`);
    const data = (await res.json()) as { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (!data.ok) throw new TelegramRejected(data.error_code ?? res.status, data.description ?? "", data.parameters?.retry_after ?? 0);
    return data.result as T;
  }

  async send(chatId: string, html: string, extra: Record<string, unknown> = {}): Promise<number> {
    const r = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra,
    });
    return r.message_id;
  }
}
