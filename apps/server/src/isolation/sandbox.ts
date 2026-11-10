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
  /**
   * Whether the process may create child processes. Off by default: a single process cannot escape the limits.
   * When on (runtime CLIs that start our MCP server), descendants are tracked and killed with it.
   */
  allowFork?: boolean;
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
  /** Resident memory limit for the process and all its descendants (checked every 250 ms). */
  maxRssBytes?: number;
  stdin?: string;
  /** Tests only: replaces the `ps` snapshot used by the monitor. */
  probe?: () => Promise<{ pid: number; ppid: number; pgid: number; rss: number }[]>;
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
    ...(policy.allowFork ? ["(allow process-fork)"] : []),
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

export type Proc = { pid: number; ppid: number; pgid: number; rss: number };

/** One `ps` snapshot. Rejects when ps fails, times out or prints nothing usable. */
export function snapshot(timeoutMs = 2000): Promise<Proc[]> {
  return new Promise((resolve, reject) => {
    const ps = spawn("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,rss="], { env: {} });
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
    ps.on("close", (code) => {
      clearTimeout(timer);
      const procs = out
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number))
        .filter((f) => f.length === 4 && f.every(Number.isFinite))
        .map(([pid, ppid, pgid, rss]) => ({ pid: pid!, ppid: ppid!, pgid: pgid!, rss: rss! }));
      if (code !== 0 || !procs.length) reject(new Error("ps failed"));
      else resolve(procs);
    });
  });
}

/** The process and everything that descends from it — by parent links, so leaving the process group does not help. */
export function descendants(root: number, procs: Proc[], known: Set<number>): Set<number> {
  const set = new Set<number>([root, ...known].filter((pid) => procs.some((p) => p.pid === pid)));
  for (const p of procs) if (p.pgid === root) set.add(p.pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs)
      if (!set.has(p.pid) && set.has(p.ppid)) {
        set.add(p.pid);
        grew = true;
      }
  }
  return set;
}

/** Runs a command inside the sandbox with time, output and memory limits. Fails closed off macOS. */
export function runIsolated(o: RunIsolatedOptions): Promise<RunResult> {
  if (process.platform !== "darwin") return Promise.reject(new SandboxUnavailableError());
  const profile = buildProfile(o);
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, o.command, ...o.args], {
      cwd: o.cwd,
      env: o.env, // the whole environment — no inheritance
      detached: true, // own process group
      stdio: ["pipe", "pipe", "pipe"],
    });
    const root = child.pid!;
    let out = "";
    let err = "";
    let bytes = 0;
    let killed: RunResult["killed"] = null;
    /** Every descendant seen so far — killed with the process even if it left the group or was orphaned. */
    const known = new Set<number>([root]);

    const killAll = () => {
      try {
        process.kill(-root, "SIGKILL");
      } catch {
        // group already gone
      }
      for (const pid of known)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
    };
    const kill = (why: NonNullable<RunResult["killed"]>) => {
      if (killed) return;
      killed = why;
      killAll();
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
      if (sampling || killed) return;
      sampling = true;
      try {
        const procs = await (o.probe ?? snapshot)();
        const tree = descendants(root, procs, known);
        for (const pid of tree) known.add(pid);
        const kb = procs.filter((p) => tree.has(p.pid)).reduce((a, p) => a + p.rss, 0);
        if (o.maxRssBytes && kb * 1024 > o.maxRssBytes) kill("memory");
      } catch {
        kill("monitor"); // cannot measure → cannot enforce → stop
      } finally {
        sampling = false;
      }
    };
    const monitor = o.maxRssBytes || o.allowFork ? setInterval(() => void sample(), 250) : undefined;

    // When the process exits, nothing may outlive it: find any remaining descendants and kill them all.
    // (Their kill also closes pipes they kept open, so "close" — and the result — can follow.)
    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      clearTimeout(timer);
      clearInterval(monitor);
      void (async () => {
        if (o.allowFork) {
          try {
            for (const pid of descendants(root, await snapshot(), known)) known.add(pid);
          } catch {
            // best effort; everything already known is still killed
          }
        }
        killAll();
      })();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(monitor);
      reject(e);
    });
    child.on("close", () => resolve({ ...exit, stdout: out, stderr: err, killed }));
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
