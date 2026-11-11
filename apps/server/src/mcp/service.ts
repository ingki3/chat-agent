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
  SELFTEST_SKILL,
  SKILL_CATALOGUE,
  type BundledSkill,
  type CatalogueStatus,
} from "@agentlee/mcp-tools/skills";
import type { UserStore } from "../auth/users.js";
import { EgressService } from "../isolation/egress.js";
import type { McpTokens } from "../isolation/tokens.js";
import { runIsolated, type RunIsolatedOptions } from "../isolation/sandbox.js";
import { logEvent, type EventLogger } from "../logging.js";
import { registerToolNames } from "../observability/policy.js";
import type { InstallState } from "./install.js";
import type { PythonRuntime } from "./python.js";

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
    // A skill must never hand a secret back to the model (an API echoing its key, a debug print).
    let out = r.stdout;
    for (const v of secretValues) out = out.split(v).join("[redacted]");
    try {
      return { ok: true, output: JSON.parse(out) as unknown };
    } catch {
      return { ok: false, code: "skill_bad_output" };
    }
  };
}

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
};

/** A skill in the admin's list (FR-10.3): the PRD §7 catalogue plus where each one stands on this server. */
export type SkillStatus =
  Exclude<CatalogueStatus, "implemented"> | "available" | "not_installed" | "broken" | "needs_python";
export type SkillOverview = {
  name: string;
  tool: string;
  finance: boolean;
  status: SkillStatus;
  issue?: string;
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

  constructor(
    private readonly tokens: McpTokens,
    private readonly users: Pick<UserStore, "byId">,
    private readonly opts: McpServiceOptions = {},
  ) {
    this.skills = (opts.skills ?? BUNDLED_SKILLS).filter((s) => s.kind !== "python" || opts.python);
    // Our tool names are fixed in code: they may be logged (#46).
    registerToolNames(this.toolNames());
  }

  /** Every tool this server offers (without the `mcp__agentlee__` prefix) — for log registration. */
  toolNames(): string[] {
    return toolNames({ skills: this.skills });
  }

  /** The tools one user's run gets: echo_time and the skills that user may use (FR-1.6). */
  toolNamesFor(userId: string): string[] {
    return toolNames({ skills: this.skillsFor(userId) });
  }

  /** Whether this user may use this skill now: active, and the skill always on or in their permissions. */
  allows(userId: string, skill: string): boolean {
    const u = this.users.byId(userId);
    if (!u?.active) return false;
    if (ALWAYS_ON_SKILLS.has(skill)) return true;
    const p = (u as { permissions?: { skills?: unknown } }).permissions?.skills;
    return p === "all" || (Array.isArray(p) && p.includes(skill));
  }

  private skillsFor(userId: string): BundledSkill[] {
    return this.skills.filter((s) => this.allows(userId, s.name));
  }

  /** The PRD §7 catalogue with each skill's state here (the admin screen is #35). */
  overview(): SkillOverview[] {
    const offered = new Set(this.skills.map((s) => s.name));
    return SKILL_CATALOGUE.map((e) => {
      let status: SkillStatus;
      if (e.status === "implemented") {
        const st = this.opts.installed?.[e.name] ?? "not_installed";
        status = offered.has(e.name) ? "available" : st === "installed" ? "needs_python" : st;
      } else status = e.status;
      return {
        name: e.name,
        tool: skillToolName(e.name),
        finance: e.finance,
        status,
        ...(e.issue ? { issue: e.issue } : {}),
      };
    });
  }

  private proxyFor(skill: BundledSkill) {
    let p = this.proxies.get(skill.name);
    if (!p) {
      p = (this.opts.egress ?? ((allow) => new EgressService({ allow })))(skill.hosts);
      this.proxies.set(skill.name, p);
    }
    return p.endpoint();
  }

  private host(): McpHost {
    const runSkill =
      this.opts.runSkill ??
      sandboxedSkillRunner({
        ...(this.opts.limits ? { limits: this.opts.limits } : {}),
        python: this.opts.python,
        secrets: this.opts.secrets,
        proxy: (s) => this.proxyFor(s),
      });
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
        return r;
      },
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.timeZone ? { timeZone: this.opts.timeZone } : {}),
    };
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
    const limit = this.opts.concurrency ?? DEFAULT_SKILL_CONCURRENCY;
    const mine = this.activeByRun.get(scope.runId) ?? 0;
    if (this.active >= limit.total || mine >= limit.perRun) return { ok: false, code: "skill_busy" };
    this.active++;
    this.activeByRun.set(scope.runId, mine + 1);
    try {
      return await runSkill(skill, parsed.data as Record<string, unknown>, scope);
    } finally {
      this.active--;
      const left = (this.activeByRun.get(scope.runId) ?? 1) - 1;
      if (left > 0) this.activeByRun.set(scope.runId, left);
      else this.activeByRun.delete(scope.runId);
    }
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
  }
}
