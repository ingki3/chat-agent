/**
 * Uptime measurement (#46, PRD NFR 가용성: 99% = 7일간 5분 간격 외부 헬스 체크 성공 비율). docs/ops.md §9.
 *
 *   pnpm -s uptime check  [--file F] [--token-file T] [--local URL] [--external URL]   one check, appended to F
 *   pnpm -s uptime planned start|end [--note CODE] [--file F]                           mark a planned stop
 *   pnpm -s uptime planned add <from ISO> <to ISO> [--note CODE] [--file F]             mark one afterwards
 *   pnpm -s uptime report [--days 7] [--file F] [--json]                                verdict (exit 0 = pass)
 *
 * A check calls the health endpoint twice at the same moment: locally (127.0.0.1:3000) and through Cloudflare
 * (chat.2prostream.com, with an Access service token). Success = external 200 within 10 s. A failure is "app"
 * when the local call failed too, otherwise "tunnel". The LaunchDaemon com.agentlee.uptime runs `check` every
 * 5 minutes.
 *
 * The service token lives in a file (mode 600) as two header lines, `CF-Access-Client-Id: …` and
 * `CF-Access-Client-Secret: …`. Header values never appear in the output or the records — only status codes,
 * durations and an error class.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeaderLines } from "./sse-probe.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_FILE = process.env.AGENTLEE_UPTIME_FILE ?? path.join(REPO, "data", "uptime.jsonl");
export const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".agentlee", "uptime-token");
export const DEFAULT_LOCAL = "http://127.0.0.1:3000/api/health";
export const DEFAULT_EXTERNAL = "https://chat.2prostream.com/api/health";
export const INTERVAL_MS = 5 * 60_000;
/** How late a scheduled check may start and still count as on time (launchd start delay, clock jitter). */
export const TOLERANCE_MS = 60_000;
export const TIMEOUT_MS = 10_000;
export const TARGET = 0.99;
const DAY = 24 * 3600_000;

export type Probe =
  | { ok: boolean; status: number; ms: number; error?: string }
  /** No service token configured: the external path was not measured. */
  | { skipped: true };
export type CheckRecord = { kind: "check"; at: number; local: Probe; external: Probe };
export type PlannedRecord =
  | { kind: "planned"; from: number; to: number; note?: string }
  | { kind: "planned_start"; at: number; note?: string }
  | { kind: "planned_end"; at: number };
export type UptimeRecord = CheckRecord | PlannedRecord;

/** Error class for a failed request — a fixed word, never the error's message. */
function errorClass(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (code && /^[A-Z_]{2,40}$/.test(code)) return code.toLowerCase();
  return "network";
}

/** One health request: ok = 200 within the timeout and the body is our health response (not an Access page). */
export async function probeHealth(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = TIMEOUT_MS,
): Promise<Probe> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      // not JSON — e.g. a login page
    }
    const ms = Math.round(performance.now() - t0);
    const ours = (body as { service?: unknown } | undefined)?.service === "agent-lee";
    const ok = res.status === 200 && ours && ms <= timeoutMs;
    return {
      ok,
      status: res.status,
      ms,
      ...(ok || res.status !== 200 || ours ? {} : { error: "not_health" }),
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - t0), error: errorClass(e) };
  }
}

/** Reads the service-token header file; refuses one that others can read. Undefined when it does not exist. */
export function readTokenFile(file: string): Record<string, string> | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`token file must be mode 600: ${file}`);
  const h = parseHeaderLines(fs.readFileSync(file, "utf8"));
  const pick = (name: string) => Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];
  const id = pick("cf-access-client-id");
  const secret = pick("cf-access-client-secret");
  if (!id || !secret)
    throw new Error(`token file needs CF-Access-Client-Id and CF-Access-Client-Secret lines`);
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

export async function runCheck(opts: {
  local: string;
  external: string;
  token: Record<string, string> | undefined;
  now?: () => number;
}): Promise<CheckRecord> {
  const at = (opts.now ?? Date.now)();
  const [local, external] = await Promise.all([
    probeHealth(opts.local),
    opts.token ? probeHealth(opts.external, opts.token) : Promise.resolve({ skipped: true } as const),
  ]);
  return { kind: "check", at, local, external };
}

export function appendRecord(file: string, rec: UptimeRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}

export function readRecords(file: string): UptimeRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: UptimeRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as UptimeRecord);
    } catch {
      // a torn last line (power cut mid-write) is skipped
    }
  }
  return out;
}

/** Planned-stop windows from explicit ranges and start/end pairs (an open start runs until `now`). */
export function plannedWindows(records: UptimeRecord[], now: number): [number, number][] {
  const out: [number, number][] = [];
  let open: number | undefined;
  for (const r of [...records].sort((a, b) => ("at" in a ? a.at : a.from) - ("at" in b ? b.at : b.from))) {
    if (r.kind === "planned") out.push([r.from, r.to]);
    else if (r.kind === "planned_start") open ??= r.at;
    else if (r.kind === "planned_end" && open !== undefined) {
      out.push([open, r.at]);
      open = undefined;
    }
  }
  if (open !== undefined) out.push([open, now]);
  return out;
}

export type SlotResult = "ok" | "app" | "tunnel" | "missing" | "planned" | "unmeasured";

export type UptimeReport = {
  verdict: "pass" | "fail" | "insufficient";
  reasons: string[];
  from: string;
  to: string;
  target: number;
  /** ok / (slots − planned − unmeasured). Null when nothing could be measured. */
  uptime: number | null;
  /** Scheduled checks in the window (2016 for 7 days at 5 minutes): recorded slots + missed ones. */
  slots: number;
  /** Checks actually recorded in the window. */
  recorded: number;
  /** Slots counted in the denominator. */
  denominator: number;
  counts: Record<SlotResult, number>;
  /** Failed slots, newest first (at most 50), for the ops log. */
  failures: { at: string; kind: "app" | "tunnel" | "missing" }[];
};

/**
 * The verdict. Checks run on a schedule (launchd StartInterval: every `intervalMs` after the previous start),
 * so each recorded check stands for one scheduled slot, and the gaps between checks say how many were missed:
 * a gap longer than one interval plus `toleranceMs` (a late start, clock jitter) means a check that never ran.
 * A missed check counts as a failure ("missing": the Mac or the checker was down — the checker runs on the
 * same Mac, so a power cut leaves no record at all). Checks closer together than half an interval (a restart
 * runs one at load) are one slot, and the worst of them counts; the schedule continues from the later one. Slots in a planned stop are excluded and shown.
 */
export function computeUptime(
  records: UptimeRecord[],
  opts: { now: number; days?: number; intervalMs?: number; toleranceMs?: number; target?: number },
): UptimeReport {
  const days = opts.days ?? 7;
  const iv = opts.intervalMs ?? INTERVAL_MS;
  const tol = opts.toleranceMs ?? TOLERANCE_MS;
  const target = opts.target ?? TARGET;
  const to = opts.now;
  const from = to - days * DAY;
  const planned = plannedWindows(records, to);
  const inPlanned = (t: number) => planned.some(([a, b]) => t >= a && t < b);
  const all = records
    .filter((r): r is CheckRecord => r.kind === "check" && r.at < to)
    .sort((a, b) => a.at - b.at);

  // Merge checks that belong to one slot; the worst result wins.
  const rank = (c: CheckRecord) => {
    const r = resultOf(c);
    return r === "ok" ? 0 : r === "unmeasured" ? 1 : r === "tunnel" ? 2 : 3;
  };
  /**
   * One scheduled slot: `at` is when it ran (its place in the window, and the end of the gap before it), `base`
   * is the start the next run is scheduled from. They differ after a restart: launchd counts StartInterval from
   * the last launch, and a restart launches a check at load — so the schedule continues from the later check.
   */
  type Slot = { at: number; base: number; check: CheckRecord };
  const kept: Slot[] = [];
  for (const c of all) {
    const last = kept.at(-1);
    if (last && c.at - last.base < iv / 2) {
      // Same slot: the worse result counts, the schedule moves on to the later start.
      if (rank(c) > rank(last.check)) last.check = c;
      last.base = c.at;
    } else kept.push({ at: c.at, base: c.at, check: c });
  }

  const counts: Record<SlotResult, number> = {
    ok: 0,
    app: 0,
    tunnel: 0,
    missing: 0,
    planned: 0,
    unmeasured: 0,
  };
  const failures: UptimeReport["failures"] = [];
  const mark = (t: number, result: SlotResult) => {
    if (t < from || t >= to) return;
    const r = result !== "planned" && inPlanned(t) ? "planned" : result;
    counts[r]++;
    if (r === "app" || r === "tunnel" || r === "missing")
      failures.push({ at: new Date(t).toISOString(), kind: r });
  };
  const missedBetween = (a: number, b: number) => {
    const n = Math.max(0, Math.ceil((b - a - iv - tol) / iv));
    for (let k = 1; k <= n; k++) mark(a + k * iv, "missing");
  };

  let prev = [...kept].reverse().find((k) => k.at < from)?.base;
  const inWindow = kept.filter((k) => k.at >= from);
  for (const k of inWindow) {
    if (prev !== undefined) missedBetween(prev, k.at);
    else {
      // No check before the window: the slots before the first one were missed (coverage is reported below).
      const n = Math.max(0, Math.floor((k.at - from - tol) / iv));
      for (let i = n; i >= 1; i--) mark(k.at - i * iv, "missing");
    }
    mark(k.at, resultOf(k.check));
    prev = k.base;
  }
  if (prev !== undefined) {
    const n = Math.max(0, Math.floor((to - prev - tol) / iv));
    for (let k = 1; k <= n; k++) mark(prev + k * iv, "missing");
  } else {
    for (let t = from; t + iv <= to; t += iv) mark(t, "missing");
  }

  const slots = Object.values(counts).reduce((a, b) => a + b, 0);
  const denominator = slots - counts.planned - counts.unmeasured;
  const uptime = denominator > 0 ? counts.ok / denominator : null;
  const reasons: string[] = [];
  const firstCheck = all[0]?.at;
  if (firstCheck === undefined || firstCheck >= from + iv + tol)
    reasons.push(`recording has not covered ${days} days yet`);
  if (counts.unmeasured > 0)
    reasons.push(`${counts.unmeasured} checks without the external path (no service token)`);
  let verdict: UptimeReport["verdict"];
  if (reasons.length || uptime === null) verdict = "insufficient";
  else verdict = uptime >= target ? "pass" : "fail";
  if (verdict === "fail") reasons.push(`uptime ${(uptime! * 100).toFixed(2)}% < ${target * 100}%`);
  return {
    verdict,
    reasons,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    target,
    uptime,
    slots,
    recorded: all.filter((c) => c.at >= from).length,
    denominator,
    counts,
    failures: failures.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50),
  };
}

function resultOf(c: CheckRecord): SlotResult {
  if ("skipped" in c.external) return "unmeasured";
  if (c.external.ok) return "ok";
  return "ok" in c.local && c.local.ok ? "tunnel" : "app";
}

export function formatReport(r: UptimeReport): string {
  const pct = r.uptime === null ? "—" : `${(r.uptime * 100).toFixed(2)}%`;
  const verdict = { pass: "합격", fail: "불합격", insufficient: "판정 불가" }[r.verdict];
  return [
    `가동률 ${pct} (목표 ${r.target * 100}%) — ${verdict}`,
    `기간 ${r.from} ~ ${r.to}`,
    `분모 ${r.denominator} = 예정 체크 ${r.slots} − 계획 정지 ${r.counts.planned} − 외부 미측정 ${r.counts.unmeasured} (기록된 체크 ${r.recorded})`,
    `성공 ${r.counts.ok} · 앱 실패 ${r.counts.app} · 터널 실패 ${r.counts.tunnel} · 기록 없음 ${r.counts.missing}`,
    ...r.reasons.map((x) => `- ${x}`),
  ].join("\n");
}

const NOTE = /^[a-z0-9_-]{1,32}$/;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") flags.json = true;
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else pos.push(a);
  }
  return { flags, pos };
}

function isMainModule(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return fs.realpathSync(path.resolve(arg)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<number> {
  const { flags, pos } = parseArgs(argv);
  const str = (k: string, d: string) => (typeof flags[k] === "string" ? (flags[k] as string) : d);
  const file = str("file", DEFAULT_FILE);
  const note = typeof flags.note === "string" ? flags.note : undefined;
  if (note !== undefined && !NOTE.test(note))
    throw new Error("--note must be a short code like reboot or filevault");
  const withNote = note ? { note } : {};
  switch (pos[0]) {
    case "check": {
      const token = readTokenFile(str("token-file", DEFAULT_TOKEN_FILE));
      const rec = await runCheck({
        local: str("local", DEFAULT_LOCAL),
        external: str("external", DEFAULT_EXTERNAL),
        token,
      });
      appendRecord(file, rec);
      console.log(JSON.stringify(rec));
      return 0;
    }
    case "planned": {
      const now = Date.now();
      if (pos[1] === "start") appendRecord(file, { kind: "planned_start", at: now, ...withNote });
      else if (pos[1] === "end") appendRecord(file, { kind: "planned_end", at: now });
      else if (pos[1] === "add") {
        const a = Date.parse(pos[2] ?? "");
        const b = Date.parse(pos[3] ?? "");
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a)
          throw new Error("planned add <from ISO> <to ISO>");
        appendRecord(file, { kind: "planned", from: a, to: b, ...withNote });
      } else throw new Error("planned start|end|add");
      console.log("recorded");
      return 0;
    }
    case "report": {
      const days = Number(str("days", "7"));
      if (!(days > 0)) throw new Error("--days must be positive");
      const r = computeUptime(readRecords(file), { now: Date.now(), days });
      console.log(flags.json ? JSON.stringify(r, null, 2) : formatReport(r));
      return r.verdict === "pass" ? 0 : r.verdict === "fail" ? 1 : 3;
    }
    default:
      console.error(
        fs
          .readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(3, 7)
          .join("\n"),
      );
      return 2;
  }
}

if (isMainModule()) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    // Our own messages name files and rules only; anything else is reduced to its class.
    console.error(
      `uptime: ${e instanceof Error && /^(token file|--|planned)/.test(e.message) ? e.message : "failed"}`,
    );
    process.exit(2);
  }
}
