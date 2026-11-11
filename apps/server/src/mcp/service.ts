import fs from "node:fs";
import path from "node:path";
import {
  startMcpServer,
  toolNames,
  type McpHost,
  type RunningMcpServer,
  type SkillResult,
  type ToolScope,
} from "@agentlee/mcp-tools";
import { BUNDLED_SKILLS, type BundledSkill } from "@agentlee/mcp-tools/skills";
import type { UserStore } from "../auth/users.js";
import type { McpTokens } from "../isolation/tokens.js";
import { runIsolated } from "../isolation/sandbox.js";

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

/**
 * A bundled skill as a sandboxed node process: reads only its own folder (and node itself), writes nothing,
 * no network, no child processes, empty environment. Input on stdin, JSON result on stdout.
 */
export function sandboxedSkillRunner(limits: SkillLimits = DEFAULT_SKILL_LIMITS): SkillRunner {
  const node = fs.realpathSync(process.execPath);
  const nodeHome = path.dirname(path.dirname(node));
  return async (skill, input) => {
    let r;
    try {
      r = await runIsolated({
        command: node,
        args: [skill.entry],
        cwd: skill.dir,
        env: {},
        read: [skill.dir],
        trusted: [nodeHome],
        write: [],
        network: "none",
        stdin: JSON.stringify(input),
        ...limits,
      });
    } catch {
      return { ok: false, code: "skill_unavailable" }; // no sandbox here (not macOS), hard links, spawn failure
    }
    if (r.killed === "timeout") return { ok: false, code: "skill_timeout" };
    if (r.killed) return { ok: false, code: "skill_limit" };
    if (r.code !== 0) return { ok: false, code: "skill_failed" };
    try {
      return { ok: true, output: JSON.parse(r.stdout) as unknown };
    } catch {
      return { ok: false, code: "skill_bad_output" };
    }
  };
}

export type McpServiceOptions = {
  /** Allow-list of skills offered as tools. Default: the bundled ones. */
  skills?: readonly BundledSkill[];
  runSkill?: SkillRunner;
  now?: () => Date;
  timeZone?: string;
};

/**
 * Our MCP server inside the Agent Lee server process (PRD D7, #43). It listens on a loopback port of its own —
 * never on the public :3000 app — and starts on first use, so tests and runs without tools open no port.
 * Every request is authenticated with a run-scoped token (`McpTokens`), and every tool result is dropped when
 * the run ended meanwhile.
 */
export class McpService {
  private running: Promise<RunningMcpServer> | undefined;
  private closed = false;
  private readonly skills: readonly BundledSkill[];

  constructor(
    private readonly tokens: McpTokens,
    private readonly users: Pick<UserStore, "byId">,
    private readonly opts: McpServiceOptions = {},
  ) {
    this.skills = opts.skills ?? BUNDLED_SKILLS;
  }

  /** Tool names runtimes are allowed to call (without the `mcp__agentlee__` prefix). */
  toolNames(): string[] {
    return toolNames({ skills: this.skills });
  }

  private host(): McpHost {
    const runSkill = this.opts.runSkill ?? sandboxedSkillRunner();
    const byName = new Map(this.skills.map((s) => [s.name, s]));
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
      runSkill: async (name, input, scope) => {
        const skill = byName.get(name);
        if (!skill) return { ok: false, code: "skill_not_allowed" };
        return runSkill(skill, input, scope);
      },
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.timeZone ? { timeZone: this.opts.timeZone } : {}),
    };
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
  }
}
