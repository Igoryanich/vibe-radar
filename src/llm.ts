import { appendFileSync } from "node:fs";
import type { z } from "zod";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errMsg, log } from "./log.ts";
import { sleep } from "./util.ts";

const API = "https://generativelanguage.googleapis.com/v1beta";

export class BudgetExhausted extends Error {}

class QuotaError extends Error {}

/**
 * Gemini over REST. A call walks a model chain: a model that answers 429 /
 * quota / not-found is skipped for the rest of the run, so free-tier daily caps
 * on one model degrade to the next instead of failing the cycle.
 */
export class Llm {
  private lastCall = 0;
  private callsThisRun = 0;
  private dead = new Set<string>();
  private db: Db;
  private cfg: Config;
  constructor(db: Db, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
  }

  get enabled() {
    return !!this.cfg.GEMINI_API_KEY;
  }

  get calls() {
    return this.callsThisRun;
  }

  private day() {
    return new Date().toISOString().slice(0, 10);
  }

  private checkBudget() {
    if (this.callsThisRun >= this.cfg.LLM_MAX_CALLS_PER_RUN) throw new BudgetExhausted("per-run LLM cap reached");
    const used = this.db.get<{ n: number }>("SELECT COALESCE(SUM(calls),0) AS n FROM llm_usage WHERE day = ?", this.day())?.n ?? 0;
    if (used >= this.cfg.LLM_MAX_CALLS_PER_DAY) throw new BudgetExhausted("daily LLM cap reached");
  }

  private record(model: string, ok: boolean, tin = 0, tout = 0) {
    this.db.run(
      `INSERT INTO llm_usage(day, model, calls, failures, tokens_in, tokens_out) VALUES(?,?,1,?,?,?)
       ON CONFLICT(day, model) DO UPDATE SET calls = calls + 1, failures = failures + excluded.failures,
       tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
      this.day(), model, ok ? 0 : 1, tin, tout,
    );
  }

  private async throttle() {
    const wait = this.cfg.LLM_MIN_INTERVAL_MS - (Date.now() - this.lastCall);
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
  }

  /** Estimated EUR spent today through the paid key (list prices, thinking counted as output). */
  paidSpendToday(): number {
    const r = this.db.get<{ tin: number; tout: number }>(
      "SELECT COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout FROM llm_usage WHERE day = ? AND model LIKE 'paid:%'",
      this.day(),
    );
    return ((r?.tin ?? 0) * this.cfg.PAID_PRICE_IN_PER_M + (r?.tout ?? 0) * this.cfg.PAID_PRICE_OUT_PER_M) / 1e6;
  }

  /** Would the next paid call (worst case: full prompt + full output incl. thinking) exceed today's cap? */
  private paidBudgetAllows(promptChars: number, maxTokens: number): boolean {
    const worst = ((promptChars / 3) * this.cfg.PAID_PRICE_IN_PER_M + maxTokens * 2 * this.cfg.PAID_PRICE_OUT_PER_M) / 1e6;
    return this.paidSpendToday() + worst <= this.cfg.PAID_DAILY_BUDGET_EUR;
  }

  private async post(path: string, body: unknown, apiKey = this.cfg.GEMINI_API_KEY): Promise<any> {
    const res = await fetch(`${API}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    // 402 = prepay credits depleted (or billing not yet synced): treat like an exhausted model.
    if (res.status === 402 || res.status === 429 || res.status === 404 || /RESOURCE_EXHAUSTED|quota/i.test(text.slice(0, 500)) && !res.ok)
      throw new QuotaError(`${res.status} ${text.slice(0, 160)}`);
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  /** Generate JSON validated by `schema`. One repair retry on invalid output per model. */
  async json<T extends z.ZodTypeAny>(opts: {
    system: string;
    user: string;
    schema: T;
    tier: "cheap" | "editor";
    maxTokens?: number;
    temperature?: number;
  }): Promise<z.infer<T>> {
    const free = (opts.tier === "editor" ? this.cfg.LLM_EDITOR_MODELS : this.cfg.LLM_MODELS).split(",").map((m) => m.trim());
    // The paid key only ever serves the editor tier, first in its chain.
    const paid = opts.tier === "editor" && this.cfg.GEMINI_PAID_API_KEY ? [`paid:${this.cfg.PAID_EDITOR_MODEL}`] : [];
    const chain = [...paid, ...free].filter((m) => m && !this.dead.has(m));
    if (!chain.length) throw new BudgetExhausted("all models exhausted for this run");
    let lastErr: unknown;
    for (const entry of chain) {
      const isPaid = entry.startsWith("paid:");
      const model = isPaid ? entry.slice(5) : entry;
      if (isPaid && !this.paidBudgetAllows(opts.system.length + opts.user.length, opts.maxTokens ?? 8192)) {
        log.info("paid daily budget reached, using free editor models", { spent: this.paidSpendToday().toFixed(3) });
        this.dead.add(entry);
        continue;
      }
      const gemma = model.startsWith("gemma");
      for (let attempt = 0; attempt < 2; attempt++) {
        this.checkBudget();
        await this.throttle();
        this.callsThisRun++;
        const user = attempt === 0 ? opts.user : `${opts.user}\n\nТвой прошлый ответ не прошёл проверку схемы: ${errMsg(lastErr)}. Верни ТОЛЬКО корректный JSON.`;
        const body: Record<string, unknown> = {
          contents: [{ role: "user", parts: [{ text: gemma ? `${opts.system}\n\n${user}` : user }] }],
          generationConfig: {
            temperature: opts.temperature ?? 0.2,
            maxOutputTokens: opts.maxTokens ?? 8192,
            ...(gemma ? {} : { responseMimeType: "application/json" }),
          },
        };
        if (!gemma) body.systemInstruction = { parts: [{ text: opts.system }] };
        try {
          const data = await this.post(`models/${model}:generateContent`, body, isPaid ? this.cfg.GEMINI_PAID_API_KEY : undefined);
          const text: string = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
          const um = data.usageMetadata ?? {};
          // Thinking tokens are billed as output: fold them in so the paid budget sees the real cost.
          um.candidatesTokenCount = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
          if (process.env.LLM_DUMP) appendFileSync(process.env.LLM_DUMP, `
=== ${model}
${text}
`);
          const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
          const parsed = opts.schema.safeParse(JSON.parse(cleaned));
          if (!parsed.success) {
            this.record(entry, false, um.promptTokenCount, um.candidatesTokenCount);
            lastErr = new Error(parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
            log.warn("llm output failed validation", { model, err: errMsg(lastErr), finish: data.candidates?.[0]?.finishReason });
            continue;
          }
          this.record(entry, true, um.promptTokenCount, um.candidatesTokenCount);
          return parsed.data;
        } catch (e) {
          lastErr = e;
          if (e instanceof QuotaError) {
            this.record(entry, false);
            log.warn("model quota/unavailable, falling back", { model: entry, err: errMsg(e) });
            this.dead.add(entry);
            break;
          }
          if (e instanceof BudgetExhausted) throw e;
          this.record(entry, false);
          if (!(e instanceof SyntaxError)) log.warn("llm call failed", { model: entry, err: errMsg(e) });
        }
      }
    }
    throw new Error(`LLM failed on all models: ${errMsg(lastErr)}`);
  }

  /** Batch embeddings (one request per ≤100 texts), unit-normalised. */
  async embed(texts: string[]): Promise<number[][]> {
    // Free tier counts every text in a batch against a ~100/min quota.
    const CHUNK = 90;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += CHUNK) {
      const chunk = texts.slice(i, i + CHUNK);
      if (i > 0) await sleep(62_000);
      this.checkBudget();
      await this.throttle();
      this.callsThisRun++;
      const model = this.cfg.EMBED_MODEL;
      const body = {
        requests: chunk.map((t) => ({
          model: `models/${model}`,
          content: { parts: [{ text: t.slice(0, 6000) }] },
          taskType: "CLUSTERING",
          outputDimensionality: 768,
        })),
      };
      try {
        let data: any;
        try {
          data = await this.post(`models/${model}:batchEmbedContents`, body);
        } catch (e) {
          if (!(e instanceof QuotaError)) throw e;
          await sleep(65_000);
          data = await this.post(`models/${model}:batchEmbedContents`, body);
        }
        this.record(model, true);
        for (const e of data.embeddings as { values: number[] }[]) {
          const n = Math.hypot(...e.values) || 1;
          out.push(e.values.map((v) => Math.round((v / n) * 1e5) / 1e5));
        }
      } catch (e) {
        this.record(model, false);
        throw e;
      }
    }
    return out;
  }
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

export function centroid(vectors: number[][]): number[] | null {
  if (!vectors.length) return null;
  const sum = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  const n = Math.hypot(...sum) || 1;
  return sum.map((x) => Math.round((x / n) * 1e5) / 1e5);
}
