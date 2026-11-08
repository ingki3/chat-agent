// Minimal stdio MCP server for the spike: one tool `echo_time`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "agentlee-echo", version: "0.0.1" });
server.registerTool("echo_time", { description: "Returns the server time and echoes a tag.", inputSchema: { tag: z.string() } },
  async ({ tag }) => ({ content: [{ type: "text", text: `ECHO_OK tag=${tag} time=${new Date().toISOString()} token=${process.env.AGENTLEE_RUN_TOKEN ?? "none"}` }] }));
await server.connect(new StdioServerTransport());
