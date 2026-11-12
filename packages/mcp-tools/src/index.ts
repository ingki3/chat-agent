// Common MCP server shared by both runtimes (PRD D7): the connection test (#43) and the allow-listed skills (#21),
// each user seeing only the skills they may use.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const MCP_SERVER_NAME = "agentlee";
export const MCP_PATH = "/mcp";
/** Request bodies above this are refused before parsing (tool inputs are small; files go through uploads). */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Who a call is for — resolved from the run-scoped token on every request (isolation/tokens.ts, #42). */
export type ToolScope = { userId: string; conversationId: string; runId: string };

/** An allow-listed skill as the MCP server sees it; how it runs (sandboxed process) is the host's business. */
export type SkillInfo = {
  name: string;
  description: string;
  /** Input shape (zod object shape) validated before the skill is started. */
  input: z.ZodRawShape;
};

/** `hint`: fixed words the host adds to a refusal (e.g. what to ask for instead) — never input or file content. */
export type SkillResult = { ok: true; output: unknown } | { ok: false; code: string; hint?: string };

/** A tool implemented by the host itself (web search and fetch, #50) — offered to every active user. */
export type ServerToolInfo = SkillInfo;

export type McpHost = {
  /** Token → scope, or undefined when unknown, expired or revoked. Called per HTTP request and again per tool result. */
  authenticate(token: string): ToolScope | undefined;
  /** Display name of an active user (undefined when gone). */
  userName(userId: string): string | undefined;
  now?: () => Date;
  timeZone?: string;
  /** Every skill this server offers (tool names for the runtimes' allow-lists and the log). */
  skills: readonly SkillInfo[];
  /**
   * The skills one user may use right now (FR-1.6). Only these are listed and callable on that user's requests;
   * `runSkill` checks again (a permission can change while a run is going).
   */
  skillsFor(userId: string): readonly SkillInfo[];
  runSkill(name: string, input: Record<string, unknown>, scope: ToolScope): Promise<SkillResult>;
  /** Told about every answered tool call (the connection test #17 checks that our server really served them). */
  onToolCall?(tool: string, scope: ToolScope, ok: boolean): void;
  /** The host's own tools (named as they are, no prefix), and how to run one. */
  tools?: readonly ServerToolInfo[];
  /**
   * The host's tools one user may use right now (finance tools follow the user's skill permissions, #30). Default:
   * all of `tools`. `runTool` checks again.
   */
  toolsFor?(userId: string): readonly ServerToolInfo[];
  runTool?(name: string, input: Record<string, unknown>, scope: ToolScope): Promise<SkillResult>;
};

/** Tool names this server offers (adapters list them as allowed; runtimes see `mcp__agentlee__<name>`). */
export const skillToolName = (skill: string) => `skill_${skill}`;
export function toolNames(host: Pick<McpHost, "skills" | "tools">): string[] {
  return [
    "echo_time",
    ...(host.tools ?? []).map((t) => t.name),
    ...host.skills.map((s) => skillToolName(s.name)),
  ];
}

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/** A fresh MCP server bound to one authenticated request (stateless transport: one server per HTTP request). */
function serverFor(host: McpHost, token: string, scope: ToolScope): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
  // A run can end (and its token be revoked) while a tool is working: its result then goes nowhere.
  const stillValid = () => {
    const s = host.authenticate(token);
    return !!s && s.runId === scope.runId;
  };

  server.registerTool(
    "echo_time",
    {
      description:
        "Connection test: returns the Agent Lee server's current time and the name of the family member you are talking to.",
      inputSchema: {},
    },
    async () => {
      const name = host.userName(scope.userId);
      if (!name || !stillValid()) return text({ error: "unauthorized" }, true);
      const now = (host.now ?? (() => new Date()))();
      const timeZone = host.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      host.onToolCall?.("echo_time", scope, true);
      return text({
        now: now.toISOString(),
        local: now.toLocaleString("ko-KR", { timeZone }),
        timeZone,
        userName: name,
      });
    },
  );

  for (const tool of host.toolsFor?.(scope.userId) ?? host.tools ?? []) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: z.strictObject(tool.input) },
      async (input: Record<string, unknown>) => {
        if (!stillValid() || !host.runTool) return text({ error: "unauthorized" }, true);
        const r = await host.runTool(tool.name, input, scope);
        if (!stillValid()) return text({ error: "unauthorized" }, true);
        host.onToolCall?.(tool.name, scope, r.ok);
        return r.ok ? text(r.output) : text({ error: r.code, ...(r.hint ? { hint: r.hint } : {}) }, true);
      },
    );
  }

  for (const skill of host.skillsFor(scope.userId)) {
    server.registerTool(
      skillToolName(skill.name),
      // Strict: an argument the skill does not define is refused, not silently dropped.
      { description: skill.description, inputSchema: z.strictObject(skill.input) },
      async (input: Record<string, unknown>) => {
        if (!stillValid()) return text({ error: "unauthorized" }, true);
        const r = await host.runSkill(skill.name, input, scope);
        if (!stillValid()) return text({ error: "unauthorized" }, true);
        host.onToolCall?.(skillToolName(skill.name), scope, r.ok);
        return r.ok ? text(r.output) : text({ error: r.code }, true);
      },
    );
  }
  return server;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function deny(res: http.ServerResponse, status: number, error: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify({ error }));
}

function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The HTTP handler. Checks, in order: path, loopback Host (DNS rebinding), no browser Origin, POST, bearer token.
 * The token itself is never logged or echoed.
 */
export function createMcpHandler(host: McpHost, port: () => number) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== MCP_PATH) return deny(res, 404, "not_found");
      // Only a client on this machine that addressed us directly (not a web page via a rebinding hostname).
      const hostHeader = req.headers.host ?? "";
      const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
      if (!m || !LOOPBACK_HOSTS.has(m[1]!.toLowerCase()) || Number(m[2]) !== port())
        return deny(res, 403, "forbidden_host");
      if (req.headers.origin !== undefined) return deny(res, 403, "forbidden_origin");
      if (req.method !== "POST") return deny(res, 405, "method_not_allowed", { allow: "POST" });

      const auth = req.headers.authorization;
      const token =
        typeof auth === "string" && /^Bearer [A-Za-z0-9_-]+$/.test(auth) ? auth.slice(7) : undefined;
      const scope = token ? host.authenticate(token) : undefined;
      if (!token || !scope) return deny(res, 401, "unauthorized", { "www-authenticate": "Bearer" });

      const raw = await readBody(req);
      if (!raw) return deny(res, 413, "too_large");
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return deny(res, 400, "invalid_json");
      }

      const server = serverFor(host, token, scope);
      // Stateless (no session id option): every request is authenticated on its own, nothing is kept between them.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) deny(res, 500, "internal");
      else res.destroy();
    }
  };
}

export type RunningMcpServer = {
  /** Base URL clients connect to, e.g. http://127.0.0.1:53211/mcp */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
};

/** Starts the MCP server on a loopback port (0 = any free port). Never reachable from outside this machine. */
export async function startMcpServer(host: McpHost, port = 0): Promise<RunningMcpServer> {
  let bound = 0;
  const server = http.createServer(createMcpHandler(host, () => bound));
  server.requestTimeout = 5 * 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${bound}${MCP_PATH}`,
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
