import type { FastifyInstance } from "fastify";
import type { AdminSkill } from "@agentlee/shared";
import { SKILL_SPECS } from "@agentlee/mcp-tools/skills";
import type { Config } from "../config.js";
import { storagePaths } from "../storage/paths.js";
import { loadInstalledSkills } from "./install.js";
import { pythonRuntime } from "./python.js";
import { BUNDLED_SKILLS, type McpService, type McpServiceOptions } from "./service.js";

/**
 * MCP service settings from the configuration (#21): the bundled skill, the installed allow-listed skills in
 * `<DATA_DIR>/skills`, the python for python skills, and the per-skill secrets from `.env`. Tests (NODE_ENV=test)
 * get only the bundled skill — whatever is installed in the developer's data folder never leaks into them.
 */
export function mcpOptionsFromConfig(config: Config): McpServiceOptions {
  if (config.env === "test") return {};
  const { skills, states } = loadInstalledSkills(storagePaths(config.dataDir).skills, SKILL_SPECS);
  const py = pythonRuntime(config.skillPython);
  return {
    skills: [...BUNDLED_SKILLS, ...skills],
    installed: states,
    python: py.ok ? py.runtime : undefined,
    secrets: config.skillSecrets,
  };
}

/** The PRD §7 skill list with each skill's state (FR-10.3). Per-user choices: PUT /api/admin/users/:id/skills. */
export function registerSkillRoutes(app: FastifyInstance, mcp: McpService): void {
  app.get(
    "/api/admin/skills",
    { config: { auth: "admin", noResource: "admin-only skill catalogue" } },
    async (_req, reply) =>
      reply.header("Cache-Control", "no-store").send({ skills: mcp.overview() satisfies AdminSkill[] }),
  );
}
