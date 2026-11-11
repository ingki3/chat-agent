/**
 * Built-in tool lockdown for both runtimes — the first line of defence (#42, spike #39). Process isolation
 * (isolation/sandbox.ts) is the second. The adapters (#15, #16) pass these settings unchanged.
 */

export const AGENTLEE_MCP = "agentlee";
/** Prefix of tool names coming from our MCP server, as the Claude Agent SDK names them. */
export const OUR_TOOL_PREFIX = `mcp__${AGENTLEE_MCP}__`;

/**
 * How a runtime reaches our MCP server (#43): Streamable HTTP on a loopback port inside the Agent Lee server, with
 * the run's token as a bearer token. HTTP rather than stdio, so a sandboxed runtime never has to start (fork) an
 * MCP process of its own.
 */
export type McpConnection = { url: string; token: string };

/** Environment variable that carries the token to Codex (`bearer_token_env_var`); never written into config.toml. */
export const CODEX_MCP_TOKEN_ENV = "AGENTLEE_MCP_TOKEN";

/** Sandbox network rule for a runtime process: our MCP port and nothing else (plus what the caller adds). */
export function mcpLoopbackPort(mcp: McpConnection): number {
  const u = new URL(mcp.url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port)
    throw new Error("MCP server must be on 127.0.0.1");
  return Number(u.port);
}

export type PreToolUseResult = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
};

/**
 * Allows our MCP tools — explicitly: without an "allow" the SDK asks for permission, and with nobody to ask the call
 * fails (checked against the pinned SDK with our HTTP MCP server, #43). Everything else (Bash, Read, account
 * connectors, …) is denied.
 */
export function preToolUse(toolName: string): PreToolUseResult {
  const ours = toolName.startsWith(OUR_TOOL_PREFIX);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: ours ? "allow" : "deny",
      permissionDecisionReason: ours ? "Agent Lee tool" : "Agent Lee: only Agent Lee tools are allowed",
    },
  };
}

/**
 * Claude Agent SDK options. Not relied on: `canUseTool` (not called for read-only commands) and `allowedTools`
 * (auto-approves). Relied on: no built-in tools, no user/project settings, only our MCP server, the hook above.
 */
export function claudeLockdown(o: { cwd: string; env: Record<string, string>; mcp: McpConnection }) {
  mcpLoopbackPort(o.mcp);
  return {
    cwd: o.cwd,
    env: o.env, // replaces the parent environment (SDK: not merged)
    tools: [] as string[],
    disallowedTools: [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "Task",
      "NotebookEdit",
    ],
    settingSources: [] as string[],
    strictMcpConfig: true,
    mcpServers: {
      [AGENTLEE_MCP]: {
        type: "http" as const,
        url: o.mcp.url,
        headers: { Authorization: `Bearer ${o.mcp.token}` },
      },
    },
    hooks: {
      PreToolUse: [{ hooks: [async (input: { tool_name: string }) => preToolUse(input.tool_name)] }],
    },
  };
}

/**
 * Claude may attach account connectors despite the settings (seen once in the spike). At session init the
 * list of MCP servers must be exactly ours — otherwise the run stops (fail closed).
 */
export function assertOnlyOurMcp(servers: readonly { name: string }[]): void {
  const others = servers.filter((s) => s.name !== AGENTLEE_MCP).map((s) => s.name);
  if (others.length) throw new Error(`unexpected MCP servers: ${others.join(", ")}`);
}

/** Features of `codex app-server` that reach outside our tools. All off. */
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "plugins",
  "apps",
  "browser_use",
  "computer_use",
  "memories",
  "web_search_request",
] as const;

const toml = (v: string) => JSON.stringify(v); // TOML basic strings use the same escapes as JSON

/**
 * `config.toml` for a connection's own CODEX_HOME (never the user's ~/.codex): features off, our MCP server only,
 * tool calls auto-approved for our server (the user never sees a Codex approval prompt). The token goes in the
 * app-server's environment (`codexMcpEnv`), not in this file.
 * The read-only sandbox is set but not relied on — it does not prevent reads.
 */
export function codexConfigToml(o: { model: string; mcp: McpConnection }): string {
  mcpLoopbackPort(o.mcp);
  const lines = [
    `model = ${toml(o.model)}`,
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    "",
    "[features]",
    ...CODEX_DISABLED_FEATURES.map((f) => `${f} = false`),
    "",
    `[mcp_servers.${AGENTLEE_MCP}]`,
    `url = ${toml(o.mcp.url)}`,
    `bearer_token_env_var = ${toml(CODEX_MCP_TOKEN_ENV)}`,
    `default_tools_approval_mode = "approve"`,
  ];
  return lines.join("\n") + "\n";
}

/** Environment entries the codex app-server process needs for our MCP server (merge into its own env). */
export function codexMcpEnv(mcp: McpConnection): Record<string, string> {
  return { [CODEX_MCP_TOKEN_ENV]: mcp.token };
}
