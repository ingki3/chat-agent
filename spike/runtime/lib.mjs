import fs from "node:fs";
export function cleanEnv(extra = {}) {
  // Minimal env: never inherit the parent Claude Code session vars or secrets.
  const keep = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}
export function save(name, data) {
  fs.writeFileSync(new URL(`./results/${name}.json`, import.meta.url), JSON.stringify(data, null, 2));
  console.log(`== ${name}:`, JSON.stringify(data).slice(0, 600));
}
export const ECHO = new URL("./echo-mcp.mjs", import.meta.url).pathname;
