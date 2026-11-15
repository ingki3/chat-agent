/**
 * Measures an SSE stream end to end (#8): time to headers, gaps between events (including the first and the
 * last), heartbeat spacing, and whether events arrive in bursts (a sign of buffering in a proxy).
 * Pairs with the server's /api/diag/stream (DIAG_STREAM=1).
 *
 *   pnpm -s sse-probe <url>/api/diag/stream?seconds=180 [--header-file h.txt] [--json out.json]
 *
 * Request headers (e.g. an Access cookie) go in a file, one "Name: value" per line, so they never appear in the
 * command line, the process list, the output or the result file. `-H "Name: value"` also works for local tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Arrival = {
  at: number;
  kind: "tick" | "done" | "open" | "heartbeat";
  sentAt?: number | undefined;
};

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
  maxHeartbeatGapMs: number;
  done: boolean;
  /** Longest silence between headers, ticks and done. */
  maxGapMs: number;
  /** Ticks that arrived much sooner after the previous one than they were sent — i.e. released together. */
  bunched: number;
};

export type Limits = {
  maxGapMs: number;
  maxBunched: number;
  maxHeadersMs: number;
  maxHeartbeatGapMs: number;
};
export const DEFAULT_LIMITS: Limits = {
  maxGapMs: 3000,
  maxBunched: 2,
  maxHeadersMs: 2000,
  // Server heartbeat is 15 s; allow some jitter.
  maxHeartbeatGapMs: 20_000,
};

/** Pure analysis of a recorded stream, so the pass/fail rules are unit-testable. */
export function analyse(
  meta: {
    status: number;
    contentType: string;
    headersMs: number;
    expectedTicks: number | null;
    error?: string;
  },
  arrivals: Arrival[],
  limits: Limits = DEFAULT_LIMITS,
): ProbeReport {
  const ticks = arrivals.filter((a) => a.kind === "tick");
  const doneAt = arrivals.find((a) => a.kind === "done")?.at;
  const end = arrivals.length ? arrivals[arrivals.length - 1]!.at : meta.headersMs;

  const timeline = [meta.headersMs, ...ticks.map((t) => t.at), ...(doneAt === undefined ? [] : [doneAt])];
  let maxGapMs = 0;
  for (let i = 1; i < timeline.length; i++) maxGapMs = Math.max(maxGapMs, timeline[i]! - timeline[i - 1]!);

  let bunched = 0;
  for (let i = 1; i < ticks.length; i++) {
    const gap = ticks[i]!.at - ticks[i - 1]!.at;
    const sentGap = (ticks[i]!.sentAt ?? 0) - (ticks[i - 1]!.sentAt ?? 0);
    if (sentGap >= 500 && gap < sentGap * 0.2) bunched++;
  }

  const beats = [meta.headersMs, ...arrivals.filter((a) => a.kind === "heartbeat").map((a) => a.at), end];
  let maxHeartbeatGapMs = 0;
  for (let i = 1; i < beats.length; i++)
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, beats[i]! - beats[i - 1]!);

  const reasons: string[] = [];
  if (meta.error) reasons.push(meta.error);
  if (meta.status !== 200) reasons.push(`status ${meta.status}`);
  if (!meta.contentType.startsWith("text/event-stream"))
    reasons.push(`content-type ${meta.contentType || "(none)"}`);
  if (meta.headersMs > limits.maxHeadersMs) reasons.push(`headers after ${meta.headersMs} ms`);
  if (doneAt === undefined) reasons.push("stream ended before the done event");
  if (meta.expectedTicks !== null && ticks.length !== meta.expectedTicks)
    reasons.push(`${ticks.length}/${meta.expectedTicks} ticks`);
  if (maxGapMs > limits.maxGapMs) reasons.push(`max gap ${maxGapMs} ms`);
  if (bunched > limits.maxBunched) reasons.push(`${bunched} bunched ticks (buffering?)`);
  if (maxHeartbeatGapMs > limits.maxHeartbeatGapMs) reasons.push(`no heartbeat for ${maxHeartbeatGapMs} ms`);
  return {
    pass: reasons.length === 0,
    reasons,
    status: meta.status,
    contentType: meta.contentType,
    headersMs: meta.headersMs,
    durationMs: end,
    ticks: ticks.length,
    expectedTicks: meta.expectedTicks,
    heartbeats: arrivals.filter((a) => a.kind === "heartbeat").length,
    maxHeartbeatGapMs,
    done: doneAt !== undefined,
    maxGapMs,
    bunched,
  };
}

/** Splits an SSE byte stream into arrivals. Keeps partial blocks between chunks; accepts LF, CRLF and CR. */
export function sseParser(now: () => number) {
  let buf = "";
  return (chunk: string): Arrival[] => {
    buf += chunk;
    // A trailing CR may be the first half of a CRLF split across chunks.
    const hold = buf.endsWith("\r") ? "\r" : "";
    let text = (hold ? buf.slice(0, -1) : buf).replace(/\r\n?/g, "\n");
    const out: Arrival[] = [];
    let idx: number;
    while ((idx = text.indexOf("\n\n")) !== -1) {
      const lines = text.slice(0, idx).split("\n");
      text = text.slice(idx + 2);
      if (lines.every((l) => l.startsWith(":"))) {
        out.push({ at: now(), kind: lines.some((l) => l.slice(1).trim() === "open") ? "open" : "heartbeat" });
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
    buf = text + hold;
    return out;
  };
}

export async function probe(
  url: string,
  headers: Record<string, string>,
  opts: { idleMs?: number; graceMs?: number } = {},
): Promise<ProbeReport> {
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const seconds = Number(new URL(url).searchParams.get("seconds") ?? 180);
  const expectedTicks = Number.isFinite(seconds) ? seconds : null;
  // Hard deadline: the stream length plus grace; idle deadline: nothing at all received for idleMs.
  const ctrl = new AbortController();
  const total = setTimeout(
    () => ctrl.abort(new Error("overall deadline")),
    (expectedTicks ?? 180) * 1000 + (opts.graceMs ?? 15_000),
  );
  let idle: NodeJS.Timeout | undefined;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new Error("idle deadline")), opts.idleMs ?? 30_000);
  };
  const meta = {
    status: 0,
    contentType: "",
    headersMs: 0,
    expectedTicks,
    error: undefined as string | undefined,
  };
  const arrivals: Arrival[] = [];
  try {
    bump();
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream", ...headers },
      signal: ctrl.signal,
    });
    meta.headersMs = now();
    meta.status = res.status;
    meta.contentType = res.headers.get("content-type") ?? "";
    if (res.ok && res.body) {
      const parse = sseParser(now);
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        bump();
        arrivals.push(...parse(decoder.decode(chunk, { stream: true })));
      }
    }
  } catch (e) {
    meta.headersMs ||= now();
    // Error messages may echo request headers; report only a fixed description.
    const reason = ctrl.signal.aborted ? (ctrl.signal.reason as Error).message : (e as Error).name;
    meta.error = `request failed: ${reason}`;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
  const { error, ...rest } = meta;
  return analyse(error ? { ...rest, error } : rest, arrivals);
}

/** Parses "Name: value" lines. Blank lines and lines starting with # are ignored. */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

function parseArgs(argv: string[]) {
  const headers: Record<string, string> = {};
  let url: string | undefined;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-H") Object.assign(headers, parseHeaderLines(argv[++i] ?? ""));
    else if (a === "--header-file")
      Object.assign(headers, parseHeaderLines(fs.readFileSync(argv[++i] ?? "", "utf8")));
    else if (a === "--json") json = argv[++i];
    else url = a;
  }
  return { url, headers, json };
}

/** True when run as a script. Compares real paths, so spaces, non-ASCII names and symlinks (/var → /private/var) work. */
function isMainModule(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fs.realpathSync(path.resolve(arg)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const isMain = isMainModule();
if (isMain) {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`sse-probe: cannot read arguments (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    process.exit(2);
  }
  if (!args.url) {
    console.error(
      "usage: pnpm -s sse-probe <url>/api/diag/stream?seconds=180 [--header-file h.txt] [--json out.json]",
    );
    process.exit(2);
  }
  const report = await probe(args.url, args.headers);
  const out = { url: args.url.split("?")[0], at: new Date().toISOString(), ...report };
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  process.exit(report.pass ? 0 : 1);
}
