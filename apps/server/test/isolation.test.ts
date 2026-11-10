import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openInside, PathDeniedError, resolveInside } from "../src/isolation/paths.js";
import { BlockedRequestError, isBlockedAddress, safeFetch } from "../src/isolation/net.js";
import {
  allowEnv,
  buildProfile,
  HardLinkError,
  runIsolated,
  SandboxUnavailableError,
} from "../src/isolation/sandbox.js";
import { McpTokens } from "../src/isolation/tokens.js";
import {
  assertOnlyOurMcp,
  claudeLockdown,
  CODEX_DISABLED_FEATURES,
  codexConfigToml,
  preToolUse,
} from "../src/runtime/lockdown.js";

/** A family data layout: data/files/<user>/…, with a symlink planted in son's folder pointing at mom's file. */
function familyTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-iso-")));
  const son = path.join(root, "files", "son");
  const mom = path.join(root, "files", "mom");
  const home = path.join(root, "home");
  for (const d of [son, mom, path.join(home, ".claude"), path.join(home, ".codex")])
    fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(son, "homework.txt"), "son's homework");
  fs.writeFileSync(path.join(mom, "diary.txt"), "MOM-SECRET");
  fs.writeFileSync(path.join(home, ".claude", "credentials"), "CLAUDE-TOKEN");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "CODEX-TOKEN");
  fs.symlinkSync(path.join(mom, "diary.txt"), path.join(son, "link-to-mom.txt"));
  fs.symlinkSync(mom, path.join(son, "mom-dir"));
  return { root, son, mom, home };
}

describe("path checks", () => {
  const t = familyTree();
  it("allows paths inside the roots", () => {
    expect(resolveInside("homework.txt", [t.son])).toBe(path.join(t.son, "homework.txt"));
    expect(resolveInside(path.join(t.son, "new", "file.txt"), [t.son])).toBe(
      path.join(t.son, "new", "file.txt"),
    );
    // A symlink that stays inside resolves to its real target, so callers open the checked file itself.
    fs.symlinkSync(path.join(t.son, "homework.txt"), path.join(t.son, "hw-link.txt"));
    expect(resolveInside("hw-link.txt", [t.son])).toBe(path.join(t.son, "homework.txt"));
  });
  it("refuses absolute paths, .., symlinks and NUL that leave the roots", () => {
    for (const p of [
      path.join(t.mom, "diary.txt"),
      "../mom/diary.txt",
      "sub/../../mom/diary.txt",
      "link-to-mom.txt",
      "mom-dir/diary.txt",
      path.join(t.home, ".claude", "credentials"),
      "/etc/passwd",
      "homework.txt\0../../mom",
    ])
      expect(() => resolveInside(p, [t.son]), p).toThrow(PathDeniedError);
    expect(() => resolveInside("x", [])).toThrow(PathDeniedError);
  });
});

const darwin = process.platform === "darwin";

describe.skipIf(process.platform !== "darwin")("safe open", () => {
  it("refuses to follow a parent folder swapped for a symlink after the check", async () => {
    const t = familyTree();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-other-")));
    fs.mkdirSync(path.join(t.son, "sub"));
    fs.writeFileSync(path.join(t.son, "sub", "f.txt"), "mine");
    fs.writeFileSync(path.join(other, "f.txt"), "OTHER-SECRET");
    await expect(
      openInside("sub/f.txt", [t.son], "r", () => {
        fs.renameSync(path.join(t.son, "sub"), path.join(t.son, "sub.old"));
        fs.symlinkSync(other, path.join(t.son, "sub"));
      }),
    ).rejects.toBeInstanceOf(PathDeniedError);
  });
});

describe("hard links", () => {
  it("refuses a hard link to another family member's file, for checks, reads and writes", async () => {
    const t = familyTree();
    fs.linkSync(path.join(t.mom, "diary.txt"), path.join(t.son, "hard.txt"));
    expect(() => resolveInside("hard.txt", [t.son])).toThrow(PathDeniedError);
    await expect(openInside("hard.txt", [t.son])).rejects.toBeInstanceOf(PathDeniedError);
    await expect(openInside("hard.txt", [t.son], "w")).rejects.toBeInstanceOf(PathDeniedError);
    expect(fs.readFileSync(path.join(t.mom, "diary.txt"), "utf8")).toBe("MOM-SECRET");
    // Ordinary files open fine.
    const fh = await openInside("homework.txt", [t.son]);
    expect((await fh.readFile("utf8")).toString()).toBe("son's homework");
    await fh.close();
  });
});

describe.skipIf(!darwin)("process sandbox (macOS sandbox-exec)", () => {
  const t = familyTree();
  const cat = (file: string, extra: Partial<Parameters<typeof runIsolated>[0]> = {}) =>
    runIsolated({
      command: "/bin/cat",
      args: [file],
      cwd: t.son,
      env: {},
      read: [t.son],
      write: [],
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
      ...extra,
    });

  it("reads inside its own folder", async () => {
    const r = await cat(path.join(t.son, "homework.txt"));
    expect(r.stdout).toBe("son's homework");
  });

  it("cannot read another family member's files — by absolute path or through a symlink", async () => {
    for (const f of [
      path.join(t.mom, "diary.txt"),
      path.join(t.son, "link-to-mom.txt"),
      path.join(t.son, "mom-dir", "diary.txt"),
    ]) {
      const r = await cat(f);
      expect(r.code, f).not.toBe(0);
      expect(r.stdout, f).not.toContain("MOM-SECRET");
      expect(r.stderr, f).toMatch(/not permitted/);
    }
  });

  it("cannot read runtime credentials (~/.claude, ~/.codex) — the test home and the real one", async () => {
    const targets = [path.join(t.home, ".claude", "credentials"), path.join(t.home, ".codex", "auth.json")];
    for (const real of [
      path.join(os.homedir(), ".claude.json"),
      path.join(os.homedir(), ".codex", "auth.json"),
    ])
      if (fs.existsSync(real)) targets.push(real);
    for (const f of targets) {
      const r = await cat(f);
      expect(r.code, f).not.toBe(0);
      expect(r.stdout, f).toBe("");
    }
  });

  it("cannot run any program it was not given", async () => {
    const r = await runIsolated({
      command: "/bin/bash",
      args: ["-c", "/bin/ls / && /usr/bin/id"],
      cwd: t.son,
      env: {},
      read: [t.son],
      write: [],
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/not permitted/);
  });

  it("writes only where allowed", async () => {
    const sh = (script: string) =>
      runIsolated({
        command: "/bin/bash",
        args: ["-c", script],
        cwd: t.son,
        env: {},
        read: [t.son],
        write: [path.join(t.son, "out")],
        timeoutMs: 5000,
        maxOutputBytes: 10_000,
      });
    fs.mkdirSync(path.join(t.son, "out"), { recursive: true });
    expect((await sh(`echo ok > ${path.join(t.son, "out", "a.txt")}`)).code).toBe(0);
    expect(fs.readFileSync(path.join(t.son, "out", "a.txt"), "utf8")).toBe("ok\n");
    expect((await sh(`echo bad > ${path.join(t.son, "x.txt")}`)).code).not.toBe(0);
    expect((await sh(`echo bad > ${path.join(t.mom, "x.txt")}`)).code).not.toBe(0);
    expect(fs.existsSync(path.join(t.mom, "x.txt"))).toBe(false);
  });

  it("passes only the environment it is given", async () => {
    process.env.AGENTLEE_TEST_SECRET = "PARENT-SECRET";
    const r = await runIsolated({
      command: "/usr/bin/env",
      args: [],
      cwd: t.son,
      env: allowEnv(["LANG"], { ONLY_THIS: "1" }),
      read: [],
      write: [],
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
    });
    delete process.env.AGENTLEE_TEST_SECRET;
    expect(r.stdout).toMatch(/ONLY_THIS=1/);
    expect(r.stdout).not.toMatch(/PARENT-SECRET|AGENTLEE_TEST_SECRET|HOME=/);
  });

  it("enforces time and output limits (killing the whole process group)", async () => {
    const slow = await runIsolated({
      command: "/bin/sleep",
      args: ["30"],
      cwd: t.son,
      env: {},
      read: [],
      write: [],
      timeoutMs: 200,
      maxOutputBytes: 1000,
    });
    expect(slow.killed).toBe("timeout");
    const loud = await runIsolated({
      command: "/usr/bin/yes",
      args: [],
      cwd: t.son,
      env: {},
      read: [],
      write: [],
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
    });
    expect(loud.killed).toBe("output");
    expect(loud.stdout.length).toBeLessThanOrEqual(10_000);
  });

  describe("network", () => {
    let server: http.Server;
    let port = 0;
    beforeAll(async () => {
      server = http.createServer((_q, s) => s.end("hello"));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    // node (what the runtimes' MCP clients are): curl needs proxy auto-configuration services to start at all.
    const node = fs.realpathSync(process.execPath);
    const nodeHome = path.dirname(path.dirname(node));
    const curl = (network: Parameters<typeof runIsolated>[0]["network"]) =>
      runIsolated({
        command: node,
        args: [
          "-e",
          `fetch("http://127.0.0.1:${port}/").then(r => r.text()).then(t => process.stdout.write(t), e => process.stdout.write("ERR " + (e.cause?.code ?? e.message)))`,
        ],
        cwd: t.son,
        env: {},
        read: [],
        trusted: [nodeHome],
        write: [],
        network,
        timeoutMs: 6000,
        maxOutputBytes: 10_000,
      });
    it("has no network by default", async () => {
      const r = await curl(undefined);
      expect(r.stdout).toMatch(/^ERR/);
    });
    it("can be allowed one loopback port (our MCP server) and nothing else", async () => {
      expect((await curl({ loopbackPorts: [port] })).stdout).toBe("hello");
      expect((await curl({ loopbackPorts: [port + 1] })).stdout).toMatch(/^ERR/);
    });
  });

  it("cannot create a hard link to a file outside its folders", async () => {
    const r = await runIsolated({
      command: "/bin/ln",
      args: [path.join(t.mom, "diary.txt"), path.join(t.son, "out", "steal.txt")],
      cwd: t.son,
      env: {},
      read: [t.son],
      write: [path.join(t.son, "out")],
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
    });
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(t.son, "out", "steal.txt"))).toBe(false);
  });

  it("cannot start child processes at all (so nothing can outlive it or escape its limits)", async () => {
    const node = fs.realpathSync(process.execPath);
    const nodeHome = path.dirname(path.dirname(node));
    const script = `try{const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});c.on("error",e=>{process.stdout.write("ERR "+e.code);process.exit(0)});c.on("spawn",()=>{process.stdout.write("SPAWNED "+c.pid);process.exit(0)})}catch(e){process.stdout.write("ERR "+e.code)}`;
    const r = await runIsolated({
      command: node,
      args: ["-e", script],
      cwd: t.son,
      env: {},
      read: [],
      trusted: [nodeHome],
      write: [],
      timeoutMs: 8000,
      maxOutputBytes: 10_000,
    });
    expect(r.stdout).toMatch(/^ERR/);
    expect(r.stdout).not.toMatch(/SPAWNED/);
  });

  it("refuses to run while an allowed folder holds a hard-linked file", async () => {
    const t2 = familyTree();
    fs.linkSync(path.join(t2.mom, "diary.txt"), path.join(t2.son, "hard.txt"));
    await expect(
      runIsolated({
        command: "/bin/cat",
        args: [path.join(t2.son, "hard.txt")],
        cwd: t2.son,
        env: {},
        read: [t2.son],
        write: [],
        timeoutMs: 5000,
        maxOutputBytes: 1000,
      }),
    ).rejects.toBeInstanceOf(HardLinkError);
  });

  it("a child that exits before reading its input does not crash the server", async () => {
    const r = await runIsolated({
      command: "/usr/bin/true",
      args: [],
      cwd: t.son,
      env: {},
      read: [],
      write: [],
      timeoutMs: 5000,
      maxOutputBytes: 1000,
      stdin: "x".repeat(4 * 1024 * 1024),
    });
    expect(r.code).toBe(0);
  });

  it("stops the process when its memory cannot be measured", async () => {
    const r = await runIsolated({
      command: "/bin/sleep",
      args: ["5"],
      cwd: t.son,
      env: {},
      read: [],
      write: [],
      timeoutMs: 8000,
      maxOutputBytes: 1000,
      maxRssBytes: 1024 * 1024 * 1024,
      probe: () => Promise.reject(new Error("ps failed")),
    });
    expect(r.killed).toBe("monitor");
  });

  it("escapes paths in the profile", () => {
    const dir = fs.realpathSync(os.tmpdir());
    const p = buildProfile({ command: "/bin/cat", read: [path.join(dir, 'a"b\\c')], write: [] });
    expect(p).toContain(`(subpath "${dir}/a\\"b\\\\c")`);
    expect(p).toMatch(/^\(version 1\)\n\(deny default\)/);
    expect(() =>
      buildProfile({ command: "/bin/cat", read: [], write: [], network: { loopbackPorts: [0] } }),
    ).toThrow();
  });
});

describe.skipIf(darwin)("process sandbox elsewhere", () => {
  it("fails closed when sandbox-exec is not available", async () => {
    await expect(
      runIsolated({
        command: "/bin/true",
        args: [],
        cwd: "/",
        env: {},
        read: [],
        write: [],
        timeoutMs: 100,
        maxOutputBytes: 1,
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});

describe("network policy", () => {
  it("classifies addresses", () => {
    const blocked = [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a9fe:a9fe",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "not-an-ip",
    ];
    for (const ip of blocked) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });

  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((q, s) => {
      if (q.url === "/to-private")
        s.writeHead(302, { location: `http://internal.test:${port}/secret` }).end();
      else s.end("internal");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses loopback, private and metadata addresses — literal or resolved by DNS", async () => {
    for (const url of [
      `http://127.0.0.1:${port}/`,
      "http://10.1.2.3/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ])
      await expect(safeFetch(url, { timeoutMs: 1000 }), url).rejects.toBeInstanceOf(BlockedRequestError);
    // A public-looking name that resolves to a private address (DNS rebinding) is refused at connect time.
    await expect(
      safeFetch(`http://rebind.test:${port}/`, { resolve: async () => ["127.0.0.1"] }),
    ).rejects.toBeInstanceOf(BlockedRequestError);
    await expect(
      safeFetch("http://mixed.test/", { resolve: async () => ["8.8.8.8", "10.0.0.1"] }),
    ).rejects.toBeInstanceOf(BlockedRequestError);
  });

  it("re-checks every redirect hop", async () => {
    // First hop allowed (test override for one host), then a redirect to a name that resolves to loopback.
    const res = safeFetch(`http://public.test:${port}/to-private`, {
      resolve: async () => ["127.0.0.1"],
      allow: (address, host) => host === "public.test" && address === "127.0.0.1",
    });
    await expect(res).rejects.toBeInstanceOf(BlockedRequestError);
  });

  it("ignores proxy settings from the environment (the policy must see the real address)", async () => {
    let proxied = 0;
    const proxy = http.createServer((_q, r) => {
      proxied++;
      r.end("via proxy");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const saved = { ...process.env };
    process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
    process.env.NODE_USE_ENV_PROXY = "1";
    try {
      await expect(
        safeFetch("http://rebind.test/", { resolve: async () => ["10.0.0.1"] }),
      ).rejects.toBeInstanceOf(BlockedRequestError);
      expect(proxied).toBe(0);
    } finally {
      process.env = saved;
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });

  it("refuses other schemes and credentials in the URL", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "gopher://x/",
      "http://user:pw@example.com/",
    ])
      await expect(safeFetch(url), url).rejects.toBeInstanceOf(BlockedRequestError);
  });
});

describe("MCP call tokens", () => {
  it("are scoped to one user, conversation and run, and die with the run", () => {
    let t = 0;
    const tokens = new McpTokens(() => t);
    const a = tokens.issue({ userId: "son", conversationId: "c1", runId: "r1" }, 1000);
    const scope = tokens.verify(a)!;
    expect(scope).toMatchObject({ userId: "son", conversationId: "c1", runId: "r1" });
    expect(tokens.allows(scope, { userId: "son", conversationId: "c1" })).toBe(true);
    expect(tokens.allows(scope, { userId: "son", conversationId: "c2" })).toBe(false);
    expect(tokens.allows(scope, { userId: "mom", conversationId: "c1" })).toBe(false);
    for (const bad of [undefined, "", "x", "A".repeat(43)]) expect(tokens.verify(bad)).toBeUndefined();
    tokens.revokeRun("r1");
    expect(tokens.verify(a)).toBeUndefined();
    const b = tokens.issue({ userId: "son", conversationId: "c1", runId: "r2" }, 1000);
    t = 1001;
    expect(tokens.verify(b)).toBeUndefined();
  });
});

describe("runtime lockdown settings", () => {
  const mcp = { command: "/usr/local/bin/node", args: ["/srv/mcp.js"], env: { AGENTLEE_MCP_TOKEN: "t" } };

  it("Claude: no built-in tools, no user settings, only our MCP, and a hook that denies anything else", async () => {
    const o = claudeLockdown({ cwd: "/srv/work", env: { PATH: "/usr/bin" }, mcp });
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers)).toEqual(["agentlee"]);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "WebFetch"]));
    const hook = o.hooks.PreToolUse[0]!.hooks[0]!;
    for (const name of [
      "Bash",
      "Read",
      "mcp__claude_ai_Google_Drive__read_file_content",
      "mcp__agentleeX__t",
      "mcp__evil__agentlee",
    ])
      expect(await hook({ tool_name: name }), name).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    expect(await hook({ tool_name: "mcp__agentlee__echo_time" })).toEqual({});
    expect(preToolUse("mcp__agentlee__cite")).toEqual({});
  });

  it("Claude: a session with any other MCP server is refused", () => {
    expect(() => assertOnlyOurMcp([{ name: "agentlee" }])).not.toThrow();
    expect(() => assertOnlyOurMcp([{ name: "agentlee" }, { name: "claude.ai Google Drive" }])).toThrow(
      /Google Drive/,
    );
  });

  it("Codex: own config with features off and only our MCP server", () => {
    const tomlText = codexConfigToml({
      model: "gpt-6.1-sol",
      mcp: { ...mcp, env: { AGENTLEE_MCP_TOKEN: 'a"b' } },
    });
    for (const f of CODEX_DISABLED_FEATURES) expect(tomlText).toContain(`${f} = false`);
    expect(tomlText.match(/^\[mcp_servers\.[^.\]]+\]$/gm)).toEqual(["[mcp_servers.agentlee]"]);
    expect(tomlText).toContain('approval_policy = "never"');
    expect(tomlText).toContain('AGENTLEE_MCP_TOKEN = "a\\"b"');
  });
});
