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

/** Where an MCP tool call comes from (SDK `McpServerProvenance`). Our server, passed in options, is "dynamic". */
export type ToolProvenance = { name: string; source: string };

/**
 * Allows exactly the run's own tools of our MCP server — explicitly: without an "allow" the SDK asks for
 * permission, and with nobody to ask the call fails (#43). A call is ours only if its name is one of
 * `mcp__agentlee__<allowed>` *and* the SDK says it comes from our server as configured in the options. Names
 * alone are not proof (a connector called `agentlee__extra` produces `mcp__agentlee__extra__…`, review #80), and
 * a call without provenance is refused. Everything else (Bash, Read, account connectors, …) is denied.
 */
export function preToolUse(
  toolName: string,
  allowed: readonly string[],
  provenance?: ToolProvenance,
): PreToolUseResult {
  const ours =
    allowed.some((t) => toolName === OUR_TOOL_PREFIX + t) &&
    provenance?.name === AGENTLEE_MCP &&
    provenance.source === "dynamic";
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
export function claudeLockdown(o: {
  cwd: string;
  env: Record<string, string>;
  mcp?: McpConnection | undefined;
  /** The run's tools of our MCP server, without prefix (StartContext.tools). Nothing else is ever allowed. */
  tools: readonly string[];
  /**
   * Called when an MCP tool call is refused — a server other than ours is attached (account connectors can join
   * after init, review #80). The adapter stops the turn then (fail closed).
   */
  onForeignTool?: () => void;
}) {
  const allowed = o.mcp ? [...o.tools] : [];
  if (o.mcp) mcpLoopbackPort(o.mcp);
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
    mcpServers: o.mcp
      ? {
          [AGENTLEE_MCP]: {
            type: "http" as const,
            url: o.mcp.url,
            headers: { Authorization: `Bearer ${o.mcp.token}` },
          },
        }
      : {},
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input: { tool_name: string; mcp_server?: ToolProvenance }) => {
              const r = preToolUse(input.tool_name, allowed, input.mcp_server);
              if (
                r.hookSpecificOutput.permissionDecision === "deny" &&
                (input.tool_name.startsWith("mcp__") || input.mcp_server)
              )
                o.onForeignTool?.();
              return r;
            },
          ],
        },
      ],
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

/**
 * Features of `codex app-server` (0.165.0) that reach outside our tools, or start processes, or talk to more than
 * the model API. All off. `code_mode_host` is off too: with our model catalog (`codexModelCatalog`, tool mode
 * "direct") MCP tools are plain function tools, and the code-mode host would be a child process (#16 — the
 * sandbox forbids fork). Every name is checked by the real binary (`--strict-config`) in the macOS tests.
 */
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot", // runs the user's shell once to snapshot its environment (a child process; keeps env on disk)
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "in_app_chat",
  "in_app_local_automation",
  "memories",
  "web_search_request",
  "code_mode_host",
  "multi_agent", // sub-agents (`collaboration.*`); the catalog also sets multi_agent_version = "disabled"
  "multi_agent_v2",
  "sleep_tool",
  "goals",
  "view_image",
  "image_generation",
  "tool_suggest",
  "hooks",
  "skill_mcp_dependency_install",
  "skill_search",
  "workspace_dependencies",
  "mentions_v2",
  "tool_call_mcp_elicitation",
  "guardian_approval",
  "daemon_auto_start",
  "api_key_model_discovery", // would fetch the model list from the API instead of our catalog
  "system_proxy_fallback", // reads the macOS system proxy settings; the only way out is our egress proxy
  "unbounded_connection_retries",
] as const;

/** Bare names of the built-in tools codex still offers with the settings below (MCP resource helpers). */
export const CODEX_BUILTIN_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

const toml = (v: string) => JSON.stringify(v); // TOML basic strings use the same escapes as JSON

/**
 * `config.toml` for a connection's own CODEX_HOME (never the user's ~/.codex): features off, no MCP server, tool
 * calls auto-approved (nobody is there to approve), no instructions from files (AGENTS.md, skills), no environment
 * details in the prompt, credentials in memory only (`ephemeral`: the API key is passed over stdin with
 * `account/login/start`, never written). The read-only sandbox is set but not relied on — it does not prevent
 * reads; the OS sandbox does. The same for every session of the connection (sessions of one user can run at
 * once): what belongs to one run — model, our MCP server, its tools — goes on that process's command line
 * (`codexRunConfig`).
 *
 * `provider` replaces the OpenAI API with another Responses endpoint — tests only (a local fake API).
 */
export function codexConfigToml(o: {
  /** Absolute path of the model catalog file (`codexModelCatalog`). Left out only by the login process. */
  catalogPath?: string | undefined;
  provider?: { baseUrl: string } | undefined;
  /**
   * Where a login keeps its credentials. Always `ephemeral` (memory) for runs. Only the short-lived device-code
   * login process (#18, codex-login.ts) uses `file`: the server reads the tokens it wrote at once, stores them
   * encrypted and removes the whole login folder — app-server offers no other way to hand them over.
   */
  credentialsStore?: "ephemeral" | "file";
}): string {
  const lines = [
    ...(o.catalogPath ? [`model_catalog_json = ${toml(o.catalogPath)}`] : []),
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    `cli_auth_credentials_store = "${o.credentialsStore ?? "ephemeral"}"`,
    `web_search = "disabled"`,
    `include_permissions_instructions = false`,
    `include_apps_instructions = false`,
    `include_collaboration_mode_instructions = false`,
    `include_environment_context = false`,
    `project_doc_max_bytes = 0`,
    `check_for_update_on_startup = false`,
    ...(o.provider ? [`model_provider = "agentlee-test"`] : []),
    "",
    "[history]",
    `persistence = "none"`,
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
    "[skills]",
    "include_instructions = false",
    "",
    "[skills.bundled]",
    "enabled = false",
    "",
    "[tools.experimental_request_user_input]",
    "enabled = false",
    "",
    "[features]",
    ...CODEX_DISABLED_FEATURES.map((f) => `${f} = false`),
    ...(o.provider
      ? [
          "",
          `[model_providers.agentlee-test]`,
          `name = "agentlee-test"`,
          `base_url = ${toml(o.provider.baseUrl)}`,
          `wire_api = "responses"`,
          "requires_openai_auth = false",
          "supports_websockets = false",
          "request_max_retries = 0",
          "stream_max_retries = 0",
        ]
      : []),
  ];
  return lines.join("\n") + "\n";
}

/**
 * One run's settings, as `-c key=value` overrides (TOML values) for its app-server process: the model, and our MCP
 * server — only ours, with only the run's tools (`enabled_tools`), auto-approved, required to start. The token is
 * not here: it goes in the environment (`codexMcpEnv`, `bearer_token_env_var`).
 */
export function codexRunConfig(o: {
  model: string;
  mcp?: McpConnection | undefined;
  /** The run's tools of our MCP server (StartContext.tools). */
  tools: readonly string[];
}): string[] {
  const out = [`model=${toml(o.model)}`];
  if (o.mcp) {
    mcpLoopbackPort(o.mcp);
    out.push(
      `mcp_servers.${AGENTLEE_MCP}={ url = ${toml(o.mcp.url)}, bearer_token_env_var = ${toml(CODEX_MCP_TOKEN_ENV)}, ` +
        `default_tools_approval_mode = "approve", enabled_tools = [${o.tools.map(toml).join(", ")}], required = true }`,
    );
  }
  return out;
}

/** Environment entries the codex app-server process needs for our MCP server (merge into its own env). */
export function codexMcpEnv(mcp: McpConnection): Record<string, string> {
  return { [CODEX_MCP_TOKEN_ENV]: mcp.token };
}

/**
 * Our model catalog (`model_catalog_json`), made from the catalog the pinned binary ships (`codex debug models
 * --bundled`): only the models we offer, and per model
 *  - `tool_mode: "direct"` — MCP tools are plain function tools. The shipped "code_mode_only" puts every tool
 *    behind a JavaScript `exec` tool run by a separate code-mode host process (a fork), with nested built-ins
 *    (apply_patch, view_image, …).
 *  - `multi_agent_version: "disabled"` — no sub-agent tools (`collaboration.*`); the feature flag alone does not
 *    remove them for these models.
 *  - no apply_patch, no experimental tools, no tool search.
 * Also keeps the binary from fetching a model list over the network.
 */
export function codexModelCatalog(bundled: unknown, models: readonly string[]): { models: unknown[] } {
  const list = (bundled as { models?: { slug?: unknown }[] } | null)?.models;
  if (!Array.isArray(list)) throw new Error("codex model catalog: no models");
  const picked = list
    .filter((m) => typeof m.slug === "string" && models.includes(m.slug))
    .map((m) => ({
      ...m,
      tool_mode: "direct",
      multi_agent_version: "disabled",
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
      supports_search_tool: false,
    }));
  if (picked.length !== models.length) throw new Error("codex model catalog: a model we offer is missing");
  return { models: picked };
}
