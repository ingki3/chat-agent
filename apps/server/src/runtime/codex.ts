import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { PublicPart } from "@agentlee/shared";
import { runIsolated, spawnIsolated, type SpawnIsolatedOptions } from "../isolation/sandbox.js";
import {
  RuntimeFailure,
  SessionGoneError,
  type ModelCapability,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeTurn,
  type ConnectionRequest,
  type StartContext,
} from "./adapter.js";
import {
  AGENTLEE_MCP,
  codexConfigToml,
  codexMcpEnv,
  codexModelCatalog,
  codexRunConfig,
  mcpLoopbackPort,
} from "./lockdown.js";
import { notificationThread } from "./codex-protocol.js";
import { tokenExpiry } from "../connections/chatgpt.js";

/**
 * Codex runtime (#16) through `codex app-server` (stdio JSON-RPC, pinned @openai/codex 0.165.0). One app-server
 * process per session (the run manager opens a session per run): `thread/start` or `thread/resume`, then
 * `turn/start` per turn, `turn/interrupt` to stop.
 *
 * Isolation, in layers (#42, spike #39, verified on 0.165.0 — docs/decisions/isolation.md):
 *  1. Codex settings — our own CODEX_HOME with only our config.toml (`codexConfigToml`, loaded with
 *     `--strict-config`) and our model catalog (`codexModelCatalog`): no shell, files, plugins, apps, sub-agents,
 *     web search, skills or AGENTS.md; our MCP server only, and of it only the run's tools.
 *  2. Fail closed on what arrives: any item that is not text, reasoning or one of the run's own tools on our
 *     server (another MCP server, a built-in tool, a sub-agent, a command) stops the turn as `runtime_policy`;
 *     so does any request the app-server makes of us (approvals, user input, elicitation).
 *  3. The process runs under `sandbox-exec` (`spawnIsolated`): it reads and writes only its connection × user
 *     folder, cannot start child processes, and reaches only loopback ports (our MCP server, the egress proxy).
 *  4. Credentials go over stdin (`account/login/start`) into memory only (`cli_auth_credentials_store =
 *     "ephemeral"`) — never in the environment, arguments or on disk: the API key, or a ChatGPT login's access
 *     token (`chatgptAuthTokens`, #18). The refresh token never reaches the process: when app-server asks for new
 *     tokens (`account/chatgptAuthTokens/refresh`) the server refreshes them itself (connections/chatgpt.ts).
 */

/** New ChatGPT tokens for a running session (`refresh`): access token and account only. */
export type CodexChatgptTokens = { accessToken: string; accountId: string; planType: string | null };

export type CodexAuth =
  | { kind: "api_key"; apiKey: string }
  | {
      kind: "chatgpt";
      accessToken: string;
      accountId: string;
      planType: string | null;
      /**
       * New tokens when app-server finds the current ones refused (or they are about to expire). Rejects with
       * `RuntimeFailure("runtime_auth")` when the login is over (the turn fails `runtime_auth`), anything else for
       * a passing failure (`runtime_error`).
       */
      refresh(): Promise<CodexChatgptTokens>;
    };

/** Refreshes one session may ask for: app-server asks again on every retry of a refused request. */
const MAX_REFRESHES = 3;
/** An access token this close to its expiry is refreshed before the session starts. */
const REFRESH_AHEAD_MS = 2 * 60_000;

/** One Codex connection (#17 manages them): its folder `data/runtimes/<id>/<user id>` and its credential. */
export type CodexConnection = { id: string; dir: string; auth: CodexAuth };

/**
 * Models offered and the effort values each accepts — as the pinned binary's catalog lists them (checked by the
 * macOS test against `codex debug models --bundled`). The API refuses other values (spike: `minimal`).
 */
export const CODEX_MODELS: ModelCapability[] = [
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
];

/** The app-server process as the adapter uses it (spawnIsolated's child; a scripted one in tests). */
export type CodexChild = {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly pid?: number | undefined;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type CodexAdapterOptions = {
  /**
   * The run's connection (`ctx.connectionId`) for this user, or undefined when it is gone or not theirs to use
   * (the run then fails with `no_connection`). Connections live in the database (#17, connections/store.ts).
   */
  connection(ctx: ConnectionRequest): CodexConnection | undefined;
  models?: ModelCapability[];
  /** codex executable. Default: the pinned package's own platform binary (never a `codex` on PATH). */
  executable?: string;
  /** Memory limit of the app-server process. */
  maxRssBytes?: number;
  /**
   * Egress proxy the app-server must use for the internet (HTTPS_PROXY). The sandbox then opens only loopback
   * ports: this proxy and our MCP server. Without it the process has no internet at all.
   */
  egress?: { endpoint(): Promise<{ port: number; url: string }> };
  /**
   * Egress proxy for ChatGPT-login sessions (#18: `chatgpt.com` instead of the API host). Default: `egress`.
   */
  chatgptEgress?: { endpoint(): Promise<{ port: number; url: string }> };
  /** How long a JSON-RPC request may take before the session fails. */
  requestTimeoutMs?: number;
  /** Tests: replaces the sandboxed spawn (recorded-message replay). */
  spawn?: (o: SpawnIsolatedOptions) => CodexChild;
  /** Tests: the shipped model catalog (default: `codex debug models --bundled`, run in the sandbox). */
  bundledCatalog?: () => Promise<unknown>;
  /** Tests only: a local Responses endpoint instead of the OpenAI API (`codexConfigToml` `provider`). */
  provider?: { baseUrl: string };
};

/** The pinned platform binary of @openai/codex (its launcher script would pick one at run time). */
export function codexBinary(): string | undefined {
  const triple =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "aarch64-apple-darwin"
        : "x86_64-apple-darwin"
      : undefined;
  if (!triple) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const main = path.dirname(fs.realpathSync(require.resolve("@openai/codex/package.json")));
    const pkg = path.join(path.dirname(main), `codex-${process.platform}-${process.arch}`);
    const bin = path.join(pkg, "vendor", triple, "bin", "codex");
    return fs.existsSync(bin) ? fs.realpathSync(bin) : undefined;
  } catch {
    return undefined;
  }
}

/** Root certificates for TLS: the app-server's platform verifier cannot reach trustd inside the sandbox. */
export const CA_BUNDLE = "/private/etc/ssl/cert.pem";

/** Folders inside a connection folder. Created on first use, owner-only. */
export function codexPaths(dir: string) {
  return {
    codexHome: path.join(dir, "codex-home"), // CODEX_HOME: our config.toml and catalog, threads, state
    home: path.join(dir, "home"),
    work: path.join(dir, "work"), // cwd (no tools touch it)
    tmp: path.join(dir, "tmp"),
  };
}

/**
 * Files codex would turn into instructions: AGENTS.md and skills (a `$name` in a prompt pulls in that skill's
 * SKILL.md, even with skills switched off — checked on 0.165.0), in every place it looks. Nothing of ours puts them
 * there and the process cannot write `work` or `home`; removed before every start anyway, so a stray file never
 * reaches a prompt. Only these files: another session of the same user may be running in the folder.
 */
const INSTRUCTION_FILES = {
  codexHome: ["AGENTS.md", "AGENTS.override.md", "skills", "rules", "prompts", "hooks", ".agents"],
  home: [".agents", ".codex", "AGENTS.md", "AGENTS.override.md"],
  work: [".agents", ".codex", "AGENTS.md", "AGENTS.override.md"],
} as const;
function scrub(dir: string) {
  const p = codexPaths(dir);
  for (const [where, names] of Object.entries(INSTRUCTION_FILES))
    for (const n of names)
      fs.rmSync(path.join(p[where as keyof typeof INSTRUCTION_FILES], n), { recursive: true, force: true });
}

/** Writes a file in one step: a session starting at the same time never reads half of it. */
function writeAtomic(file: string, text: string) {
  const tmpFile = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmpFile, text, { mode: 0o600 });
  fs.renameSync(tmpFile, file);
}

function ensureDirs(dir: string) {
  for (const d of [dir, ...Object.values(codexPaths(dir))]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** The process's whole environment. No credential: the API key goes over stdin. */
export function codexEnv(conn: Pick<CodexConnection, "dir">): Record<string, string> {
  const p = codexPaths(conn.dir);
  return {
    PATH: "/usr/bin:/bin",
    HOME: p.home,
    TMPDIR: p.tmp,
    CODEX_HOME: p.codexHome,
    CODEX_CA_CERTIFICATE: CA_BUNDLE,
    LANG: "en_US.UTF-8",
  };
}

/**
 * What the server remembers per thread, outside the folder the process can write: the instructions the thread
 * started with (resumes send the same ones).
 */
type ThreadMeta = { instructions: string; history: string };
const metaDir = (dir: string) => `${dir}-meta`;
const metaFile = (dir: string, id: string) => path.join(metaDir(dir), `${id}.json`);
function readMeta(dir: string, id: string): ThreadMeta | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(dir, id), "utf8")) as ThreadMeta;
    return typeof m.instructions === "string" && typeof m.history === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}
function writeMeta(dir: string, id: string, m: ThreadMeta) {
  fs.mkdirSync(metaDir(dir), { recursive: true, mode: 0o700 });
  const f = metaFile(dir, id);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

/** Prior history for a fresh thread (a summary replaces it when long, #45). Sent as developer instructions. */
function historyText(history: StartContext["history"]): string {
  const lines = history.flatMap((h) => {
    const text = h.parts
      .flatMap((p: PublicPart) => (p.type === "text" ? [p.text] : []))
      .join("\n")
      .trim();
    return text
      ? [`[${h.role === "user" ? "사용자" : h.role === "assistant" ? "assistant" : "system"}]\n${text}`]
      : [];
  });
  return lines.length ? `<earlier_conversation>\n${lines.join("\n\n")}\n</earlier_conversation>` : "";
}

/** A thread's rollout file in CODEX_HOME — without it there is nothing to resume. */
function hasRollout(codexHome: string, threadId: string): boolean {
  const root = path.join(codexHome, "sessions");
  const want = `-${threadId}.jsonl`;
  const walk = (d: string, depth: number): boolean => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    return names.some((n) =>
      n.isDirectory()
        ? depth < 4 && walk(path.join(d, n.name), depth + 1)
        : n.isFile() && n.name.endsWith(want),
    );
  };
  return walk(root, 0);
}

/** MCP tool result content → our output value (JSON when the tool returned JSON text). */
function toolOutput(result: unknown): unknown {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result ?? null;
  const texts = content.flatMap((c: { type?: string; text?: string }) =>
    c && c.type === "text" && typeof c.text === "string" ? [c.text] : [],
  );
  const text = texts.join("\n");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export type Json = Record<string, unknown>;
export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Json;
  result?: Json;
  error?: Json;
};

/** The JSON-RPC failure of one request (the app-server answered with an error). Never carries its text. */
export class RpcError extends Error {
  constructor(readonly method: string) {
    super(`codex ${method} failed`);
  }
}

/**
 * Line-delimited JSON-RPC over the child's stdin/stdout. Server requests are refused unless `answer` takes one
 * (only a ChatGPT session's token refresh, #18).
 */
export class Rpc {
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(m: RpcMessage): void; reject(e: Error): void }>();
  exited = false;
  constructor(
    private readonly child: CodexChild,
    private readonly handlers: {
      notification(m: RpcMessage): void;
      /** A request from the app-server (approval, user input, …) that `answer` did not take: refused already. */
      serverRequest(method: string): void;
      /** Takes a server request: its answer (an error is sent when it rejects). Undefined = refused. */
      answer?(method: string, params: Json): Promise<Json> | undefined;
      exit(): void;
    },
    private readonly timeoutMs: number,
  ) {
    // One decoder for the stream: a multi-byte character split across chunks stays whole.
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (d: Buffer | string) => this.read(typeof d === "string" ? d : decoder.write(d)));
    child.once("exit", () => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new RuntimeFailure("runtime_error"));
      this.pending.clear();
      handlers.exit();
    });
  }

  private read(chunk: string) {
    this.buf += chunk;
    if (this.buf.length > 16 * 1024 * 1024) return void this.child.kill("SIGKILL"); // a runaway line
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: RpcMessage;
      try {
        m = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // not a protocol message
      }
      if (m.id !== undefined && m.method) {
        const id = m.id;
        const answer = this.handlers.answer?.(m.method, m.params ?? {});
        if (answer)
          answer.then(
            (result) => this.write({ id, result }),
            () => this.write({ id, error: { code: -32000, message: "refused by Agent Lee" } }),
          );
        else {
          this.write({ id, error: { code: -32601, message: "not supported by Agent Lee" } });
          this.handlers.serverRequest(m.method);
        }
      } else if (m.id !== undefined) {
        const p = this.pending.get(Number(m.id));
        this.pending.delete(Number(m.id));
        p?.resolve(m);
      } else if (m.method) this.handlers.notification(m);
    }
  }

  private write(m: RpcMessage) {
    if (!this.exited) this.child.stdin.write(JSON.stringify(m) + "\n");
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.exited) return Promise.reject(new RuntimeFailure("runtime_error"));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeFailure("runtime_error"));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          if (m.error || !m.result) reject(new RpcError(method));
          else resolve(m.result);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Json) {
    this.write({ method, params });
  }
}

/** Codex error info that means the credential is not accepted: fail at once (the binary would retry ~40 s). */
function isAuthError(info: unknown): boolean {
  if (info === "unauthorized") return true;
  if (info && typeof info === "object")
    return Object.values(info as Json).some(
      (v) => (v as { httpStatusCode?: unknown } | null)?.httpStatusCode === 401,
    );
  return false;
}
function isLimitError(info: unknown): boolean {
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded") return true;
  if (info && typeof info === "object")
    return Object.values(info as Json).some(
      (v) => (v as { httpStatusCode?: unknown } | null)?.httpStatusCode === 429,
    );
  return false;
}

/** Notifications naming an MCP server (`params.name`): only ours may appear. */
const MCP_SERVER_NOTIFICATIONS = new Set([
  "mcpServer/startupStatus/updated",
  "mcpServer/oauthLogin/completed",
]);
/** Output of processes or commands — nothing of ours starts any, so these never belong to a session of ours. */
const NEVER_NOTIFICATIONS = new Set([
  "process/outputDelta",
  "process/exited",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
]);

/** Items that are only conversation: they produce no event of their own (text comes as deltas). */
const QUIET_ITEMS = new Set(["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction"]);

const LIMIT_EVENT: RuntimeEvent = {
  type: "limit",
  code: "rate_limit",
  message: "Codex 사용 한도에 도달했어요.",
};

export class CodexAdapter implements RuntimeAdapter {
  readonly id = "codex" as const;
  private readonly models: ModelCapability[];
  private catalog: Promise<unknown> | undefined;
  /** Session opening per connection folder, one at a time (see `open`). */
  private readonly opening = new Map<string, Promise<void>>();
  constructor(private readonly opts: CodexAdapterOptions) {
    this.models = opts.models ?? CODEX_MODELS;
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
    return this.open(ctx, undefined);
  }

  async resume(externalSessionId: string, ctx: StartContext): Promise<RuntimeSession> {
    const conn = this.connectionFor(ctx);
    if (
      !/^[0-9a-f-]{36}$/.test(externalSessionId) ||
      !readMeta(conn.dir, externalSessionId) ||
      !hasRollout(codexPaths(conn.dir).codexHome, externalSessionId)
    )
      throw new SessionGoneError();
    return this.open(ctx, externalSessionId);
  }

  private connectionFor(ctx: StartContext): CodexConnection {
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

  private executable(): string {
    const bin = this.opts.executable ?? codexBinary();
    if (!bin) throw new RuntimeFailure("runtime_error");
    return bin;
  }

  /** The shipped catalog, read once from the pinned binary inside the sandbox (no network, a scratch home). */
  private bundledCatalog(dir: string): Promise<unknown> {
    if (this.opts.bundledCatalog) return this.opts.bundledCatalog();
    this.catalog ??= (async () => {
      const home = path.join(codexPaths(dir).tmp, "catalog-home");
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const r = await runIsolated({
        command: this.executable(),
        args: ["debug", "models", "--bundled"],
        cwd: home,
        env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: home, TMPDIR: home },
        read: [home],
        write: [home],
        network: "none",
        timeoutMs: 20_000,
        maxOutputBytes: 8 * 1024 * 1024,
      });
      if (r.code !== 0) throw new RuntimeFailure("runtime_error");
      return JSON.parse(r.stdout) as unknown;
    })().catch((e: unknown) => {
      this.catalog = undefined;
      throw e;
    });
    return this.catalog;
  }

  /**
   * Two app-servers initialising the same fresh CODEX_HOME at once can fail ("failed to initialize sqlite state
   * runtime", seen on 0.165.0 with two conversations of one user). Sessions of one folder are therefore opened one
   * after another; once open they run side by side.
   */
  private async open(ctx: StartContext, resumeId: string | undefined): Promise<RuntimeSession> {
    const dir = this.connectionFor(ctx).dir;
    const before = this.opening.get(dir) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = before.then(() => mine);
    this.opening.set(dir, chain);
    await before;
    try {
      return await this.openNow(ctx, resumeId);
    } finally {
      release();
      if (this.opening.get(dir) === chain) this.opening.delete(dir);
    }
  }

  private async openNow(ctx: StartContext, resumeId: string | undefined): Promise<RuntimeSession> {
    /** Cancelled (ctx.signal): nothing more is written to the folder and nothing is started. */
    const cancelled = () => {
      if (ctx.signal?.aborted) throw new RuntimeFailure("runtime_error");
    };
    cancelled(); // also covers the wait for an earlier opening of this folder
    const conn = this.connectionFor(ctx);
    this.checkModel(ctx.model, ctx.effort);
    scrub(conn.dir);
    ensureDirs(conn.dir);
    const paths = codexPaths(conn.dir);
    const bundled = await this.bundledCatalog(conn.dir);
    cancelled();
    const catalog = codexModelCatalog(
      bundled,
      this.models.map((m) => m.id),
    );
    const catalogPath = path.join(paths.codexHome, "agentlee-models.json");
    writeAtomic(catalogPath, JSON.stringify(catalog));
    writeAtomic(
      path.join(paths.codexHome, "config.toml"),
      codexConfigToml({ catalogPath, provider: this.opts.provider }),
    );
    const tools = ctx.mcp ? [...ctx.tools] : [];
    const runConfig = codexRunConfig({ model: ctx.model, mcp: ctx.mcp, tools });
    const env = codexEnv(conn);
    const mcpPort = ctx.mcp ? mcpLoopbackPort(ctx.mcp) : undefined;
    if (ctx.mcp) Object.assign(env, codexMcpEnv(ctx.mcp));
    const chatgpt = conn.auth.kind === "chatgpt" ? conn.auth : undefined;
    const egress = chatgpt ? (this.opts.chatgptEgress ?? this.opts.egress) : this.opts.egress;
    const proxy = egress ? await egress.endpoint() : undefined;
    if (proxy) Object.assign(env, { HTTPS_PROXY: proxy.url, NO_PROXY: "127.0.0.1,localhost" });
    cancelled();
    const providerPort = this.opts.provider ? Number(new URL(this.opts.provider.baseUrl).port) : undefined;
    const spawnFn = this.opts.spawn ?? spawnIsolated;
    const child = spawnFn({
      command: this.executable(),
      args: ["app-server", "--strict-config", "--listen", "stdio://", ...runConfig.flatMap((c) => ["-c", c])],
      cwd: paths.work,
      env,
      read: [conn.dir, CA_BUNDLE],
      // Writes only its state (CODEX_HOME) and temp files: work and home stay as we left them (empty), so nothing
      // in the process can plant instruction or skill files there.
      write: [paths.codexHome, paths.tmp],
      // Loopback only: our MCP server and the egress proxy. No direct internet, no home network.
      network: {
        loopbackPorts: [mcpPort, proxy?.port, providerPort].filter((p): p is number => p !== undefined),
      },
      maxRssBytes: this.opts.maxRssBytes ?? 2 * 1024 ** 3,
      onStderr: () => {}, // never logged: may echo prompts
    });
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    /** Resolves when the process has exited (or after `ms` — it was SIGKILLed, so it is going). */
    const exitedP = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const gone = (ms = 2000) => Promise.race([exitedP, new Promise<void>((r) => setTimeout(r, ms).unref())]);
    // A cancel while the session opens kills the process: the pending request fails, the open throws below.
    const onAbort = () => kill();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    // Every message is checked first, whenever it comes — while the session opens, between turns, during a turn
    // (`allowed`). What passes is routed to the running turn, if any.
    let onNotification: ((m: RpcMessage) => void) | undefined;
    let onEnd: (() => void) | undefined;
    /** Set while a turn runs: stops it as runtime_policy. */
    let onBreach: (() => void) | undefined;
    let policyBreach = false;
    let opened = false;
    /** A ChatGPT session whose login is over (a refresh was refused): every turn fails `runtime_auth`. */
    let authBroken = false;
    /** Set while a turn runs: ends it as runtime_auth. */
    let onAuthBroken: (() => void) | undefined;
    let refreshes = 0;
    /**
     * The last refresh failed for a passing reason (network, a malformed answer): the refusal app-server then
     * reports is not the login's end — the turn fails `runtime_error` and the connection is not marked expired.
     */
    let refreshFailedTransiently = false;
    /** The session's current ChatGPT tokens (a refresh replaces them). */
    let tokens = chatgpt
      ? { accessToken: chatgpt.accessToken, accountId: chatgpt.accountId, planType: chatgpt.planType }
      : undefined;
    const refreshTokens = async () => {
      if (!chatgpt) throw new RuntimeFailure("runtime_auth");
      try {
        tokens = await chatgpt.refresh();
        refreshFailedTransiently = false;
        return tokens;
      } catch (e) {
        // Only the provider refusing the login ends it; anything else (also an unexpected error) is passing.
        if (e instanceof RuntimeFailure && e.code === "runtime_auth") {
          authBroken = true;
          onAuthBroken?.();
        } else refreshFailedTransiently = true;
        throw e;
      }
    };
    /** The provider refused the credential — unless only our last refresh failed for a passing reason. */
    const refusedAuth = () =>
      new RuntimeFailure(refreshFailedTransiently && !authBroken ? "runtime_error" : "runtime_auth");
    /** app-server's `account/chatgptAuthTokens/refresh`: new tokens from the server, a few times per session. */
    const answer = (method: string): Promise<Json> | undefined => {
      if (method !== "account/chatgptAuthTokens/refresh" || !chatgpt) return undefined;
      if (authBroken || ++refreshes > MAX_REFRESHES) {
        authBroken = true;
        onAuthBroken?.();
        return Promise.reject(new RuntimeFailure("runtime_auth"));
      }
      return refreshTokens().then((t) => ({
        accessToken: t.accessToken,
        chatgptAccountId: t.accountId,
        chatgptPlanType: t.planType,
      }));
    };
    // A resume knows its thread from the first message on; a fresh start learns it from thread/start.
    let threadId: string | undefined = resumeId;
    /** Thread ids seen before thread/start told us ours. */
    const early = new Set<string>();
    const allowed = (m: RpcMessage): boolean => {
      const method = String(m.method);
      // A server other than ours (the config has only ours; account connectors could join late, review #80).
      if (MCP_SERVER_NOTIFICATIONS.has(method) && m.params?.name !== AGENTLEE_MCP) return false;
      if (NEVER_NOTIFICATIONS.has(method)) return false;
      const t = notificationThread(method, m.params);
      if (t === "unknown" || t === "malformed") return false; // not in the pinned protocol: fail closed
      if (t !== "global") {
        if (threadId === undefined) early.add(t.thread);
        else if (t.thread !== threadId) return false; // another thread (a sub-agent)
      }
      return itemAllowed(m);
    };
    /**
     * Items, whenever they come: only conversation, or a call of one of the run's tools on our server. Anything else
     * — a built-in (`codex` server), another server, a command, a file change, a sub-agent, a web search — is
     * refused, before its result is used.
     */
    const runTools = new Set(tools);
    const itemAllowed = (m: RpcMessage): boolean => {
      if (m.method !== "item/started" && m.method !== "item/completed") return true;
      const item = (m.params?.item ?? {}) as Json;
      const type = String(item.type);
      if (QUIET_ITEMS.has(type)) return true;
      return type === "mcpToolCall" && item.server === AGENTLEE_MCP && runTools.has(String(item.tool));
    };
    /**
     * Something we do not allow: during a turn it is stopped at once; between turns the session is closed (the
     * next turn fails closed); while opening, the open fails.
     */
    const breach = () => {
      policyBreach = true;
      if (onBreach) onBreach();
      else if (opened) kill();
    };
    const rpc = new Rpc(
      child,
      {
        notification: (m) => {
          if (!allowed(m)) return breach();
          onNotification?.(m);
        },
        serverRequest: () => breach(),
        answer,
        exit: () => onEnd?.(),
      },
      this.opts.requestTimeoutMs ?? 30_000,
    );

    let meta: ThreadMeta;
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "agentlee", title: null, version: "0.1.0" },
        // `chatgptAuthTokens` needs the experimental API (0.165.0: refused otherwise). It adds nothing we allow:
        // every notification and item is still checked against the pinned protocol table (fail closed).
        capabilities: { experimentalApi: chatgpt !== undefined, requestAttestation: false },
      });
      rpc.notify("initialized", {});
      cancelled();
      if (chatgpt) {
        // A token about to expire is refreshed first: one refused request fewer.
        const exp = tokenExpiry(tokens!.accessToken);
        if (exp !== undefined && exp < Date.now() + REFRESH_AHEAD_MS) await refreshTokens();
        cancelled();
        const login = await rpc.request("account/login/start", {
          type: "chatgptAuthTokens",
          accessToken: tokens!.accessToken,
          chatgptAccountId: tokens!.accountId,
          chatgptPlanType: tokens!.planType,
        });
        if (login.type !== "chatgptAuthTokens") throw new RuntimeFailure("runtime_auth");
      } else if (conn.auth.kind === "api_key") {
        const login = await rpc.request("account/login/start", { type: "apiKey", apiKey: conn.auth.apiKey });
        if (login.type !== "apiKey") throw new RuntimeFailure("runtime_auth");
      }
      cancelled();
      if (resumeId === undefined) {
        meta = { instructions: ctx.systemPrompt, history: historyText(ctx.history) };
        const r = await rpc.request("thread/start", {
          model: ctx.model,
          cwd: paths.work,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions: meta.instructions,
          developerInstructions: meta.history || null,
          ephemeral: false,
        });
        const started = (r.thread as { id?: unknown } | undefined)?.id;
        if (typeof started !== "string" || !/^[0-9a-f-]{36}$/.test(started))
          throw new RuntimeFailure("runtime_error");
        threadId = started;
        cancelled();
        writeMeta(conn.dir, threadId, meta);
      } else {
        meta = readMeta(conn.dir, resumeId)!;
        try {
          await rpc.request("thread/resume", {
            threadId: resumeId,
            model: ctx.model,
            cwd: paths.work,
            approvalPolicy: "never",
            sandbox: "read-only",
            baseInstructions: meta.instructions,
            excludeTurns: true,
          });
        } catch (e) {
          throw e instanceof RpcError ? new SessionGoneError() : e;
        }
      }
      // Thread ids seen before ours was known (a fresh start) must be ours too.
      if ([...early].some((t) => t !== threadId)) policyBreach = true;
      if (policyBreach) throw new RuntimeFailure("runtime_policy");
      if (authBroken) throw new RuntimeFailure("runtime_auth");
      cancelled();
      opened = true;
    } catch (e) {
      kill();
      ctx.signal?.removeEventListener("abort", onAbort);
      await gone(); // the open has failed only once the process is gone
      if (e instanceof RpcError)
        throw new RuntimeFailure(e.method === "account/login/start" ? "runtime_auth" : "runtime_error");
      throw e;
    }

    const id = threadId!; // set by thread/start or the resume (otherwise the open failed above)
    let closed = false;
    let model = ctx.model;
    const session: RuntimeSession = {
      externalSessionId: id,
      setModel: async (m) => {
        this.checkModel(m, undefined);
        model = m; // the next turn/start carries it (codex keeps it for later turns)
      },
      close: async () => {
        closed = true;
        ctx.signal?.removeEventListener("abort", onAbort);
        kill();
        await gone();
      },
      turn: (input): RuntimeTurn => {
        if (policyBreach) throw new RuntimeFailure("runtime_policy"); // seen between turns: closed already
        if (authBroken) throw new RuntimeFailure("runtime_auth");
        if (closed || rpc.exited) throw new Error("session closed");
        const cap = this.checkModel(input.model, input.effort);
        model = input.model;
        const queue: RuntimeEvent[] = [];
        let wake: (() => void) | undefined;
        let done = false;
        let failure: RuntimeFailure | undefined;
        let interrupted = false; // we asked for it
        let limited = false;
        let limitReached = false; // a rate-limit snapshot said so; counts only if the turn then fails
        let turnId: string | undefined;
        let usage: { total: Json; baseline: Json } | undefined;
        const push = (e: RuntimeEvent) => {
          queue.push(e);
          wake?.();
        };
        const end = (f?: RuntimeFailure) => {
          if (done) return;
          if (f && !failure) failure = f;
          done = true;
          onNotification = undefined;
          onEnd = undefined;
          onBreach = undefined;
          onAuthBroken = undefined;
          wake?.();
        };
        const stop = () => {
          if (turnId) void rpc.request("turn/interrupt", { threadId: id, turnId }).catch(() => {});
        };
        /** Something we do not allow showed up: stop the turn, report runtime_policy. */
        const refuse = () => {
          stop();
          end(new RuntimeFailure("runtime_policy"));
        };
        const num = (o: Json, k: string) => (typeof o[k] === "number" ? o[k] : 0);

        onEnd = () => end(interrupted ? undefined : new RuntimeFailure("runtime_error"));
        onBreach = refuse;
        // The login is over (a refresh was refused): no retries with it.
        onAuthBroken = () => {
          stop();
          end(new RuntimeFailure("runtime_auth"));
        };
        onNotification = (m) => {
          if (done) return;
          const p = m.params ?? {};
          if (turnId && p.turnId !== undefined && p.turnId !== turnId) return;
          switch (m.method) {
            case "item/agentMessage/delta":
              if (typeof p.delta === "string" && p.delta) push({ type: "text_delta", text: p.delta });
              return;
            case "item/reasoning/summaryTextDelta":
            case "item/reasoning/textDelta":
              if (typeof p.delta === "string" && p.delta) push({ type: "reasoning_delta", text: p.delta });
              return;
            case "item/started":
            case "item/completed": {
              const item = (p.item ?? {}) as Json;
              const type = String(item.type);
              if (QUIET_ITEMS.has(type)) return; // anything else that is not our tool was refused by itemAllowed
              const callId = String(item.id);
              if (m.method === "item/started")
                push({ type: "tool_start", callId, name: String(item.tool), input: item.arguments ?? null });
              else {
                const result = item.result as { isError?: unknown } | null;
                const isError = item.status !== "completed" || result?.isError === true;
                push({
                  type: "tool_end",
                  callId,
                  output:
                    isError && !result ? ((item.error as Json | null)?.message ?? null) : toolOutput(result),
                  ...(isError ? { isError: true } : {}),
                });
              }
              return;
            }
            case "thread/tokenUsage/updated": {
              const tu = (p.tokenUsage ?? {}) as { total?: Json; last?: Json };
              if (!tu.total) return;
              // `total` runs on across the thread (and resumes): this turn's share starts below its first report.
              const baseline =
                usage?.baseline ??
                Object.fromEntries(
                  ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens"].map((k) => [
                    k,
                    num(tu.total!, k) - num(tu.last ?? {}, k),
                  ]),
                );
              usage = { total: tu.total, baseline };
              return;
            }
            case "account/rateLimits/updated": {
              // A snapshot can say "reached" right after a turn that still completed: only a failing turn is limited.
              const rl = (p.rateLimits ?? {}) as { rateLimitReachedType?: unknown };
              if (rl.rateLimitReachedType) limitReached = true;
              return;
            }
            case "error": {
              const err = (p.error ?? {}) as { codexErrorInfo?: unknown };
              if (isAuthError(err.codexErrorInfo)) {
                // A ChatGPT session gets new tokens first (app-server asks for them, `answer`) and retries.
                if (chatgpt && p.willRetry === true && !authBroken && refreshes < MAX_REFRESHES) return;
                stop(); // no retries with a credential that is refused
                return end(refusedAuth());
              }
              if (isLimitError(err.codexErrorInfo) && p.willRetry !== true && !limited) {
                limited = true;
                push(LIMIT_EVENT);
              }
              return;
            }
            case "turn/completed": {
              const turn = (p.turn ?? {}) as {
                status?: unknown;
                error?: { codexErrorInfo?: unknown } | null;
              };
              // The turn's share, once, at its end: one usage event per attempt (#44). A figure Codex does not
              // report stays out (NULL) instead of becoming 0.
              if (usage) {
                const u = usage;
                const d = (k: string) =>
                  typeof u.total[k] === "number"
                    ? Math.max(0, num(u.total, k) - num(u.baseline, k))
                    : undefined;
                push({
                  type: "usage",
                  inputTokens: d("inputTokens"),
                  outputTokens: d("outputTokens"),
                  cacheReadTokens: d("cachedInputTokens"),
                  cacheWriteTokens: d("cacheWriteInputTokens"),
                });
              }
              if (turn.status === "completed") return end();
              if (turn.status === "interrupted" && interrupted) return end();
              if (isAuthError(turn.error?.codexErrorInfo)) return end(refusedAuth());
              if (limited || limitReached || isLimitError(turn.error?.codexErrorInfo)) {
                if (!limited) push(LIMIT_EVENT);
                limited = true;
                return end();
              }
              return end(new RuntimeFailure("runtime_error"));
            }
            default:
              return; // warnings, status changes, rate-limit snapshots without a limit: nothing to report
          }
        };

        const started = rpc
          .request("turn/start", {
            threadId: id,
            input: [{ type: "text", text: input.text, text_elements: [] }],
            model,
            // Codex keeps a turn's effort for later turns: always say which one (the model's default when unset).
            effort: input.effort ?? cap.defaultEffort ?? null,
          })
          .then((r) => {
            turnId = (r.turn as { id?: unknown } | undefined)?.id as string | undefined;
            if (typeof turnId !== "string") return end(new RuntimeFailure("runtime_error"));
            if (interrupted || failure) stop(); // asked before codex told us the turn id
          })
          .catch(() => end(interrupted ? undefined : new RuntimeFailure("runtime_error")));

        async function* events(): AsyncGenerator<RuntimeEvent> {
          try {
            for (;;) {
              if (queue.length) {
                yield queue.shift()!;
                continue;
              }
              if (done) break;
              await new Promise<void>((r) => (wake = r));
              wake = undefined;
            }
            await started;
            if (failure) throw failure;
          } finally {
            if (!done) {
              stop();
              end();
            }
          }
        }

        return {
          events: events(),
          interrupt: async () => {
            interrupted = true;
            stop();
          },
        };
      },
    };
    return session;
  }
}
