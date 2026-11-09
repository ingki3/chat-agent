/**
 * Measures an SSE stream end to end (#8): time to headers, gaps between events, and whether events arrive in
 * bursts (a sign of buffering in a proxy). Pairs with the server's /api/diag/stream (DIAG_STREAM=1).
 *
 *   pnpm sse-probe https://chat.2prostream.com/api/diag/stream?seconds=180 [-H "Name: value"] [--json out.json]
 *
 * Headers given with -H (e.g. an Access cookie) are sent but never printed.
 */
import fs from "node:fs";

export type Arrival = { at: number; kind: "tick" | "done" | "comment"; sentAt?: number | undefined };

export type ProbeReport = {
  pass: boolean;
  reasons: string[];
  status: number;
  contentType: string;
  headersMs: number;
  durationMs: number;
  ticks: number;
  expectedTicks: number | null;
  heartbeats: number;
  done: boolean;
  maxGapMs: number;
  /** Ticks that arrived much sooner after the previous one than they were sent — i.e. released together. */
  bunched: number;
};

export type Limits = { maxGapMs: number; maxBunched: number; maxHeadersMs: number };
export const DEFAULT_LIMITS: Limits = { maxGapMs: 3000, maxBunched: 2, maxHeadersMs: 2000 };

/** Pure analysis of a recorded stream, so the pass/fail rules are unit-testable. */
export function analyse(
  meta: { status: number; contentType: string; headersMs: number; expectedTicks: number | null },
  arrivals: Arrival[],
  limits: Limits = DEFAULT_LIMITS,
): ProbeReport {
  const ticks = arrivals.filter((a) => a.kind === "tick");
  let maxGapMs = 0;
  let bunched = 0;
  for (let i = 1; i < ticks.length; i++) {
    const gap = ticks[i]!.at - ticks[i - 1]!.at;
    maxGapMs = Math.max(maxGapMs, gap);
    const sentGap = (ticks[i]!.sentAt ?? 0) - (ticks[i - 1]!.sentAt ?? 0);
    if (sentGap >= 500 && gap < sentGap * 0.2) bunched++;
  }
  const done = arrivals.some((a) => a.kind === "done");
  const durationMs = arrivals.length ? arrivals[arrivals.length - 1]!.at : 0;
  const reasons: string[] = [];
  if (meta.status !== 200) reasons.push(`status ${meta.status}`);
  if (!meta.contentType.startsWith("text/event-stream"))
    reasons.push(`content-type ${meta.contentType || "(none)"}`);
  if (meta.headersMs > limits.maxHeadersMs) reasons.push(`headers after ${meta.headersMs} ms`);
  if (!done) reasons.push("stream ended before the done event");
  if (meta.expectedTicks !== null && ticks.length !== meta.expectedTicks)
    reasons.push(`${ticks.length}/${meta.expectedTicks} ticks`);
  if (maxGapMs > limits.maxGapMs) reasons.push(`max gap ${maxGapMs} ms`);
  if (bunched > limits.maxBunched) reasons.push(`${bunched} bunched ticks (buffering?)`);
  return {
    pass: reasons.length === 0,
    reasons,
    status: meta.status,
    contentType: meta.contentType,
    headersMs: meta.headersMs,
    durationMs,
    ticks: ticks.length,
    expectedTicks: meta.expectedTicks,
    heartbeats: arrivals.filter((a) => a.kind === "comment").length,
    done,
    maxGapMs,
    bunched,
  };
}

/** Splits an SSE byte stream into arrivals. Keeps partial blocks between chunks. */
export function sseParser(now: () => number) {
  let buf = "";
  return (chunk: string): Arrival[] => {
    buf += chunk;
    const out: Arrival[] = [];
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split("\n");
      if (lines.every((l) => l.startsWith(":"))) {
        out.push({ at: now(), kind: "comment" });
        continue;
      }
      const event = lines
        .find((l) => l.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = lines
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (event === "tick" || event === "done") {
        let sentAt: number | undefined;
        try {
          sentAt = (JSON.parse(data ?? "{}") as { t?: number }).t;
        } catch {
          sentAt = undefined;
        }
        out.push({ at: now(), kind: event, sentAt });
      }
    }
    return out;
  };
}

export async function probe(url: string, headers: Record<string, string>): Promise<ProbeReport> {
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const res = await fetch(url, { headers: { Accept: "text/event-stream", ...headers } });
  const headersMs = now();
  const seconds = Number(new URL(url).searchParams.get("seconds") ?? 180);
  const meta = {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    headersMs,
    expectedTicks: Number.isFinite(seconds) ? seconds : null,
  };
  const arrivals: Arrival[] = [];
  if (res.ok && res.body) {
    const parse = sseParser(now);
    const decoder = new TextDecoder();
    for await (const chunk of res.body) arrivals.push(...parse(decoder.decode(chunk, { stream: true })));
  }
  return analyse(meta, arrivals);
}

function parseArgs(argv: string[]) {
  const headers: Record<string, string> = {};
  let url: string | undefined;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-H") {
      const [k, ...v] = (argv[++i] ?? "").split(":");
      if (k && v.length) headers[k.trim()] = v.join(":").trim();
    } else if (a === "--json") json = argv[++i];
    else url = a;
  }
  return { url, headers, json };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url, headers, json } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error(
      "usage: pnpm sse-probe <url>/api/diag/stream?seconds=180 [-H 'Name: value'] [--json out.json]",
    );
    process.exit(2);
  }
  const report = await probe(url, headers);
  const out = { url: url.split("?")[0], at: new Date().toISOString(), ...report };
  if (json) fs.writeFileSync(json, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  process.exit(report.pass ? 0 : 1);
}
