import { spawn, type ChildProcess } from "node:child_process";
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
    "--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,AutofillServerCommunication",
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
  /** Loopback port of the egress proxy: the browser's only network. */
  proxyPort: number;
  /** The watchdog's own wall-clock cap (`watchdogPrefix`): a backstop past the render's limit. */
  deadlineSec: number;
};

/** A started browser: its process and the two debugging pipes (fd 3 = commands in, fd 4 = replies out). */
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
 * sandbox writes only the folder itself), so the browser can neither remove nor replace it. Held (flock) by the
 * watchdog and, inherited, by the browser while either lives.
 */
export const renderLockPath = (workDir: string) => `${workDir}.lock`;
/** Upper bound of the watchdog's own clock (monotonic), whatever the caller asks. */
export const WATCHDOG_MAX_SEC = 120;
const PERL = "/usr/bin/perl";
const LSOF = "/usr/sbin/lsof";

/**
 * The render watchdog (#170) — a small Perl process **outside** the server that starts the browser as its own child
 * and makes sure it never outlives the server. The server spawns it as the leader of a new process group
 * (`detached`); the browser is forked into that same group, gets fd 3/4 (the debugging pipe) and nothing else of
 * the watchdog. The watchdog's stdin is a pipe the server holds and never writes: the kernel closes it when the
 * server dies, however it dies (SIGKILL included), and EOF there — or a changed parent pid — means the owner is gone:
 * the browser is killed (SIGKILL, reaped), the whole group killed. A cap on the monotonic clock (`deadlineSec`, at
 * most `WATCHDOG_MAX_SEC` — a changed wall clock does not move it) kills it even while the server lives but stopped
 * doing so itself (a blocked event loop). However the browser ends — by itself (after the server has its bytes over
 * the pipe and asked it to close), killed, or orphaned — the watchdog removes the render folder (our name only, a
 * real folder) and its lock file before it exits: the server dying right after a render leaves nothing behind.
 * The flocked lock file (`renderLockPath`) is inherited by the browser: the lock is free only once both are gone —
 * the proof the sweep (`sweepRenderDirs`) needs. A watchdog killed by itself is the server's to clean up (`export.ts`:
 * an abnormal watchdog exit kills what is left of its group).
 * argv: <owner pid> <deadline sec> <render folder> <command…>
 */
export const WATCHDOG_PL = String.raw`use strict; use POSIX (); use Errno ();
use Fcntl qw(:flock F_GETFD F_SETFD FD_CLOEXEC O_WRONLY O_CREAT O_NOFOLLOW);
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC); use File::Path ();
my ($owner, $max, $dir, @cmd) = @ARGV;
POSIX::_exit(127) unless defined $dir && @cmd && $owner =~ /\A[0-9]{1,10}\z/ && $max =~ /\A[0-9]{1,4}\z/;
$max = ${WATCHDOG_MAX_SEC} if $max > ${WATCHDOG_MAX_SEC};
my $ours = $dir =~ m{/${RENDER_DIR_PREFIX}[A-Za-z0-9]{6}\z} && -d $dir && !-l $dir;
sysopen(my $lock, "$dir.lock", O_WRONLY | O_CREAT | O_NOFOLLOW, 0600) or POSIX::_exit(127);
flock($lock, LOCK_EX | LOCK_NB) or POSIX::_exit(127);
my $fl = fcntl($lock, F_GETFD, 0);
POSIX::_exit(127) unless defined $fl && fcntl($lock, F_SETFD, $fl & ~FD_CLOEXEC);
$SIG{PIPE} = "IGNORE";
my $pid = fork();
POSIX::_exit(127) unless defined $pid;
if ($pid == 0) {
  open(STDIN, "<", "/dev/null") or POSIX::_exit(127);
  exec { $cmd[0] } @cmd;
  POSIX::_exit(127);
}
POSIX::close(3); POSIX::close(4);
chdir("/");    # File::Path will not remove the current folder (the browser's cwd is the render folder)
my $t0 = clock_gettime(CLOCK_MONOTONIC);
my $clean = sub { if ($ours && -d $dir && !-l $dir) { File::Path::remove_tree($dir); } unlink("$dir.lock"); };
my $stop = sub {
  kill("KILL", $pid); waitpid($pid, 0);
  $clean->();
  kill("KILL", -$$) if getpgrp() == $$;
  POSIX::_exit(137);
};
$SIG{$_} = $stop for qw(TERM INT HUP);
$SIG{CHLD} = sub { };
while (1) {
  my $g = waitpid($pid, POSIX::WNOHANG());
  if ($g == $pid) { my $st = $?; $clean->(); POSIX::_exit(($st & 127) ? 128 + ($st & 127) : $st >> 8); }
  $stop->() if $g < 0 || getppid() != $owner;
  $stop->() if clock_gettime(CLOCK_MONOTONIC) - $t0 > $max;
  my $rin = ""; vec($rin, 0, 1) = 1;
  my $n = select(my $rout = $rin, undef, undef, 0.25);
  next unless defined $n && $n > 0;
  my $r = sysread(STDIN, my $buf, 4096);
  $stop->() if defined $r ? $r == 0 : !($!{EINTR} || $!{EAGAIN});
}`;

/** argv before the browser's own: the watchdog, owned by this process, with the spec's cap and render folder. */
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
    stdio: ["pipe", "ignore", "ignore", "pipe", "pipe"],
  });
  child.stdin!.on("error", () => {});
  return pipes(child);
};

/**
 * Same-uid renders still running in this process: process group (the watchdog's pid) → render folder.
 * `killLiveRenders` is the last word on shutdown (`closeRenderers` in `export.ts`: `exit`, SIGTERM/SIGINT in
 * `index.ts`; the tests' `afterAll`).
 */
const liveRenders = new Map<number, string>();

/** Records a running render; the returned function forgets it (call it once its process has exited). */
export function trackRender(pgid: number, workDir: string): () => void {
  liveRenders.set(pgid, workDir);
  return () => {
    if (liveRenders.get(pgid) === workDir) liveRenders.delete(pgid);
  };
}

/** Removes a render folder and its lock file (best effort: the sweep removes what is left). */
export function removeRenderDir(workDir: string) {
  for (const p of [workDir, renderLockPath(workDir)])
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
}

/** SIGKILLs every live render's process group and removes its folder (synchronous: safe in an `exit` hook). */
export function killLiveRenders(): number {
  const n = liveRenders.size;
  for (const [pgid, dir] of liveRenders) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
    removeRenderDir(dir);
  }
  liveRenders.clear();
  return n;
}

/** How many renders are tracked (tests). */
export const liveRenderCount = () => liveRenders.size;

/**
 * Folders younger than this are never swept: the moment between `mkdtemp` and the watchdog taking the lock (and far
 * past `WATCHDOG_MAX_SEC`). The server sweeps at start and again every `SWEEP_GRACE_SEC` (`startRenderSweeps`), so a
 * folder too young at one sweep is looked at again once it is old enough.
 */
export const SWEEP_GRACE_SEC = 600;

/**
 * The sweep: removes `agentlee-render-XXXXXX` folders (our prefix only, real folders of our uid — no symlinks) in
 * `root`, older than `graceSec`, whose owner is provably gone. Evidence, from the kernel or from where the browser
 * cannot write:
 *  - the lock file beside the folder (`renderLockPath`): a real file of ours, the same file (device + inode) before
 *    and after it is opened (no symlink followed) and locked — a held lock keeps the folder; and
 *  - `lsof +D` (the kernel's view of every process of ours): no process has a file or its cwd under the folder.
 * A folder with a free lock is removed unless lsof shows a user. A folder **without** a lock file (a render from
 * before the watchdog, or a server that died between `mkdtemp` and the watchdog) only when lsof positively shows
 * none — no lsof (Linux), an lsof error or warning, or any output keeps it. Any lookup error keeps it too. The folder
 * removed is checked to be the one judged (device + inode). Lock files left without a folder are removed when free.
 * No process is killed: nothing is matched by name. Prints the count of folders removed.
 */
export const SWEEP_PL = String.raw`use strict; use POSIX (); use Errno ();
use Fcntl qw(:flock O_RDONLY O_NOFOLLOW); use File::Path ();
my ($root, $grace, $lsof) = @ARGV;
opendir(my $dh, $root) or do { print "0\n"; exit 0 };
my @names = readdir($dh);
closedir($dh);
my $P = qr/${RENDER_DIR_PREFIX}[A-Za-z0-9]{6}/;
my (%dirs, %locks);
for (@names) { $dirs{$1} = 1 if /\A($P)\z/; $locks{$1} = 1 if /\A($P)\.lock\z/; }
my $old = time() - $grace;
# A real folder of ours: its lstat, or nothing.
sub real_dir { my @st = lstat($_[0]); return () unless @st && -d _ && !-l _ && $st[4] == $<; return @st; }
# The lock: "none" (no such file), a locked handle, or undef (keep: held, not ours, not the same file, any error).
sub take_lock {
  my ($l) = @_;
  my @st = lstat($l);
  return $!{ENOENT} ? "none" : undef unless @st;
  return undef unless -f _ && $st[4] == $<;
  sysopen(my $fh, $l, O_RDONLY | O_NOFOLLOW) or return undef;
  my @f = stat($fh);
  return undef unless @f && $f[0] == $st[0] && $f[1] == $st[1];
  flock($fh, LOCK_EX | LOCK_NB) or return undef;
  my @again = lstat($l);
  return undef unless @again && $again[0] == $st[0] && $again[1] == $st[1];
  return $fh;
}
# 0 = lsof positively shows no process using the folder; 1 = it shows one (or anything else); undef = no lsof.
sub in_use {
  my ($p) = @_;
  return undef unless $lsof && -x $lsof;
  my $pid = open(my $fh, "-|");
  return 1 unless defined $pid;
  if (!$pid) { open(STDERR, ">&", \*STDOUT); exec($lsof, "+D", $p); POSIX::_exit(127); }
  my $out = do { local $/; <$fh> };
  close($fh);
  return ($? >> 8) == 1 && !length($out // "") ? 0 : 1;
}
my $n = 0;
for my $e (sort keys %dirs) {
  my $p = "$root/$e";
  my @st = real_dir($p) or next;
  next if $st[9] > $old;
  my $lock = take_lock("$p.lock");
  next unless defined $lock;
  my $use = in_use($p);
  # A free lock: gone unless lsof shows a user. No lock: only when lsof positively shows none.
  next if ref $lock ? ($use // 0) : !defined $use || $use;
  my @again = real_dir($p) or next;
  next unless $again[0] == $st[0] && $again[1] == $st[1];
  File::Path::remove_tree($p);
  next if lstat($p);
  unlink("$p.lock") if ref $lock;
  $n++;
}
for my $e (sort keys %locks) {
  my $l = "$root/$e.lock";
  next if lstat("$root/$e") || !$!{ENOENT};    # its folder is there (the loop above judged it), or unknown
  my @st = lstat($l) or next;
  next if $st[9] > $old;
  my $fh = take_lock($l);
  unlink($l) if ref $fh;
}
print "$n\n";`;

/** One sweep of `root` (default: the OS temp folder). Never throws; 0 when perl is missing or anything fails. */
export function sweepRenderDirs(root = os.tmpdir(), graceSec = SWEEP_GRACE_SEC): Promise<number> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(PERL, ["-e", SWEEP_PL, fs.realpathSync(root), String(graceSec), LSOF], {
        env: {},
        detached: true, // its own group: a timeout takes lsof with it
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return resolve(0);
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 60_000);
    timer.unref();
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(0);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const n = Number(out.trim());
      resolve(Number.isSafeInteger(n) ? n : 0);
    });
  });
}

/** The server's sweeps: now, then every `everyMs` (a folder too young now is judged again later). Returns stop. */
export function startRenderSweeps(root = os.tmpdir(), everyMs = SWEEP_GRACE_SEC * 1000): () => void {
  let running = false;
  const once = () => {
    if (running) return;
    running = true;
    void sweepRenderDirs(root).finally(() => (running = false));
  };
  once();
  const timer = setInterval(once, everyMs);
  timer.unref();
  return () => clearInterval(timer);
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
