import fs from "node:fs";
import { z } from "zod";
import {
  skillToolName,
  startMcpServer,
  toolNames,
  type McpHost,
  type RunningMcpServer,
  type SkillResult,
  type ToolScope,
} from "@agentlee/mcp-tools";
import {
  ALWAYS_ON_SKILLS,
  GOOGLE_NEWS_SKILL,
  SELFTEST_SKILL,
  SKILL_CATALOGUE,
  type BundledSkill,
  type CatalogueStatus,
} from "@agentlee/mcp-tools/skills";
import { CITE_TOOL, SOURCES_LIST_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@agentlee/mcp-tools/web";
import { FINANCE_TOOLS, type FinanceToolInfo } from "@agentlee/mcp-tools/finance";
import { FinanceService, type FinanceOptions } from "../finance/service.js";
import { ARTIFACT_CREATE_TOOL, ARTIFACT_TOOLS, ARTIFACT_UPDATE_TOOL } from "@agentlee/mcp-tools/artifacts";
import { SCHEDULE_CREATE_TOOL } from "@agentlee/mcp-tools/schedules";
import type { ScheduleProposalStore } from "../schedules/proposals.js";
import { firstRunAfter, ScheduleInputError } from "../schedules/store.js";
import {
  artifactPath,
  frameExternal,
  ScheduleProposalInput,
  type ArtifactKind,
  type ScheduleProposalToolOutput,
} from "@agentlee/shared";
import { CiteRefused, type CitationStore } from "../citations/store.js";
import { ArtifactError, type ArtifactBody, type ArtifactStore } from "../artifacts/store.js";
import type { ServerToolInfo } from "@agentlee/mcp-tools";
import type { UserStore } from "../auth/users.js";
import { EgressService } from "../isolation/egress.js";
import type { McpTokens } from "../isolation/tokens.js";
import { runIsolated, type RunIsolatedOptions } from "../isolation/sandbox.js";
import { logEvent, type EventLogger } from "../logging.js";
import { registerToolNames } from "../observability/policy.js";
import type { InstallState } from "./install.js";
import type { ErrorLog } from "../observability/errors.js";
import type { SkillSwitches } from "./switches.js";
import type { PythonRuntime } from "./python.js";
import type { SourceStore } from "../web/sources.js";
import { scrubKnownDeep } from "../secrets/known.js";
import {
  DUCKDUCKGO_HOSTS,
  duckDuckGoProvider,
  sandboxedWorker,
  WebService,
  type Proxy,
  type SearchProvider,
  type SearchProviderName,
  type WebWorker,
} from "../web/service.js";

/** PRD §7 finance skills (FR-7): hidden from youth accounts unless named explicitly (#30). */
const FINANCE_SKILLS: ReadonlySet<string> = new Set(
  SKILL_CATALOGUE.filter((e) => e.finance).map((e) => e.name),
);

export const isFinanceSkill = (skill: string) => FINANCE_SKILLS.has(skill);

/**
 * Whether a user's own permissions allow `skill` (FR-1.6) — not whether it is offered now (`McpService.allows`
 * adds the account being active and the server allow-list). "all" = every skill except the finance skills for a
 * youth account (the son, #30): hidden by default; only an explicit list that names them turns them on.
 */
export function skillPermitted(user: { permissions?: unknown; youth?: unknown }, skill: string): boolean {
  const p = (user as { permissions?: { skills?: unknown } }).permissions?.skills;
  if (p === "all") return !(user.youth === true && FINANCE_SKILLS.has(skill));
  return Array.isArray(p) && p.includes(skill);
}

/** The bundled skills (always available): the verification skill. Installed skills come from `install.ts`. */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [SELFTEST_SKILL];

/** Runs one allow-listed skill for one call. The default runs it in the sandbox (#42). */
export type SkillRunner = (
  skill: BundledSkill,
  input: Record<string, unknown>,
  scope: ToolScope,
) => Promise<SkillResult>;

export type SkillLimits = { timeoutMs: number; maxOutputBytes: number; maxRssBytes: number };
export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  timeoutMs: 10_000,
  maxOutputBytes: 256 * 1024,
  maxRssBytes: 256 * 1024 * 1024,
};

/** TLS roots for python skills (a standalone python has none of its own). */
export const SYSTEM_CA_BUNDLE = "/private/etc/ssl/cert.pem";

/** Why a call did not run (or did not succeed). Codes only — the model sees them, the log keeps them. */
export class SkillRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type SkillPolicyContext = {
  /** Absolute path of the node executable (bundled node skills). */
  node: string;
  python?: PythonRuntime | undefined;
  /** Secret values by env name; a skill gets only the ones it declares, when the call needs them. */
  secrets?: Readonly<Record<string, string>> | undefined;
  /** The skill's own egress proxy (only for skills with hosts). */
  proxy?: { url: string; port: number } | undefined;
};

/**
 * Sandbox policy of one skill call. Every skill reads its own folder only; node is readable as the executable
 * (`process-exec` literal), nothing else of its install; a python skill also reads the interpreter's own install
 * folder. Nothing is written, no child processes, no inherited environment. Network: none, or the skill's own
 * egress proxy (a loopback port) that lets through HTTPS to the skill's hosts only. Secrets are env variables of
 * this process only. Arguments come from the definition's `args` (validated input), never from the model as text.
 */
export function skillPolicy(
  skill: BundledSkill,
  input: Record<string, unknown>,
  ctx: SkillPolicyContext,
): Omit<RunIsolatedOptions, "timeoutMs" | "maxOutputBytes" | "maxRssBytes"> & { secretValues: string[] } {
  const args = skill.args(input);
  if (!args || args.some((a) => typeof a !== "string" || a.includes("\0")))
    throw new SkillRefused("skill_bad_input");
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const s of skill.secrets) {
    if (s.when && !s.when(input)) continue;
    const v = ctx.secrets?.[s.env];
    if (!v) throw new SkillRefused("skill_unconfigured");
    env[s.env] = v;
    secretValues.push(v);
  }
  let network: RunIsolatedOptions["network"] = "none";
  if (skill.hosts.length) {
    if (!ctx.proxy) throw new SkillRefused("skill_unavailable");
    network = { loopbackPorts: [ctx.proxy.port] };
    env.HTTPS_PROXY = env.https_proxy = ctx.proxy.url;
  }
  if (skill.kind === "node")
    return {
      command: ctx.node,
      args: [skill.entry, ...args],
      cwd: skill.dir,
      env,
      read: [skill.dir],
      trusted: [],
      write: [],
      network,
      secretValues,
    };
  if (!ctx.python) throw new SkillRefused("skill_unavailable");
  // -I: no PYTHON* variables, no user site, no script folder on sys.path. -S: no site-packages (standard library
  // only). -B: writes no .pyc (it could not anyway).
  Object.assign(env, { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
  if (skill.hosts.length) env.SSL_CERT_FILE = SYSTEM_CA_BUNDLE;
  return {
    command: ctx.python.exe,
    args: ["-I", "-S", "-B", skill.entry, ...args],
    cwd: skill.dir,
    env,
    read: [skill.dir],
    trusted: [ctx.python.root, ...(skill.hosts.length ? [SYSTEM_CA_BUNDLE] : [])],
    write: [],
    network,
    secretValues,
  };
}

export type SandboxedRunnerOptions = {
  limits?: SkillLimits;
  python?: PythonRuntime | undefined;
  secrets?: Readonly<Record<string, string>> | undefined;
  /** The egress proxy of a skill with hosts (one per skill: each reaches only its own hosts). */
  proxy?: (skill: BundledSkill) => Promise<{ url: string; port: number }>;
  node?: string;
};

/** Runs a skill under `skillPolicy`. Input on stdin as JSON, a JSON result on stdout; secrets never come back. */
export function sandboxedSkillRunner(o: SandboxedRunnerOptions = {}): SkillRunner {
  const node = o.node ?? fs.realpathSync(process.execPath);
  const limits = o.limits ?? DEFAULT_SKILL_LIMITS;
  return async (skill, input) => {
    let policy;
    try {
      const proxy = skill.hosts.length && o.proxy ? await o.proxy(skill) : undefined;
      policy = skillPolicy(skill, input, { node, python: o.python, secrets: o.secrets, proxy });
    } catch (e) {
      return { ok: false, code: e instanceof SkillRefused ? e.code : "skill_unavailable" };
    }
    const { secretValues, ...run } = policy;
    // An installed skill runs only from its pinned copy, checked again right before each run (install.ts).
    if (skill.verify && !skill.verify()) return { ok: false, code: "skill_changed" };
    let r;
    try {
      r = await runIsolated({
        ...run,
        stdin: JSON.stringify(input),
        ...limits,
        timeoutMs: skill.timeoutMs ?? limits.timeoutMs,
      });
    } catch {
      return { ok: false, code: "skill_unavailable" }; // no sandbox here (not macOS), hard links, spawn failure
    }
    if (r.killed === "timeout") return { ok: false, code: "skill_timeout" };
    if (r.killed) return { ok: false, code: "skill_limit" };
    if (r.code === null || !(skill.okExitCodes ?? [0]).includes(r.code) || !r.stdout.trim())
      return { ok: false, code: "skill_failed" };
    // A skill must never hand a secret back to the model (an API echoing its key, a debug print): its own
    // secrets exactly (refused if any is left), then every other secret the server knows (review round 23).
    const res = redactOutput(r.stdout, secretValues);
    return res.ok ? { ok: true, output: scrubKnownDeep(res.output) } : res;
  };
}

const REDACTED = "[redacted]";

/** Replaces every occurrence of a secret in one string. */
const scrub = (t: string, secrets: readonly string[]) => {
  let out = t;
  for (const v of secrets) out = out.split(v).join(REDACTED);
  return out;
};

/** Every string value and object key, recursively, with secrets replaced (after JSON escapes were decoded). */
export function redactValue(v: unknown, secrets: readonly string[]): unknown {
  if (typeof v === "string") return scrub(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, secrets));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        scrub(k, secrets),
        redactValue(x, secrets),
      ]),
    );
  return v;
}

/**
 * A skill's stdout as its result, with no secret left in it. The raw text is scrubbed first (non-JSON output
 * never gets back anyway: it is refused), then — because JSON escapes such as `\u0041` or `\"` can spell a
 * secret the raw text does not contain — every decoded string and key is scrubbed again. A result that still
 * contains a secret after that is refused, not returned.
 */
export function redactOutput(stdout: string, secrets: readonly string[]): SkillResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scrub(stdout, secrets));
  } catch {
    return { ok: false, code: "skill_bad_output" };
  }
  if (!secrets.length) return { ok: true, output: parsed };
  const output = redactValue(parsed, secrets);
  // Last check on the decoded strings themselves (not their JSON form, which escapes quotes): a replacement can
  // recreate a secret from its surroundings (e.g. secret `redacted]"` next to the `[redacted]` marker).
  // Also the serialised form: number normalisation can produce a secret (`1.2345678e7` → `12345678`).
  const text = JSON.stringify(output);
  if (containsSecret(output, secrets) || secrets.some((v) => text.includes(v)))
    return { ok: false, code: "skill_bad_output" };
  return { ok: true, output };
}

/** True if any string value or object key, at any depth, still contains a secret. */
function containsSecret(v: unknown, secrets: readonly string[]): boolean {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "string" || typeof x === "number") {
      const t = String(x);
      if (secrets.some((s) => t.includes(s))) return true;
    } else if (Array.isArray(x)) {
      for (const item of x) stack.push(item); // (no spread: a huge array would overflow the call stack)
    } else if (x && typeof x === "object")
      for (const [k, val] of Object.entries(x)) {
        if (secrets.some((s) => k.includes(s))) return true;
        stack.push(val);
      }
  }
  return false;
}

/** Sources `sources_list` returns at most (the newest). */
const SOURCES_LIST_MAX = 100;

/** What the model is told per citation status (fixed words). */
const CITE_HINT: Record<string, string> = {
  verified: "The passage is in the stored page. Put the marker at the end of the sentence it supports.",
  snippet_not_found:
    "The passage is not in the stored page text. Copy a passage exactly from the page and cite again; otherwise the user sees this citation with a warning.",
  fetch_failed:
    "This source has no stored page text (a search result or an unreadable page). Read the page with web_fetch and cite that sourceId; otherwise the user sees this citation with a warning.",
  unknown_source:
    "Not a source of this conversation. Use a sourceId from web_fetch or sources_list; otherwise the user sees this citation with a warning.",
};

/** At most this many skill processes at once — in total and per run. Beyond that a call is refused at once. */
export type SkillConcurrency = { total: number; perRun: number };
export const DEFAULT_SKILL_CONCURRENCY: SkillConcurrency = { total: 4, perRun: 2 };

export type McpServiceOptions = {
  concurrency?: SkillConcurrency;
  /** Allow-list of skills offered as tools. Default: the bundled ones (app.ts adds the installed ones). */
  skills?: readonly BundledSkill[];
  /** Install state of each wrapped skill (for the admin's skill list). */
  installed?: Readonly<Record<string, InstallState>>;
  /** The python for python skills. Without it they are not offered. */
  python?: PythonRuntime | undefined;
  /** Secret values by env name (from `.env`), handed to the skills that declare them. Never logged. */
  secrets?: Readonly<Record<string, string>>;
  limits?: SkillLimits;
  /** Egress proxy per skill (tests). Default: an `EgressService` for the skill's hosts. */
  egress?: (allow: readonly string[]) => Pick<EgressService, "endpoint" | "close">;
  runSkill?: SkillRunner;
  now?: () => Date;
  timeZone?: string;
  /** Structured log (#46): one `skill.finished` per call — tool name, outcome code, duration, IDs. No content. */
  log?: EventLogger;
  /** Web search and fetch (#50). Without it the web tools are not offered (tests without a database). */
  web?: WebOptions;
  /** Artifact storage (#27). Without it the artifact tools are not offered. */
  artifacts?: ArtifactStore;
  /** Finance tools (#30). Without it they are not offered. Per user: the owning skill's permission. */
  finance?: FinanceOptions;
  /** Schedule proposals (#55): `schedule_create` stores what it proposes. Without it the tool is not offered. */
  scheduleProposals?: ScheduleProposalStore;
  /** The server allow-list switches (#35). Without it every skill is on. */
  switches?: SkillSwitches;
  /** Recent errors (#46): failed skill calls are recorded (tool name and code only) for the admin screen. */
  errors?: ErrorLog;
};

export type WebOptions = {
  sources: SourceStore;
  /** Citations (#25): with it, `cite` is offered (checked against `sources`). */
  citations?: CitationStore;
  /** Search providers to try in order (`WEB_SEARCH_PROVIDERS`); default duckduckgo, then google-news. */
  providers?: readonly SearchProviderName[];
  /** Tests: the worker (in-process), the page proxy, and ready-made providers instead of `providers`. */
  worker?: WebWorker;
  fetchProxy?: Proxy;
  searchProviders?: readonly SearchProvider[];
};

/** A skill in the admin's list (FR-10.3): the PRD §7 catalogue plus where each one stands on this server. */
export type SkillStatus =
  | Exclude<CatalogueStatus, "implemented" | "tools">
  | "available"
  | "not_installed"
  | "broken"
  | "needs_python";
export type SkillOverview = {
  name: string;
  tool: string;
  finance: boolean;
  status: SkillStatus;
  issue?: string;
  /** On the server allow-list (#35). */
  enabled: boolean;
};

/**
 * Our MCP server inside the Agent Lee server process (PRD D7, #43). It listens on a loopback port of its own —
 * never on the public :3000 app — and starts on first use, so tests and runs without tools open no port.
 * Every request is authenticated with a run-scoped token (`McpTokens`), every tool result is dropped when the run
 * ended meanwhile, and each user sees and can call only the skills they are allowed (#21, FR-1.6).
 */
export class McpService {
  private running: Promise<RunningMcpServer> | undefined;
  private closed = false;
  /** Offered skills: allow-listed, installed intact, and runnable here (python skills need python). */
  private readonly skills: readonly BundledSkill[];
  private active = 0;
  private readonly activeByRun = new Map<string, number>();
  private readonly proxies = new Map<string, Pick<EgressService, "endpoint" | "close">>();
  /** Runs whose answered tool calls are being recorded (connection tests, #17). */
  private readonly watched = new Map<string, Set<string>>();
  private readonly runner: SkillRunner;
  /** Web search and fetch (#50), when configured. */
  readonly web: WebService | undefined;
  /** The server's own tools (web, artifacts): every active user has them. */
  private readonly tools: readonly ServerToolInfo[];
  /** Finance tools (#30), when configured: each user gets those of the finance skills they may use. */
  readonly finance: FinanceService | undefined;
  private readonly financeTools: readonly FinanceToolInfo[];

  constructor(
    private readonly tokens: McpTokens,
    private readonly users: Pick<UserStore, "byId">,
    private readonly opts: McpServiceOptions = {},
  ) {
    this.skills = (opts.skills ?? BUNDLED_SKILLS).filter((s) => s.kind !== "python" || opts.python);
    this.runner =
      opts.runSkill ??
      sandboxedSkillRunner({
        ...(opts.limits ? { limits: opts.limits } : {}),
        python: opts.python,
        secrets: opts.secrets,
        proxy: (s) => this.proxyFor(s.name, s.hosts),
      });
    this.web = opts.web ? this.buildWeb(opts.web) : undefined;
    this.tools = [
      ...(this.web
        ? [
            ...(this.web.canSearch ? [WEB_SEARCH_TOOL] : []),
            WEB_FETCH_TOOL,
            SOURCES_LIST_TOOL,
            ...(opts.web?.citations ? [CITE_TOOL] : []),
          ]
        : []),
      ...(opts.artifacts ? ARTIFACT_TOOLS : []),
      ...(opts.scheduleProposals ? [SCHEDULE_CREATE_TOOL] : []),
    ];
    this.finance = opts.finance
      ? new FinanceService(
          opts.finance.worker ?? sandboxedWorker(),
          // One proxy per tool, reaching exactly its hosts (docs/decisions/isolation.md "금융 도구 (#30)").
          (t) => this.proxyFor(`finance:${t.name}`, t.hosts),
          opts.finance,
        )
      : undefined;
    this.financeTools = this.finance ? FINANCE_TOOLS : [];
    // Our tool names are fixed in code: they may be logged (#46).
    registerToolNames(this.toolNames());
  }

  /**
   * Search providers in the configured order. `google-news` runs the installed google-news-search-skill (news
   * only; leads, not evidence); `duckduckgo` reads its HTML results page through a proxy for that host only.
   */
  private buildWeb(o: WebOptions): WebService {
    const worker = o.worker ?? sandboxedWorker();
    const news = this.skills.find((s) => s.name === GOOGLE_NEWS_SKILL.name);
    const providers =
      o.searchProviders ??
      (o.providers ?? ["duckduckgo", "google-news"]).flatMap((name): SearchProvider[] => {
        if (name === "duckduckgo") {
          const proxy = {
            endpoint: () => this.proxyFor("web:duckduckgo", DUCKDUCKGO_HOSTS),
            close: async () => {},
          };
          return [duckDuckGoProvider(worker, proxy)];
        }
        if (name === "google-news" && news)
          return [
            {
              name: "google-news",
              search: async (query, max, scope) => {
                const r = await this.runner(
                  news,
                  { query, maxResults: max, lookbackDays: 30, sort: "relevance" },
                  scope,
                );
                if (!r.ok) return { ok: false, code: "web_search_unavailable" };
                const out = r.output as { ok?: unknown };
                if (out?.ok === false) return { ok: false, code: "web_search_unavailable" };
                return { ok: true, hits: (news.searchHits?.(r.output) ?? []).map((h) => h.hit) };
              },
            },
          ];
        return [];
      });
    return new WebService({
      sources: o.sources,
      providers,
      worker,
      ...(o.fetchProxy ? { fetchProxy: o.fetchProxy } : {}),
    });
  }

  /** Every tool this server offers (without the `mcp__agentlee__` prefix) — for log registration. */
  toolNames(): string[] {
    return toolNames({ skills: this.skills, tools: [...this.tools, ...this.financeTools] });
  }

  /**
   * The tools one user's run gets: echo_time, the web and artifact tools, the finance tools and the skills that
   * user may use (FR-1.6).
   */
  toolNamesFor(userId: string): string[] {
    return toolNames({ skills: this.skillsFor(userId), tools: this.toolsFor(userId) });
  }

  /**
   * Whether this user may use this skill now: active, and the skill always on, or on the server allow-list (#35)
   * and allowed by their permissions (`skillPermitted`: youth accounts without finance under "all").
   */
  allows(userId: string, skill: string): boolean {
    const u = this.users.byId(userId);
    if (!u?.active) return false;
    if (ALWAYS_ON_SKILLS.has(skill)) return true;
    if (this.opts.switches && !this.opts.switches.enabled(skill)) return false;
    return skillPermitted(u, skill);
  }

  /** Turns a catalogue skill on or off on the server allow-list (#35); applies from the next tool list / call. */
  setServerEnabled(skill: string, enabled: boolean): void {
    this.opts.switches?.set(skill, enabled);
  }

  /** The server allow-list switch of a skill (#35). */
  serverEnabled(skill: string): boolean {
    return ALWAYS_ON_SKILLS.has(skill) || (this.opts.switches?.enabled(skill) ?? true);
  }

  private toolsFor(userId: string): ServerToolInfo[] {
    return [...this.tools, ...this.financeTools.filter((t) => this.allows(userId, t.skill))];
  }

  private skillsFor(userId: string): BundledSkill[] {
    return this.skills.filter((s) => this.allows(userId, s.name));
  }

  /** The PRD §7 catalogue with each skill's state here (the admin screen is #35). */
  overview(): SkillOverview[] {
    const offered = new Set(this.skills.map((s) => s.name));
    return SKILL_CATALOGUE.map((e) => {
      let status: SkillStatus;
      if (this.finance && FINANCE_TOOLS.some((t) => t.skill === e.name)) status = "available";
      else if (e.status === "tools") status = "planned";
      else if (e.status === "implemented") {
        const st = this.opts.installed?.[e.name] ?? "not_installed";
        status = offered.has(e.name) ? "available" : st === "installed" ? "needs_python" : st;
      } else status = e.status;
      return {
        name: e.name,
        tool: skillToolName(e.name),
        finance: e.finance,
        status,
        ...(e.issue ? { issue: e.issue } : {}),
        enabled: this.serverEnabled(e.name),
      };
    });
  }

  /** One egress proxy per key (a skill, or a search provider), reaching only its own hosts. */
  private proxyFor(key: string, hosts: readonly string[]) {
    let p = this.proxies.get(key);
    if (!p) {
      p = (this.opts.egress ?? ((allow) => new EgressService({ allow })))(hosts);
      this.proxies.set(key, p);
    }
    return p.endpoint();
  }

  private host(): McpHost {
    const runSkill = this.runner;
    const toolByName = new Map(this.tools.map((t) => [t.name, t]));
    const financeByName = new Map(this.financeTools.map((t) => [t.name, t]));
    const byName = new Map(this.skills.map((s) => [s.name, s]));
    const now = () => Date.now();
    return {
      authenticate: (token) => {
        const s = this.tokens.verify(token);
        if (!s || !this.users.byId(s.userId)?.active) return undefined;
        return { userId: s.userId, conversationId: s.conversationId, runId: s.runId };
      },
      userName: (id) => {
        const u = this.users.byId(id);
        return u?.active ? u.name : undefined;
      },
      skills: this.skills,
      skillsFor: (userId) => this.skillsFor(userId),
      runSkill: async (name, input, scope) => {
        const t0 = now();
        const r = await this.call(byName.get(name), input, scope, runSkill);
        logEvent(this.opts.log, r.ok ? "info" : "warn", "skill.finished", {
          userId: scope.userId,
          conversationId: scope.conversationId,
          runId: scope.runId,
          tool: skillToolName(name),
          status: r.ok ? "ok" : "error",
          durationMs: now() - t0,
          ...(r.ok ? {} : { skillCode: r.code }),
        });
        // The admin's "스킬 실행 실패" list (FR-10.4): tool name and code only.
        if (!r.ok)
          this.opts.errors?.record({
            source: "tool",
            code: r.code,
            category: "tool",
            tool: skillToolName(name),
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
          });
        return r;
      },
      onToolCall: (tool, scope, ok) => {
        if (ok) this.watched.get(scope.runId)?.add(tool);
      },
      tools: [...this.tools, ...this.financeTools],
      toolsFor: (userId) => this.toolsFor(userId),
      runTool: async (name, input, scope) => {
        const t0 = now();
        const fin = financeByName.get(name);
        if (fin) {
          const r = await this.callFinanceTool(fin, input, scope);
          logEvent(this.opts.log, r.ok ? "info" : "warn", "finance.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            ...(r.ok ? {} : { financeCode: r.code }),
          });
          // Finance tools are skills too (PRD §7): their failures join the admin's skill failure list, by tool name
          // and fixed `finance_*` code only.
          if (!r.ok)
            this.opts.errors?.record({
              source: "tool",
              code: r.code,
              category: "tool",
              tool: name,
              userId: scope.userId,
              conversationId: scope.conversationId,
              runId: scope.runId,
            });
          return r;
        }
        if (name === CITE_TOOL.name || name === SOURCES_LIST_TOOL.name) {
          const r = this.callCitationTool(toolByName.get(name), input, scope);
          const status = r.ok ? (r.output as { status?: unknown }).status : undefined;
          logEvent(this.opts.log, r.ok ? "info" : "warn", "citation.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            // The fixed outcome only: never the source id, the snippet or the page text.
            ...(r.ok ? (typeof status === "string" ? { citeCode: status } : {}) : { citeCode: r.code }),
          });
          return r;
        }
        if (name === SCHEDULE_CREATE_TOOL.name) {
          const r = this.callScheduleTool(input, scope);
          logEvent(this.opts.log, r.ok ? "info" : "warn", "schedule.proposed", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            ...(r.ok ? {} : { scheduleCode: r.code }),
          });
          return r;
        }
        if (ARTIFACT_TOOLS.some((t) => t.name === name)) {
          const r = this.callArtifactTool(toolByName.get(name), input, scope);
          logEvent(this.opts.log, r.ok ? "info" : "warn", "artifact.finished", {
            userId: scope.userId,
            conversationId: scope.conversationId,
            runId: scope.runId,
            tool: name,
            status: r.ok ? "ok" : "error",
            durationMs: now() - t0,
            ...(r.ok ? {} : { artifactCode: r.code }),
          });
          return r;
        }
        const r = await this.callTool(toolByName.get(name), input, scope);
        logEvent(this.opts.log, r.ok ? "info" : "warn", "web.finished", {
          userId: scope.userId,
          conversationId: scope.conversationId,
          runId: scope.runId,
          tool: name,
          status: r.ok ? "ok" : "error",
          durationMs: now() - t0,
          ...(r.ok ? {} : { webCode: r.code }),
        });
        return r;
      },
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.timeZone ? { timeZone: this.opts.timeZone } : {}),
    };
  }

  /**
   * An artifact tool call: active user, strict input, then the store — which writes only into the token's own
   * conversation, after checking that the token's user owns it. Content is never logged or echoed back.
   */
  private callArtifactTool(
    tool: ServerToolInfo | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): SkillResult {
    const store = this.opts.artifacts;
    if (!tool || !store || !this.users.byId(scope.userId)?.active)
      return { ok: false, code: "artifact_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) {
      // Too long a content is its own code (the model should split or shorten, not fix a field).
      const long = parsed.error.issues.some((i) => i.code === "too_big" && i.path[0] === "content");
      return { ok: false, code: long ? "artifact_too_large" : "artifact_bad_input" };
    }
    const data = parsed.data as ArtifactBody & { kind?: ArtifactKind; title?: string; artifactId?: string };
    try {
      const { artifact, version } =
        tool.name === ARTIFACT_CREATE_TOOL.name
          ? store.create(scope, { ...data, kind: data.kind!, title: data.title })
          : tool.name === ARTIFACT_UPDATE_TOOL.name
            ? store.update(scope, data.artifactId!, data)
            : (() => {
                throw new ArtifactError("artifact_not_allowed");
              })();
      return {
        ok: true,
        output: {
          artifactId: artifact.id,
          kind: artifact.kind,
          title: artifact.title,
          version: version.version,
          url: artifactPath(artifact.id),
        },
      };
    } catch (e) {
      if (e instanceof ArtifactError) return { ok: false, code: e.code };
      throw e;
    }
  }

  /**
   * `schedule_create` (#55, FR-8.1): checks the proposal like `POST /api/schedules` would (strict input, skills from
   * the catalogue that this user may use, a timing with a next occurrence) and stores it for the token's own
   * conversation — after checking that the token's user owns it. Nothing is scheduled: the user confirms the card.
   */
  private callScheduleTool(input: Record<string, unknown>, scope: ToolScope): SkillResult {
    const store = this.opts.scheduleProposals;
    if (!store || !this.users.byId(scope.userId)?.active) return { ok: false, code: "schedule_not_allowed" };
    if (!store.ownsConversation(scope)) return { ok: false, code: "schedule_not_allowed" };
    const parsed = ScheduleProposalInput.safeParse(input);
    if (!parsed.success) return { ok: false, code: "schedule_bad_input" };
    const p = parsed.data;
    const catalogue = new Set(this.overview().map((s) => s.name));
    if (p.skills.some((s) => !catalogue.has(s) || !this.allows(scope.userId, s)))
      return { ok: false, code: "skill_not_allowed" };
    const at = (this.opts.now?.() ?? new Date()).getTime();
    let nextRunAt: number;
    try {
      nextRunAt = firstRunAfter(p.timing, p.timeZone, at);
    } catch (e) {
      if (e instanceof ScheduleInputError) return { ok: false, code: e.code };
      throw e;
    }
    const row = store.create(scope, { ...p, skills: [...new Set(p.skills)] }, at);
    const output: ScheduleProposalToolOutput = {
      proposalId: row.id,
      status: "proposed",
      nextRunAt,
      note: "Not created yet: the user sees a confirmation card and the schedule is created only if they confirm it there. Tell them to check the card; do not say it was created.",
    };
    return { ok: true, output };
  }

  /**
   * `cite` and `sources_list` (#25): active user, strict input, then the stores — which read and write only the
   * token's own conversation, after checking that the token's user owns it. Page titles reach the model inside an
   * `<external_content>` block (they are page text).
   */
  private callCitationTool(
    tool: ServerToolInfo | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): SkillResult {
    const web = this.opts.web;
    if (!tool || !web || !this.users.byId(scope.userId)?.active)
      return { ok: false, code: "cite_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) return { ok: false, code: "cite_bad_input" };
    if (tool.name === SOURCES_LIST_TOOL.name) {
      const rows = web.sources.listFor(scope);
      if (!rows) return { ok: false, code: "cite_not_allowed" };
      const items = rows.slice(-SOURCES_LIST_MAX);
      return {
        ok: true,
        output: {
          items: items.map((r, i) => ({
            n: i + 1,
            sourceId: r.id,
            kind: r.kind,
            site: r.site,
            publishedAt: r.publishedAt ?? null,
            url: r.finalUrl ?? r.url,
            hasText: r.kind === "page" && !!r.body,
          })),
          content: frameExternal({
            source: "sources",
            content: items.map((r, i) => `[${i + 1}] ${r.title}`).join("\n") || "(no sources)",
          }),
        },
      };
    }
    if (!web.citations) return { ok: false, code: "cite_not_allowed" };
    const data = parsed.data as { sourceId: string; snippet: string };
    try {
      const r = web.citations.cite(scope, data);
      const src = r.sourceId ? web.sources.get(scope.conversationId, r.sourceId) : undefined;
      return {
        ok: true,
        output: {
          ...r,
          ...(src
            ? { site: src.site, url: src.finalUrl ?? src.url, publishedAt: src.publishedAt ?? null }
            : {}),
          hint: CITE_HINT[r.status],
        },
      };
    } catch (e) {
      if (e instanceof CiteRefused) return { ok: false, code: e.code };
      throw e;
    }
  }

  /**
   * A finance tool call: the user may use its skill (checked again: a permission can change during a run), strict
   * input, a process slot like a skill, then the finance service. Input and output are never logged.
   */
  private async callFinanceTool(
    tool: FinanceToolInfo,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): Promise<SkillResult> {
    const finance = this.finance;
    if (!finance || !this.allows(scope.userId, tool.skill)) return { ok: false, code: "finance_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) return { ok: false, code: "finance_bad_input" };
    return (
      (await this.withSlot(scope, () => finance.run(tool, parsed.data as Record<string, unknown>))) ?? {
        ok: false,
        code: "finance_busy",
      }
    );
  }

  /** A web tool call: active user, strict input, a process slot like a skill, then the web service. */
  private async callTool(
    tool: ServerToolInfo | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
  ): Promise<SkillResult> {
    const web = this.web;
    if (!tool || !web || !this.users.byId(scope.userId)?.active)
      return { ok: false, code: "web_not_allowed" };
    const parsed = z.strictObject(tool.input).safeParse(input);
    if (!parsed.success) return { ok: false, code: "web_bad_input" };
    const data = parsed.data as Record<string, unknown>;
    return (
      (await this.withSlot(scope, () =>
        tool.name === WEB_SEARCH_TOOL.name
          ? web.search(data as { query: string; maxResults?: number }, scope)
          : web.fetch(data as { url: string }, scope),
      )) ?? { ok: false, code: "web_busy" }
    );
  }

  /** Runs `fn` in a process slot (total and per run), or returns undefined at once when none is free. */
  private async withSlot<T>(scope: ToolScope, fn: () => Promise<T>): Promise<T | undefined> {
    const limit = this.opts.concurrency ?? DEFAULT_SKILL_CONCURRENCY;
    const mine = this.activeByRun.get(scope.runId) ?? 0;
    if (this.active >= limit.total || mine >= limit.perRun) return undefined;
    this.active++;
    this.activeByRun.set(scope.runId, mine + 1);
    try {
      return await fn();
    } finally {
      this.active--;
      const left = (this.activeByRun.get(scope.runId) ?? 1) - 1;
      if (left > 0) this.activeByRun.set(scope.runId, left);
      else this.activeByRun.delete(scope.runId);
    }
  }

  private async call(
    skill: BundledSkill | undefined,
    input: Record<string, unknown>,
    scope: ToolScope,
    runSkill: SkillRunner,
  ): Promise<SkillResult> {
    // Checked here as well as by the MCP server's tool list: the permission may have changed during the run.
    if (!skill || !this.allows(scope.userId, skill.name)) return { ok: false, code: "skill_not_allowed" };
    const parsed = z.strictObject(skill.input).safeParse(input);
    // The schema, then the wrapper's own argument rules (e.g. a code that does not fit the command).
    if (!parsed.success || !skill.args(parsed.data as Record<string, unknown>))
      return { ok: false, code: "skill_bad_input" };
    // Each call is a process: cap them so one batch or one runtime cannot exhaust the machine.
    const r = await this.withSlot(scope, () =>
      runSkill(skill, parsed.data as Record<string, unknown>, scope),
    );
    if (!r) return { ok: false, code: "skill_busy" };
    if (r.ok && skill.searchHits && this.web) this.registerHits(skill, r.output, scope);
    return r;
  }

  /** A search skill's results become sources (#50); each item gets its `sourceId` (null when not stored). */
  private registerHits(skill: BundledSkill, output: unknown, scope: ToolScope): void {
    for (const { item, hit } of skill.searchHits?.(output) ?? [])
      item.sourceId = this.web?.registerHit(skill.name, hit, scope)?.id ?? null;
  }

  /**
   * Records which tools this server successfully answered for `runId` until `stop()` — evidence for the connection
   * test (#17) that the runtime really reached our MCP server, not just that it reported a tool call.
   */
  watch(runId: string): { seen: ReadonlySet<string>; stop(): void } {
    const seen = new Set<string>();
    this.watched.set(runId, seen);
    return { seen, stop: () => void this.watched.delete(runId) };
  }

  /** Whether a start was requested (tests: runtimes without tools must not open the port). */
  get started(): boolean {
    return this.running !== undefined;
  }

  /** Starts the server once (concurrent callers share the start) and returns where it listens. */
  endpoint(): Promise<RunningMcpServer> {
    if (this.closed) return Promise.reject(new Error("mcp service closed"));
    this.running ??= startMcpServer(this.host()).catch((e: unknown) => {
      this.running = undefined; // a failed start can be retried by the next run
      throw e;
    });
    return this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    const r = await this.running?.catch(() => undefined);
    this.running = undefined;
    await r?.close();
    await Promise.all([...this.proxies.values()].map((p) => p.close()));
    this.proxies.clear();
    await this.web?.close();
  }
}
