import https from "node:https";
const UA =
  "Mozilla/5.0 (compatible; VibeRadar/0.1; +https://github.com/) AI project monitor";

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

/** GET with timeout, size cap and a polite User-Agent. Returns text (and final URL after redirects). */
export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<{ text: string; url: string; contentType: string }> {
  const { timeoutMs = 20_000, maxBytes = 4_000_000 } = opts;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en,ru;q=0.8,*;q=0.5", ...opts.headers },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) return { text: "", url: res.url, contentType: res.headers.get("content-type") ?? "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  const contentType = res.headers.get("content-type") ?? "";
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  let text: string;
  try {
    text = new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8").decode(buf);
  } catch {
    text = buf.toString("utf8");
  }
  return { text, url: res.url, contentType };
}

/** Plain node:https GET — for hosts whose slow TLS handshake trips undici's fixed 10 s connect timeout (GDELT). */
export function httpsGetText(url: string, timeoutMs = 45_000): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA }, timeout: timeoutMs, family: 4 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (d: Buffer) => {
        size += d.length;
        if (size > 4_000_000) req.destroy(new Error("response too large"));
        else chunks.push(d);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
