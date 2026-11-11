import type { SkillResult } from "@agentlee/mcp-tools";
import type { FinanceToolInfo } from "@agentlee/mcp-tools/finance";
import { redactValue } from "../mcp/service.js";
import type { RawResponse, RawStep, WebWorker } from "../web/service.js";
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
  job: { op: "raw"; steps: RawStep[] },
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

export class FinanceService {
  constructor(
    private readonly worker: FinanceWorker,
    /** The tool's own egress proxy (exact hosts: `tool.hosts`). */
    private readonly proxyFor: (tool: FinanceToolInfo) => Promise<{ url: string; port: number }>,
    private readonly opts: FinanceOptions = {},
  ) {}

  /** Runs one validated call. Never throws: a fixed `finance_*` code on failure. */
  async run(tool: FinanceToolInfo, input: Record<string, unknown>): Promise<SkillResult> {
    const impl = TOOL_IMPLS[tool.name];
    if (!impl) return { ok: false, code: "finance_not_allowed" };
    const secrets = this.opts.secrets ?? {};
    const ctx = { now: (this.opts.now ?? Date.now)(), secrets };
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
        const r = await this.worker({ op: "raw", steps: plan.steps }, proxy);
        if (!r.ok) return { ok: false, code: FROM_WEB[r.code] ?? "finance_failed" };
        const responses = Array.isArray(r.responses) ? (r.responses as unknown[]).filter(isResponse) : [];
        rounds.push(responses);
        const parsed = impl.parse(rounds, input, ctx);
        if ("next" in parsed) {
          plan = parsed.next;
          continue;
        }
        if (!parsed.ok) return { ok: false, code: parsed.code };
        const output = finalize(tool.name, parsed.data);
        return { ok: true, output: secretValues.length ? redactValue(output, secretValues) : output };
      }
      return { ok: false, code: "finance_failed" };
    } catch {
      return { ok: false, code: "finance_failed" };
    }
  }
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
