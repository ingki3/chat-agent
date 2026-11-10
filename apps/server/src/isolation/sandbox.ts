import { spawn } from "node:child_process";
import { canonicalPath } from "../fs-safety.js";

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
  /** Resident memory limit (checked every 250 ms; the process group is killed above it). */
  maxRssBytes?: number;
  stdin?: string;
};

export type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  killed: null | "timeout" | "output" | "memory";
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
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    `(allow process-exec ${exec.map((p) => `(literal ${lit(p)})`).join(" ")})`,
    ...exec.map((p) => `(allow file-read* (literal ${lit(p)}))`),
    ...read.map((p) => `(allow file-read* (subpath ${lit(p)}))`),
    ...write.map((p) => `(allow file-read* file-write* (subpath ${lit(p)}))`),
  ];
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

/** Runs a command inside the sandbox with time, output and memory limits. Fails closed off macOS. */
export function runIsolated(o: RunIsolatedOptions): Promise<RunResult> {
  if (process.platform !== "darwin") return Promise.reject(new SandboxUnavailableError());
  const profile = buildProfile(o);
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, o.command, ...o.args], {
      cwd: o.cwd,
      env: o.env, // the whole environment — no inheritance
      detached: true, // own process group, so limits kill grandchildren too
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let bytes = 0;
    let killed: RunResult["killed"] = null;
    const kill = (why: NonNullable<RunResult["killed"]>) => {
      if (killed) return;
      killed = why;
      try {
        process.kill(-child.pid!, "SIGKILL");
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
    const timer = setTimeout(() => kill("timeout"), o.timeoutMs);
    const mem = o.maxRssBytes
      ? setInterval(() => {
          // Sum the resident memory of the whole process group (the child is its leader).
          const ps = spawn("/bin/ps", ["-A", "-o", "pgid=,rss="], { env: {} });
          let s = "";
          ps.stdout.on("data", (d: Buffer) => (s += d.toString()));
          ps.on("close", () => {
            let kb = 0;
            for (const line of s.split("\n")) {
              const [pgid, rss] = line.trim().split(/\s+/);
              if (Number(pgid) === child.pid) kb += Number(rss) || 0;
            }
            if (kb * 1024 > o.maxRssBytes!) kill("memory");
          });
        }, 250)
      : undefined;
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(mem);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(mem);
      resolve({ code, signal, stdout: out, stderr: err, killed });
    });
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
