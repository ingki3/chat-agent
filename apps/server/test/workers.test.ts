import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { browserArgs } from "../src/artifacts/browser.js";
import { exportDocument, Renderer } from "../src/artifacts/export.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import type { FileRow } from "../src/files/store.js";
import { buildProfile } from "../src/isolation/sandbox.js";
import { storagePaths } from "../src/storage/paths.js";
import {
  leaderUid,
  LAUNCHER_MAX_SEC,
  parseWorkerProbe,
  workerAccountFromConfig,
  workerJobDir,
  workerLauncherClean,
  workerLauncherProbe,
  workerLauncherReap,
  workerLauncherRun,
  workerLauncherVerify,
  workerLeaderFile,
  workerScratchRoot,
  type WorkerAccount,
} from "../src/workers/account.js";
import { docAsAccount } from "../src/workers/docgen.js";
import { accountOrSandboxExtractor, EXTRACT_INPUT, extractAsAccount } from "../src/workers/extract.js";
import { makeWorkerJobDir, runWorkerJob, sweepWorkerScratch, type WorkerSpawn } from "../src/workers/run.js";
import {
  docJobCheck,
  extractJobCheck,
  probeWorker,
  renderJobCheck,
  selfCheckWorker,
  WorkerGates,
  type WorkerJobCheck,
  type WorkerProbeRunner,
} from "../src/workers/selfcheck.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * The sandboxed workers' dedicated account (#122): the extractor, the document worker and the export browser run as
 * a different uid through a root-owned launcher (`ops/workers/agentlee-worker-run`), each only after its self-check
 * passed; until then the same-uid sandbox, and the admin status says so. Linux CI: the argument checks, the
 * launcher's bytes and its profile/switch builders (perl), the gates, the routing and the job paths with stand-in
 * processes. macOS: a relaxed copy of the launcher (only its constant lines differ) on a real bundle, as this user.
 * The real account: only with TEST_WORKER_RUN_USER (launcher, config, sudoers and ACL installed).
 */

const closers: (() => unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-workers-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_SRC = path.resolve(HERE, "../../../ops/workers/agentlee-worker-run");
const PY_LAUNCHER_SRC = path.resolve(HERE, "../../../ops/python/agentlee-python-run");
const PERL = fs.existsSync("/usr/bin/perl") ? "/usr/bin/perl" : undefined;
const ACCT: WorkerAccount = { user: "_agentleewk", launcher: "/usr/local/libexec/agentlee-worker-run" };
const JOB = "0b8e1c2a-5d6f-4a3b-9c8d-7e6f5a4b3c2d";
const SUDO = ["-n", "-u", "_agentleewk", "--", "/usr/local/libexec/agentlee-worker-run"];

// ---- the server's side of the boundary: arguments, verdicts, run records ----------------------------------------

describe("worker launcher arguments (#122)", () => {
  it("builds only fixed sudo commands from a kind, a UUID, a bounded timeout and — render only — a port", () => {
    expect(workerLauncherRun(ACCT, "extract", JOB, 60)).toEqual({
      command: "/usr/bin/sudo",
      args: [...SUDO, "run", "extract", JOB, "60"],
    });
    expect(workerLauncherRun(ACCT, "ocr", JOB, 300).args.slice(-4)).toEqual(["run", "ocr", JOB, "300"]);
    expect(workerLauncherRun(ACCT, "render", JOB, 25, 54321).args.slice(-5)).toEqual([
      "run",
      "render",
      JOB,
      "25",
      "54321",
    ]);
    expect(workerLauncherProbe(ACCT, "docgen", JOB, 4242).args.slice(-4)).toEqual([
      "probe",
      "docgen",
      JOB,
      "4242",
    ]);
    expect(workerLauncherProbe(ACCT, "render", JOB, 4242, 9).args.slice(-5)).toEqual([
      "probe",
      "render",
      JOB,
      "4242",
      "9",
    ]);
    expect(workerLauncherReap(ACCT, JOB).args).toEqual([...SUDO, "reap", JOB]);
    expect(workerLauncherClean(ACCT, JOB).args).toEqual([...SUDO, "clean", JOB]);
    expect(workerLauncherVerify(ACCT)).toEqual({ command: ACCT.launcher, args: ["verify", "_agentleewk"] });
    for (const bad of [
      () => workerLauncherRun(ACCT, "python" as "extract", JOB, 10),
      () => workerLauncherRun(ACCT, "extract", `${JOB}\nrun`, 10),
      () => workerLauncherRun(ACCT, "extract", "../x", 10),
      () => workerLauncherRun(ACCT, "extract", JOB, 61),
      () => workerLauncherRun(ACCT, "extract", JOB, 0),
      () => workerLauncherRun(ACCT, "ocr", JOB, 301),
      () => workerLauncherRun(ACCT, "extract", JOB, 1.5),
      () => workerLauncherRun(ACCT, "render", JOB, 20),
      () => workerLauncherRun(ACCT, "render", JOB, 20, 0),
      () => workerLauncherRun(ACCT, "render", JOB, 20, 65536),
      () => workerLauncherRun(ACCT, "docgen", JOB, 20, 8080),
      () => workerLauncherProbe(ACCT, "extract", JOB, 1),
      () => workerLauncherReap(ACCT, JOB.toUpperCase()),
      () => workerJobDir("/d", "x"),
    ])
      expect(bad).toThrow();
    expect(LAUNCHER_MAX_SEC).toEqual({ extract: 60, ocr: 300, docgen: 60, render: 60 });
    expect(workerAccountFromConfig(undefined)).toBeUndefined();
    expect(workerAccountFromConfig("Bad Name")).toBeUndefined();
    expect(workerAccountFromConfig("_agentleewk")).toEqual(ACCT);
    expect(workerScratchRoot("/d")).toBe(path.join(path.resolve("/d"), "worker-scratch"));
  });

  it("reads exactly one strict probe verdict; anything else is no verdict", () => {
    expect(parseWorkerProbe("uid=502 sibling=501 procargs=blocked\n", 0)).toEqual({
      uid: 502,
      siblingUid: 501,
      readBlocked: true,
    });
    expect(parseWorkerProbe("uid=501 sibling=501 procargs=readable\n", 0)).toEqual({
      uid: 501,
      siblingUid: 501,
      readBlocked: false,
    });
    expect(parseWorkerProbe("uid=502 procargs=error sibling\n", 0)).toEqual({ uid: 502, readBlocked: false });
    expect(parseWorkerProbe("uid=502 procargs=error errno=22\n", 0)).toEqual({
      uid: 502,
      readBlocked: false,
    });
    for (const [out, code] of [
      ["uid=502 sibling=501 procargs=blocked\n", 1],
      ["uid=502 sibling=501 procargs=blocked\n", null],
      ["uid=502 sibling=501 procargs=blocked", 0],
      ["uid=502 sibling=501 procargs=blocked\n\n", 0],
      ["uid=502 sibling=501 procargs=blocked\nuid=502 sibling=501 procargs=readable\n", 0],
      ["x uid=502 sibling=501 procargs=blocked\n", 0],
      ["uid=0502 sibling=501 procargs=blocked\n", 0],
      ["uid=4294967296 sibling=501 procargs=blocked\n", 0],
      ["uid=502 procargs=blocked\n", 0], // no sibling: not a blocked verdict
      ["uid=502 sibling=501 procargs=error control\n", 0],
      ["", 0],
    ] as const)
      expect(parseWorkerProbe(out, code), JSON.stringify(out)).toBeUndefined();
  });

  it("a run record counts only when well-formed and owned by the uid it names", () => {
    const d = tmp();
    const f = path.join(d, "leader");
    fs.writeFileSync(f, "1234 502 1794585131 9970\n");
    expect(leaderUid(f, () => 502)).toBe(502);
    expect(leaderUid(f, () => 501)).toBeUndefined();
    for (const bad of ["1234 502 1794585131 9970", "1234 502 1 2\nx", "a b c d\n", ""]) {
      fs.writeFileSync(f, bad);
      expect(leaderUid(f, () => 502)).toBeUndefined();
    }
    expect(leaderUid(path.join(d, "none"), () => 502)).toBeUndefined();
  });

  it("refuses WORKER_RUN_USER equal to PYTHON_RUN_USER (two accounts on purpose) and a malformed name", () => {
    const base = { NODE_ENV: "test", DATA_DIR: tmp() };
    expect(() => loadConfig({ ...base, WORKER_RUN_USER: "_agentlee", PYTHON_RUN_USER: "_agentlee" })).toThrow(
      /different account/,
    );
    expect(() => loadConfig({ ...base, WORKER_RUN_USER: "Bad Name" })).toThrow();
    expect(
      loadConfig({ ...base, WORKER_RUN_USER: "_agentleewk", PYTHON_RUN_USER: "_agentleepy" }).workerRunUser,
    ).toBe("_agentleewk");
  });
});

// ---- the launcher's shipped bytes ---------------------------------------------------------------------------------

/** The launcher's functions as a perl library (everything above its dispatch marker) plus a harness. */
function perlLib(harness: string, input: unknown): string {
  const src = fs.readFileSync(LAUNCHER_SRC, "utf8");
  const cut = src.indexOf("\n# ---- dispatch");
  expect(cut).toBeGreaterThan(0);
  const lib = path.join(tmp(), "lib.pl");
  fs.writeFileSync(lib, src.slice(0, cut) + "\nuse JSON::PP;\n" + harness);
  const r = spawnSync(PERL!, ["-T", lib], { input: JSON.stringify(input), encoding: "utf8", env: {} });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/** `sub name {…}` blocks of a perl file, by name (a block ends at the first line that is exactly "}"). */
function perlSubs(file: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^sub ([a-z0-9_]+) +\{(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (m[2]!.trimEnd().endsWith("}")) {
      out.set(m[1]!, lines[i]!);
      continue;
    }
    let j = i;
    while (lines[j] !== "}") j++;
    out.set(m[1]!, lines.slice(i, j + 1).join("\n"));
  }
  return out;
}

describe("the shipped worker launcher (#122)", () => {
  const src = fs.readFileSync(LAUNCHER_SRC, "utf8");

  it("has no bypass: fixed config path and owner, taint mode, a replaced environment, no shell, kernel identity", () => {
    expect(src.split("\n")[0]).toBe("#!/usr/bin/perl -T");
    expect(src).toContain('use constant CONF_PATH        => "/usr/local/etc/agentlee-worker.conf";');
    expect(src).toContain("use constant OWNER_ALLOW_SELF => 0;");
    expect(src).not.toMatch(/OWNER_ALLOW_SELF\s*=>\s*1/);
    expect(src).not.toMatch(/AGENTLEE_WORKER_CONF|SELFTEST/);
    // The memory limits are the server's numbers, one constant line each (a test copy rewrites only these).
    expect(src).toContain("use constant MEM_EXTRACT_KB   => 786432;");
    expect(src).toContain("use constant MEM_OCR_KB       => 1572864;");
    expect(src).toContain("use constant MEM_DOCGEN_KB    => 786432;");
    expect(src).toContain("use constant MEM_RENDER_KB    => 786432;");
    expect(src).not.toMatch(/setrlimit|RLIMIT_AS/);
    expect(src).toMatch(/\n%ENV = \(PATH => "\/usr\/bin:\/bin", LC_ALL => "C"\);\n/);
    expect(src).not.toMatch(/comm=|lstart=/);
    expect(src).not.toMatch(/qx[{(/]/);
    expect(src.split("\n").filter((l) => !/^\s*#/.test(l) && /`/.test(l.replace(/#.*$/, "")))).toEqual([]);
    // Every exec is list form with a fixed program first.
    for (const l of src.split("\n").filter((x) => /\bexec\(/.test(x) && !/^\s*#/.test(x)))
      expect(l).toMatch(/exec\("\/usr\/bin\/sandbox-exec", "-p", \$profile, /);
    expect(fs.statSync(LAUNCHER_SRC).mode & 0o777).toBe(0o755);
  });

  it("shares python_run's reviewed trust, run-record, reap, clean and verify functions byte for byte", () => {
    const mine = perlSubs(LAUNCHER_SRC);
    const theirs = perlSubs(PY_LAUNCHER_SRC);
    const shared = [
      "die_err",
      "must",
      "safe_path",
      "owner_ok",
      "run_lines",
      "acl_lines_err",
      "node_acl",
      "node_err",
      "chain_err",
      "file_err",
      "tree_err",
      "parse_config",
      "conf_path",
      "job_workdir",
      "ctl_dir",
      "kinfo_gone",
      "kinfo",
      "rss_kb",
      "write_status",
      "refuse_reap",
      "op_reap",
      "op_clean",
      "u32",
      "account_info",
      "principal_mine",
      "account_eval",
      "account_may",
      "account_traverse",
    ];
    for (const name of shared) {
      expect(mine.get(name), name).toBeDefined();
      expect(mine.get(name), name).toBe(theirs.get(name));
    }
  });

  it.skipIf(!PERL)("compiles under taint mode", () => {
    const r = spawnSync(PERL!, ["-Tc", LAUNCHER_SRC], { encoding: "utf8", env: {} });
    expect(r.status, r.stderr).toBe(0);
  });

  it.skipIf(!PERL)(
    "its profile per kind is exactly buildProfile's for the same policy (and the probe's)",
    () => {
      const cfg = {
        node: "/usr/local/lib/agentlee-workers/node",
        app: "/usr/local/lib/agentlee-workers/app",
        browser: "/usr/local/lib/agentlee-workers/browser",
        scratch: "/Users/agentlee/data/worker-scratch",
      };
      const work = `${cfg.scratch}/${JOB}`;
      const out = JSON.parse(
        perlLib(
          `
my $req = JSON::PP->new->decode(do { local $/; <STDIN> });
my %cfg = %{ $req->{cfg} };
program_paths(\\%cfg);
my %o;
for my $k (qw(extract ocr docgen render)) {
  my $port = $k eq "render" ? 54321 : undef;
  my $pol = kind_policy(\\%cfg, $k, $req->{work});
  $o{$k} = build_profile($pol, $pol->{exe}, $port);
  $o{"probe-$k"} = build_profile($pol, "/usr/bin/perl", $port);
}
print JSON::PP->new->canonical->encode(\\%o);
`,
          { cfg, work },
        ),
      ) as Record<string, string>;
      const node = `${cfg.node}/bin/node`;
      const chrome = `${cfg.browser}/chrome-headless-shell`;
      const ts = (
        command: string,
        p: { read?: string[]; write?: string[]; trusted: string[]; port?: number },
      ) =>
        buildProfile({
          command,
          read: p.read ?? [],
          write: p.write ?? [],
          trusted: p.trusted,
          network: p.port ? { loopbackPorts: [p.port] } : "none",
        });
      const extract = { read: [work], trusted: [cfg.app] };
      const docgen = { trusted: [cfg.app] };
      const render = { write: [work], trusted: [cfg.browser], port: 54321 };
      expect(out.extract).toBe(ts(node, extract));
      expect(out.ocr).toBe(ts(node, extract));
      expect(out.docgen).toBe(ts(node, docgen));
      expect(out.render).toBe(ts(chrome, render));
      expect(out["probe-extract"]).toBe(ts("/usr/bin/perl", extract));
      expect(out["probe-docgen"]).toBe(ts("/usr/bin/perl", docgen));
      expect(out["probe-render"]).toBe(ts("/usr/bin/perl", render));
      // What the kinds may not do: docgen reads no job folder; nothing but render writes; no network but render's port.
      expect(out.docgen).not.toContain(work);
      expect(out.extract).not.toMatch(/file-write|network/);
      expect(out.render).toContain('(allow network-outbound (remote ip "localhost:54321"))');
    },
  );

  it.skipIf(!PERL)("its browser switches are exactly browserArgs' (the proxy on the given port)", () => {
    const profile = `/Users/agentlee/data/worker-scratch/${JOB}/profile`;
    const out = JSON.parse(
      perlLib(`print JSON::PP->new->encode([browser_args("${profile}", 54321)]);`, {}),
    ) as string[];
    expect(out).toEqual(browserArgs(profile, "http://127.0.0.1:54321"));
  });
});

// ---- the worker side: under the account, library paths come from the program tree only ---------------------------

describe("the workers take their library paths from the program tree's manifest under the account (#122)", () => {
  const manifestApp = () => {
    const app = tmp();
    fs.writeFileSync(
      path.join(app, "manifest.json"),
      JSON.stringify({
        version: 1,
        docgen: {
          modules: { docx: "node_modules/docx.js", jszip: "node_modules/jszip.js" },
          fonts: { regular: "fonts/r.ttf", bold: "fonts/b.ttf" },
        },
        extract: {
          modules: { pdfjs: "node_modules/pdf.mjs", tesseract: "node_modules/t.js" },
          assets: { cmaps: "node_modules/cmaps", standardFonts: "node_modules/fonts" },
          ocrLangDir: "ocr",
        },
      }),
    );
    return app;
  };

  it("extract: modules, assets and OCR data from the manifest; the job's own paths and limits are dropped", async () => {
    const { fromApp } = (await import(pathToFileURL(path.resolve(HERE, "../extract/worker.mjs")).href)) as {
      fromApp: (job: object, app?: string) => Record<string, unknown>;
    };
    const app = manifestApp();
    const job = {
      path: "/w/input",
      kind: "pdf",
      bytes: 3,
      modules: { pdfjs: "file:///evil.mjs", tesseract: "file:///evil.mjs" },
      assets: { cmaps: "/evil/" },
      ocr: { langDir: "/evil" },
      limits: { pdf: { maxPages: 1e9 } },
    };
    expect(fromApp(job, undefined)).toBe(job);
    expect(fromApp(job, app)).toEqual({
      path: "/w/input",
      kind: "pdf",
      bytes: 3,
      modules: {
        pdfjs: pathToFileURL(path.join(app, "node_modules/pdf.mjs")).href,
        tesseract: pathToFileURL(path.join(app, "node_modules/t.js")).href,
      },
      assets: {
        cmaps: path.join(app, "node_modules/cmaps") + path.sep,
        standardFonts: path.join(app, "node_modules/fonts") + path.sep,
      },
      ocr: { langDir: path.join(app, "ocr") },
    });
    expect(fromApp({ ...job, ocr: null }, app).ocr).toBeNull();
    const m = JSON.parse(fs.readFileSync(path.join(app, "manifest.json"), "utf8")) as {
      extract: { modules: { pdfjs: string } };
    };
    for (const bad of ["../outside.mjs", "/abs.mjs", ""]) {
      m.extract.modules.pdfjs = bad;
      fs.writeFileSync(path.join(app, "manifest.json"), JSON.stringify(m));
      expect(() => fromApp(job, app)).toThrow();
    }
  });

  it("docgen: modules and fonts from the manifest; the job's module paths are dropped", async () => {
    const { fromApp } = (await import(pathToFileURL(path.resolve(HERE, "../docgen/worker.mjs")).href)) as {
      fromApp: (job: object, app?: string) => Record<string, unknown>;
    };
    const app = manifestApp();
    const job = {
      kind: "docx",
      doc: { title: "t", blocks: [] },
      images: {},
      modules: { docx: "file:///evil.js" },
      fonts: { regular: "/evil" },
    };
    expect(fromApp(job, undefined)).toBe(job);
    expect(fromApp(job, app)).toEqual({
      kind: "docx",
      doc: { title: "t", blocks: [] },
      images: {},
      modules: {
        docx: pathToFileURL(path.join(app, "node_modules/docx.js")).href,
        jszip: pathToFileURL(path.join(app, "node_modules/jszip.js")).href,
      },
      fonts: { regular: path.join(app, "fonts/r.ttf"), bold: path.join(app, "fonts/b.ttf") },
    });
  });
});

// ---- the job paths with stand-in processes (every platform) ------------------------------------------------------

/** A stand-in for `sudo … launcher …`: records the argv, runs a node script with the stdin; `script` gets the argv. */
function standIn(
  script: (args: string[]) => string,
  seen: { command: string; args: string[] }[] = [],
): WorkerSpawn {
  return (command, args) => {
    seen.push({ command, args });
    return spawn(process.execPath, ["-e", script(args)], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  };
}

const VERIFIED = { account: ACCT, uid: 777 };

describe("jobs through the worker account, with a stand-in launcher (#122)", () => {
  const row = (data: Buffer, kind = "txt") =>
    ({ kind, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") }) as FileRow;

  it("extract: a server-owned 0600 copy in a fresh job folder, the launcher's argv, the answer, the folder removed", async () => {
    const dataDir = tmp();
    const src = path.join(tmp(), "stored");
    const data = Buffer.from("hello\n");
    fs.writeFileSync(src, data);
    const seen: { command: string; args: string[] }[] = [];
    const cleaned: string[] = [];
    let snapshot: { mode: number; uid: number; text: string; stdin: Record<string, unknown> } | undefined;
    const r = await extractAsAccount(
      VERIFIED,
      dataDir,
      { file: row(data), path: src, signal: new AbortController().signal },
      () => ({ available: true, langDir: "/x" }),
      {
        spawn: (command, args) => {
          seen.push({ command, args });
          const dir = workerJobDir(dataDir, args[7]!);
          const input = path.join(dir, EXTRACT_INPUT);
          const st = fs.statSync(input);
          const child = spawn(
            process.execPath,
            [
              "-e",
              "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stderr.write(s);process.stdout.write(JSON.stringify({ok:true,sha256:'x',units:1,truncated:false,ocr:'none',segments:[]}))})",
            ],
            { env: {}, stdio: ["pipe", "pipe", "pipe"] },
          );
          let err = "";
          child.stderr!.on("data", (d: Buffer) => (err += d));
          child.on("close", () => {
            snapshot = {
              mode: st.mode & 0o777,
              uid: st.uid,
              text: fs.readFileSync(input, "utf8"),
              stdin: JSON.parse(err),
            };
          });
          return child;
        },
        clean: (_a, jobId) => cleaned.push(jobId),
      },
    );
    expect(r).toMatchObject({ ok: true, units: 1 });
    expect(seen).toHaveLength(1);
    const jobId = seen[0]!.args[7]!;
    expect(seen[0]).toEqual({ command: "/usr/bin/sudo", args: [...SUDO, "run", "extract", jobId, "60"] });
    expect(snapshot).toMatchObject({ mode: 0o600, uid: process.getuid!(), text: "hello\n" });
    // Only data travels with the job: no library path, no limits.
    expect(snapshot!.stdin).toEqual({
      path: path.join(workerJobDir(dataDir, jobId), EXTRACT_INPUT),
      kind: "txt",
      bytes: 6,
      modules: {},
      assets: {},
      ocr: null,
    });
    expect(cleaned).toEqual([jobId]);
    expect(fs.existsSync(workerJobDir(dataDir, jobId))).toBe(false);
  });

  it("extract: a picture with OCR uses the ocr kind and its limit; a hard link or a changed file never runs", async () => {
    const dataDir = tmp();
    const d = tmp();
    const src = path.join(d, "stored");
    const data = Buffer.from("\x89PNG fake");
    fs.writeFileSync(src, data);
    const seen: { command: string; args: string[] }[] = [];
    const ok = standIn(() => "process.stdout.write(JSON.stringify({ok:false,code:'extract_invalid'}))", seen);
    const job = { file: row(data, "png"), path: src, signal: new AbortController().signal };
    const ocr = () => ({ available: true as const, langDir: "/x" });
    expect(await extractAsAccount(VERIFIED, dataDir, job, ocr, { spawn: ok, clean: () => {} })).toEqual({
      ok: false,
      code: "extract_invalid",
    });
    expect(seen[0]!.args.slice(5, 9)).toEqual(["run", "ocr", seen[0]!.args[7], "300"]);
    // Without OCR: the text kind.
    await extractAsAccount(VERIFIED, dataDir, job, () => ({ available: false, reason: "off" }), {
      spawn: ok,
      clean: () => {},
    });
    expect(seen[1]!.args.slice(5, 9)).toEqual(["run", "extract", seen[1]!.args[7], "60"]);
    // A changed file (hash) and a hard link: nothing is spawned.
    expect(
      await extractAsAccount(
        VERIFIED,
        dataDir,
        { ...job, file: { ...job.file, sha256: "0".repeat(64) } },
        ocr,
        {
          spawn: ok,
          clean: () => {},
        },
      ),
    ).toEqual({ ok: false, code: "extract_changed" });
    fs.linkSync(src, path.join(d, "other"));
    expect(await extractAsAccount(VERIFIED, dataDir, job, ocr, { spawn: ok, clean: () => {} })).toEqual({
      ok: false,
      code: "extract_unavailable",
    });
    expect(seen).toHaveLength(2);
    expect(fs.readdirSync(workerScratchRoot(dataDir)).filter((n) => n !== ".ctl")).toEqual([]);
  });

  it("docgen: the job without library paths, the docgen kind, the file from stdout", async () => {
    const dataDir = tmp();
    const seen: { command: string; args: string[] }[] = [];
    let stdin = "";
    const r = await docAsAccount(
      VERIFIED,
      dataDir,
      { kind: "docx", doc: { title: "t", blocks: [] }, images: {} },
      {
        spawn: (command, args) => {
          seen.push({ command, args });
          const c = spawn(
            process.execPath,
            [
              "-e",
              "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stderr.write(s);process.stdout.write(JSON.stringify({ok:true,data:Buffer.from('PKdoc').toString('base64'),checks:{paragraphs:1}}))})",
            ],
            { env: {}, stdio: ["pipe", "pipe", "pipe"] },
          );
          c.stderr!.on("data", (d: Buffer) => (stdin += d));
          return c;
        },
        clean: () => {},
      },
    );
    expect(r).toEqual({ ok: true, data: Buffer.from("PKdoc"), checks: { paragraphs: 1 } });
    expect(seen[0]!.args.slice(5, 9)).toEqual(["run", "docgen", seen[0]!.args[7], "60"]);
    expect(JSON.parse(stdin)).toEqual({
      kind: "docx",
      doc: { title: "t", blocks: [] },
      images: {},
      modules: {},
      fonts: {},
    });
  });

  it("runWorkerJob: the launcher's 124/125 are timeout/memory; over the output cap or aborted, the job is reaped", async () => {
    const run = (script: string, o: { maxOutputBytes?: number; signal?: AbortSignal } = {}) => {
      const reaped: string[] = [];
      const p = runWorkerJob({
        account: ACCT,
        kind: "extract",
        jobId: JOB,
        timeoutMs: 5000,
        maxOutputBytes: o.maxOutputBytes ?? 1000,
        stdin: "{}",
        signal: o.signal,
        spawn: standIn(() => script),
        reap: (_a, id, onExit) => {
          reaped.push(id);
          onExit(0);
        },
      });
      return p.then((r) => ({ r, reaped }));
    };
    expect((await run("process.exit(124)")).r.killed).toBe("timeout");
    expect((await run("process.exit(125)")).r.killed).toBe("memory");
    expect((await run("process.stdout.write('{}')")).r).toMatchObject({
      code: 0,
      killed: null,
      stdout: "{}",
    });
    const big = await run("process.stdout.write('x'.repeat(5000))", { maxOutputBytes: 100 });
    expect(big.r.killed).toBe("output");
    expect(big.reaped).toEqual([JOB]);
    const ac = new AbortController();
    ac.abort();
    const aborted = await run("setTimeout(()=>{}, 300)", { signal: ac.signal });
    expect(aborted.r.killed).toBe("aborted");
    expect(aborted.reaped).toEqual([JOB]);
  });

  it("render: the launcher's argv with the proxy port, a job folder with home/tmp/profile, its 125 → export_limit", async () => {
    const dataDir = tmp();
    const seen: { command: string; args: string[] }[] = [];
    let dirs: string[] = [];
    const cleaned: string[] = [];
    const renderer = new Renderer({
      browser: undefined,
      account: {
        verified: () => VERIFIED,
        dataDir,
        spawn: (command, args) => {
          seen.push({ command, args });
          dirs = fs.readdirSync(workerJobDir(dataDir, args[7]!)).sort();
          return standIn(() => "process.exit(125)")(command, args) as ChildProcess;
        },
        reap: (_a, _id, onExit) => onExit(0),
        clean: (_a, id) => cleaned.push(id),
      },
    });
    closers.push(() => renderer.close());
    expect(renderer.available).toBe(true);
    const doc = exportDocument("markdown", "t", "hello")!;
    const r = await renderer.render({ format: "png", doc, scripts: false });
    expect(r).toEqual({ ok: false, code: "export_limit" });
    const a = seen[0]!.args;
    expect(a.slice(0, 9)).toEqual([...SUDO, "run", "render", a[7], "25"]);
    expect(Number(a[9])).toBeGreaterThan(0);
    expect(a).toHaveLength(10);
    expect(dirs).toEqual(["home", "profile", "tmp"]);
    expect(cleaned).toEqual([a[7]]);
    expect(fs.existsSync(workerJobDir(dataDir, a[7]!))).toBe(false);
    // Without a verified account and without a browser: unavailable, as before.
    const off = new Renderer({ browser: undefined, account: { verified: () => undefined, dataDir } });
    closers.push(() => off.close());
    expect(off.available).toBe(false);
    expect(await off.render({ format: "png", doc, scripts: false })).toEqual({
      ok: false,
      code: "export_unavailable",
    });
  });

  it("the app's extractor uses the account only while the gate has verified one; else the same-uid sandbox", async () => {
    const gate: { verified?: typeof VERIFIED } = {};
    const calls: string[] = [];
    const runner = accountOrSandboxExtractor(
      () => gate.verified,
      async () => {
        calls.push("sandbox");
        return { ok: false, code: "extract_unavailable" };
      },
      tmp(),
      () => ({ available: false, reason: "off" }),
    );
    const job = { file: row(Buffer.from("x")), path: "/nonexistent", signal: new AbortController().signal };
    await runner(job);
    expect(calls).toEqual(["sandbox"]);
    gate.verified = VERIFIED;
    // The account path: the missing file never reaches the launcher (and not the sandbox either).
    expect(await runner(job)).toEqual({ ok: false, code: "extract_unavailable" });
    expect(calls).toEqual(["sandbox"]);
  });

  it("the start sweep removes job folders left by a crash and keeps the root and .ctl", () => {
    const dataDir = tmp();
    const a = makeWorkerJobDir(dataDir);
    fs.writeFileSync(path.join(a.dir, "input"), "x");
    fs.mkdirSync(path.join(workerScratchRoot(dataDir), ".ctl", a.jobId), { recursive: true });
    fs.writeFileSync(workerLeaderFile(dataDir, a.jobId), "1 2 3 4\n");
    expect(sweepWorkerScratch(dataDir)).toBe(true);
    expect(fs.readdirSync(workerScratchRoot(dataDir))).toEqual([".ctl"]);
    expect(fs.readdirSync(path.join(workerScratchRoot(dataDir), ".ctl"))).toEqual([]);
    expect(sweepWorkerScratch(tmp())).toBe(true); // no root yet
  });
});

// ---- the self-check and the gates ----------------------------------------------------------------------------------

describe("the worker self-check and gates (#122)", () => {
  const SERVER = process.getuid?.() ?? 501;
  const probe =
    (r: { uid: number; siblingUid?: number; readBlocked: boolean }): WorkerProbeRunner =>
    async () =>
      r;
  /** A job check that "ran" one job, whose run record names `uid` (the file owner is reported as `owner`). */
  const job =
    (dataDir: string, uid: number, why?: string): WorkerJobCheck =>
    async (_w, onJob) => {
      const id = crypto.randomUUID();
      fs.mkdirSync(path.dirname(workerLeaderFile(dataDir, id)), { recursive: true });
      fs.writeFileSync(workerLeaderFile(dataDir, id), `1234 ${uid} 1794585131 9970\n`);
      onJob(id);
      return why;
    };

  it("passes only for a different, real uid that cannot read the server-uid sibling, and jobs that ran as it", async () => {
    const dataDir = tmp();
    const check = (p: WorkerProbeRunner, j: WorkerJobCheck, owner = 777) =>
      selfCheckWorker({
        kind: "extract",
        account: ACCT,
        dataDir,
        serverUid: SERVER,
        probe: p,
        job: j,
        clean: () => {},
        ownerOf: () => owner,
      });
    expect(
      await check(probe({ uid: 777, siblingUid: SERVER, readBlocked: true }), job(dataDir, 777)),
    ).toEqual({
      ok: true,
      uid: 777,
    });
    expect(
      await check(probe({ uid: SERVER, siblingUid: SERVER, readBlocked: true }), job(dataDir, 777)),
    ).toMatchObject({
      ok: false,
      step: "probe",
      reason: expect.stringMatching(/server's uid/),
    });
    expect(
      await check(probe({ uid: 0, siblingUid: SERVER, readBlocked: true }), job(dataDir, 0)),
    ).toMatchObject({
      ok: false,
      step: "probe",
    });
    expect(
      await check(probe({ uid: 777, siblingUid: 1, readBlocked: true }), job(dataDir, 777)),
    ).toMatchObject({
      ok: false,
      step: "probe",
      reason: expect.stringMatching(/did not see/),
    });
    expect(await check(probe({ uid: 777, readBlocked: false }), job(dataDir, 777))).toMatchObject({
      ok: false,
      step: "probe",
    });
    expect(
      await check(probe({ uid: 777, siblingUid: SERVER, readBlocked: false }), job(dataDir, 777)),
    ).toMatchObject({
      ok: false,
      step: "probe",
      reason: expect.stringMatching(/could read/),
    });
    expect(
      await check(
        probe({ uid: 777, siblingUid: SERVER, readBlocked: true }),
        job(dataDir, 777, "extract: extract_failed"),
      ),
    ).toEqual({ ok: false, step: "run", reason: "extract: extract_failed" });
    // The job's run record names another uid, or the record's file is owned by someone else.
    expect(
      await check(probe({ uid: 777, siblingUid: SERVER, readBlocked: true }), job(dataDir, SERVER)),
    ).toMatchObject({
      ok: false,
      step: "identity",
    });
    expect(
      await check(probe({ uid: 777, siblingUid: SERVER, readBlocked: true }), job(dataDir, 777), SERVER),
    ).toMatchObject({
      ok: false,
      step: "identity",
    });
    expect(
      await check(probe({ uid: 777, siblingUid: SERVER, readBlocked: true }), async () => undefined),
    ).toMatchObject({ ok: false, step: "identity", reason: "no job was recorded" });
    expect(
      await check(
        async () => {
          throw new Error("sudo: a password is required");
        },
        job(dataDir, 777),
      ),
    ).toMatchObject({ ok: false, step: "probe", reason: "sudo: a password is required" });
  });

  it("the probe's sibling holds a synthetic secret in its environment and is gone afterwards; the job folder too", async () => {
    const dataDir = tmp();
    let seen: { pid: number; env: string } | undefined;
    const r = await probeWorker({
      account: ACCT,
      kind: "render",
      dataDir,
      serverUid: SERVER,
      clean: () => {},
      run: async ({ siblingPid, port, kind }) => {
        expect(kind).toBe("render");
        expect(port).toBe(9);
        const env =
          process.platform === "linux"
            ? fs.readFileSync(`/proc/${siblingPid}/environ`, "utf8")
            : "AGENTLEE_SELFCHECK=";
        seen = { pid: siblingPid, env };
        return { uid: 777, siblingUid: SERVER, readBlocked: true };
      },
    });
    expect(r).toEqual({ ok: true, uid: 777 });
    expect(seen!.env).toMatch(/AGENTLEE_SELFCHECK=/);
    await new Promise((res) => setTimeout(res, 100));
    expect(() => process.kill(seen!.pid, 0)).toThrow();
    expect(fs.readdirSync(workerScratchRoot(dataDir))).toEqual([]);
  });

  it("gates: not configured → same_uid; a passed kind → account; a failed or throwing one stays same_uid", async () => {
    expect(new WorkerGates(undefined).status()).toEqual([
      { kind: "extract", isolation: "same_uid", state: "not_configured", step: null },
      { kind: "docgen", isolation: "same_uid", state: "not_configured", step: null },
      { kind: "render", isolation: "same_uid", state: "not_configured", step: null },
    ]);
    const g = new WorkerGates(ACCT);
    expect(g.status().map((s) => s.state)).toEqual(["checking", "checking", "checking"]);
    const order: string[] = [];
    await g.start(async (kind) => {
      order.push(kind);
      if (kind === "extract") return { ok: true, uid: 777 };
      if (kind === "docgen") return { ok: false, step: "probe", reason: "sudo: a password is required" };
      throw new Error("boom");
    });
    expect(order).toEqual(["extract", "docgen", "render"]);
    expect(g.verified("extract")).toEqual({ account: ACCT, uid: 777 });
    expect(g.verified("docgen")).toBeUndefined();
    expect(g.status()).toEqual([
      { kind: "extract", isolation: "account", state: "ok", step: null },
      { kind: "docgen", isolation: "same_uid", state: "failed", step: "probe" },
      { kind: "render", isolation: "same_uid", state: "failed", step: "exception" },
    ]);
    // Skipped kinds are not checked; shutdown stops a running check (it does not count as passed).
    const h = new WorkerGates(ACCT);
    h.skip("docgen", "in-process documents (tests only)");
    let release!: () => void;
    const started: string[] = [];
    void h.start(async (kind, signal) => {
      started.push(kind);
      await new Promise<void>((r) => {
        release = r;
        signal.addEventListener("abort", () => r());
      });
      return { ok: false, step: "probe", reason: "aborted" };
    });
    await new Promise((r) => setTimeout(r, 10));
    await h.stop(1000);
    await h.done;
    expect(started).toEqual(["extract"]);
    expect(h.status().map((s) => s.state)).toEqual(["stopped", "unavailable", "stopped"]);
    release();
  });

  it("the admin's system status lists every worker's isolation (codes only); a failed check stays same_uid", async () => {
    const dataDir = tmp();
    const app = await buildApp(
      loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, WORKER_RUN_USER: "_agentleewk" }),
      {
        db: createTestDb(),
        logger: false,
        workers: {
          selfCheck: async (kind) =>
            kind === "docgen"
              ? { ok: true, uid: 777 }
              : { ok: false, step: "run", reason: `${kind}: secret-free reason` },
        },
      },
    );
    closers.push(() => app.close());
    const f = await createFamily(app);
    await app.ready();
    // The checks run in the background once ready.
    for (let i = 0; i < 50; i++) {
      const s = (
        await app.inject({
          method: "GET",
          url: "/api/admin/system",
          headers: { host: "localhost:3000", cookie: f.cookies.admin },
        })
      ).json() as { workers: { kind: string; state: string }[] };
      if (s.workers.every((w) => w.state !== "checking")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/system",
      headers: { host: "localhost:3000", cookie: f.cookies.admin },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { workers: unknown }).workers).toEqual([
      { kind: "extract", isolation: "same_uid", state: "failed", step: "run" },
      { kind: "docgen", isolation: "account", state: "ok", step: null },
      { kind: "render", isolation: "same_uid", state: "failed", step: "run" },
    ]);
    expect(res.body).not.toMatch(/secret-free reason/);
  });
});

// ---- macOS: the launcher itself, a relaxed test copy on a real bundle, as this user ---------------------------------

const ME = os.userInfo().username;
const MAC = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec") && !!PERL;

describe.skipIf(!MAC)("the worker launcher (relaxed test copy on a real bundle, own user)", () => {
  type Rig = { dir: string; launcher: string; conf: string; dataDir: string; scratch: string; lib: string };
  let shared: string | undefined;
  /** One bundle per run (APFS clones), copied into each rig. */
  const bundle = async (): Promise<string> => {
    if (shared) return shared;
    const { bundleWorkers } = await import("../src/workers/bundle.js");
    const out = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-wkbundle-"))), "b");
    bundleWorkers(out);
    shared = out;
    return out;
  };
  const confText = (r: Rig) =>
    `node=${r.lib}/node\napp=${r.lib}/app\nbrowser=${r.lib}/browser\nscratch=${r.scratch}\n`;
  async function rig(
    mem: Partial<Record<"EXTRACT" | "OCR" | "DOCGEN" | "RENDER", number>> = {},
  ): Promise<Rig> {
    const dir = tmp();
    fs.chmodSync(dir, 0o755);
    const lib = path.join(dir, "lib");
    expect(spawnSync("/bin/cp", ["-cR", await bundle(), lib]).status).toBe(0);
    expect(spawnSync("/bin/chmod", ["-R", "go-w", lib]).status).toBe(0);
    const dataDir = path.join(dir, "data");
    fs.mkdirSync(dataDir, { mode: 0o755 });
    const r: Rig = {
      dir,
      lib,
      launcher: path.join(dir, "launcher"),
      conf: path.join(dir, "conf"),
      dataDir,
      scratch: path.join(dataDir, "worker-scratch"),
    };
    fs.mkdirSync(r.scratch, { mode: 0o755 });
    const src = fs.readFileSync(LAUNCHER_SRC, "utf8");
    let test = src
      .replace(/^use constant CONF_PATH .*$/m, `use constant CONF_PATH        => "${r.conf}";`)
      .replace(/^use constant OWNER_ALLOW_SELF => 0;$/m, "use constant OWNER_ALLOW_SELF => 1;");
    for (const [k, v] of Object.entries(mem))
      test = test.replace(new RegExp(`^(use constant MEM_${k}_KB +=> )\\d+;`, "m"), `$1${v};`);
    // Exactly the constant lines differ from the shipped bytes.
    const diff = src.split("\n").filter((l, i) => l !== test.split("\n")[i]);
    expect(diff).toHaveLength(2 + Object.keys(mem).length);
    fs.writeFileSync(r.launcher, test, { mode: 0o755 });
    fs.writeFileSync(r.conf, confText(r), { mode: 0o644 });
    return r;
  }
  /** The account path's sudo argv, run as this user straight against the test copy. */
  const direct =
    (r: Rig): WorkerSpawn =>
    (_command, args) => {
      const i = args.indexOf("--");
      return spawn(r.launcher, args.slice(i + 2), {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    };
  const cleanDirect = (r: Rig) => (_a: WorkerAccount, jobId: string) =>
    void spawnSync(r.launcher, ["clean", jobId], { env: {}, stdio: "ignore" });
  const worker = (r: Rig) => ({ account: { user: ME, launcher: r.launcher }, uid: process.getuid!() });
  const run = (r: Rig, args: string[], input = "") => {
    const out = spawnSync(r.launcher, args, { input, encoding: "utf8", env: {} });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  };

  afterAll(() => {
    if (shared) fs.rmSync(path.dirname(shared), { recursive: true, force: true });
  });

  it("verify passes on a clean install; extract and docgen run through the account path; caller paths are ignored", async () => {
    const r = await rig();
    const v = spawnSync(r.launcher, ["verify", ME], { encoding: "utf8", env: {} });
    expect(v.status, v.stdout).toBe(0);
    expect(v.stdout).toContain("result ok");
    const w = worker(r);
    // Extraction of a text file and of a DOCX made by the document worker.
    const src = path.join(tmp(), "f.txt");
    const text = Buffer.from("첫 줄\nsecond line\n");
    fs.writeFileSync(src, text);
    const ids: string[] = [];
    const ex = await extractAsAccount(
      w,
      r.dataDir,
      {
        file: {
          kind: "txt",
          bytes: text.length,
          sha256: crypto.createHash("sha256").update(text).digest("hex"),
        } as FileRow,
        path: src,
        signal: new AbortController().signal,
      },
      () => ({ available: false, reason: "off" }),
      { spawn: direct(r), clean: cleanDirect(r), onJob: (id) => ids.push(id) },
    );
    expect(ex.ok, JSON.stringify(ex)).toBe(true);
    if (ex.ok) expect(ex.segments.map((s) => s.text).join("\n")).toBe("첫 줄\nsecond line");
    // The run record names this uid; the job folder and its record are gone afterwards.
    expect(ids).toHaveLength(1);
    expect(fs.existsSync(workerJobDir(r.dataDir, ids[0]!))).toBe(false);
    const evil = path.join(tmp(), "evil.mjs");
    fs.writeFileSync(evil, "throw new Error('PWNED')");
    let stdin = "";
    const doc = await docAsAccount(
      w,
      r.dataDir,
      { kind: "docx", doc: { title: "검사 문서", blocks: [] }, images: {} },
      {
        spawn: (c, a) => {
          const child = direct(r)(c, a);
          const write = child.stdin!.end.bind(child.stdin!);
          // A caller that names its own module: the worker under the account ignores it (manifest only).
          child.stdin!.end = ((chunk: string) => {
            const j = JSON.parse(chunk) as Record<string, unknown>;
            stdin = JSON.stringify({ ...j, modules: { docx: pathToFileURL(evil).href } });
            return write(stdin);
          }) as typeof child.stdin.end;
          return child;
        },
        clean: cleanDirect(r),
      },
    );
    expect(doc.ok, JSON.stringify(doc)).toBe(true);
    expect(stdin).toContain("evil.mjs");
    if (doc.ok) expect(doc.data.subarray(0, 2).toString()).toBe("PK");
  }, 120_000);

  it("the self-checks pass end to end against the test copy (same uid here, so the probe reads 'readable')", async () => {
    const r = await rig();
    const me = process.getuid!();
    // The run and identity steps exactly as the server runs them, through the test copy. The probe step is the
    // account's (here: same uid, so it is stood in for — the server uid is pretended to be another).
    const hooks = { spawn: direct(r), clean: cleanDirect(r) };
    for (const [kind, job] of [
      ["extract", extractJobCheck(r.dataDir, () => ({ available: true, langDir: "" }), os.tmpdir, hooks)],
      ["docgen", docJobCheck(r.dataDir, hooks)],
    ] as const) {
      const v = await selfCheckWorker({
        kind,
        account: { user: ME, launcher: r.launcher },
        dataDir: r.dataDir,
        serverUid: 1,
        probe: async () => ({ uid: me, siblingUid: 1, readBlocked: true }),
        clean: cleanDirect(r),
        job,
      });
      expect(v, kind).toEqual({ ok: true, uid: me });
    }
    // The probe through the test copy: it sees a same-uid sibling and can read it (the account would be blocked).
    const sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], {
      env: { AGENTLEE_SELFCHECK: "x" },
      stdio: "ignore",
    });
    closers.push(() => sibling.kill("SIGKILL"));
    await new Promise((res) => setTimeout(res, 150));
    for (const kind of ["extract", "ocr", "docgen"]) {
      const id = makeWorkerJobDir(r.dataDir).jobId;
      const p = run(r, ["probe", kind, id, String(sibling.pid)]);
      expect(p.status, p.stderr).toBe(0);
      expect(parseWorkerProbe(p.stdout, p.status)).toEqual({
        uid: process.getuid!(),
        siblingUid: process.getuid!(),
        readBlocked: false,
      });
    }
    // A root process: another uid — blocked, as the account will be for the server's processes.
    const id = makeWorkerJobDir(r.dataDir).jobId;
    const root = run(r, ["probe", "render", id, "1", "9"]);
    expect(parseWorkerProbe(root.stdout, root.status)).toEqual({
      uid: process.getuid!(),
      siblingUid: 0,
      readBlocked: true,
    });
    // A pid that is gone is never "blocked".
    const gone = run(r, ["probe", "docgen", id, "999999"]);
    expect(parseWorkerProbe(gone.stdout, gone.status)).toEqual({
      uid: process.getuid!(),
      readBlocked: false,
    });
  }, 120_000);

  it.skipIf(!fs.existsSync("/bin/cp"))(
    "render: a page to PNG through the relayed pipe; reap and the time limit stop it",
    async () => {
      const r = await rig();
      const w = worker(r);
      const renderer = new Renderer({
        browser: undefined,
        account: {
          verified: () => w,
          dataDir: r.dataDir,
          spawn: direct(r),
          clean: cleanDirect(r),
          reap: (_a, id, onExit) => {
            const p = spawnSync(r.launcher, ["reap", id], { env: {} });
            onExit(p.status);
          },
        },
      });
      closers.push(() => renderer.close());
      const seen: number[] = [];
      const out = await renderJobCheck(renderer)(
        w,
        (id) => seen.push(leaderUid(workerLeaderFile(r.dataDir, id)) ?? -1),
        undefined,
      );
      expect(out).toBeUndefined();
      expect(seen).toEqual([process.getuid!()]);
      // The launcher's own wall clock: a browser nobody talks to is killed at its limit (124).
      const id = makeWorkerJobDir(r.dataDir);
      for (const d of ["home", "tmp", "profile"]) fs.mkdirSync(path.join(id.dir, d));
      const t0 = Date.now();
      const p = spawn(r.launcher, ["run", "render", id.jobId, "2", "9"], {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });
      const code = await new Promise<number | null>((res) => p.on("exit", res));
      expect(code).toBe(124);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(fs.readFileSync(path.join(r.scratch, ".ctl", id.jobId, "status"), "utf8")).toBe("timeout\n");
      // reap kills a running browser by its recorded kernel identity.
      const id2 = makeWorkerJobDir(r.dataDir);
      for (const d of ["home", "tmp", "profile"]) fs.mkdirSync(path.join(id2.dir, d));
      const p2 = spawn(r.launcher, ["run", "render", id2.jobId, "30", "9"], {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });
      const exited = new Promise<number | null>((res) => p2.on("exit", res));
      for (let i = 0; i < 100 && !fs.existsSync(path.join(r.scratch, ".ctl", id2.jobId, "leader")); i++)
        await new Promise((res) => setTimeout(res, 50));
      expect(run(r, ["reap", id2.jobId]).status).toBe(0);
      expect(await exited).toBe(128 + 9);
    },
    120_000,
  );

  it("the memory watch kills a worker over its kind's limit (125 → doc_limit)", async () => {
    const r = await rig({ DOCGEN: 20_000 });
    const res = await docAsAccount(
      worker(r),
      r.dataDir,
      { kind: "docx", doc: { title: "t", blocks: [] }, images: {} },
      { spawn: direct(r), clean: cleanDirect(r) },
    );
    expect(res).toEqual({ ok: false, code: "doc_limit" });
  }, 60_000);

  it("refuses bad arguments, a group-writable file in a tree, and reading another job's folder", async () => {
    const r = await rig();
    for (const args of [
      ["run", "python", JOB, "10"],
      ["run", "render", JOB, "10"],
      ["run", "extract", JOB, "61"],
      ["run", "ocr", JOB, "301"],
      ["run", "docgen", JOB, "10", "80"],
      ["run", "extract", "../x", "10"],
      ["probe", "extract", JOB, "x"],
    ])
      expect(run(r, args).status, args.join(" ")).toBe(64);
    const deep = path.join(r.lib, "app", "extract", "worker.mjs");
    fs.chmodSync(deep, 0o664);
    const a = makeWorkerJobDir(r.dataDir);
    const bad = run(r, ["run", "extract", a.jobId, "10"], "{}");
    expect(bad.status).toBe(64);
    expect(bad.stderr).toMatch(/app tree: writable by group\/other/);
    fs.chmodSync(deep, 0o644);
    // Job B's extractor cannot read job A's folder (the profile allows its own folder only).
    fs.writeFileSync(path.join(a.dir, "input"), "SECRET-A\n");
    const b = makeWorkerJobDir(r.dataDir);
    const job = JSON.stringify({
      path: path.join(a.dir, "input"),
      kind: "txt",
      bytes: 9,
      modules: {},
      assets: {},
      ocr: null,
    });
    const p = spawn(r.launcher, ["run", "extract", b.jobId, "30"], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stdin.end(job);
    await new Promise((res) => p.on("close", res));
    expect(JSON.parse(out)).toEqual({ ok: false, code: "extract_failed" });
    expect(out).not.toContain("SECRET-A");
  }, 60_000);
});

// ---- the real account (operator-provided) ---------------------------------------------------------------------------

const RUN_USER = process.env.TEST_WORKER_RUN_USER;

describe.skipIf(!RUN_USER || process.platform !== "darwin")(
  "the worker account, for real (TEST_WORKER_RUN_USER)",
  () => {
    it("every kind's self-check passes: a different uid, KERN_PROCARGS2 of a server-uid sibling blocked, jobs as it", async () => {
      const config = loadConfig();
      const account = workerAccountFromConfig(RUN_USER)!;
      const renderer = new Renderer({
        browser: undefined,
        account: { verified: () => undefined, dataDir: config.dataDir },
      });
      closers.push(() => renderer.close());
      for (const kind of ["extract", "docgen", "render"] as const) {
        const v = await selfCheckWorker({
          kind,
          account,
          dataDir: config.dataDir,
          serverUid: process.getuid!(),
          job:
            kind === "extract"
              ? extractJobCheck(config.dataDir, () => ({
                  available: true,
                  langDir: storagePaths(config.dataDir).ocrLang,
                }))
              : kind === "docgen"
                ? docJobCheck(config.dataDir)
                : renderJobCheck(renderer),
        });
        expect(v, kind).toMatchObject({ ok: true });
        if (v.ok) expect(v.uid).not.toBe(process.getuid!());
      }
    }, 300_000);
  },
);
