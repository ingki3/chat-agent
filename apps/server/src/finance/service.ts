import type { SkillResult } from "@agentlee/mcp-tools";
import type { FinanceToolInfo } from "@agentlee/mcp-tools/finance";
import { redactValue } from "../mcp/service.js";
import { KnownSecrets, scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import { DART_HOSTS, SEC_HOSTS } from "@agentlee/mcp-tools/finance";
import { RAW_JOB_LIMITS, type RawResponse, type RawStep, type WebWorker } from "../web/service.js";
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
          const r = await this.worker({ op: "raw", steps }, proxy);
          if (!r.ok) return { ok: false, code: FROM_WEB[r.code] ?? "finance_failed" };
          if (Array.isArray(r.responses)) responses.push(...(r.responses as unknown[]).filter(isResponse));
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

/** Characters of a configured secret that count as a leak of it anywhere it is not allowed. */
export const CONFIG_WINDOW = 16;

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
  let url = step.url;
  try {
    const u = new URL(step.url);
    host = u.hostname;
    if (
      tool === "dart_disclosures" &&
      dartKey &&
      (DART_HOSTS as readonly string[]).includes(host) &&
      u.searchParams.get("crtfc_key") === dartKey
    ) {
      u.searchParams.delete("crtfc_key");
      url = u.toString();
    }
  } catch {
    // not a URL: checked as it is (and refused by the worker)
  }
  const texts = [url];
  for (const [name, value] of Object.entries(step.headers ?? {})) {
    const allowed =
      tool.startsWith("sec_") &&
      !!ua &&
      value === ua &&
      name.toLowerCase() === "user-agent" &&
      (SEC_HOSTS as readonly string[]).includes(host);
    if (!allowed) texts.push(value);
  }
  const values = Object.values(config).filter((v) => v.length > 0);
  const cfg = new KnownSecrets();
  for (const v of values) cfg.add(v, { fresh: true });
  // A configured secret is also refused in part: any window of `CONFIG_WINDOW` characters of it (all of it when
  // shorter), raw or URL-encoded — the shared matcher finds a cut-off value only at the end of a text.
  const windows = values.flatMap((v) => {
    const w = Math.min(CONFIG_WINDOW, v.length);
    return Array.from({ length: v.length - w + 1 }, (_, i) => v.slice(i, i + w));
  });
  // Full matches: the shared matcher (raw and its encodings). Parts of a configured secret: its windows in the raw
  // text and in every decoded view of it (review #111 round 5 — two base64 halves of a key each carry a window).
  return texts.some(
    (t) =>
      scrubKnown(t) !== t ||
      scrubKnown(t, { registry: cfg }) !== t ||
      (windows.length > 0 && decodedViews(t).some((v) => windows.some((w) => v.includes(w)))),
  );
}

const percentDecode = (t: string): string | undefined => {
  if (!t.includes("%")) return undefined;
  try {
    return decodeURIComponent(t.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
};

/** A token's single decodes: base64, base64url and hex, each read as UTF-8 and as Latin-1 text. */
function tokenDecodes(token: string): string[] {
  const out: string[] = [];
  const bytes = (b: Buffer) => {
    if (b.length) out.push(b.toString("utf8"), b.toString("latin1"));
  };
  if (token.length >= 8 && /^[0-9a-fA-F]+$/.test(token) && token.length % 2 === 0)
    bytes(Buffer.from(token, "hex"));
  if (token.length >= 8 && /^[A-Za-z0-9+/]+={0,2}$/.test(token)) bytes(Buffer.from(token, "base64"));
  if (token.length >= 8 && /^[A-Za-z0-9_-]+={0,2}$/.test(token)) bytes(Buffer.from(token, "base64url"));
  return out;
}

/**
 * What a text can say once decoded (the common-encodings bound of the shared matcher): the text itself, its
 * percent-decoded form (one transport-escape layer), and every base64 / base64url / hex / percent token in either
 * of those decoded once more. A configured secret's windows are looked for in all of them.
 */
export function decodedViews(text: string): string[] {
  const layers = [text, percentDecode(text)].filter((x): x is string => x !== undefined);
  const views = [...layers];
  for (const layer of layers) {
    // base64 / base64url / hex tokens (with their padding), and runs with percent escapes.
    for (const [token] of layer.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) views.push(...tokenDecodes(token));
    for (const [token] of layer.matchAll(/(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9+/_=.-]){8,}/g)) {
      const pd = percentDecode(token);
      if (pd === undefined) continue;
      views.push(pd);
      for (const [inner] of pd.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)) views.push(...tokenDecodes(inner));
    }
  }
  return views;
}

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
