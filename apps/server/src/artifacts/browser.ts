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
  /** Its lock file's identity (`makeRenderDir`): the watchdog locks that very file or does not start. */
  lock: LockId;
  /** Loopback port of the egress proxy: the browser's only network. */
  proxyPort: number;
  /** The watchdog's own wall-clock cap (`watchdogPrefix`): a backstop past the render's limit. */
  deadlineSec: number;
};

/**
 * A started browser: its process (the watchdog), the two debugging pipes (fd 3 = commands in, fd 4 = replies out),
 * and — once the watchdog has reported it — the browser's own process group (`browserGroup`).
 */
export type Launched = {
  child: ChildProcess;
  input: Writable;
  output: Readable;
  browserGroup?: () => number | undefined;
};
export type Launcher = (spec: LaunchSpec) => Launched;

/** The watchdog's one report on stdout: `pgid <n>` (the browser's group, which it leads). Nothing else is read. */
function readBrowserGroup(stdout: Readable): () => number | undefined {
  let group: number | undefined;
  let buf = "";
  stdout.on("data", (d: Buffer) => {
    if (group !== undefined || buf.length > 64) return;
    buf += d.toString("latin1");
    const m = /^pgid ([1-9][0-9]{0,9})\n/.exec(buf);
    if (m) group = Number(m[1]);
  });
  return () => group;
}

const pipes = (child: ChildProcess): Launched => ({
  child,
  input: child.stdio[3] as Writable,
  output: child.stdio[4] as Readable,
  browserGroup: readBrowserGroup(child.stdout!),
});

/** Prefix of every same-uid render folder (`mkdtemp`: six more characters). Nothing else is ever removed. */
export const RENDER_DIR_PREFIX = "agentlee-render-";
/**
 * The render's lock file: **beside** its folder (`<folder>.lock`, in the temp folder the browser cannot write — the
 * sandbox writes only the folder itself), so the browser can neither remove nor replace it. Created by the server
 * (`makeRenderDir`, exclusively), held (flock) by the watchdog and, inherited, by the browser while either lives.
 */
export const renderLockPath = (workDir: string) => `${workDir}.lock`;
/** Device + inode of the lock file a render created: only that very file is ever locked or unlinked. */
export type LockId = { dev: number; ino: number };
export type RenderDir = { workDir: string; lock: LockId };
/** Upper bound of the watchdog's own clock (monotonic), whatever the caller asks. */
export const WATCHDOG_MAX_SEC = 120;
/**
 * The watchdog's **own** exit codes (never the browser's): it ended by itself / the watchdog stopped it — reaped,
 * its group gone, cleaned up; it was never started (arguments, lock); its exec failed; its group could not be
 * confirmed gone (the server kills it and cleans up). Any other end (a signal) means the watchdog was interrupted.
 */
export const WATCHDOG_EXIT = { done: 0, stopped: 3, notStarted: 4, execFailed: 5, cleanupFailed: 6 } as const;
const PERL = "/usr/bin/perl";

/**
 * A fresh render folder (`mkdtemp`, our prefix) and its lock file beside it, created with
 * `O_CREAT | O_EXCL | O_NOFOLLOW` — never an object that was already there. On a name conflict (a lock file left
 * from an older folder of the same name) the folder is dropped and another name is tried.
 */
export function makeRenderDir(parent: string): RenderDir {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  for (let i = 0; i < 5; i++) {
    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(parent, RENDER_DIR_PREFIX)));
    let fd: number;
    try {
      fd = fs.openSync(renderLockPath(workDir), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch (e) {
      fs.rmdirSync(workDir);
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      const st = fs.fstatSync(fd);
      return { workDir, lock: { dev: st.dev, ino: st.ino } };
    } finally {
      fs.closeSync(fd);
    }
  }
  throw new Error("no free render folder name");
}

/**
 * Removes a render folder, and its lock file only when it is still the regular file this render created (same device
 * and inode) — `unlink`, never a recursive delete. Best effort: the sweep removes what is left.
 */
export function removeRenderDir(workDir: string, lock?: LockId) {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  if (!lock) return;
  const p = renderLockPath(workDir);
  try {
    const st = fs.lstatSync(p);
    if (st.isFile() && st.dev === lock.dev && st.ino === lock.ino) fs.unlinkSync(p);
  } catch {
    // gone already (the watchdog removes it), or not ours to remove
  }
}

/**
 * The render watchdog (#170) — a small Perl process **outside** the server that starts the browser as its own child
 * and makes sure it never outlives the server.
 *  - The server spawns it as the leader of a new process group (`detached`). It locks the render's lock file — the
 *    very file the server created (device + inode passed in), opened without following a link and without blocking
 *    (a FIFO cannot hang it), checked on the open file and on the path after locking; anything else: not started.
 *  - The browser is forked into **its own** process group (`setpgid` on both sides of the fork), gets fd 3/4 (the
 *    debugging pipe) and the inherited lock, and nothing else of the watchdog (stdout: /dev/null). The watchdog
 *    tells the server that group on stdout (`pgid <n>`), so a server that outlives its watchdog can kill it too.
 *  - Exec failure is told apart from a browser that exits 127 by a close-on-exec status pipe.
 *  - The watchdog's stdin is a pipe the server holds and never writes: the kernel closes it when the server dies,
 *    however it dies (SIGKILL included). EOF there, a changed parent pid, or the cap on the monotonic clock
 *    (`deadlineSec`, at most `WATCHDOG_MAX_SEC`) → SIGKILL to the browser's whole group (before it is reaped, so the
 *    id cannot have been reused), then reap.
 *  - However the browser ends, the watchdog then confirms its group is gone (SIGKILL to the group, a bounded wait),
 *    removes the render folder (our name only, a real folder), unlinks the lock (only the file it locked), and exits
 *    with its own status (`WATCHDOG_EXIT`). A group it cannot confirm gone: `cleanupFailed`, folder left to the server.
 * argv: <owner pid> <deadline sec> <render folder> <lock dev> <lock ino> <command…>
 */
export const WATCHDOG_PL = String.raw`use strict; use POSIX (); use Errno ();
use Fcntl qw(:flock F_GETFD F_SETFD FD_CLOEXEC O_RDONLY O_NOFOLLOW O_NONBLOCK);
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC usleep); use File::Path ();
my %X = (done => ${WATCHDOG_EXIT.done}, stopped => ${WATCHDOG_EXIT.stopped}, notStarted => ${WATCHDOG_EXIT.notStarted},
  execFailed => ${WATCHDOG_EXIT.execFailed}, cleanupFailed => ${WATCHDOG_EXIT.cleanupFailed});
my ($owner, $max, $dir, $ldev, $lino, @cmd) = @ARGV;
POSIX::_exit($X{notStarted}) unless defined $lino && @cmd && $owner =~ /\A[0-9]{1,10}\z/ && $max =~ /\A[0-9]{1,4}\z/
  && $ldev =~ /\A[0-9]{1,20}\z/ && $lino =~ /\A[0-9]{1,20}\z/;
$max = ${WATCHDOG_MAX_SEC} if $max > ${WATCHDOG_MAX_SEC};
my $ours = $dir =~ m{/${RENDER_DIR_PREFIX}[A-Za-z0-9]{6}\z} && -d $dir && !-l $dir;
my $lp = "$dir.lock";
sysopen(my $lock, $lp, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or POSIX::_exit($X{notStarted});
my @f = stat($lock);
POSIX::_exit($X{notStarted}) unless @f && -f _ && $f[4] == $< && $f[0] == $ldev && $f[1] == $lino;
flock($lock, LOCK_EX | LOCK_NB) or POSIX::_exit($X{notStarted});
my @p = lstat($lp);
POSIX::_exit($X{notStarted}) unless @p && -f _ && $p[0] == $ldev && $p[1] == $lino;
my $fl = fcntl($lock, F_GETFD, 0);
POSIX::_exit($X{notStarted}) unless defined $fl && fcntl($lock, F_SETFD, $fl & ~FD_CLOEXEC);
$SIG{PIPE} = "IGNORE";
pipe(my $sr, my $sw) or POSIX::_exit($X{notStarted});    # close-on-exec (perl's default above fd 2)
my $pid = fork();
POSIX::_exit($X{notStarted}) unless defined $pid;
if ($pid == 0) {
  close($sr);
  POSIX::setpgid(0, 0);
  open(STDIN, "<", "/dev/null") or POSIX::_exit(127);
  open(STDOUT, ">", "/dev/null") or POSIX::_exit(127);
  exec { $cmd[0] } @cmd;
  syswrite($sw, "E");
  POSIX::_exit(127);
}
close($sw);
POSIX::setpgid($pid, $pid);    # also here: no moment where the browser is in our group
POSIX::close(3); POSIX::close(4);
chdir("/");    # File::Path will not remove the current folder (the browser's cwd is the render folder)
my $t0 = clock_gettime(CLOCK_MONOTONIC);
my $execd = sysread($sr, my $e, 1);
close($sr);
my $finish = sub {
  my ($code) = @_;
  # The browser's group: anything left in it is killed; it must be gone within a second.
  kill("KILL", -$pid);
  my $until = clock_gettime(CLOCK_MONOTONIC) + 1;
  while (kill(0, -$pid) || !$!{ESRCH}) {
    POSIX::_exit($X{cleanupFailed}) if clock_gettime(CLOCK_MONOTONIC) > $until;
    usleep(20_000);
  }
  File::Path::remove_tree($dir) if $ours && -d $dir && !-l $dir;
  my @now = lstat($lp);
  unlink($lp) if @now && -f _ && $now[0] == $ldev && $now[1] == $lino;
  POSIX::_exit($code);
};
if (!defined $execd || $execd != 0) { waitpid($pid, 0); $finish->($X{execFailed}); }
syswrite(STDOUT, "pgid $pid\n");
my $stop = sub { kill("KILL", -$pid); waitpid($pid, 0); $finish->($X{stopped}); };
$SIG{$_} = $stop for qw(TERM INT HUP);
$SIG{CHLD} = sub { };
while (1) {
  my $g = waitpid($pid, POSIX::WNOHANG());
  $finish->($X{done}) if $g == $pid;
  $stop->() if $g < 0 || getppid() != $owner;
  $stop->() if clock_gettime(CLOCK_MONOTONIC) - $t0 > $max;
  my $rin = ""; vec($rin, 0, 1) = 1;
  my $n = select(my $rout = $rin, undef, undef, 0.25);
  next unless defined $n && $n > 0;
  my $r = sysread(STDIN, my $buf, 4096);
  $stop->() if defined $r ? $r == 0 : !($!{EINTR} || $!{EAGAIN});
}`;

/** argv before the browser's own: the watchdog, owned by this process, with the spec's cap, folder and lock. */
export function watchdogPrefix(s: LaunchSpec, owner = process.pid): string[] {
  return [
    PERL,
    "-e",
    WATCHDOG_PL,
    String(owner),
    String(s.deadlineSec),
    s.workDir,
    String(s.lock.dev),
    String(s.lock.ino),
  ];
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
export const sandboxedLauncher: Launcher = (s) => pipes(spawnIsolated(rendererSandbox(s)));

/**
 * The same browser without the process sandbox — **tests only** (Linux CI has no sandbox-exec): everything in
 * the browser (switches, request interception, the egress proxy, the watchdog) is the same; the kernel layer is
 * missing. stdin is the watchdog's owner pipe (never written), stdout its report.
 */
export const unsandboxedLauncher: Launcher = (s) => {
  const [command, ...pre] = watchdogPrefix(s);
  const child = spawn(command!, [...pre, s.browser, ...s.args], {
    cwd: s.workDir,
    env: s.env,
    detached: true,
    stdio: ["pipe", "pipe", "ignore", "pipe", "pipe"],
  });
  child.stdin!.on("error", () => {});
  return pipes(child);
};

/**
 * Same-uid renders still running in this process: the watchdog's group → the render's folder and lock, and the
 * browser's own group once known. `killLiveRenders` is the last word on shutdown (`closeRenderers` in `export.ts`:
 * `exit`, SIGTERM/SIGINT in `index.ts`; the tests' `afterAll`).
 */
type LiveRender = RenderDir & { browserGroup?: () => number | undefined };
const liveRenders = new Map<number, LiveRender>();

/**
 * Records a running render. `untrack` forgets it (once its process has exited); `tracked` says whether it is still
 * on record — false once `killLiveRenders` has killed its groups (nothing more to kill then).
 */
export function trackRender(pgid: number, dir: LiveRender) {
  liveRenders.set(pgid, dir);
  return {
    tracked: () => liveRenders.get(pgid) === dir,
    untrack: () => {
      if (liveRenders.get(pgid) === dir) liveRenders.delete(pgid);
    },
  };
}

/** SIGKILLs a render's groups: the browser's (when known) and the watchdog's. */
export function killRenderGroups(pgid: number, browserGroup?: number) {
  for (const g of [browserGroup, pgid])
    if (g)
      try {
        process.kill(-g, "SIGKILL");
      } catch {
        // already gone
      }
}

/** SIGKILLs every live render's process groups and removes its folder (synchronous: safe in an `exit` hook). */
export function killLiveRenders(): number {
  const n = liveRenders.size;
  for (const [pgid, dir] of liveRenders) {
    killRenderGroups(pgid, dir.browserGroup?.());
    removeRenderDir(dir.workDir, dir.lock);
  }
  liveRenders.clear();
  return n;
}

/** How many renders are tracked (tests). */
export const liveRenderCount = () => liveRenders.size;

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
  next if lstat($p);
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
