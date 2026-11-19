import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { spawnIsolated, type SpawnIsolatedOptions } from "../isolation/sandbox.js";

/**
 * The headless browser behind PNG/PDF export (#51): Playwright's Chrome Headless Shell (the build pinned by the
 * repo's `@playwright/test`, installed with `pnpm exec playwright install --only-shell chromium`), started as its
 * own process for every render and driven over `--remote-debugging-pipe` (fd 3 in, fd 4 out — no listening port
 * another local process could use).
 */

/** Folder names of the shell inside a Playwright `chromium_headless_shell-<revision>` folder, per platform. */
const SHELL_DIRS: Record<string, string> = {
  "darwin-arm64": "chrome-headless-shell-mac-arm64",
  "darwin-x64": "chrome-headless-shell-mac-x64",
  "linux-x64": "chrome-headless-shell-linux64",
  "linux-arm64": "chrome-headless-shell-linux-arm64",
};

/** Playwright's browser cache: `PLAYWRIGHT_BROWSERS_PATH`, else its per-platform default. */
export function playwrightCache(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0")
    return env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright");
}

/**
 * The browser executable: `configured` (EXPORT_BROWSER) when given, else the newest completely installed
 * `chromium_headless_shell-<rev>` in Playwright's cache. Undefined when there is none (export is then off).
 */
export function findBrowser(configured?: string, cache = playwrightCache()): string | undefined {
  if (configured) return fs.existsSync(configured) ? fs.realpathSync(configured) : undefined;
  const dir = SHELL_DIRS[`${process.platform}-${process.arch}`];
  if (!dir) return undefined;
  let names: string[];
  try {
    names = fs.readdirSync(cache);
  } catch {
    return undefined;
  }
  const revs = names
    .map((n) => /^chromium_headless_shell-(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const m of revs) {
    const root = path.join(cache, m[0]);
    const exe = path.join(root, dir, "chrome-headless-shell");
    if (fs.existsSync(path.join(root, "INSTALLATION_COMPLETE")) && fs.existsSync(exe))
      return fs.realpathSync(exe);
  }
  return undefined;
}

/**
 * Command-line switches of every render. One process (`--single-process`: no renderer, GPU or network helper
 * processes — the sandbox forbids fork, and the memory limit then covers the whole browser). Chrome's own sandbox
 * is off because the process already runs inside ours (macOS does not nest seatbelt profiles). All traffic goes
 * to `proxy` (the allow-listed egress proxy), loopback included (`<-loopback>` removes Chrome's implicit bypass);
 * WebRTC may not send UDP around it. No background services (updates, sync, metrics, safe browsing).
 */
export function browserArgs(userDataDir: string, proxy: string | undefined): string[] {
  return [
    "--single-process",
    "--no-zygote",
    "--no-sandbox",
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--metrics-recording-only",
    "--no-pings",
    "--mute-audio",
    "--hide-scrollbars",
    // RenderDocument off (#103, #207): with it, a document that navigates itself (an artifact sending itself elsewhere,
    // its navigation then failing to an error page) could make this single-process shell end itself — "Terminating
    // renderer for bad IPC message, reason 262" (RFH_INACTIVE_CHECK_FROM_PENDING_COMMIT_RFH) — now and then on a
    // loaded machine: the render failed. Measured (macOS sandbox, loaded): 14 of 438 renders with it, 0 of 438 without.
    "--disable-features=site-per-process,IsolateOrigins,RenderDocument,Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,AutofillServerCommunication",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-quic",
    ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>"] : []),
    "about:blank",
  ];
}

export type LaunchSpec = {
  /** The browser executable (its folder is read-only and trusted: a program, not family data). */
  browser: string;
  args: string[];
  /** The complete environment (nothing inherited). */
  env: Record<string, string>;
  /** The render's own fresh folder: the only place the browser may write. */
  workDir: string;
  /** The server's open descriptor of the render's lock file (`makeRenderDir`): handed to the watchdog as its fd 5. */
  lockFd: number;
  /** Loopback port of the egress proxy: the browser's only network. */
  proxyPort: number;
  /** The watchdog's own wall-clock cap (`watchdogPrefix`): a backstop past the render's limit. */
  deadlineSec: number;
};

/** A started browser: its process (the watchdog) and the two debugging pipes (fd 3 = commands in, fd 4 = replies out). */
export type Launched = { child: ChildProcess; input: Writable; output: Readable };
export type Launcher = (spec: LaunchSpec) => Launched;

const pipes = (child: ChildProcess): Launched => ({
  child,
  input: child.stdio[3] as Writable,
  output: child.stdio[4] as Readable,
});

/** Prefix of every same-uid render folder (`mkdtemp`: six more characters). Nothing else is ever removed. */
export const RENDER_DIR_PREFIX = "agentlee-render-";
/**
 * The render's lock file: **beside** its folder (`<folder>.lock`, in the temp folder the browser cannot write — the
 * sandbox writes only the folder itself), so the browser can neither remove nor replace it. Created by the server
 * (`makeRenderDir`, exclusively), held (flock) by the watchdog and, inherited, by the browser while either lives.
 */
export const renderLockPath = (workDir: string) => `${workDir}.lock`;
/**
 * A render's folder and the server's open descriptor of its lock file (`-1` once closed — `removeRenderDir` closes it
 * exactly once). Kept open from creation to removal, it is the identity of the lock: the file it refers to cannot
 * be replaced by one that happens to reuse its inode while it is open.
 */
export type RenderDir = { workDir: string; lockFd: number };
/** The watchdog's descriptor of the lock (inherited from the server's, `lockFd`). */
export const WATCHDOG_LOCK_FD = 5;
/** Upper bound of the watchdog's own clock (monotonic), whatever the caller asks. */
export const WATCHDOG_MAX_SEC = 120;
/**
 * The watchdog's **own** exit codes (never the browser's): the browser ended by itself / the watchdog stopped it —
 * reaped in both cases; it was never started (arguments, lock); the watchdog's own exec of its direct child failed
 * (in production that child is `sandbox-exec`, so a profile `sandbox-exec` itself rejects is not this code — that
 * child then just ends). Any other end (a signal) means the watchdog itself was interrupted.
 */
export const WATCHDOG_EXIT = { done: 0, stopped: 3, notStarted: 4, execFailed: 5 } as const;
const PERL = "/usr/bin/perl";

/**
 * A fresh render folder (`mkdtemp`, our prefix) and its lock file beside it, created with
 * `O_CREAT | O_EXCL | O_NOFOLLOW` — never an object that was already there. On a name conflict (a lock file left
 * from an older folder of the same name) the folder is dropped and another name is tried.
 */
export function makeRenderDir(parent: string): RenderDir {
  const { O_RDONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  for (let i = 0; i < 5; i++) {
    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(parent, RENDER_DIR_PREFIX)));
    let fd: number;
    try {
      // Read-only: the browser inherits it, and an open descriptor is not limited by the sandbox's path rules.
      fd = fs.openSync(renderLockPath(workDir), O_RDONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch (e) {
      fs.rmdirSync(workDir);
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    return { workDir, lockFd: fd };
  }
  throw new Error("no free render folder name");
}

/** Whether the path is still the file the descriptor refers to (a regular file, same device and inode). */
function sameFile(p: string, fd: number) {
  try {
    const a = fs.lstatSync(p);
    const b = fs.fstatSync(fd);
    return a.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * Removes a render folder, then its lock file — only once the folder is confirmed gone (`ENOENT`), and only when the
 * lock path is still the file of the server's descriptor: `unlink`, never a recursive delete. A folder that could
 * not be removed keeps its lock, so the sweep tries again later. Closes the descriptor (once).
 */
export function removeRenderDir(dir: RenderDir) {
  try {
    fs.rmSync(dir.workDir, { recursive: true, force: true });
  } catch {
    // kept: its lock stays too (below)
  }
  if (dir.lockFd < 0) return;
  let goneDir = false;
  try {
    fs.lstatSync(dir.workDir);
  } catch (e) {
    goneDir = (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  const p = renderLockPath(dir.workDir);
  try {
    if (goneDir && sameFile(p, dir.lockFd)) fs.unlinkSync(p);
  } catch {
    // not ours to remove, or gone already
  }
  try {
    fs.closeSync(dir.lockFd);
  } catch {
    // already closed
  }
  dir.lockFd = -1;
}

/**
 * The render watchdog (#170) — a small Perl process **outside** the server that starts the browser as its direct
 * child and makes sure it never outlives the server.
 *  - The server spawns it as the leader of a new process group and session (`detached`); the browser stays in that
 *    group — **one** group, known to the server from the spawn on. The production sandbox forbids the browser to
 *    fork, so the browser is that one child, and the watchdog kills and reaps it by its pid (nothing is signalled
 *    after it is reaped).
 *  - It locks the render's lock file through the descriptor the server created it with (inherited as fd 5 — no path is
 *    opened, so nothing put at the path can be locked instead): a regular file of ours, flocked without waiting;
 *    anything else: not started. The browser inherits the lock and fd 3/4 (the debugging pipe).
 *  - Its stdin is a pipe the server holds and never writes: the kernel closes it when the server dies, however it
 *    dies (SIGKILL included). EOF there, a changed parent pid, or the cap on the monotonic clock (`deadlineSec`, at
 *    most `WATCHDOG_MAX_SEC`) → SIGKILL to the browser, reap. A close-on-exec status pipe, watched in the same loop,
 *    tells its own exec failing (`execFailed`) from a browser that exits 127.
 *  - TERM/INT/HUP only ask the loop to stop; the loop kills the child only while it is not yet reaped.
 *  - However the browser ends, the watchdog then removes the render folder (our name only, a real folder) and —
 *    only once the folder is gone — unlinks the lock path if it is still the file of fd 5, and exits with its own
 *    status.
 * argv: <owner pid> <deadline sec> <render folder> <command…>; fd 5: the lock.
 */
export const WATCHDOG_PL = String.raw`use strict; use POSIX (); use Errno ();
use Fcntl qw(:flock F_GETFD F_SETFD FD_CLOEXEC);
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC); use File::Path ();
my %X = (done => ${WATCHDOG_EXIT.done}, stopped => ${WATCHDOG_EXIT.stopped}, notStarted => ${WATCHDOG_EXIT.notStarted},
  execFailed => ${WATCHDOG_EXIT.execFailed});
my ($owner, $max, $dir, @cmd) = @ARGV;
POSIX::_exit($X{notStarted}) unless @cmd && $owner =~ /\A[0-9]{1,10}\z/ && $max =~ /\A[0-9]{1,4}\z/;
$max = ${WATCHDOG_MAX_SEC} if $max > ${WATCHDOG_MAX_SEC};
my $ours = $dir =~ m{/${RENDER_DIR_PREFIX}[A-Za-z0-9]{6}\z} && -d $dir && !-l $dir;
my $lp = "$dir.lock";
open(my $lock, "<&=", ${WATCHDOG_LOCK_FD}) or POSIX::_exit($X{notStarted});    # the server's descriptor (no path)
my @f = stat($lock);
POSIX::_exit($X{notStarted}) unless @f && -f _ && $f[4] == $<;
flock($lock, LOCK_EX | LOCK_NB) or POSIX::_exit($X{notStarted});
# perl marks a descriptor it opens close-on-exec: fd 5 (only) must reach the browser, so it holds the lock too.
my $fl = fcntl($lock, F_GETFD, 0);
POSIX::_exit($X{notStarted}) unless defined $fl && fcntl($lock, F_SETFD, $fl & ~FD_CLOEXEC);
$SIG{PIPE} = "IGNORE";
pipe(my $sr, my $sw) or POSIX::_exit($X{notStarted});    # close-on-exec (perl's default above fd 2)
my $pid = fork();
POSIX::_exit($X{notStarted}) unless defined $pid;
if ($pid == 0) {
  close($sr);
  open(STDIN, "<", "/dev/null") or POSIX::_exit(127);
  exec { $cmd[0] } @cmd;
  syswrite($sw, "E");
  POSIX::_exit(127);
}
close($sw);
POSIX::close(3); POSIX::close(4);
chdir("/");    # File::Path will not remove the current folder (the browser's cwd is the render folder)
my $t0 = clock_gettime(CLOCK_MONOTONIC);
my $finish = sub {
  my ($code) = @_;
  File::Path::remove_tree($dir) if $ours && -d $dir && !-l $dir;
  if (!lstat($dir) && $!{ENOENT}) {
    my @now = lstat($lp);
    unlink($lp) if @now && -f _ && $now[0] == $f[0] && $now[1] == $f[1];    # fd 5 is open: its inode is not reused
  }
  POSIX::_exit($code);
};
# The exec status: undef = not known yet, 1 = exec done (pipe closed), 0 = exec failed.
my $execd;
my $status = sub {
  my $r = sysread($sr, my $e, 1);
  return if !defined $r && ($!{EINTR} || $!{EAGAIN});
  $execd = (defined $r && $r == 0) ? 1 : 0;
  close($sr);
};
# Kills the child only while it is not reaped yet (a reaped pid may already be another process's).
my $stop = sub {
  kill("KILL", $pid) if waitpid($pid, POSIX::WNOHANG()) == 0;
  waitpid($pid, 0);
  $finish->($X{stopped});
};
my $asked = 0;
$SIG{$_} = sub { $asked = 1 } for qw(TERM INT HUP);
$SIG{CHLD} = sub { };
while (1) {
  $stop->() if $asked;
  my $g = waitpid($pid, POSIX::WNOHANG());
  if ($g == $pid) {
    $status->() unless defined $execd;    # the child is gone: its status byte (or EOF) is there now
    $finish->($execd ? $X{done} : $X{execFailed});
  }
  $stop->() if $g < 0 || getppid() != $owner;
  $stop->() if clock_gettime(CLOCK_MONOTONIC) - $t0 > $max;
  if (defined $execd && !$execd) { waitpid($pid, 0); $finish->($X{execFailed}); }    # it exits by itself (127)
  my $rin = ""; vec($rin, 0, 1) = 1;
  vec($rin, fileno($sr), 1) = 1 unless defined $execd;
  my $n = select(my $rout = $rin, undef, undef, 0.25);
  next unless defined $n && $n > 0;
  $status->() if !defined $execd && vec($rout, fileno($sr), 1);
  next unless vec($rout, 0, 1);
  my $r = sysread(STDIN, my $buf, 4096);
  $stop->() if defined $r ? $r == 0 : !($!{EINTR} || $!{EAGAIN});
}`;

/** argv before the browser's own: the watchdog, owned by this process, with the spec's cap, folder and lock. */
export function watchdogPrefix(s: LaunchSpec, owner = process.pid): string[] {
  return [PERL, "-e", WATCHDOG_PL, String(owner), String(s.deadlineSec), s.workDir];
}

/**
 * What the production launcher hands `spawnIsolated` — pure, so its policy (and the profile `buildProfile` makes
 * of it) is checked on every platform, Linux CI included: network = the proxy's loopback port only, reads = the
 * browser's own folder, writes = the render's folder, the given environment only, no fork (the profile never
 * allows it), the two debugging pipes — and the watchdog in front of `sandbox-exec` (outside the sandbox).
 */
export function rendererSandbox(s: LaunchSpec): SpawnIsolatedOptions {
  return {
    command: s.browser,
    args: s.args,
    cwd: s.workDir,
    env: s.env,
    read: [],
    trusted: [path.dirname(s.browser)],
    write: [s.workDir],
    network: { loopbackPorts: [s.proxyPort] },
    extraPipes: 2,
    wrap: watchdogPrefix(s),
    inheritFds: [s.lockFd],
  };
}

/**
 * The browser in the process sandbox (macOS, `isolation/sandbox.ts`): reads its own folder (plus the OS
 * libraries and fonts of `system.sb`), writes only the render's folder, cannot fork, and reaches only the egress
 * proxy's loopback port — a request that slips past every check in the browser is still refused by the kernel.
 * Throws `SandboxUnavailableError` elsewhere (export is then unavailable: fail closed).
 */
export const sandboxedLauncher: Launcher = (s) => {
  const child = spawnIsolated(rendererSandbox(s));
  // Nothing is read from stdout (stderr is drained by spawnIsolated): never let a full pipe block the browser.
  child.stdout.resume();
  return pipes(child);
};

/**
 * The same browser without the process sandbox — **tests only** (Linux CI has no sandbox-exec): everything in
 * the browser (switches, request interception, the egress proxy, the watchdog) is the same; the kernel layer is
 * missing. stdin is the watchdog's owner pipe (never written).
 */
export const unsandboxedLauncher: Launcher = (s) => {
  const [command, ...pre] = watchdogPrefix(s);
  const child = spawn(command!, [...pre, s.browser, ...s.args], {
    cwd: s.workDir,
    env: s.env,
    detached: true,
    stdio: ["pipe", "ignore", "ignore", "pipe", "pipe", s.lockFd],
  });
  child.stdin!.on("error", () => {});
  return pipes(child);
};

/**
 * Same-uid renders in this process (#170, #215). An entry is **live** from the spawn until the watchdog's exit is
 * seen — while live, its group id is the watchdog's own pid, not yet reaped, so the group is ours to signal. A render
 * whose reap was started stays as **reaping** after that, until its processes are confirmed gone (or the bound is
 * hit). `killLiveRenders` is the last word on shutdown (`closeRenderers` in `export.ts`: `exit`, SIGTERM/SIGINT in
 * `index.ts`; the tests' `afterAll`): it takes over both kinds.
 */
type RenderEntry = {
  pgid: number;
  dir: RenderDir;
  /** The reap has been started (with the one group SIGKILL, or — after the watchdog's own end — without). */
  signalled: boolean;
  /** The watchdog can fork no more: its exit was seen, or a listing showed it a zombie or gone. */
  leaderGone: boolean;
  /** The render's `finally` handed the folder over (`releaseRenderDir`): the reap removes it once confirmed. */
  ownsDir: boolean;
  /** The reap is over (confirmed, given up, or taken over by shutdown). */
  over: boolean;
  timer?: NodeJS.Timeout;
  /** Told when the reap is over (`renderReaped`). */
  waiters: (() => void)[];
  /** What `ps` prints of the watchdog's whole command line (`psEncode`); none when unknown. */
  cmdline?: string;
  /** What `ps` prints of the browser executable launched followed by a space, and of its profile switch. */
  browser?: { prefix: string; token: string };
};
const liveRenders = new Map<number, RenderEntry>();
const reaping = new Set<RenderEntry>();
/** Folders whose processes were never confirmed gone: kept with their lock (the sweep keeps them while held). */
const unconfirmed = new WeakSet<RenderDir>();

/**
 * Records a running render — `who`: the watchdog's command line as spawned (`child.spawnargs`) and the browser
 * executable launched, the two identities of its processes in a listing (#215). The returned function says its
 * watchdog has exited (call it once, on the exit). A render whose reap never started is then forgotten; one being
 * reaped stays until its reap is over.
 */
export function trackRender(
  pgid: number,
  dir: RenderDir,
  who: { argv?: readonly string[]; browser?: string } = {},
): () => void {
  const entry: RenderEntry = {
    pgid,
    dir,
    ...identities(who, dir.workDir),
    signalled: false,
    leaderGone: false,
    ownsDir: false,
    over: false,
    waiters: [],
  };
  liveRenders.set(pgid, entry);
  return () => {
    if (liveRenders.get(pgid) !== entry) return;
    liveRenders.delete(pgid);
    entry.leaderGone = true;
    if (entry.signalled && !entry.over) reaping.add(entry);
  };
}

/** A process as `ps` lists it. */
export type RenderProcess = { pid: number; pgid: number; zombie: boolean; args: string };

/** Every process (`ps`, full command lines: a control character in one is printed escaped, never as a new line). */
const PS_ARGS = ["axww", "-o", "pid=,pgid=,stat=,args="];
export function parsePs(out: string): RenderProcess[] {
  const rows: RenderProcess[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), zombie: m[3]!.startsWith("Z"), args: m[4]! });
  }
  return rows;
}
/** A finished `ps` run, as `spawnSync` reports it. */
export type PsRun = { status: number | null; signal?: NodeJS.Signals | null; error?: Error; stdout: string };
/**
 * The rows of a `ps` run — only of a **whole** one: it exited 0, by itself (no signal), with no error (a full buffer is
 * `ENOBUFS` with status 0 and the tail cut off), and its output ends with a complete line. Anything else is no listing
 * (undefined): never read as "the group is empty".
 */
export function psListing(r: PsRun): RenderProcess[] | undefined {
  if (r.error || r.signal || r.status !== 0 || typeof r.stdout !== "string" || !r.stdout.endsWith("\n"))
    return undefined;
  return parsePs(r.stdout);
}
/** `ps` in the C locale (#215): how it prints a byte then does not depend on the server's locale (`psEncode`). */
const PS_OPTS = { encoding: "utf8" as const, maxBuffer: 64 << 20, env: { LC_ALL: "C", LANG: "C" } };
const budget = (ms: number) => Math.max(1, Math.ceil(ms));
/** The listing, within `ms` (the caller's remaining budget); undefined when it failed, was cut or ran out of time. */
const listSync = (ms: number): RenderProcess[] | undefined => {
  if (reap.run) return psListing(reap.run(ms));
  const r = spawnSync("/bin/ps", PS_ARGS, { ...PS_OPTS, timeout: budget(ms) });
  return psListing({
    status: r.status,
    signal: r.signal,
    ...(r.error ? { error: r.error } : {}),
    stdout: r.stdout,
  });
};
const listAsync = (ms: number, done: (rows: RenderProcess[] | undefined) => void) => {
  if (reap.run) return done(psListing(reap.run(ms)));
  execFile("/bin/ps", PS_ARGS, { ...PS_OPTS, timeout: budget(ms) }, (e, out) =>
    done(psListing(e ? { status: null, error: e, stdout: String(out ?? "") } : { status: 0, stdout: out })),
  );
};

/** The reap's timing (and, tests only, its process list). */
const reap = {
  everyMs: 50,
  forMs: 5000,
  shutdownMs: 1000,
  list: undefined as ((ms: number) => RenderProcess[] | undefined) | undefined,
  /** Tests only: a given `ps` run (what `spawnSync`/`execFile` reported), judged like a real one. */
  run: undefined as ((ms: number) => PsRun) | undefined,
};
/** Tests only: other timing or a given process list; returns the restore. */
export function setRenderReapForTests(o: Partial<typeof reap>): () => void {
  const before = { ...reap };
  Object.assign(reap, o);
  return () => void Object.assign(reap, before);
}
let onIncomplete: ((count: number) => void) | undefined;
/** Told how many renders were given up on at once (never a path): the app logs it. */
export function onRenderReapIncomplete(fn: ((count: number) => void) | undefined) {
  onIncomplete = fn;
}

/**
 * Exactly what this platform's `ps` prints of `text` (part of a command line) in the C locale it is run in
 * (`PS_OPTS`) — one deterministic encoding, compared as plain strings (#215). Undefined on a platform it is not known
 * for: nothing is then attributed (never signalled).
 *  - macOS (`/bin/ps`, `vis` in the C locale; checked against the real output for every byte valid UTF-8 can hold):
 *    printable ASCII as it is (the backslash too); tab and new line as octal (`\011`, `\012`); any other control
 *    character as `^X`, DEL as `^?`; a byte above 0x7f as `M-x` (its low seven bits printable), `M^X` / `M^?` (a
 *    control), or `\240` (0xa0).
 *  - Linux (procps, C locale; checked byte by byte on the CI's Ubuntu): printable ASCII as it is; a new line as a
 *    space; any other control character and DEL as `.`; a byte above 0x7f as `?`.
 */
export function psEncode(text: string, platform: string = process.platform): string | undefined {
  return psEncodeBytes(Buffer.from(text, "utf8"), platform);
}
/** `psEncode` of raw bytes (an argv is bytes; tests check every byte value against the real `ps`). */
export function psEncodeBytes(bytes: Uint8Array, platform: string = process.platform): string | undefined {
  if (platform !== "darwin" && platform !== "linux") return undefined;
  let out = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else if (platform === "linux") out += b === 0x0a ? " " : b < 0x80 ? "." : "?";
    else if (b === 0x09 || b === 0x0a) out += `\\0${b.toString(8).padStart(2, "0")}`;
    else if (b < 0x20) out += `^${String.fromCharCode(b + 0x40)}`;
    else if (b === 0x7f) out += "^?";
    else {
      const m = b & 0x7f;
      if (m < 0x20) out += `M^${String.fromCharCode(m + 0x40)}`;
      else if (m === 0x7f) out += "M^?";
      else if (m === 0x20) out += "\\240";
      else out += `M-${String.fromCharCode(m)}`;
    }
  }
  return out;
}

/** A render's two identities as `ps` prints them, worked out once (`trackRender`). */
function identities(
  who: { argv?: readonly string[]; browser?: string },
  workDir: string,
): Pick<RenderEntry, "cmdline" | "browser"> {
  const cmdline = who.argv?.length ? psEncode(who.argv.join(" ")) : undefined;
  const exe = who.browser ? psEncode(who.browser) : undefined;
  const token = psEncode(`--user-data-dir=${workDir}/profile`);
  return {
    ...(cmdline !== undefined ? { cmdline } : {}),
    ...(exe !== undefined && token !== undefined ? { browser: { prefix: `${exe} `, token } } : {}),
  };
}

/**
 * Whether a process is provably this render's (#215). `ps` joins argv with spaces, so no single argument can be told
 * apart in it; two identities only, both as `ps` prints them (`psEncode`) and compared as plain strings:
 *  - the browser: its command line starts with the executable launched (argv[0]) and a space, and has
 *    `--user-data-dir=<folder>/profile` as a space-bounded token (the folder is `agentlee-render-XXXXXX`, random);
 *  - the watchdog and a child it forked before exec: its **whole** command line exactly as it was spawned.
 * Anything else in the group is unattributed: never signalled (it keeps the reap from completing) — so is anything the
 * check fails on. What remains indistinguishable: a process in the same group, of the same executable, with the exact
 * switch inside one of its arguments — only something that runs the browser binary in the render's own group; on
 * Linux, where `ps` prints lossily, a literal space, `.` or `?` where the expected text has a new line, another control
 * character or a non-ASCII byte.
 */
function ours(e: RenderEntry, row: RenderProcess): boolean {
  try {
    const args = row.args;
    if (e.cmdline !== undefined && args === e.cmdline) return true;
    const b = e.browser;
    return !!b && args.startsWith(b.prefix) && ` ${args} `.includes(` ${b.token} `);
  } catch {
    return false;
  }
}

/**
 * One reap step on a listing taken at `startedGoneLeader` (whether the watchdog was known unable to fork before the
 * listing began). Kills the members that are provably ours (`ours`; the deadline checked again before each kill);
 * a live member of the group that cannot be attributed (unreadable arguments, `[chrome-headless-shell]`, anything
 * else) is never signalled — it only keeps the reap from completing. Complete (true) only when the watchdog could fork
 * no more before this listing **and** the listing shows no live process of the group at all.
 */
function reapStep(e: RenderEntry, rows: RenderProcess[], leaderWasGone: boolean, deadline: number): boolean {
  const group = rows.filter((r) => !r.zombie && r.pgid === e.pgid);
  if (!group.some((r) => r.pid === e.pgid)) e.leaderGone = true; // a zombie or gone: no more forks
  for (const r of group) {
    if (!ours(e, r)) continue;
    if (performance.now() >= deadline) break;
    try {
      process.kill(r.pid, "SIGKILL");
    } catch {
      // gone meanwhile
    }
  }
  return leaderWasGone && group.length === 0;
}

/** The reap is over: confirmed (the folder goes, if handed over) or not (folder and lock kept, counted). */
function endReap(e: RenderEntry, confirmed: boolean) {
  e.over = true;
  if (e.timer) clearTimeout(e.timer);
  reaping.delete(e);
  if (liveRenders.get(e.pgid) === e) liveRenders.delete(e.pgid);
  if (!confirmed) unconfirmed.add(e.dir);
  if (e.ownsDir) releaseRenderDir(e.dir);
  for (const w of e.waiters.splice(0)) w();
}

/**
 * Resolves once the render of this folder has no reap going (at once when it was never started): the render's
 * `finally` waits for it, so a render is over only when its processes are confirmed gone or given up on (bounded by
 * the reap's own deadline).
 */
export function renderReaped(dir: RenderDir): Promise<void> {
  const e = [...reaping, ...liveRenders.values()].find((x) => x.dir === dir && x.signalled && !x.over);
  return e ? new Promise((r) => e.waiters.push(r)) : Promise.resolve();
}

/**
 * The reap (#215). On macOS a group SIGKILL landing while the watchdog is inside `fork` kills the watchdog but can miss
 * the child being made, which then execs the browser (PPID 1, same group). So the render's processes are listed every
 * `everyMs` and its own (`ours`) killed by pid, until a listing taken after the watchdog's end shows the group empty.
 * The group id itself is never signalled here (once its leader is reaped it may be anyone's). The deadline (`forMs`)
 * bounds each listing (its timeout is what is left) and is checked again before each kill; a listing that returns past
 * it ends the reap as given up (`onRenderReapIncomplete`): folder and lock kept.
 */
function startReap(e: RenderEntry) {
  const deadline = performance.now() + reap.forMs;
  const giveUp = () => {
    endReap(e, false);
    onIncomplete?.(1);
  };
  const step = () => {
    if (e.over) return;
    const left = deadline - performance.now();
    if (left <= 0) return giveUp();
    const leaderWasGone = e.leaderGone;
    const go = (rows: RenderProcess[] | undefined) => {
      if (e.over) return;
      if (performance.now() >= deadline) return giveUp();
      if (rows && reapStep(e, rows, leaderWasGone, deadline)) return endReap(e, true);
      e.timer = setTimeout(step, reap.everyMs).unref();
    };
    if (reap.list) go(reap.list(left));
    else listAsync(left, go);
  };
  e.timer = setTimeout(step, reap.everyMs).unref();
}

/**
 * SIGKILLs a live render's process group (the watchdog's, the browser in it) — **once**, and only while the watchdog's
 * exit has not been seen (its pid, the group id, is not reaped yet) — and starts its reap. The render's limits and
 * shutdown come here; whichever is first sends the one signal. An untracked group is never signalled.
 */
export function signalRender(pgid: number) {
  const entry = liveRenders.get(pgid);
  if (!entry || entry.signalled) return;
  entry.signalled = true;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
  startReap(entry);
}

/**
 * The watchdog ended abnormally (a signal — its exit already seen, so it is reaped and its pid, the group id, may be
 * anyone's): **no** group signal; the reap alone (by pid, `ours`) — unless one is already going.
 */
export function reapAfterWatchdog(pgid: number) {
  const entry = liveRenders.get(pgid);
  if (!entry || entry.signalled) return;
  entry.signalled = true;
  entry.leaderGone = true;
  startReap(entry);
}

/**
 * The render's own clean-up of its folder (its `finally`): removed now — unless its reap is still going (then the
 * reap removes it once its processes are confirmed gone), or they never were (then the folder and its lock stay for the
 * sweep, which keeps them while the lock is held; only the server's descriptor is closed).
 */
export function releaseRenderDir(dir: RenderDir) {
  const e = [...reaping].find((x) => x.dir === dir);
  if (e && !e.over) {
    e.ownsDir = true;
    return;
  }
  if (unconfirmed.has(dir)) {
    try {
      if (dir.lockFd >= 0) fs.closeSync(dir.lockFd);
    } catch {
      // already closed
    }
    dir.lockFd = -1;
    return;
  }
  removeRenderDir(dir);
}

const pause = new Int32Array(new SharedArrayBuffer(4));
/**
 * Shutdown (synchronous: safe in an `exit` hook, which runs no timer): SIGKILLs the group of every live render whose
 * reap has not started, takes over every reap in progress, and reaps them all in place (one listing per step, its
 * timeout and each pause what is left of `shutdownMs`, the deadline checked again before each kill). Confirmed renders
 * lose their folders; any left past the deadline keep folder and lock and are counted (`onRenderReapIncomplete`).
 * Returns how many renders were live.
 */
export function killLiveRenders(): number {
  const live = [...liveRenders.values()];
  for (const e of live) {
    if (!e.signalled) {
      e.signalled = true;
      try {
        process.kill(-e.pgid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  const all = [...live.filter((e) => !e.over), ...[...reaping].filter((e) => !e.over)];
  for (const e of all) {
    if (e.timer) clearTimeout(e.timer);
    e.ownsDir = true; // shutdown removes the folders (a render's own `finally` may never run)
  }
  const deadline = performance.now() + reap.shutdownMs;
  let left = all;
  for (;;) {
    const remaining = deadline - performance.now();
    if (!left.length || remaining <= 0) break;
    const wasGone = new Map(left.map((e) => [e, e.leaderGone]));
    const rows = (reap.list ?? listSync)(remaining);
    if (performance.now() >= deadline) break;
    if (rows) {
      const done = left.filter((e) => reapStep(e, rows, wasGone.get(e)!, deadline));
      for (const e of done) endReap(e, true);
      left = left.filter((e) => !done.includes(e));
    }
    const pauseMs = Math.min(10, deadline - performance.now());
    if (left.length && pauseMs > 0) Atomics.wait(pause, 0, 0, pauseMs);
  }
  for (const e of left) endReap(e, false);
  if (left.length) onIncomplete?.(left.length);
  liveRenders.clear();
  return live.length;
}

/** How many renders are tracked as live (tests). */
export const liveRenderCount = () => liveRenders.size;
/** How many reaps are still going (tests). */
export const reapingRenderCount = () => reaping.size;

/**
 * Folders younger than this are never swept (far past `WATCHDOG_MAX_SEC`). The server sweeps at start and again every
 * `SWEEP_GRACE_SEC` (`startRenderSweeps`), so a folder too young at one sweep is looked at again later.
 */
export const SWEEP_GRACE_SEC = 600;
/** One sweep's time budget: past it the sweep stops and the next one resumes after the last name it judged. */
export const SWEEP_BUDGET_SEC = 45;

/**
 * The sweep — deliberately small (review #201 round 3). One proof of disuse only: the render's lock file beside its
 * folder exists, is a regular file of our uid, is the same file (device + inode) on the path and on the descriptor
 * (opened without following a link or blocking), can be flocked without waiting, and is still the same file on the
 * path once locked. Then — and only for our prefix, real folders of our uid (no symlinks), older than `graceSec`,
 * the folder checked to be the one judged — the folder is removed, then the lock (still the file held). A lock file
 * whose folder is gone is reclaimed by the same proof.
 * A folder **without** a lock file (a render from before the watchdog, or a server that died between `mkdtemp` and
 * its lock) is never removed — it is only counted (the server logs the count; removing them is a manual step,
 * `docs/ops.md` §18.4). No process is killed; nothing is matched by name.
 * Bounded by itself: a budget (monotonic) after which it stops between names and prints where it got to; an alarm a
 * little past that; its owner — stdin is a pipe the server holds, so EOF or a changed parent pid stops it before the
 * next name.
 * argv: <root> <grace sec> <owner pid> <resume after name or -> <budget sec>.
 * Prints "<removed> <kept without lock> <resume after, or ->".
 */
export const SWEEP_PL = String.raw`use strict; use POSIX (); use Errno ();
use Fcntl qw(:flock O_RDONLY O_NOFOLLOW O_NONBLOCK); use File::Path ();
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC);
my ($root, $grace, $owner, $after, $budget) = @ARGV;
$budget = ${SWEEP_BUDGET_SEC} unless defined $budget && $budget =~ /\A[0-9]{1,4}\z/;
$after = "-" unless defined $after && length $after;
$SIG{ALRM} = sub { POSIX::_exit(124); };
alarm($budget + 15);
my $t0 = clock_gettime(CLOCK_MONOTONIC);
my ($n, $lockless, $last) = (0, 0, "-");
my $finish = sub { print "$n $lockless $_[0]\n"; exit 0; };
opendir(my $dh, $root) or $finish->("-");
my @names = sort grep { /\A${RENDER_DIR_PREFIX}[A-Za-z0-9]{6}(?:\.lock)?\z/ } readdir($dh);
closedir($dh);
my $old = time() - $grace;
# The owner still wants this sweep: same parent, and its pipe neither closed nor written to.
sub wanted {
  return 0 if $owner =~ /\A[0-9]+\z/ && getppid() != $owner;
  my $rin = ""; vec($rin, 0, 1) = 1;
  my $k = select(my $rout = $rin, undef, undef, 0);
  return !(defined $k && $k > 0);
}
sub same { my ($x, $y) = @_; return @$x && @$y && $x->[0] == $y->[0] && $x->[1] == $y->[1]; }
# The proof: a locked handle and the lock's stat, or nothing (keep).
sub take_lock {
  my ($l) = @_;
  my @st = lstat($l);
  return () unless @st && -f _ && $st[4] == $< && $st[9] <= $old;
  sysopen(my $fh, $l, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or return ();
  my @f = stat($fh);
  return () unless @f && -f _ && same(\@f, \@st);
  flock($fh, LOCK_EX | LOCK_NB) or return ();
  my @again = lstat($l);
  return () unless same(\@again, \@st);
  return ($fh, \@st);
}
sub drop { my ($st, $l) = @_; my @now = lstat($l); unlink($l) if @now && -f _ && same(\@now, $st); }
# Names after the resume point first, then the rest: a slow name never starves the ones behind it.
my @order = $after eq "-" ? @names : ((grep { $_ gt $after } @names), (grep { $_ le $after } @names));
my $seen = 0;
for my $e (@order) {
  $finish->("-") unless wanted();
  $finish->($last) if $seen++ && clock_gettime(CLOCK_MONOTONIC) - $t0 > $budget;
  $last = $e;
  my $p = "$root/$e";
  if ($e =~ /\.lock\z/) {
    # A lock left without its folder.
    (my $d = $p) =~ s/\.lock\z//;
    next if lstat($d) || !$!{ENOENT};
    my ($fh, $st) = take_lock($p) or next;
    drop($st, $p) if !lstat($d) && $!{ENOENT};
    next;
  }
  my @st = lstat($p);
  next unless @st && -d _ && !-l _ && $st[4] == $< && $st[9] <= $old;
  if (!lstat("$p.lock")) { $lockless++ if $!{ENOENT}; next; }
  my ($fh, $lst) = take_lock("$p.lock") or next;
  my @again = lstat($p);
  next unless @again && -d _ && !-l _ && same(\@again, \@st);
  File::Path::remove_tree($p);
  next if lstat($p) || !$!{ENOENT};    # still there, or unknown: the lock stays (next sweep)
  drop($lst, "$p.lock");
  $n++;
}
$finish->("-");`;

export type SweepResult = { removed: number; lockless: number; next?: string };
/** Sweep knobs (tests: short budgets, a resume point). */
export type SweepOptions = { graceSec?: number; after?: string; budgetSec?: number };

/** One sweep run: its result, and a way to stop it (its process group). */
function runSweep(root: string, o: SweepOptions = {}) {
  const budgetSec = o.budgetSec ?? SWEEP_BUDGET_SEC;
  let child: ChildProcess | undefined;
  const kill = () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const none: SweepResult = { removed: 0, lockless: 0 };
  const done = new Promise<SweepResult>((resolve) => {
    let out = "";
    try {
      child = spawn(
        PERL,
        [
          "-e",
          SWEEP_PL,
          fs.realpathSync(root),
          String(o.graceSec ?? SWEEP_GRACE_SEC),
          String(process.pid),
          o.after ?? "-",
          String(budgetSec),
        ],
        // Its own group (a stop takes all of it); stdin = the owner pipe (never written).
        { env: {}, detached: true, stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch {
      return resolve(none);
    }
    child.stdin!.on("error", () => {});
    // The server's own bound, past the sweep's (it also bounds itself, should this process die first).
    const timer = setTimeout(kill, (budgetSec + 20) * 1000);
    timer.unref();
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(none);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const m = /^(\d+) (\d+) (\S+)\n?$/.exec(out);
      if (!m) return resolve(none);
      resolve({
        removed: Number(m[1]),
        lockless: Number(m[2]),
        ...(m[3] !== "-" ? { next: m[3] } : {}),
      });
    });
  });
  return { done, cancel: kill };
}

/** One sweep of `root` (default: the OS temp folder). Never throws; zeros when perl is missing or anything fails. */
export function sweepRenderDirs(root = os.tmpdir(), o: SweepOptions = {}): Promise<SweepResult> {
  return runSweep(root, o).done;
}

/** How long `stop` waits for a cancelled sweep to be gone (it is SIGKILLed: normally milliseconds). */
export const SWEEP_STOP_WAIT_MS = 2000;

/**
 * The server's sweeps: now, then every `everyMs`, each resuming where a sweep that ran out of budget stopped;
 * `onResult` gets each result (the app logs folders kept for want of a lock). Returns `stop`: no more sweeps, the
 * running one (if any) is killed — its group — and awaited, at most `SWEEP_STOP_WAIT_MS`.
 */
export function startRenderSweeps(
  root = os.tmpdir(),
  everyMs = SWEEP_GRACE_SEC * 1000,
  o: Omit<SweepOptions, "after"> & { onResult?: (r: SweepResult) => void } = {},
) {
  let current: ReturnType<typeof runSweep> | undefined;
  let after: string | undefined;
  let stopped = false;
  const once = () => {
    if (current || stopped) return;
    const run = runSweep(root, { ...o, ...(after ? { after } : {}) });
    current = run;
    void run.done.then((r) => {
      after = r.next;
      current = undefined;
      if (!stopped) o.onResult?.(r);
    });
  };
  once();
  const timer = setInterval(once, everyMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    const run = current;
    if (!run) return;
    run.cancel();
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([
      run.done,
      new Promise<void>((r) => {
        wait = setTimeout(r, SWEEP_STOP_WAIT_MS);
        wait.unref();
      }),
    ]);
    clearTimeout(wait);
  };
}

/**
 * A DevTools protocol reply or event, after `parseMessage`. Everything on the pipe comes from the browser, which
 * runs untrusted documents in its own process (`--single-process --no-sandbox`): a compromised renderer controls
 * fd 4. So every message is checked before use, and anything malformed ends that render — never the server.
 */
export type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The shape of one pipe message, or undefined when it is not one (wrong JSON type, field types, neither kind). */
export function parseMessage(text: string): Message | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(v)) return undefined;
  const m: Message = {};
  if (v.id !== undefined) {
    if (!Number.isSafeInteger(v.id) || (v.id as number) < 1) return undefined;
    m.id = v.id as number;
  }
  if (v.method !== undefined) {
    if (typeof v.method !== "string") return undefined;
    m.method = v.method;
  }
  if (v.sessionId !== undefined) {
    if (typeof v.sessionId !== "string") return undefined;
    m.sessionId = v.sessionId;
  }
  for (const k of ["params", "result"] as const)
    if (v[k] !== undefined) {
      const x = v[k];
      if (!isObject(x)) return undefined;
      m[k] = x;
    }
  if (v.error !== undefined) m.error = v.error;
  // A reply has an id; an event has a method; nothing else is a message.
  if ((m.id === undefined) === (m.method === undefined)) return undefined;
  return m;
}

export class CdpError extends Error {
  constructor(readonly code: "closed" | "too_large" | "protocol") {
    super(`cdp ${code}`);
  }
}

/** A promise whose rejection is never "unhandled" (the caller may await it later — or not at all). */
function quiet<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/**
 * DevTools protocol over the debugging pipe: NUL-separated JSON messages. Incoming bytes are bounded
 * (`maxBytes` per message): a reply larger than that (a huge screenshot) closes the connection. A malformed
 * message, or a listener that throws on one, closes it too (`protocol`); the render then fails and its process
 * is killed. No promise of this class can reject unhandled (`quiet`), so a browser that dies at any moment
 * cannot take the server down.
 */
export class CdpPipe {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (r: Message) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(m: Message) => void>();
  private chunks: Buffer[] = [];
  private size = 0;
  private closed: CdpError | undefined;
  private readonly waiters = new Set<(e: CdpError) => void>();
  private readonly closeHandlers = new Set<(e: CdpError) => void>();

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly maxBytes: number,
  ) {
    output.on("data", (d: Buffer) => {
      try {
        this.take(d);
      } catch {
        this.close(new CdpError("protocol"));
      }
    });
    output.on("error", () => this.close(new CdpError("closed")));
    output.on("close", () => this.close(new CdpError("closed")));
    input.on("error", () => this.close(new CdpError("closed")));
  }

  private take(d: Buffer) {
    if (this.closed) return;
    let start = 0;
    for (let i = d.indexOf(0); i !== -1; i = d.indexOf(0, start)) {
      this.chunks.push(d.subarray(start, i));
      this.size += i - start;
      if (this.size > this.maxBytes) return this.close(new CdpError("too_large"));
      const text = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = [];
      this.size = 0;
      start = i + 1;
      const m = parseMessage(text);
      if (!m) return this.close(new CdpError("protocol"));
      this.dispatch(m);
      if (this.closed) return;
    }
    const rest = d.subarray(start);
    this.size += rest.length;
    if (this.size > this.maxBytes) return this.close(new CdpError("too_large"));
    if (rest.length) this.chunks.push(rest);
  }

  private dispatch(m: Message) {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      // A reply to nothing we asked: the other side is not following the protocol.
      if (!p) return this.close(new CdpError("protocol"));
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new CdpError("protocol"));
      else p.resolve(m);
      return;
    }
    for (const l of [...this.listeners]) {
      try {
        l(m);
      } catch {
        return this.close(new CdpError("protocol"));
      }
    }
  }

  /** Why the connection ended, if it did. */
  get error(): CdpError | undefined {
    return this.closed;
  }

  /** Called once when the connection ends (the renderer kills the process on a protocol error). */
  onClose(fn: (e: CdpError) => void) {
    if (this.closed) fn(this.closed);
    else this.closeHandlers.add(fn);
  }

  close(e: CdpError) {
    if (this.closed) return;
    this.closed = e;
    this.chunks = [];
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    for (const w of this.waiters) w(e);
    this.waiters.clear();
    for (const h of this.closeHandlers) h(e);
    this.closeHandlers.clear();
  }

  /** One command; resolves with its `result` object (`{}` when there is none). */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.closed) return quiet(Promise.reject<Record<string, unknown>>(this.closed));
    const id = this.next++;
    return quiet(
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(id, { resolve: (m) => resolve(m.result ?? {}), reject });
        this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      }),
    );
  }

  /** Calls `fn` for every event (until the returned function is called). */
  on(fn: (m: Message) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The next event `method` (of `sessionId`); rejects when the connection ends first. */
  wait(method: string, sessionId?: string) {
    return quiet(
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (this.closed) return reject(this.closed);
        const fail = (e: CdpError) => {
          off();
          reject(e);
        };
        this.waiters.add(fail);
        const off = this.on((m) => {
          if (m.method === method && (!sessionId || m.sessionId === sessionId)) {
            off();
            this.waiters.delete(fail);
            resolve(m.params ?? {});
          }
        });
      }),
    );
  }
}
