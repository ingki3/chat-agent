import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/release.sh (#143) end to end against a tiny fixture app: a temporary AGENTLEE_HOME, a local bare repository
 * as the source, a free port and no launchd (AGENTLEE_LAUNCHD_PLIST points nowhere). The fixture stands in for the
 * real app's entry points the script calls — `apps/server/dist/index.js` (a small HTTP server), the release CLI
 * (`dist/cli/release.js`: config / backup / migrate-data) and `scripts/launchd-helper.mjs check` — so every install,
 * switch, restart, verification and rollback path of the script itself runs for real in a few seconds. The real
 * helpers behind those entry points are tested in apps/server/test/release.test.ts; the whole thing with the real
 * app is in the PR's test evidence (docs/ops.md §43.6).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/release.sh");
const SECRET = "synthetic-gate-code-143-do-not-print";
const GIT_ENV = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

/**
 * The temporary HOME must not make corepack (when pnpm comes from it) fetch pnpm again: keep its cache where it is.
 * Only corepack's own cache — no credentials live there.
 */
const COREPACK = {
  COREPACK_HOME: process.env.COREPACK_HOME ?? path.join(os.homedir(), ".cache", "node", "corepack"),
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "release-fixture",
    private: true,
    packageManager: (
      JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { packageManager: string }
    ).packageManager,
    scripts: { build: "node build.mjs" },
  }),
  ".gitignore": "node_modules\ndist\n",
  "mode.txt": "ok\n",
  "version.txt": "v1\n",
  "apps/server/drizzle/meta/_journal.json": JSON.stringify({ entries: [{ tag: "0000_init" }] }),
  "build.mjs": `
import fs from "node:fs"; import crypto from "node:crypto";
const v = fs.readFileSync("version.txt", "utf8").trim();
const h = crypto.createHash("sha256").update(v).digest("hex").slice(0, 8);
fs.mkdirSync("apps/server/dist/cli", { recursive: true });
fs.mkdirSync("apps/web/dist/assets", { recursive: true });
fs.copyFileSync("src/server.mjs", "apps/server/dist/index.js");
fs.copyFileSync("src/cli.mjs", "apps/server/dist/cli/release.js");
fs.writeFileSync("apps/server/package.json", '{"type":"module"}');
fs.writeFileSync("apps/web/dist/assets/app-" + h + ".js", "console.log(" + JSON.stringify(v) + ");");
fs.writeFileSync("apps/web/dist/assets/app-" + h + ".css", "body{}");
fs.writeFileSync("apps/web/dist/index.html", '<!doctype html><html><head><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/assets/app-' + h + '.css"><script type="module" src="/assets/app-' + h + '.js"></script></head><body>' + v + '</body></html>');
`,
  // Reads .env the way the app does: from the real release root (node resolves the main module through `current`).
  "src/env.mjs": `
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
export const repo = (up) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), up);
export function env(rootDir) {
  const out = {};
  for (const l of fs.readFileSync(path.join(rootDir, ".env"), "utf8").split("\\n")) { const i = l.indexOf("="); if (i > 0) out[l.slice(0, i)] = l.slice(i + 1); }
  return out;
}
`,
  "src/server.mjs": `
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { fileURLToPath } from "node:url";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const e = {}; for (const l of fs.readFileSync(path.join(rootDir, ".env"), "utf8").split("\\n")) { const i = l.indexOf("="); if (i > 0) e[l.slice(0, i)] = l.slice(i + 1); }
const mode = fs.readFileSync(path.join(rootDir, "mode.txt"), "utf8").trim();
const web = path.join(rootDir, "apps/web/dist");
// "Migrations": the database keeps the highest journal length any release started on it (like drizzle's table).
const tags = JSON.parse(fs.readFileSync(path.join(rootDir, "apps/server/drizzle/meta/_journal.json"), "utf8")).entries.length;
const schemaFile = path.join(e.DATA_DIR, "schema.txt");
const had = fs.existsSync(schemaFile) ? Number(fs.readFileSync(schemaFile, "utf8")) : 0;
fs.writeFileSync(schemaFile, String(Math.max(had, tags)));
http.createServer((req, res) => {
  if (req.url === "/api/health") {
    if (mode === "health-fail" || fs.existsSync(path.join(e.DATA_DIR, "fail-health"))) { res.writeHead(503); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ status: "ok", root: rootDir }));
  }
  const f = req.url.startsWith("/assets/") ? path.join(web, req.url) : path.join(web, "index.html");
  if (mode === "html-assets" || !fs.existsSync(f) || f.endsWith("index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(web, "index.html")));
  }
  res.writeHead(200, { "content-type": f.endsWith(".css") ? "text/css" : "text/javascript" }); res.end(fs.readFileSync(f));
}).listen(Number(e.PORT), e.HOST || "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`,
  "src/cli.mjs": `
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const e = {}; for (const l of fs.readFileSync(path.join(rootDir, ".env"), "utf8").split("\\n")) { const i = l.indexOf("="); if (i > 0) e[l.slice(0, i)] = l.slice(i + 1); }
if (process.env.NODE_ENV !== "production") { console.error("not production"); process.exit(1); }
const [cmd, , from] = process.argv.slice(2);
const db = path.join(e.DATA_DIR, "agentlee.db");
if (cmd === "config") {
  console.log(["host=127.0.0.1", "port=" + e.PORT, "data_dir=" + e.DATA_DIR, "backup_dir=" + e.BACKUP_DIR, "database=" + (fs.existsSync(db) ? "present" : "absent"), "worker_run_user=unset", "python_run=off"].join("\\n"));
} else if (cmd === "backup") {
  const id = "20261115-000000Z-" + crypto.randomBytes(3).toString("hex");
  fs.mkdirSync(path.join(e.BACKUP_DIR, id), { recursive: true });
  fs.copyFileSync(db, path.join(e.BACKUP_DIR, id, "agentlee.db"));
  const sf = path.join(e.DATA_DIR, "schema.txt");
  fs.writeFileSync(path.join(e.BACKUP_DIR, id, "schema.txt"), fs.existsSync(sf) ? fs.readFileSync(sf) : "0");
  console.log("backup_id=" + id + "\\npending_migrations=0\\nintegrity=ok");
} else if (cmd === "check-backup") {
  const id = process.argv[3];
  const sf = path.join(e.BACKUP_DIR, id, "schema.txt");
  if (!fs.existsSync(sf)) { console.error("release: backup_not_found"); process.exit(1); }
  const own = JSON.parse(fs.readFileSync(path.join(rootDir, "apps/server/drizzle/meta/_journal.json"), "utf8")).entries.length;
  if (Number(fs.readFileSync(sf, "utf8")) > own) { console.error("release: schema_newer — backup " + id + ": schema_newer"); process.exit(1); }
  console.log("compatible=ok");
} else if (cmd === "migrate-data") {
  execFileSync("cp", ["-R", from, e.DATA_DIR]);
  console.log("from=" + from + "\\nto=" + e.DATA_DIR + "\\nintegrity=ok");
} else process.exit(2);
`,
  "scripts/launchd-helper.mjs": `
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = fs.readFileSync(path.join(rootDir, ".env"), "utf8");
if (process.argv[2] !== "check" || env.includes("PREFLIGHT_FAIL=1")) { console.error("check failed: fixture"); process.exit(1); }
console.log("ok — fixture check");
`,
};

type Fx = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-rel-")));
  const home = path.join(base, "home");
  const agentHome = path.join(home, ".chat-agent");
  const src = path.join(base, "src.git");
  const work = path.join(base, "work");
  const port = await freePort();
  fs.mkdirSync(home, { recursive: true });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      stdio: "pipe",
    });
  git(base, "init", "--quiet", "--bare", src);
  fs.mkdirSync(work);
  git(work, "init", "--quiet");
  for (const [f, body] of Object.entries(FIXTURE)) {
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.writeFileSync(path.join(work, f), body);
  }
  execFileSync("pnpm", ["install", "--silent", "--no-frozen-lockfile"], {
    cwd: work,
    env: { ...process.env, ...COREPACK, HOME: home },
    stdio: "pipe",
  });
  const commit = (changes: Record<string, string>, msg: string) => {
    for (const [f, body] of Object.entries(changes)) {
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      fs.writeFileSync(path.join(work, f), body);
    }
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", msg);
    git(work, "push", "--quiet", "--force", src, "HEAD:refs/heads/main");
    return git(work, "rev-parse", "HEAD").toString().trim();
  };
  commit({}, "v1");

  const dataDir = path.join(agentHome, "data");
  fs.mkdirSync(path.join(agentHome, "shared"), { recursive: true, mode: 0o700 });
  const envFile = path.join(agentHome, "shared", ".env");
  fs.writeFileSync(
    envFile,
    [
      `HOST=127.0.0.1`,
      `PORT=${port}`,
      `DATA_DIR=${dataDir}`,
      `BACKUP_DIR=${path.join(agentHome, "backups")}`,
      `TEMP_GATE_CODE=${SECRET}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, "agentlee.db"), "fixture db");

  const outputs: string[] = [];
  const run = (...args: string[]) => runWith({}, ...args);
  const runWith = (extra: Record<string, string>, ...args: string[]) => {
    const r = spawnSync("bash", [script, ...args], {
      env: {
        ...process.env,
        ...COREPACK,
        HOME: home,
        AGENTLEE_HOME: agentHome,
        AGENTLEE_SOURCE: src,
        AGENTLEE_NODE: process.execPath,
        AGENTLEE_LAUNCHD_PLIST: path.join(base, "no-such-daemon.plist"),
        AGENTLEE_HEALTH_TIMEOUT: "6",
        ...extra,
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    outputs.push(r.stdout, r.stderr);
    return r;
  };
  const pidFile = path.join(agentHome, "run", "server.pid");
  cleanups.push(() => {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // no server
    }
    // Every command's output, whatever the test checked: the secret from shared/.env never appears.
    expect(outputs.join("\n")).not.toContain(SECRET);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const envState = () => {
    const st = fs.lstatSync(envFile);
    return `${(st.mode & 0o777).toString(8)} ${st.mtimeMs} ${crypto.createHash("sha256").update(fs.readFileSync(envFile)).digest("hex")}`;
  };
  const current = () => path.basename(fs.readlinkSync(path.join(agentHome, "current")));
  const releases = () => fs.readdirSync(path.join(agentHome, "releases")).sort();
  const served = async () => (await get(port, "/")).match(/<body>(.*)<\/body>/)?.[1];
  return {
    base,
    home,
    agentHome,
    src,
    work,
    port,
    dataDir,
    envFile,
    commit,
    git,
    run,
    runWith,
    envState,
    current,
    releases,
    served,
  };
}

/** A fresh connection per request (servers are replaced between requests; a pooled socket would be reset). */
function get(port: number, p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

const ok = (r: ReturnType<Fx["run"]>) => expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);

describe.skipIf(process.platform === "win32")("release.sh", () => {
  it("installs from the source's main into a new release, links shared/.env and serves it; updates and keeps the old one", async () => {
    const fx = await fixture();
    const env0 = fx.envState();
    const r1 = fx.run("install");
    ok(r1);
    const v1 = fx.current();
    expect(v1).toMatch(/^\d{8}-\d{6}-[0-9a-f]{12}$/);
    const rel1 = path.join(fx.agentHome, "releases", v1);
    expect(fs.readlinkSync(path.join(rel1, ".env"))).toBe("../../shared/.env");
    expect(fs.existsSync(path.join(rel1, "apps/web/dist/index.html"))).toBe(true);
    expect(fs.readFileSync(path.join(rel1, ".release-info"), "utf8")).toMatch(/^sha=[0-9a-f]{40}$/m);
    expect(fs.readFileSync(path.join(rel1, ".release-info"), "utf8")).toMatch(/^predeploy_backup=20261115-/m);
    expect(r1.stdout).toMatch(/verify: ok — health 200, 2 asset\(s\)/);
    expect(await fx.served()).toBe("v1");
    // The server's REPO_ROOT is the real release folder (resolved through `current`).
    const health = JSON.parse(await get(fx.port, "/api/health")) as { root: string };
    expect(health.root).toBe(fs.realpathSync(rel1));

    // Same sha again: nothing to do.
    const again = fx.run("install");
    ok(again);
    expect(again.stdout).toMatch(/already installed/);

    // A commit in the source but uncommitted changes in a working tree never reach a release: only git archive.
    fs.writeFileSync(path.join(fx.work, "version.txt"), "dirty\n");
    fx.commit({ "version.txt": "v2\n" }, "v2");
    fs.writeFileSync(path.join(fx.work, "version.txt"), "uncommitted\n");
    const r2 = fx.run("install", "--ref", "main");
    ok(r2);
    const v2 = fx.current();
    expect(v2).not.toBe(v1);
    expect(await fx.served()).toBe("v2");
    expect(fs.readFileSync(path.join(fx.agentHome, "releases", v2, ".release-info"), "utf8")).toContain(
      `previous=${v1}`,
    );
    expect(fx.releases()).toEqual([v1, v2].sort());

    const st = fx.run("status");
    ok(st);
    expect(st.stdout).toContain(`current:  ${v2}`);
    expect(st.stdout).toMatch(/health:\s+ok/);
    expect(st.stdout).toMatch(/service:\s+running/);
    expect(fx.envState()).toBe(env0); // shared/.env never written
  }, 120_000);

  it("switches back to the previous release when the new one fails health or serves stale assets", async () => {
    const fx = await fixture();
    ok(fx.run("install"));
    const v1 = fx.current();

    fx.commit({ "mode.txt": "health-fail\n", "version.txt": "bad-health\n" }, "bad health");
    const bad = fx.run("install");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/verify: failed — health: 503/);
    expect(bad.stderr).toContain(`switching back to ${v1}`);
    expect(bad.stderr).toContain(`rolled back to ${v1}`);
    expect(fx.current()).toBe(v1);
    expect(await fx.served()).toBe("v1");
    const failed = fx.releases().find((n) => n !== v1)!;
    expect(fs.existsSync(path.join(fx.agentHome, "releases", failed, ".failed"))).toBe(true);

    // The case we hit: assets answered as text/html.
    fx.commit({ "mode.txt": "html-assets\n", "version.txt": "stale\n" }, "stale assets");
    const stale = fx.run("install");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/verify: failed — \/assets\/app-[0-9a-f]+\.(css|js): 200 text\/html/);
    expect(fx.current()).toBe(v1);
    expect(await fx.served()).toBe("v1");

    // A failed release is never a rollback target, and prune removes failed ones first.
    const p = fx.run("prune");
    ok(p);
    expect(fx.releases()).toEqual([v1]);
  }, 120_000);

  it("rolls back by hand, warns when the release being left added migrations, and prunes to --keep", async () => {
    const fx = await fixture();
    ok(fx.run("install"));
    const v1 = fx.current();
    fx.commit({ "version.txt": "v2\n" }, "v2");
    ok(fx.run("install"));
    const v2 = fx.current();

    const back = fx.run("rollback");
    ok(back);
    expect(back.stderr).not.toMatch(/WARNING/);
    expect(fx.current()).toBe(v1);
    expect(await fx.served()).toBe("v1");

    fx.commit(
      {
        "version.txt": "v3\n",
        "apps/server/drizzle/meta/_journal.json": JSON.stringify({
          entries: [{ tag: "0000_init" }, { tag: "0001_new" }],
        }),
      },
      "v3 with a migration",
    );
    const r3 = fx.run("install");
    ok(r3);
    expect(r3.stdout).toMatch(/adds database migrations: 0001_new/);
    const v3 = fx.current();
    const backup = /^predeploy_backup=(.+)$/m.exec(
      fs.readFileSync(path.join(fx.agentHome, "releases", v3, ".release-info"), "utf8"),
    )![1]!;

    const warn = fx.run("rollback");
    ok(warn);
    expect(fx.current()).toBe(v1); // v3's previous
    expect(warn.stderr).toContain(`WARNING — ${v3} added database migrations that ${v1} does not have`);
    expect(warn.stderr).toContain("0001_new");
    expect(warn.stderr).toContain(`pnpm -s restore apply ${backup} --yes`);

    ok(fx.run("rollback", "--to", v2));
    expect(fx.current()).toBe(v2);
    expect(fx.run("rollback", "--to", "nonsense").stderr).toMatch(/not an installed release/);

    ok(fx.run("prune", "--keep", "2"));
    expect(fx.releases()).toEqual([v2, v3].sort()); // current + the newest other
    ok(fx.run("prune", "--keep", "1"));
    expect(fx.releases()).toEqual([v2]);
    expect(fx.run("prune", "--keep", "0").stderr).toMatch(/--keep must be 1 or more/);
  }, 120_000);

  it("prints the restore hint even when the switch back fails too (#148 review P2)", async () => {
    const fx = await fixture();
    ok(fx.run("install"));
    const v1 = fx.current();
    fx.commit(
      {
        "version.txt": "v2\n",
        "apps/server/drizzle/meta/_journal.json": JSON.stringify({
          entries: [{ tag: "0000_init" }, { tag: "0001_new" }],
        }),
      },
      "v2 with a migration",
    );
    fs.writeFileSync(path.join(fx.dataDir, "fail-health"), ""); // every release now fails its health check
    const r = fx.run("install");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`rollback to ${v1} failed its checks too`);
    const v2 = fx.releases().find((n) => n !== v1)!;
    const backup = /^predeploy_backup=(.+)$/m.exec(
      fs.readFileSync(path.join(fx.agentHome, "releases", v2, ".release-info"), "utf8"),
    )![1]!;
    expect(r.stderr).toContain(`WARNING — ${v2} added database migrations that ${v1} does not have`);
    expect(r.stderr).toContain(`pnpm -s restore apply ${backup} --yes`);
    expect(fx.current()).toBe(v1);
  }, 120_000);

  it("suggests the backup the target can restore after several migrating releases (#148 review P2)", async () => {
    const fx = await fixture();
    const journal = (n: number) =>
      JSON.stringify({ entries: Array.from({ length: n }, (_, i) => ({ tag: `000${i}_m` })) });
    ok(fx.run("install"));
    const a = fx.current();
    const backupOf = (rel: string) =>
      /^predeploy_backup=(.+)$/m.exec(
        fs.readFileSync(path.join(fx.agentHome, "releases", rel, ".release-info"), "utf8"),
      )![1]!;
    fx.commit({ "version.txt": "B\n", "apps/server/drizzle/meta/_journal.json": journal(2) }, "B");
    ok(fx.run("install"));
    const b = fx.current();
    fx.commit({ "version.txt": "C\n", "apps/server/drizzle/meta/_journal.json": journal(3) }, "C");
    ok(fx.run("install"));
    const c = fx.current();
    const r = fx.run("rollback", "--to", a);
    ok(r);
    // C's own backup has B's schema (A would refuse it); B's backup was taken while A ran.
    expect(r.stderr).toContain(
      `backup ${backupOf(b)} (taken before ${b} was installed over ${a}; ${a} can restore it — checked)`,
    );
    expect(r.stderr).toContain(`pnpm -s restore apply ${backupOf(b)} --yes`);
    expect(r.stderr).not.toContain(`restore apply ${backupOf(c)}`);
  }, 120_000);

  it("deploys the branch main, not a tag of that name, and refuses an ambiguous --ref (#148 review P2)", async () => {
    const fx = await fixture();
    fx.git(fx.work, "tag", "main");
    fx.git(fx.work, "push", "--quiet", fx.src, "refs/tags/main");
    fx.commit({ "version.txt": "v2\n" }, "v2 on the branch");
    ok(fx.run("install"));
    expect(await fx.served()).toBe("v2");
    expect(
      fs.readFileSync(path.join(fx.agentHome, "releases", fx.current(), ".release-info"), "utf8"),
    ).toContain("ref=refs/heads/main");
    const amb = fx.run("install", "--force", "--ref", "main");
    expect(amb.status).toBe(1);
    expect(amb.stderr).toMatch(/both a branch and a tag — say refs\/heads\/main or refs\/tags\/main/);
    ok(fx.run("install", "--ref", "refs/tags/main"));
    expect(await fx.served()).toBe("v1");
  }, 120_000);

  it("moves data with a LaunchDaemon plist on disk once the daemon is unloaded (#148 review P2)", async () => {
    const fx = await fixture();
    const old = path.join(fx.base, "old-data");
    fs.renameSync(fx.dataDir, old);
    ok(fx.run("install", "--no-start"));
    const plist = path.join(fx.base, "com.agentlee.server.plist");
    fs.writeFileSync(plist, "<plist/>");
    const fake = (name: string, rc: number) => {
      const f = path.join(fx.base, name);
      fs.writeFileSync(f, `#!/bin/sh\n[ "$1" = print ] || exit 99\nexit ${rc}\n`, { mode: 0o755 });
      return f;
    };
    const loaded = fx.runWith(
      { AGENTLEE_LAUNCHD_PLIST: plist, AGENTLEE_LAUNCHCTL: fake("loaded", 0) },
      "migrate-data",
      "--from",
      old,
    );
    expect(loaded.status).toBe(1);
    expect(loaded.stderr).toMatch(/stop the LaunchDaemon first/);
    const unloaded = fx.runWith(
      { AGENTLEE_LAUNCHD_PLIST: plist, AGENTLEE_LAUNCHCTL: fake("unloaded", 113) },
      "migrate-data",
      "--from",
      old,
    );
    ok(unloaded);
    expect(fs.existsSync(path.join(fx.dataDir, "agentlee.db"))).toBe(true);
  }, 120_000);

  it("runs one release command at a time", async () => {
    const fx = await fixture();
    fs.mkdirSync(fx.agentHome, { recursive: true });
    const lockFile = path.join(fx.agentHome, ".release.lock");
    const holder = spawn("perl", [
      "-MFcntl=:flock",
      "-e",
      'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "locked\\n"; sleep 60',
      lockFile,
    ]);
    cleanups.push(() => holder.kill("SIGKILL"));
    await new Promise<void>((resolve) => holder.stdout.on("data", () => resolve()));
    for (const cmd of [["install"], ["rollback"], ["prune"], ["migrate-data", "--from", "/nonexistent"]]) {
      const r = fx.run(...cmd);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/another release command is running/);
    }
    expect(fs.existsSync(path.join(fx.agentHome, "releases")) && fx.releases()).toEqual([]);
    holder.kill("SIGKILL");
    await new Promise((r) => holder.on("exit", r));
    ok(fx.run("install"));
  }, 120_000);

  it("never writes shared/.env: refuses a missing or loose one, and refuses to start an empty install", async () => {
    const fx = await fixture();
    fs.chmodSync(fx.envFile, 0o644);
    const loose = fx.envState();
    const r = fx.run("install");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must have mode 600/);
    expect(fx.envState()).toBe(loose);
    fs.chmodSync(fx.envFile, 0o600);

    // The move from an old data folder: install --no-start (no database yet), migrate-data, restart.
    const old = path.join(fx.base, "old-data");
    fs.renameSync(fx.dataDir, old);
    const empty = fx.run("install");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/no database at DATA_DIR/);
    expect(fx.releases()).toEqual([]);
    ok(fx.run("install", "--no-start"));
    expect(fx.run("migrate-data", "--from", "relative").stderr).toMatch(/absolute path/);
    const m = fx.run("migrate-data", "--from", old);
    ok(m);
    expect(m.stdout).toMatch(/release: to=.*\/data/);
    expect(m.stdout).toMatch(/next steps/);
    expect(fs.existsSync(path.join(fx.dataDir, "agentlee.db"))).toBe(true);
    expect(fs.existsSync(path.join(old, "agentlee.db"))).toBe(true);
    ok(fx.run("restart"));
    expect(await fx.served()).toBe("v1");
    expect(fx.run("migrate-data", "--from", old).stderr).toMatch(/server is running/);
    ok(fx.run("stop"));
    await expect(get(fx.port, "/api/health")).rejects.toThrow();

    fs.rmSync(fx.envFile);
    expect(fx.run("install", "--force").stderr).toMatch(/shared\/\.env not found/);
    expect(fs.existsSync(fx.envFile)).toBe(false);
  }, 120_000);

  it("does not stop a server that is not its own on the port", async () => {
    const fx = await fixture();
    const other = net.createServer().listen(fx.port, "127.0.0.1");
    cleanups.push(() => other.close());
    await new Promise((r) => other.on("listening", r));
    const r = fx.run("install");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/in use by a process that is not this install's server/);
    expect(fs.existsSync(path.join(fx.agentHome, "current"))).toBe(false);
    expect(other.listening).toBe(true);
  }, 120_000);
});
