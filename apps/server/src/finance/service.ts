import type { SkillResult } from "@agentlee/mcp-tools";
import type { FinanceToolInfo } from "@agentlee/mcp-tools/finance";
import { redactValue } from "../mcp/service.js";
import { carriesSecret, decodedViews, EGRESS_WINDOW, urlTexts, withoutParam } from "../secrets/egress.js";
import { scrubKnownDeep } from "../secrets/known.js";
import { DART_HOSTS, SEC_HOSTS } from "@agentlee/mcp-tools/finance";
import {
  RAW_JOB_LIMITS,
  type RawPause,
  type RawResponse,
  type RawResume,
  type RawStep,
  type WebWorker,
  type WorkerJob,
} from "../web/service.js";
import { DART_KEY, SEC_UA, TOOL_IMPLS, type FinanceCode, type Plan } from "./providers.js";
import { finalize } from "./records.js";

/**
 * Finance tools (#30, PRD FR-7.1–7.4). A call: the provider's plan (exact URLs of the tool's own hosts), the
 * sandboxed fetch worker (web/worker.mjs `raw`) through the tool's own egress proxy — which lets through exactly
 * those hosts — then the provider's parser and the stamp check (records.ts `finalize`). Secrets (the OpenDART key,
 * the SEC contact) go to the worker in the job only and are scrubbed from whatever comes back.
 */

/** Outcome codes of the finance tools (logged as `financeCode`, shown to the model as `{ error }`). */
export const FINANCE_CODES: readonly FinanceCode[] = [
  "finance_bad_input",
  "finance_not_allowed",
  "finance_unconfigured",
  "finance_unavailable",
  "finance_blocked",
  "finance_unreachable",
  "finance_timeout",
  "finance_http_error",
  "finance_rate_limited",
  "finance_not_found",
  "finance_bad_response",
  "finance_busy",
  "finance_failed",
];

/** Secret names the finance tools use (both in SKILL_SECRET_NAMES, read from `.env`). */
export const FINANCE_SECRET_NAMES = [DART_KEY, SEC_UA] as const;

/** The worker's code → ours. */
const FROM_WEB: Record<string, FinanceCode> = {
  web_blocked: "finance_blocked",
  web_unreachable: "finance_unreachable",
  web_tls: "finance_unreachable",
  web_timeout: "finance_timeout",
  web_unavailable: "finance_unavailable",
  web_limit: "finance_unavailable",
  web_too_large: "finance_bad_response",
  web_bad_content: "finance_bad_response",
  web_http_error: "finance_http_error",
  web_too_many_redirects: "finance_blocked",
  web_bad_url: "finance_bad_input",
  web_bad_input: "finance_bad_input",
};

export type FinanceWorker = (
  job: Extract<WorkerJob, { op: "raw" }>,
  proxy: { url: string; port: number },
) => ReturnType<WebWorker>;

export type FinanceOptions = {
  /** OPENDART_API_KEY, SEC_USER_AGENT (values never logged). */
  secrets?: Readonly<Record<string, string>>;
  /** The fetch worker. Default: the sandboxed web worker. Tests replay recorded responses. */
  worker?: FinanceWorker;
  now?: () => number;
};

/** At most this many worker rounds per call (SEC by ticker: the CIK, then the submissions). */
const MAX_ROUNDS = 2;

/**
 * The whole call's time (#113 review round 3): every round, job and approval stop shares it. Each job gets what is
 * left (the worker's own per-request limit still holds); none starts once it is spent — `finance_timeout`.
 */
export const FINANCE_CALL_MS = 60_000;

export class FinanceService {
  constructor(
    private readonly worker: FinanceWorker,
    /** The tool's own egress proxy (exact hosts: `tool.hosts`). */
    private readonly proxyFor: (tool: FinanceToolInfo) => Promise<{ url: string; port: number }>,
    private readonly opts: FinanceOptions = {},
  ) {}

  /**
   * Whether a call with this input would be refused by the egress guard before anything leaves — the same decision
   * `run` makes on its first round (the plan's exact URLs and headers through `carriesKnownSecret`). The watchlist
   * search uses it to choose the decoy (review #111 round 4: one predicate, so no answer can tell them apart).
   */
  refuses(tool: FinanceToolInfo, input: Record<string, unknown>): boolean {
    const impl = TOOL_IMPLS[tool.name];
    if (!impl) return false;
    const secrets = this.opts.secrets ?? {};
    try {
      const plan = impl.plan(input, { now: (this.opts.now ?? Date.now)(), secrets });
      return "steps" in plan && plan.steps.some((s) => carriesKnownSecret(s, tool.name, secrets));
    } catch {
      return false;
    }
  }

  /** The configured secrets' egress check on a text that is not a request (e.g. a typed ticker shown back). */
  refusesText(text: string): boolean {
    return carriesKnownSecret({ url: text }, "", this.opts.secrets ?? {});
  }

  /**
   * One worker job, every request approved here (#113, review #127 round 2). The worker never sends a request the
   * server has not seen in its exact wire form (worker.mjs `wireRequest`: the parsed URL, the request target, every
   * header — the cookies of the jar and captured values included): it stops before each send (`pause`, reason
   * `send`) and at each redirect (reason `redirect`, the target), and hands back the request with the session so
   * far. The server checks it — an https URL of the tool's hosts, and the egress predicate on its URL texts and
   * header values with the allowed places exact per occurrence (`carriesKnownSecret`) — and resumes the steps from
   * there as a new job carrying that request as `approved`; the worker sends it only if it builds the same one.
   * At most `RAW_JOB_LIMITS.maxRedirects` redirects per step.
   */
  private async runJob(
    tool: FinanceToolInfo,
    first: RawStep[],
    proxy: { url: string; port: number },
    secrets: Readonly<Record<string, string>>,
    deadline: number,
  ): Promise<{ ok: true; responses: RawResponse[] } | { ok: false; code: FinanceCode }> {
    const now = this.opts.now ?? Date.now;
    const responses: RawResponse[] = [];
    let steps = first;
    let resume: RawResume | undefined;
    let hops = 0;
    // Each round sends at most one request: one per step and per redirect, and one to start.
    const maxRounds = first.length * (RAW_JOB_LIMITS.maxRedirects + 1) + 1;
    for (let round = 0; round < maxRounds; round++) {
      const left = deadline - now();
      if (left <= 0) return { ok: false, code: "finance_timeout" };
      const r = await this.worker(
        {
          op: "raw",
          steps,
          redirect: "manual",
          approve: true,
          timeoutMs: left,
          ...(resume ? { resume } : {}),
        },
        proxy,
      );
      if (!r.ok) return { ok: false, code: FROM_WEB[r.code] ?? "finance_failed" };
      if (Array.isArray(r.responses)) responses.push(...(r.responses as unknown[]).filter(isResponse));
      if (r.pause === undefined) return { ok: true, responses };
      const pause = readPause(r.pause, steps.length);
      if (!pause) return { ok: false, code: "finance_failed" };
      // The approved request was not the one the worker built: never approve it again in a loop.
      if (pause.reason === "send" && resume && pause.step === 0) return { ok: false, code: "finance_failed" };
      hops = pause.reason === "redirect" ? hops + 1 : 0;
      if (hops > RAW_JOB_LIMITS.maxRedirects) return { ok: false, code: "finance_blocked" };
      const req = pause.request;
      if (!allowed(req.url, tool.hosts)) return { ok: false, code: "finance_blocked" };
      if (carriesKnownSecret({ url: req.url, headers: req.headers }, tool.name, secrets))
        return { ok: false, code: "finance_bad_input" };
      steps = [{ ...steps[pause.step]!, url: pause.url }, ...steps.slice(pause.step + 1)];
      resume = { jar: pause.jar, vars: pause.vars, seen: pause.seen, literal: true, approved: req };
    }
    return { ok: false, code: "finance_failed" };
  }

  /** Runs one validated call. Never throws: a fixed `finance_*` code on failure. */
  async run(tool: FinanceToolInfo, input: Record<string, unknown>): Promise<SkillResult> {
    const impl = TOOL_IMPLS[tool.name];
    if (!impl) return { ok: false, code: "finance_not_allowed" };
    const secrets = this.opts.secrets ?? {};
    const ctx = { now: (this.opts.now ?? Date.now)(), secrets };
    const deadline = ctx.now + FINANCE_CALL_MS;
    // Every configured secret, however short (SEC_USER_AGENT may be 5 characters).
    const secretValues = Object.values(secrets).filter((v) => v.length >= 1);
    let plan: Plan = impl.plan(input, ctx);
    const rounds: RawResponse[][] = [];
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if ("refuse" in plan) return { ok: false, code: plan.refuse };
        // Defence in depth: the plan names only the tool's hosts over HTTPS (the proxy refuses the rest anyway).
        if (!plan.steps.every((s) => allowed(s.url, tool.hosts)))
          return { ok: false, code: "finance_blocked" };
        let proxy;
        try {
          proxy = await this.proxyFor(tool);
        } catch {
          return { ok: false, code: "finance_unavailable" };
        }
        // Egress guard (review #111): no known secret leaves in a URL or header of any step — raw or in any encoding
        // the shared matcher knows (URL encoding, base64, hex, a cut-off tail). A configured secret is allowed only
        // in its one place (`carriesKnownSecret`). Refused before any job exists.
        if (plan.steps.some((s) => carriesKnownSecret(s, tool.name, secrets)))
          return { ok: false, code: "finance_bad_input" };
        // The worker takes at most RAW_JOB_LIMITS.maxSteps steps a job (review #111: a 1-year KRX history is 5 pages):
        // a longer plan is split into jobs and their answers joined in order. Session steps (cookie, capture) live
        // in one job's cookie jar, so a plan that has them must fit in one job.
        const jobs = splitJobs(plan.steps);
        if (!jobs) return { ok: false, code: "finance_bad_input" };
        const responses: RawResponse[] = [];
        for (const steps of jobs) {
          const r = await this.runJob(tool, steps, proxy, secrets, deadline);
          if (!r.ok) return r;
          responses.push(...r.responses);
        }
        rounds.push(responses);
        const parsed = impl.parse(rounds, input, ctx);
        if ("next" in parsed) {
          plan = parsed.next;
          continue;
        }
        if (!parsed.ok) return { ok: false, code: parsed.code };
        const output = finalize(tool.name, parsed.data);
        // Its own secrets exactly (however short), then every other secret the server knows (review round 23).
        return {
          ok: true,
          output: scrubKnownDeep(secretValues.length ? redactValue(output, secretValues) : output),
        };
      }
      return { ok: false, code: "finance_failed" };
    } catch {
      return { ok: false, code: "finance_failed" };
    }
  }
}

/** A worker's `pause` (a raw job stopped at a redirect), or undefined when it has none or it is malformed. */
function readPause(x: unknown, steps: number): RawPause | undefined {
  const p = x as RawPause | null | undefined;
  if (!p || typeof p !== "object") return undefined;
  const pair = (a: unknown) =>
    Array.isArray(a) && a.length === 2 && typeof a[0] === "string" && typeof a[1] === "string";
  if (
    !Number.isInteger(p.step) ||
    p.step < 0 ||
    p.step >= steps ||
    typeof p.url !== "string" ||
    (p.reason !== "send" && p.reason !== "redirect") ||
    !p.request ||
    typeof p.request !== "object" ||
    typeof p.request.url !== "string" ||
    typeof p.request.target !== "string" ||
    !p.request.headers ||
    typeof p.request.headers !== "object" ||
    !Object.values(p.request.headers).every((v) => typeof v === "string") ||
    !Array.isArray(p.jar) ||
    !p.jar.every(pair) ||
    !Array.isArray(p.vars) ||
    !p.vars.every(pair) ||
    !Array.isArray(p.seen) ||
    !p.seen.every((v) => typeof v === "string")
  )
    return undefined;
  return p;
}

/** Characters of a configured secret that count as a leak of it anywhere it is not allowed (the shared bound). */
export const CONFIG_WINDOW = EGRESS_WINDOW;

/**
 * Whether a step carries a known secret — or one of the configured finance secrets — anywhere it may not (review #111
 * rounds 2–3). Each configured secret has exactly one allowed place: the OpenDART key as the `crtfc_key` query
 * parameter of an OpenDART URL from `dart_disclosures`; the SEC contact as the `user-agent` header of a request to
 * an SEC host from a `sec_*` tool. Only that occurrence is taken out before the check: the same value anywhere else
 * — another tool's query, a path, another header, another host — is refused like any other known secret, raw or in
 * any encoding the shared matcher knows (and, for a configured value too short for the matcher, as it is).
 */
export function carriesKnownSecret(
  step: RawStep,
  tool: string,
  config: Readonly<Record<string, string>> = {},
): boolean {
  const dartKey = config[DART_KEY];
  const ua = config[SEC_UA];
  let host = "";
  try {
    host = new URL(step.url).hostname;
  } catch {
    // not a URL: checked as it is (and refused by the worker)
  }
  // The allowed place is one occurrence (review #127 round 2): the first `crtfc_key=<the key>` pair only — another
  // `crtfc_key`, or the key a second time, stays in the text and is checked.
  const url =
    tool === "dart_disclosures" && dartKey && (DART_HOSTS as readonly string[]).includes(host)
      ? withoutParam(step.url, "crtfc_key", dartKey)
      : step.url;
  const texts = urlTexts(url);
  for (const [name, value] of Object.entries(step.headers ?? {})) {
    const allowed =
      tool.startsWith("sec_") &&
      !!ua &&
      value === ua &&
      name.toLowerCase() === "user-agent" &&
      (SEC_HOSTS as readonly string[]).includes(host);
    if (!allowed) texts.push(value);
  }
  // The one egress predicate (secrets/egress.ts): whole known or configured secrets in any encoding the shared
  // matcher knows, and any EGRESS_WINDOW-character window of one, raw or decoded once (review #111 rounds 5–6, #113).
  return carriesSecret(texts, { config: Object.values(config) });
}

export { decodedViews };

/** The steps as worker jobs within its step limit; undefined when a plan with session steps does not fit one. */
export function splitJobs(steps: readonly RawStep[]): RawStep[][] | undefined {
  const max = RAW_JOB_LIMITS.maxSteps;
  if (!steps.length) return undefined;
  if (steps.length <= max) return [[...steps]];
  if (steps.some((s) => s.mode)) return undefined;
  const out: RawStep[][] = [];
  for (let i = 0; i < steps.length; i += max) out.push(steps.slice(i, i + max));
  return out;
}

/** An https URL on one of these exact hosts (default port). */
export function allowed(raw: string, hosts: readonly string[]): boolean {
  try {
    const u = new URL(raw.replace(/\{\w+\}/g, "x"));
    return u.protocol === "https:" && !u.port && !u.username && !u.password && hosts.includes(u.hostname);
  } catch {
    return false;
  }
}

function isResponse(x: unknown): x is RawResponse {
  const o = x as RawResponse | null;
  return (
    !!o && typeof o.status === "number" && typeof o.body === "string" && typeof o.contentType === "string"
  );
}
