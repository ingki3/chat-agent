// Helper for scripts/install-launchd.sh (plain JS so it runs without a build step or tsx).
//   node scripts/launchd-helper.mjs render   — template from stdin-less file, values from AL_* env, XML-escaped
//   node scripts/launchd-helper.mjs check    — loads config and the master key exactly as the server does
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xml = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const cmd = process.argv[2];
if (cmd === "render") {
  const values = {
    USER: process.env.AL_USER,
    HOME: process.env.AL_HOME,
    REPO: repo,
    NODE: process.env.AL_NODE,
    NODE_DIR: process.env.AL_NODE ? path.dirname(process.env.AL_NODE) : undefined,
    LOGDIR: process.env.AL_LOGDIR,
  };
  for (const [k, v] of Object.entries(values)) if (!v) throw new Error(`missing value for __${k}__`);
  const template = fs.readFileSync(path.join(repo, "ops/launchd/com.agentlee.server.plist"), "utf8");
  const out = template.replace(/<!--[\s\S]*?-->\n/g, "").replace(/__([A-Z_]+)__/g, (m, k) => {
    if (!(k in values)) throw new Error(`unknown placeholder ${m}`);
    return xml(values[k]);
  });
  process.stdout.write(out);
} else if (cmd === "check") {
  await import(path.join(repo, "apps/server/dist/env.js"));
  const { loadConfig } = await import(path.join(repo, "apps/server/dist/config.js"));
  const { loadMasterKey } = await import(path.join(repo, "apps/server/dist/crypto/secrets.js"));
  try {
    const config = loadConfig();
    loadMasterKey(config.masterKeyPath); // throws on missing/short key, wrong mode, symlink, unsafe parent
    console.log(`ok — master key readable at ${config.masterKeyPath}`);
  } catch (e) {
    // Messages name paths and rules only, never key material.
    console.error(`check failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else {
  console.error("usage: launchd-helper.mjs render|check");
  process.exit(2);
}
