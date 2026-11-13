import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { renderPriorContext } from "./context.js";
import { spawnIsolated, type SpawnIsolatedOptions } from "../isolation/sandbox.js";
import {
  ExitUnconfirmedError,
  RuntimeFailure,
  SessionGoneError,
  type ForgetOptions,
  type ModelCapability,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeTurn,
  type ConnectionRequest,
  type StartContext,
} from "./adapter.js";
import { assertOnlyOurMcp, claudeLockdown, mcpLoopbackPort, OUR_TOOL_PREFIX } from "./lockdown.js";
import {
  assertNoLinks,
  connectionChain,
  noteEnded,
  noteStarted,
  idsNamed,
  metaIds,
  namedAfter,
  ownName,
  plainDir,
  removeMeta,
  removeNamed,
  SESSION_ID,
} from "./forget.js";

/**
 * Claude Code runtime (#15) through the Claude Agent SDK. One SDK query per run (the run manager opens a
 * session per run): streaming input so that `interrupt()` works, `includePartialMessages` for token deltas.
 *
 * Isolation, in layers (#42, spike #39):
 *  1. SDK settings — no built-in tools, no user/project settings, only our MCP server, a PreToolUse hook that
 *     allows only our tools (`claudeLockdown`), and a fail-closed check of the init message.
 *  2. The CLI process runs under `sandbox-exec` (`spawnIsolated`): it reads and writes only its connection folder,
 *     cannot start child processes, and reaches only HTTPS and our MCP port.
 *  3. Credentials go in the child's environment only — never on disk, never in arguments.
 */

export type ClaudeAuth = { kind: "api_key"; apiKey: string } | { kind: "oauth_token"; token: string };

/** One Claude connection (#17 manages them): its own folder `data/runtimes/<id>` and its credential. */
export type ClaudeConnection = { id: string; dir: string; auth: ClaudeAuth };

/**
 * Models offered and the effort values each accepts (PRD capability table; the SDK itself accepts anything). The
 * context windows are the conservative standard size (#45 summarises at a ratio of them; ops.md §27).
 */
export const CLAUDE_MODELS: ModelCapability[] = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    contextWindow: 200_000,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    contextWindow: 200_000,
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    efforts: ["low", "medium", "high"],
    defaultEffort: "low",
    contextWindow: 200_000,
    // Conversation summaries are written with it when the user may use it (#45).
    cheap: true,
  },
];

export type ClaudeAdapterOptions = {
  /**
   * The run's connection (`ctx.connectionId`) for this user, or undefined when it is gone or not theirs to use
   * (the run then fails with `no_connection`). Connections live in the database (#17, connections/store.ts).
   */
  connection(ctx: ConnectionRequest): ClaudeConnection | undefined;
  models?: ModelCapability[];
  /** Claude Code executable. Default: the SDK's own platform binary. */
  executable?: string;
  /** Memory limit of the CLI process. */
  maxRssBytes?: number;
  /**
   * Egress proxy the CLI must use for the internet (HTTPS_PROXY). The sandbox then opens only loopback ports:
   * this proxy and our MCP server. Without it the CLI has no internet at all.
   */
  egress?: { endpoint(): Promise<{ port: number; url: string }> };
  /** Tests: replaces the SDK (recorded-event replay) and the sandboxed spawn. */
  query?: typeof sdkQuery;
  spawn?: (o: SpawnIsolatedOptions) => SpawnedProcess;
};

/**
 * What the server remembers per session, outside the folder the CLI can write: the system prompt the session
 * started with (resumes send the same one — the SDK's own system-prompt snapshot is not available everywhere)
 * and the cumulative cost already reported (results carry running totals across resumes).
 */
type SessionMeta = { systemPrompt: string; costUsd: number };
const metaDir = (dir: string) => `${dir}-meta`;
const metaFile = (dir: string, id: string) => path.join(metaDir(dir), `${id}.json`);
function readMeta(dir: string, id: string): SessionMeta | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(dir, id), "utf8")) as SessionMeta;
    return typeof m.systemPrompt === "string" && typeof m.costUsd === "number" ? m : undefined;
  } catch {
    return undefined;
  }
}
function writeMeta(dir: string, id: string, m: SessionMeta) {
  fs.mkdirSync(metaDir(dir), { recursive: true, mode: 0o700 });
  const f = metaFile(dir, id);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

/** Variables the SDK adds for its CLI (entrypoint, SDK version, feature flags) — kept; nothing secret. */
const SDK_ENV = /^(CLAUDE_CODE_ENTRYPOINT|CLAUDE_AGENT_SDK_[A-Z0-9_]+|CLAUDE_CODE_SDK_[A-Z0-9_]+)$/;

/** Folders inside a connection folder. Created on first use, owner-only. */
export function connectionPaths(dir: string) {
  return {
    config: path.join(dir, "config"), // CLAUDE_CONFIG_DIR: sessions, settings, caches
    home: path.join(dir, "home"),
    work: path.join(dir, "work"), // cwd (no tools touch it)
    tmp: path.join(dir, "tmp"),
  };
}

function ensureDirs(dir: string) {
  for (const d of [dir, ...Object.values(connectionPaths(dir))])
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** The child's whole environment. The credential appears only here. */
export function claudeEnv(conn: ClaudeConnection): Record<string, string> {
  const p = connectionPaths(conn.dir);
  return {
    PATH: "/usr/bin:/bin",
    HOME: p.home,
    TMPDIR: p.tmp,
    CLAUDE_CODE_TMPDIR: p.tmp,
    CLAUDE_CONFIG_DIR: p.config,
    LANG: "en_US.UTF-8",
    // No auto-update, no telemetry or error reporting, no other "nonessential" traffic.
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "agent-lee/0.1",
    ...(conn.auth.kind === "api_key"
      ? { ANTHROPIC_API_KEY: conn.auth.apiKey }
      : { CLAUDE_CODE_OAUTH_TOKEN: conn.auth.token }),
  };
}

/** What a fresh session knows of the conversation (#45: summary, recent messages, references), after the prompt. */
function historyPrompt(ctx: StartContext): string {
  const prior = renderPriorContext(ctx);
  return prior ? `\n\n${prior}` : "";
}

/** Tool result content → our output value (JSON when the tool returned JSON text). */
function toolOutput(content: unknown): unknown {
  if (typeof content === "string") return parseMaybe(content);
  if (Array.isArray(content)) {
    const texts = content.flatMap((c: { type?: string; text?: string }) =>
      c.type === "text" && c.text ? [c.text] : [],
    );
    if (texts.length === 1) return parseMaybe(texts[0]!);
    return texts.join("\n");
  }
  return content ?? null;
}
function parseMaybe(t: string): unknown {
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return t;
  }
}

const AUTH_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
]);

export class ClaudeAdapter implements RuntimeAdapter {
  readonly id = "claude-code" as const;
  private readonly models: ModelCapability[];
  constructor(private readonly opts: ClaudeAdapterOptions) {
    this.models = opts.models ?? CLAUDE_MODELS;
  }

  capabilities(): RuntimeCapabilities {
    return {
      models: this.models,
      canSwitchModelInSession: true,
      canResume: true,
      usesTools: true,
      needsConnection: true,
    };
  }

  async start(ctx: StartContext): Promise<RuntimeSession> {
    return this.open(ctx, { sessionId: crypto.randomUUID(), fresh: true });
  }

  async resume(externalSessionId: string, ctx: StartContext): Promise<RuntimeSession> {
    const conn = this.connectionFor(ctx);
    // Claude keeps sessions as <config>/projects/<cwd>/<id>.jsonl; without the file there is nothing to resume.
    const projects = path.join(connectionPaths(conn.dir).config, "projects");
    const found =
      /^[0-9a-f-]{36}$/.test(externalSessionId) &&
      fs.existsSync(projects) &&
      fs
        .readdirSync(projects)
        .some((d) => fs.existsSync(path.join(projects, d, `${externalSessionId}.jsonl`)));
    if (!found || !readMeta(conn.dir, externalSessionId)) throw new SessionGoneError();
    return this.open(ctx, { sessionId: externalSessionId, fresh: false });
  }

  /**
   * The session's files go (#54): Claude keeps a session as `<config>/projects/<cwd>/<id>.jsonl` (with `<id>/` for its
   * tool results and sub-agents) and a few per-session files elsewhere in the config folder (todos, file history,
   * session environment, debug log) — all named after the id. Plus our own note (`<dir>-meta/<id>.json`: the start
   * prompt with the history it was given). Plain files only: nothing to start.
   */
  async forget(externalSessionId: string, dir: string, opts: ForgetOptions = {}): Promise<void> {
    if (!SESSION_ID.test(externalSessionId)) return;
    if (opts.stillOrphan && !opts.stillOrphan()) return;
    // A link anywhere on the way stops it (retried by the caller): nothing is removed through a link.
    assertNoLinks(connectionChain(dir, [connectionPaths(dir).config]));
    if (plainDir(dir)) removeNamed(connectionPaths(dir).config, namedAfter(externalSessionId), 3);
    removeMeta(dir, externalSessionId);
  }

  /** Sessions with state here: transcripts under `config/projects/` and our notes (written first, at the start). */
  storedSessions(dir: string): string[] {
    if (!plainDir(dir) || !plainDir(connectionPaths(dir).config)) return [];
    const projects = path.join(connectionPaths(dir).config, "projects");
    return [...new Set([...idsNamed(projects, ownName, 1), ...metaIds(dir)])];
  }

  private connectionFor(ctx: StartContext): ClaudeConnection {
    const conn = this.opts.connection(ctx);
    if (!conn) throw new RuntimeFailure("no_connection");
    return conn;
  }

  private checkModel(model: string, effort: string | undefined) {
    const m = this.models.find((x) => x.id === model);
    if (!m) throw new RuntimeFailure("runtime_error");
    if (effort !== undefined && !m.efforts.includes(effort)) throw new RuntimeFailure("runtime_error");
    return m;
  }

  private async open(ctx: StartContext, s: { sessionId: string; fresh: boolean }): Promise<RuntimeSession> {
    /** Cancelled (ctx.signal): nothing more is written to the folder and no CLI is started. */
    const cancelled = () => {
      if (ctx.signal?.aborted) throw new RuntimeFailure("runtime_error");
    };
    cancelled();
    const conn = this.connectionFor(ctx);
    this.checkModel(ctx.model, ctx.effort);
    // Nothing is created or written through a link (#54 review): the connection folder down to every part we use.
    assertNoLinks(connectionChain(conn.dir, Object.values(connectionPaths(conn.dir))));
    ensureDirs(conn.dir);
    const paths = connectionPaths(conn.dir);
    const env = claudeEnv(conn);
    const executable = this.opts.executable;
    const spawnFn = this.opts.spawn ?? spawnIsolated;
    const maxRssBytes = this.opts.maxRssBytes ?? 2 * 1024 ** 3;
    const mcpPort = ctx.mcp ? mcpLoopbackPort(ctx.mcp) : undefined;
    const proxy = this.opts.egress ? await this.opts.egress.endpoint() : undefined;
    if (proxy) Object.assign(env, { HTTPS_PROXY: proxy.url, NO_PROXY: "127.0.0.1,localhost" });
    cancelled();
    // The system prompt is fixed when the session starts (with the history it was given) and reused on resume.
    const meta: SessionMeta = s.fresh
      ? { systemPrompt: ctx.systemPrompt + historyPrompt(ctx), costUsd: 0 }
      : readMeta(conn.dir, s.sessionId)!;
    // Live in this process from now until it is closed and its processes have exited — a resumed one too (#54
    // review round 4: the reconciliation's last check never takes a session in use for an orphan).
    noteStarted(s.sessionId);
    if (s.fresh) {
      // Known before anything of it is written (#54): a failure from here on leaves state the caller forgets.
      ctx.sessionStarted?.(s.sessionId);
      try {
        writeMeta(conn.dir, s.sessionId, meta);
      } catch (e) {
        noteEnded(s.sessionId); // never live: the caller forgets what was written
        throw e;
      }
    }
    const run = this.opts.query ?? sdkQuery;
    let current: Query | undefined;
    let closed = false;
    /** CLI processes of this session: closing (or a cancel) waits until they have exited. */
    const procs = new Set<SpawnedProcess>();
    /** Every process of the session has exited (now or later) — `exited()`. */
    const allExited = () =>
      Promise.all(
        [...procs].map(
          (p) =>
            new Promise<void>((resolve) => {
              if (p.exitCode !== null || p.signalCode) return resolve();
              p.once("exit", () => resolve());
            }),
        ),
      ).then(() => {});
    /** True when every process exited; false when one had not even 2 s after its SIGKILL (not confirmed, #54). */
    const killAll = async (): Promise<boolean> => {
      current?.close();
      const waits = [...procs].map(
        (p) =>
          new Promise<boolean>((resolve) => {
            if (p.exitCode !== null || p.signalCode) return resolve(true);
            let forced: NodeJS.Timeout | undefined;
            const timer = setTimeout(() => {
              p.kill("SIGKILL"); // did not end on the SDK's close: forced
              forced = setTimeout(() => resolve(false), 2000);
              forced.unref();
            }, 2000);
            timer.unref();
            p.once("exit", () => {
              clearTimeout(timer);
              clearTimeout(forced);
              resolve(true);
            });
          }),
      );
      return (await Promise.all(waits)).every(Boolean);
    };
    const onAbort = () => {
      closed = true;
      void killAll();
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    const spawnClaudeCodeProcess = (o: SpawnOptions): SpawnedProcess => {
      const command = fs.realpathSync(o.command);
      // Ours, plus only the SDK's own non-secret variables (never the server's environment).
      const sdkVars = Object.fromEntries(
        Object.entries(o.env).filter(([k, v]) => SDK_ENV.test(k) && v !== undefined && !(k in env)),
      ) as Record<string, string>;
      const p = spawnFn({
        command,
        args: o.args,
        cwd: paths.work,
        env: { ...sdkVars, ...env },
        read: [conn.dir],
        write: [conn.dir],
        // Loopback only: our MCP server and the egress proxy. No direct internet, no home network.
        network: { loopbackPorts: [mcpPort, proxy?.port].filter((p): p is number => p !== undefined) },
        maxRssBytes,
      });
      procs.add(p);
      p.once("exit", () => procs.delete(p));
      return p;
    };

    const session: RuntimeSession = {
      externalSessionId: s.sessionId,
      setModel: async (model) => {
        this.checkModel(model, undefined);
        await current?.setModel(model);
      },
      close: async () => {
        closed = true;
        ctx.signal?.removeEventListener("abort", onAbort);
        // Live until its processes have really exited (#54: until then the reconciliation leaves it alone).
        void allExited().then(() => noteEnded(s.sessionId));
        if (!(await killAll())) throw new ExitUnconfirmedError();
      },
      exited: allExited,
      turn: (input): RuntimeTurn => {
        if (closed || ctx.signal?.aborted) throw new Error("session closed");
        this.checkModel(input.model, input.effort);
        let endInput!: () => void;
        const inputDone = new Promise<void>((r) => (endInput = r));
        const userMessage: SDKUserMessage = {
          type: "user",
          message: { role: "user", content: input.text },
          parent_tool_use_id: null,
        };
        async function* prompt(): AsyncGenerator<SDKUserMessage> {
          yield userMessage;
          await inputDone; // keep the input open (streaming mode) until the turn is over
        }
        const options: Options = {
          ...claudeLockdown({
            cwd: paths.work,
            env,
            mcp: ctx.mcp,
            tools: ctx.tools,
            onForeignTool: () => {
              foreign = true;
              void q.interrupt().catch(() => {});
            },
          }),
          // The text is delivered as written: no `@file` expansion, no slash commands (review #80).
          verbatimPrompts: true,
          model: input.model,
          ...(input.effort ? { effort: input.effort as NonNullable<Options["effort"]> } : {}),
          systemPrompt: meta.systemPrompt,
          includePartialMessages: true,
          persistSession: true,
          ...(s.fresh ? { sessionId: s.sessionId } : { resume: s.sessionId }),
          ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
          spawnClaudeCodeProcess,
          stderr: () => {}, // never logged: may echo prompts or credentials
        } as Options;
        s.fresh = false; // later turns of this session continue it
        const q = run({ prompt: prompt(), options });
        current = q;
        let interrupted = false;
        let foreign = false; // an MCP server that is not ours tried to run a tool: stop the turn
        let limited = false; // a usage limit ends the turn as `limit`, not as a failure (review #80)

        async function* events(): AsyncGenerator<RuntimeEvent> {
          try {
            for await (const m of q as AsyncIterable<SDKMessage>) {
              if (foreign) throw new RuntimeFailure("runtime_policy");
              yield* translate(m);
              if (m.type === "result") {
                if (m.is_error && !limited && !(interrupted && m.subtype === "error_during_execution"))
                  throw new RuntimeFailure("runtime_error");
                return;
              }
            }
            if (foreign) throw new RuntimeFailure("runtime_policy");
            if (!interrupted) throw new RuntimeFailure("runtime_error"); // ended without a result
          } finally {
            endInput();
          }
        }

        function* translate(m: SDKMessage): Generator<RuntimeEvent> {
          if (m.type === "system" && m.subtype === "init") {
            // Fail closed: exactly our MCP server, and no tool that is not ours (built-ins, connectors).
            try {
              assertOnlyOurMcp(m.mcp_servers);
            } catch {
              throw new RuntimeFailure("runtime_policy");
            }
            if (m.tools.some((t) => !t.startsWith(OUR_TOOL_PREFIX)))
              throw new RuntimeFailure("runtime_policy");
            return;
          }
          if (m.type === "stream_event") {
            const ev = m.event as {
              type: string;
              delta?: { type: string; text?: string; thinking?: string };
            };
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text)
              yield { type: "text_delta", text: ev.delta.text };
            if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking)
              yield { type: "reasoning_delta", text: ev.delta.thinking };
            return;
          }
          if (m.type === "assistant") {
            if (m.error === "rate_limit") {
              limited = true;
              yield { type: "limit", code: "rate_limit", message: "Claude 사용 한도에 도달했어요." };
              return;
            }
            if (m.error && AUTH_ERRORS.has(m.error)) throw new RuntimeFailure("runtime_auth");
            for (const b of m.message.content as {
              type: string;
              id?: string;
              name?: string;
              input?: unknown;
            }[])
              if (b.type === "tool_use" && b.id && b.name)
                yield {
                  type: "tool_start",
                  callId: b.id,
                  name: b.name.startsWith(OUR_TOOL_PREFIX) ? b.name.slice(OUR_TOOL_PREFIX.length) : b.name,
                  input: b.input ?? null,
                };
            return;
          }
          if (m.type === "user" && Array.isArray(m.message.content)) {
            for (const b of m.message.content as {
              type: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            }[])
              if (b.type === "tool_result" && b.tool_use_id)
                yield {
                  type: "tool_end",
                  callId: b.tool_use_id,
                  output: toolOutput(b.content),
                  ...(b.is_error ? { isError: true } : {}),
                };
            return;
          }
          if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") {
            limited = true;
            // The SDK's reset time is in seconds since the epoch; only a plain number is taken. A model-specific
            // window (`seven_day_opus`, `seven_day_sonnet`) limits only that family (#19).
            const at = m.rate_limit_info.resetsAt;
            const family = /^seven_day_(opus|sonnet|haiku)$/.exec(m.rate_limit_info.rateLimitType ?? "")?.[1];
            yield {
              type: "limit",
              code: "rate_limit",
              message: "Claude 사용 한도에 도달했어요.",
              ...(typeof at === "number" && Number.isFinite(at) && at > 0
                ? { resetsAt: at < 1e12 ? at * 1000 : at }
                : {}),
              ...(family ? { modelFamily: family } : {}),
            };
            return;
          }
          if (m.type === "result") {
            const u = m.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            // total_cost_usd runs on across resumes: report only what this turn added.
            let cost: number | undefined;
            if (typeof m.total_cost_usd === "number") {
              cost = Math.max(
                0,
                m.total_cost_usd >= meta.costUsd ? m.total_cost_usd - meta.costUsd : m.total_cost_usd,
              );
              meta.costUsd = m.total_cost_usd;
              writeMeta(conn.dir, s.sessionId, meta);
            }
            // Per turn and final: one usage event per attempt (#44). A figure Claude leaves out stays out (NULL).
            const cacheRead = u.cache_read_input_tokens;
            const cacheWrite = u.cache_creation_input_tokens;
            yield {
              type: "usage",
              ...(u.input_tokens === undefined
                ? {}
                : { inputTokens: u.input_tokens + (cacheRead ?? 0) + (cacheWrite ?? 0) }),
              ...(u.output_tokens === undefined ? {} : { outputTokens: u.output_tokens }),
              ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
              ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
              // A subscription (PRD FR-9.2) has no per-call price: tokens only. The CLI's figure would be what the
              // same tokens cost through the API — never shown or stored as money spent.
              ...(cost === undefined || conn.auth.kind === "oauth_token" ? {} : { costUsd: cost }),
            };
          }
        }

        return {
          events: events(),
          interrupt: async () => {
            interrupted = true;
            await q.interrupt().catch(() => {});
          },
        };
      },
    };
    return session;
  }
}
