import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/install-launchd.sh");
const run = (env: Record<string, string>, cmd = "print") =>
  spawnSync("bash", [script, cmd], {
    env: { ...process.env, AGENTLEE_NODE: process.execPath, ...env },
    encoding: "utf8",
  });

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

  it("has the app write and rotate server.log itself (LOG_FILE), stdout only as a fallback", () => {
    const xml = run({ AGENTLEE_LOG_DIR: "/Library/Logs/agentlee" }).stdout;
    expect(xml).toMatch(/<key>LOG_FILE<\/key>\s*<string>\/Library\/Logs\/agentlee\/server.log<\/string>/);
    expect(xml).toMatch(
      /<key>StandardOutPath<\/key>\s*<string>\/Library\/Logs\/agentlee\/server.out.log<\/string>/,
    );
  });

  it("renders the 5-minute uptime check daemon", () => {
    const r = run({ AGENTLEE_LOG_DIR: "/Library/Logs/agentlee" }, "print-uptime");
    expect(r.status, r.stderr).toBe(0);
    const xml = r.stdout;
    expect(xml).not.toMatch(/__[A-Z_]+__/);
    expect(xml).toContain("<string>com.agentlee.uptime</string>");
    expect(xml).toMatch(/<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
    expect(xml).toContain(`<string>${root}/node_modules/tsx/dist/cli.mjs</string>`);
    expect(xml).toContain(`<string>${root}/scripts/uptime.ts</string>`);
    expect(xml).toContain("<string>/Library/Logs/agentlee/uptime.jsonl</string>");
    expect(xml).toMatch(/<string>[^<]+\/\.agentlee\/uptime-token<\/string>/);
    if (process.platform === "darwin") {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-plist-")), "u.plist");
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

  it("treats the user name as data, never as shell code, and refuses root", () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-")), "pwned");
    const r = run({ AGENTLEE_USER: `$(touch ${marker})` });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/invalid user name/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(run({ AGENTLEE_USER: "no-such-user-agentlee" }).stderr).toMatch(/no such user/);
    expect(run({ AGENTLEE_USER: "root" }).stderr).toMatch(/refusing to run the service as root/);
  });

  it("XML-escapes values and rejects relative log directories", () => {
    const r = run({ AGENTLEE_LOG_DIR: "/tmp/a<b&c#d" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("<string>/tmp/a&lt;b&amp;c#d/server.log</string>");
    if (process.platform === "darwin") {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-plist-")), "p.plist");
      fs.writeFileSync(f, r.stdout);
      expect(execFileSync("plutil", ["-lint", f], { encoding: "utf8" })).toMatch(/OK/);
    }
    expect(run({ AGENTLEE_LOG_DIR: "logs" }).stderr).toMatch(/absolute path/);
  });
});
