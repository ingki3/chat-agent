/**
 * Built-in tool lockdown for both runtimes — the first line of defence (#42, spike #39). Process isolation
 * (isolation/sandbox.ts) is the second. The adapters (#15, #16) pass these settings unchanged.
 */

export const AGENTLEE_MCP = "agentlee";
/** Prefix of tool names coming from our MCP server, as the Claude Agent SDK names them. */
export const OUR_TOOL_PREFIX = `mcp__${AGENTLEE_MCP}__`;

export type McpServerSpec = { command: string; args: string[]; env: Record<string, string> };

export type PreToolUseResult =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
      };
    };

/** Allows our MCP tools only. Everything else (Bash, Read, account connectors, …) is denied. */
export function preToolUse(toolName: string): PreToolUseResult {
  return toolName.startsWith(OUR_TOOL_PREFIX)
    ? {}
    : {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Agent Lee: only Agent Lee tools are allowed",
        },
      };
}

/**
 * Claude Agent SDK options. Not relied on: `canUseTool` (not called for read-only commands) and `allowedTools`
 * (auto-approves). Relied on: no built-in tools, no user/project settings, only our MCP server, the hook above.
 */
export function claudeLockdown(o: { cwd: string; env: Record<string, string>; mcp: McpServerSpec }) {
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
    mcpServers: { [AGENTLEE_MCP]: { type: "stdio" as const, ...o.mcp } },
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
 * tool calls auto-approved for our server (the user never sees a Codex approval prompt).
 * The read-only sandbox is set but not relied on — it does not prevent reads.
 */
export function codexConfigToml(o: { model: string; mcp: McpServerSpec }): string {
  const lines = [
    `model = ${toml(o.model)}`,
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    "",
    "[features]",
    ...CODEX_DISABLED_FEATURES.map((f) => `${f} = false`),
    "",
    `[mcp_servers.${AGENTLEE_MCP}]`,
    `command = ${toml(o.mcp.command)}`,
    `args = [${o.mcp.args.map(toml).join(", ")}]`,
    `default_tools_approval_mode = "approve"`,
    "",
    `[mcp_servers.${AGENTLEE_MCP}.env]`,
    ...Object.entries(o.mcp.env).map(([k, v]) => `${/^[A-Za-z0-9_]+$/.test(k) ? k : toml(k)} = ${toml(v)}`),
  ];
  return lines.join("\n") + "\n";
}
