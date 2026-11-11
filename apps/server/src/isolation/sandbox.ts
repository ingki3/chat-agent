import { spawn } from "node:child_process";
import path from "node:path";
import { canonicalPath } from "../fs-safety.js";
import { findHardLinks } from "./paths.js";

/**
 * Process isolation for runtime CLIs and skills (#42, PRD D5). On macOS every child runs under `sandbox-exec`
 * with a generated profile: deny by default, then only the listed read / write / exec paths and (optionally)
 * network. The kernel checks real paths, so a symlink inside an allowed folder cannot reach outside it.
 * The environment is exactly what the caller passes — nothing is inherited from the server.
 */
export type SandboxPolicy = {
  /** Folders/files the process may read (plus the OS's own libraries, via system.sb). */
  read: string[];
  /** Folders/files the process may write (also readable). */
  write: string[];
  /** Executables the process may start (the command itself is added automatically). */
  exec?: string[];
  /** "none" (default), "all", or outbound TCP to these loopback ports only (e.g. our MCP server). */
  network?: "none" | "all" | { loopbackPorts: number[] };
  /**
   * Read-only program folders (e.g. a runtime's install directory) that are not scanned for hard links.
   * Never put family data here.
   */
  trusted?: string[];
};

export type RunIsolatedOptions = SandboxPolicy & {
  command: string;
  args: string[];
  cwd: string;
  /** The complete environment of the child. Not merged with process.env. */
  env: Record<string, string>;
  timeoutMs: number;
  /** stdout + stderr beyond this are dropped and the process is killed. */
  maxOutputBytes: number;
  /** Resident memory limit (checked every 250 ms; killed above it, and also when it cannot be measured). */
  maxRssBytes?: number;
  stdin?: string;
  /** Tests only: replaces the `ps` measurement used by the monitor. */
  probe?: () => Promise<{ pid: number; rss: number }[]>;
};

export type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Why we killed it: a limit, or "monitor" when its memory could not be measured (fail closed). */
  killed: null | "timeout" | "output" | "memory" | "monitor";
};

/** SBPL string literal. Paths are canonicalised first; quotes and backslashes are escaped. */
const lit = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function buildProfile(policy: SandboxPolicy & { command: string }): string {
  const read = policy.read.map(canonicalPath);
  const write = policy.write.map(canonicalPath);
  const exec = [policy.command, ...(policy.exec ?? [])].map(canonicalPath);
  const lines = [
    "(version 1)",
    "(deny default)",
    // OS libraries, dyld cache, locale data etc. — what any process needs to start.
    '(import "system.sb")',
    // No process-fork: a sandboxed process cannot start children, so nothing can outlive it or escape its limits
    // (process groups and polling cannot guarantee that). Our MCP servers run in the server, reached over a
    // loopback port, so runtimes do not need to fork for them.
    "(allow signal (target same-sandbox))",
    `(allow process-exec ${exec.map((p) => `(literal ${lit(p)})`).join(" ")})`,
    ...exec.map((p) => `(allow file-read* (literal ${lit(p)}))`),
    ...[...read, ...(policy.trusted ?? []).map(canonicalPath)].map(
      (p) => `(allow file-read* (subpath ${lit(p)}))`,
    ),
    ...write.map((p) => `(allow file-read* file-write* (subpath ${lit(p)}))`),
  ];
  // Metadata (stat) of the folders above allowed paths — not their contents or listings. Programs that resolve
  // their own path (node's realpath of its script) stat every parent and fail without it.
  const parents = new Set<string>();
  for (const p of [...read, ...write, ...(policy.trusted ?? []).map(canonicalPath), ...exec])
    for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) parents.add(d);
  parents.add("/");
  if (parents.size)
    lines.push(`(allow file-read-metadata ${[...parents].map((d) => `(literal ${lit(d)})`).join(" ")})`);
  const net = policy.network ?? "none";
  if (net === "all") lines.push("(allow network*)", "(allow mach-lookup)");
  else if (net !== "none")
    for (const port of net.loopbackPorts) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
      lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
    }
  return lines.join("\n") + "\n";
}

export class SandboxUnavailableError extends Error {
  constructor() {
    super("process sandbox is only available on macOS (sandbox-exec)");
  }
}

export type Proc = { pid: number; rss: number };

/** Resident memory (KiB) of one process via `ps`. Rejects when ps fails, times out or prints nothing usable. */
export function snapshot(pid: number, timeoutMs = 2000): Promise<Proc[]> {
  return new Promise((resolve, reject) => {
    const ps = spawn("/bin/ps", ["-o", "pid=,rss=", "-p", String(pid)], { env: {} });
    let out = "";
    const timer = setTimeout(() => {
      ps.kill("SIGKILL");
      reject(new Error("ps timed out"));
    }, timeoutMs);
    ps.stdout.on("data", (d: Buffer) => (out += d.toString()));
    ps.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on("close", () => {
      clearTimeout(timer);
      const procs = out
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number))
        .filter((f) => f.length === 2 && f.every(Number.isFinite))
        .map(([p, rss]) => ({ pid: p!, rss: rss! }));
      // ps exits non-zero once the process is gone; that is not a measuring failure.
      resolve(procs);
    });
  });
}

export class HardLinkError extends Error {
  constructor(readonly files: string[]) {
    super(`refusing to run: ${files.length} hard-linked file(s) in the allowed folders`);
  }
}

/**
 * Runs a command inside the sandbox with time, output and memory limits. Fails closed off macOS, and when an
 * allowed (non-trusted) folder holds a hard-linked file — the sandbox decides by path and could not tell it
 * from another family member's file.
 */
export function runIsolated(o: RunIsolatedOptions): Promise<RunResult> {
  if (process.platform !== "darwin") return Promise.reject(new SandboxUnavailableError());
  const linked = [...o.read, ...o.write].flatMap((p) => findHardLinks(canonicalPath(p)));
  if (linked.length) return Promise.reject(new HardLinkError(linked));
  const profile = buildProfile(o);
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, o.command, ...o.args], {
      cwd: o.cwd,
      env: o.env, // the whole environment — no inheritance
      detached: true, // own process group
      stdio: ["pipe", "pipe", "pipe"],
    });
    // sandbox-exec execs the command in place, and the profile forbids fork: this pid is the whole job.
    const pid = child.pid!;
    let out = "";
    let err = "";
    let bytes = 0;
    let killed: RunResult["killed"] = null;
    let exited = false;
    const kill = (why: NonNullable<RunResult["killed"]>) => {
      if (killed || exited) return;
      killed = why;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const take = (target: "out" | "err") => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > o.maxOutputBytes) return kill("output");
      if (target === "out") out += chunk.toString("utf8");
      else err += chunk.toString("utf8");
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    // The child may exit before reading its input (EPIPE): that is its failure, not the server's.
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => kill("timeout"), o.timeoutMs);

    let sampling = false;
    const sample = async () => {
      if (sampling || killed || exited) return;
      sampling = true;
      try {
        const procs = await (o.probe ?? (() => snapshot(pid)))();
        const me = procs.find((p) => p.pid === pid);
        if (!me) {
          if (!exited) kill("monitor"); // running but not measurable → cannot enforce → stop
        } else if (me.rss * 1024 > o.maxRssBytes!) kill("memory");
      } catch {
        kill("monitor");
      } finally {
        sampling = false;
      }
    };
    const monitor = o.maxRssBytes ? setInterval(() => void sample(), 250) : undefined;

    child.on("exit", () => {
      exited = true;
      clearTimeout(timer);
      clearInterval(monitor);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(monitor);
      reject(e);
    });
    child.on("close", (code, signal) => resolve({ code, signal, stdout: out, stderr: err, killed }));
    child.stdin.end(o.stdin ?? "");
  });
}

/** Builds a child environment from an allow-list of the server's variables plus explicit values. */
export function allowEnv(
  names: readonly string[],
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined) env[n] = v;
  }
  return { ...env, ...extra };
}
