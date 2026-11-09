import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/install-launchd.sh");
const run = (env: Record<string, string>) =>
  spawnSync("bash", [script, "print"], { env: { ...process.env, ...env }, encoding: "utf8" });

describe("install-launchd.sh print", () => {
  it("renders a complete LaunchDaemon plist with a stable node path", () => {
    const r = run({ AGENTLEE_NODE: process.execPath, AGENTLEE_LOG_DIR: "/Library/Logs/agentlee" });
    expect(r.status, r.stderr).toBe(0);
    const xml = r.stdout;
    expect(xml).not.toMatch(/__[A-Z_]+__/);
    expect(xml).not.toContain("<!--");
    expect(xml).toContain("<string>com.agentlee.server</string>");
    expect(xml).toContain(`<string>${fs.realpathSync(process.execPath)}</string>`);
    expect(xml).toContain(`<string>${root}/apps/server/dist/index.js</string>`);
    expect(xml).toMatch(/<key>NODE_ENV<\/key>\s*<string>production<\/string>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>UserName<\/key>\s*<string>[^<]+<\/string>/);
    if (process.platform === "darwin") {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-plist-")), "p.plist");
      fs.writeFileSync(f, xml);
      expect(execFileSync("plutil", ["-lint", f], { encoding: "utf8" })).toMatch(/OK/);
    }
  });

  it("refuses a node binary that lives in a per-shell temporary path", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-")), "fnm_multishells", "1", "bin");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(dir, "node"));
    fs.chmodSync(path.join(dir, "node"), 0o755);
    const r = run({ AGENTLEE_NODE: path.join(dir, "node") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/temporary path/);
  });
});
