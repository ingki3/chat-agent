import "../env.js";
import { SKILL_SPECS } from "@agentlee/mcp-tools/skills";
import { loadConfig } from "../config.js";
import { checkInstalled, findSource, installSkill } from "../mcp/install.js";
import { pythonRuntime } from "../mcp/python.js";
import { storagePaths } from "../storage/paths.js";

/**
 * `pnpm skills:install [name…]` copies allow-listed skills (those wrapped in SKILL_SPECS) from the admin's skill
 * folders (SKILL_SOURCES, default ~/.agents/skills:~/.claude/skills) into the server's own `<DATA_DIR>/skills`
 * — only the files each definition lists. `pnpm skills:status` shows what the server would offer.
 * Restart the server afterwards. Prints names and states only (never file contents or secrets).
 */
const config = loadConfig();
const root = storagePaths(config.dataDir).skills;
const [cmd, ...names] = process.argv.slice(2);

if (cmd === "install") {
  const unknown = names.filter((n) => !SKILL_SPECS.some((s) => s.name === n));
  if (unknown.length) {
    console.error(`not allow-listed: ${unknown.join(", ")}`);
    process.exit(2);
  }
  let failed = 0;
  for (const spec of SKILL_SPECS.filter((s) => !names.length || names.includes(s.name))) {
    const src = findSource(spec.name, config.skillSources);
    if (!src) {
      console.error(`${spec.name}: not found in ${config.skillSources.join(":")}`);
      failed++;
      continue;
    }
    try {
      const m = installSkill(spec, src, root);
      console.log(`${spec.name}: installed ${Object.keys(m.files).length} file(s) from ${src}`);
    } catch (e) {
      console.error(`${spec.name}: refused — ${(e as Error).message}`);
      failed++;
    }
  }
  process.exit(failed ? 1 : 0);
} else if (cmd === "status") {
  const py = pythonRuntime(config.skillPython);
  console.log(`skill folder: ${root}`);
  console.log(`python: ${py.ok ? py.runtime.exe : `not usable (${py.reason})`}`);
  for (const spec of SKILL_SPECS) console.log(`${spec.name}: ${checkInstalled(spec, root).state}`);
  console.log(`secrets set: ${Object.keys(config.skillSecrets).join(", ") || "none"}`);
} else {
  console.error("usage: skills install [name…] | skills status");
  process.exit(2);
}
