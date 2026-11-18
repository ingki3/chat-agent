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
 * sandbox writes only the folder itself), so the browser can neither remove nor replace it. Created by the server
 * (`makeRenderDir`, exclusively), held (flock) by the watchdog and, inherited, by the browser while either lives.
 */
export const renderLockPath = (workDir: string) => `${workDir}.lock`;
/** Device + inode of the lock file a render created: only that very file is ever unlinked. */
export type LockId = { dev: number; ino: number };
export type RenderDir = { workDir: string; lock: LockId };
/** Upper bound of the watchdog's own clock (monotonic), whatever the caller asks. */
export const WATCHDOG_MAX_SEC = 120;
/** Watchdog exit codes after it reaped the browser and cleaned up: it ended by itself / the watchdog stopped it. */
export const WATCHDOG_DONE = 0;
export const WATCHDOG_STOPPED = 3;
/** Watchdog exit code when it could not start the browser at all (bad arguments, no lock, no fork). */
export const WATCHDOG_NOT_STARTED = 127;
const PERL = "/usr/bin/perl";
const LSOF = "/usr/sbin/lsof";

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
 * and makes sure it never outlives the server. The server spawns it as the leader of a new process group
 * (`detached`); the browser is forked into that same group, gets fd 3/4 (the debugging pipe) and nothing else of
 * the watchdog. The watchdog's stdin is a pipe the server holds and never writes: the kernel closes it when the
 * server dies, however it dies (SIGKILL included), and EOF there — or a changed parent pid — means the owner is gone:
 * the browser is killed (SIGKILL, reaped). A cap on the monotonic clock (`deadlineSec`, at most `WATCHDOG_MAX_SEC` —
 * a changed wall clock does not move it) stops it even while the server lives but stopped doing so itself (a blocked
 * event loop). However the browser ends — by itself (after the server has its bytes over the pipe and asked it to
 * close), killed, or orphaned — the watchdog then kills anything else left in its group, removes the render folder
 * (our name only, a real folder) and unlinks the lock file (only the very file it locked), and exits with its **own**
 * status — `WATCHDOG_DONE` or `WATCHDOG_STOPPED`, never the browser's: any other end (a signal) means the watchdog
 * itself was interrupted, and the server kills what is left of the group (`export.ts`).
 * The lock file is the one the server created (`makeRenderDir`); the watchdog opens it without creating or following
 * anything, checks it is a regular file of ours and flocks it; the browser inherits it, so the lock is free only once
 * both are gone — the proof the sweep (`sweepRenderDirs`) needs.
 * argv: <owner pid> <deadline sec> <render folder> <command…>
 */
export const WATCHDOG_PL = String.raw`use strict; use POSIX (); use Errno ();
use Fcntl qw(:flock F_GETFD F_SETFD FD_CLOEXEC O_WRONLY O_NOFOLLOW);
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC); use File::Path ();
my ($owner, $max, $dir, @cmd) = @ARGV;
my $NOT_STARTED = ${WATCHDOG_NOT_STARTED};
POSIX::_exit($NOT_STARTED) unless defined $dir && @cmd && $owner =~ /\A[0-9]{1,10}\z/ && $max =~ /\A[0-9]{1,4}\z/;
$max = ${WATCHDOG_MAX_SEC} if $max > ${WATCHDOG_MAX_SEC};
my $ours = $dir =~ m{/${RENDER_DIR_PREFIX}[A-Za-z0-9]{6}\z} && -d $dir && !-l $dir;
sysopen(my $lock, "$dir.lock", O_WRONLY | O_NOFOLLOW) or POSIX::_exit($NOT_STARTED);
my @lk = stat($lock);
POSIX::_exit($NOT_STARTED) unless @lk && -f _ && $lk[4] == $<;
flock($lock, LOCK_EX | LOCK_NB) or POSIX::_exit($NOT_STARTED);
my $fl = fcntl($lock, F_GETFD, 0);
POSIX::_exit($NOT_STARTED) unless defined $fl && fcntl($lock, F_SETFD, $fl & ~FD_CLOEXEC);
$SIG{PIPE} = "IGNORE";
my $pid = fork();
POSIX::_exit($NOT_STARTED) unless defined $pid;
if ($pid == 0) {
  open(STDIN, "<", "/dev/null") or POSIX::_exit(127);
  exec { $cmd[0] } @cmd;
  POSIX::_exit(127);
}
POSIX::close(3); POSIX::close(4);
chdir("/");    # File::Path will not remove the current folder (the browser's cwd is the render folder)
my $t0 = clock_gettime(CLOCK_MONOTONIC);
my $done = sub {
  my ($code) = @_;
  # Anything else the browser left in our group (it cannot fork in the sandbox; this is the backstop).
  my $pp;
  if (getpgrp() == $$ && ($pp = open(my $ps, "-|", "/bin/ps", "-o", "pid=", "-g", $$))) {
    my @left = grep { $_ != $$ && $_ != $pp } map { /([0-9]+)/ ? $1 : () } <$ps>;
    close($ps);
    kill("KILL", @left) if @left;
  }
  File::Path::remove_tree($dir) if $ours && -d $dir && !-l $dir;
  my @now = lstat("$dir.lock");
  unlink("$dir.lock") if @now && -f _ && $now[0] == $lk[0] && $now[1] == $lk[1];
  POSIX::_exit($code);
};
my $stop = sub { kill("KILL", $pid); waitpid($pid, 0); $done->(${WATCHDOG_STOPPED}); };
$SIG{$_} = $stop for qw(TERM INT HUP);
$SIG{CHLD} = sub { };
while (1) {
  my $g = waitpid($pid, POSIX::WNOHANG());
  $done->(${WATCHDOG_DONE}) if $g == $pid;
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
 * Same-uid renders still running in this process: process group (the watchdog's pid) → render folder and lock.
 * `killLiveRenders` is the last word on shutdown (`closeRenderers` in `export.ts`: `exit`, SIGTERM/SIGINT in
 * `index.ts`; the tests' `afterAll`).
 */
const liveRenders = new Map<number, RenderDir>();

/**
 * Records a running render. `untrack` forgets it (once its process has exited); `tracked` says whether it is still
 * on record — false once `killLiveRenders` has killed its group (nothing more to kill then).
 */
export function trackRender(pgid: number, dir: RenderDir) {
  liveRenders.set(pgid, dir);
  return {
    tracked: () => liveRenders.get(pgid) === dir,
    untrack: () => {
      if (liveRenders.get(pgid) === dir) liveRenders.delete(pgid);
    },
  };
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
    removeRenderDir(dir.workDir, dir.lock);
  }
  liveRenders.clear();
  return n;
}

/** How many renders are tracked (tests). */
export const liveRenderCount = () => liveRenders.size;

/**
 * Folders younger than this are never swept (far past `WATCHDOG_MAX_SEC`; the moment between `mkdtemp` and the
 * watchdog taking the lock). The server sweeps at start and again every `SWEEP_GRACE_SEC` (`startRenderSweeps`), so
 * a folder too young at one sweep is looked at again once it is old enough.
 */
export const SWEEP_GRACE_SEC = 600;
/** One sweep's time budget: past it the sweep stops and the next one resumes after the last folder it judged. */
export const SWEEP_BUDGET_SEC = 45;
/** One `lsof` run (one folder): past it that folder is kept and the sweep goes on. */
export const SWEEP_LSOF_SEC = 5;

/**
 * The sweep: removes `agentlee-render-XXXXXX` folders (our prefix only, real folders of our uid — no symlinks) in
 * `root`, older than `graceSec`, whose owner is provably gone. Evidence, from the kernel or from where the browser
 * cannot write:
 *  - the lock file beside the folder (`renderLockPath`): a regular file of ours, the same file (device + inode)
 *    before and after it is opened (no symlink followed) and locked — a held lock keeps the folder. A folder with no
 *    lock file gets one: the sweep **creates** it exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`, as the server does
 *    for a new render), marks it as its own and locks it, so no one can start using the folder under it (a sweep
 *    that died holding one leaves a marked lock: still judged as lock-less); and
 *  - `lsof +D` (the kernel's view of every process of ours), run **while the sweep holds the lock**: no process has
 *    a file or its cwd under the folder.
 * A folder with a free lock is removed unless lsof shows a user. A folder that had **no** lock file (a render from
 * before the watchdog, or a server that died between `mkdtemp` and the watchdog) only when lsof positively shows
 * none — no lsof (Linux), an lsof error, warning, signal or time-out (`SWEEP_LSOF_SEC`), or any output keeps it (and
 * the lock the sweep made is unlinked again). Any lookup error keeps it too. The folder removed is checked to be the
 * one judged (device + inode); the lock is held until the folder is gone and only the very file locked is unlinked.
 * Lock files left without a folder are removed when free. No process is killed: nothing is matched by name.
 *
 * Bounded by itself, not only by the server: a budget (`SWEEP_BUDGET_SEC`, monotonic) after which it stops between
 * folders and prints where it got to (the next sweep resumes after it), an alarm a little past that which kills its
 * own group (lsof included), and its owner: stdin is a pipe the server holds — EOF (the server gone or cancelling) or
 * a changed parent pid stops it before the next folder.
 * argv: <root> <grace sec> <lsof> <owner pid> <resume after name or -> <budget sec> <lsof sec>.
 * Prints "<removed> <resume after, or ->".
 */
export const SWEEP_PL = String.raw`use strict; use POSIX (); use Errno ();
use Fcntl qw(:flock O_RDONLY O_WRONLY O_CREAT O_EXCL O_NOFOLLOW); use File::Path ();
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC);
my ($root, $grace, $lsof, $owner, $after, $budget, $lsofsec) = @ARGV;
$budget = ${SWEEP_BUDGET_SEC} unless defined $budget && $budget =~ /\A[0-9]{1,4}\z/;
$lsofsec = ${SWEEP_LSOF_SEC} unless defined $lsofsec && $lsofsec =~ /\A[1-9][0-9]{0,2}\z/;
$SIG{ALRM} = sub { kill("KILL", -$$) if getpgrp() == $$; POSIX::_exit(124); };
alarm($budget + 15);
my $t0 = clock_gettime(CLOCK_MONOTONIC);
my $n = 0;
my $last = "-";
my $finish = sub { print "$n $_[0]\n"; exit 0; };
opendir(my $dh, $root) or $finish->("-");
my @names = readdir($dh);
closedir($dh);
my $P = qr/${RENDER_DIR_PREFIX}[A-Za-z0-9]{6}/;
my (%dirs, %locks);
for (@names) { $dirs{$1} = 1 if /\A($P)\z/; $locks{$1} = 1 if /\A($P)\.lock\z/; }
my $old = time() - $grace;
# The owner still wants this sweep: same parent, and its pipe neither closed nor written to.
sub wanted {
  return 0 if defined $owner && $owner =~ /\A[0-9]+\z/ && getppid() != $owner;
  my $rin = ""; vec($rin, 0, 1) = 1;
  my $k = select(my $rout = $rin, undef, undef, 0);
  return 1 unless defined $k && $k > 0;
  return 0;
}
# A real folder of ours: its lstat, or nothing.
sub real_dir { my @st = lstat($_[0]); return () unless @st && -d _ && !-l _ && $st[4] == $<; return @st; }
sub same { my ($x, $y) = @_; return @$x && @$y && $x->[0] == $y->[0] && $x->[1] == $y->[1]; }
# The lock: [handle, stat, made-by-us] locked, or undef (keep: held, not ours, not the same file, any error).
sub take_lock {
  my ($l) = @_;
  my @st = lstat($l);
  if (!@st) {
    return undef unless $!{ENOENT};
    sysopen(my $fh, $l, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or return undef;
    my @f = stat($fh);
    if (!@f || !flock($fh, LOCK_EX | LOCK_NB)) { drop([$fh, \@f, 1], $l); return undef; }
    # Marked as the sweep's own (a render's lock is empty): should this sweep die holding it, the next one still
    # judges the folder as lock-less.
    syswrite($fh, "sweep\n");
    return [$fh, \@f, 1];
  }
  return undef unless -f _ && $st[4] == $<;
  sysopen(my $fh, $l, O_RDONLY | O_NOFOLLOW) or return undef;
  my @f = stat($fh);
  return undef unless same(\@f, \@st);
  flock($fh, LOCK_EX | LOCK_NB) or return undef;
  my @again = lstat($l);
  return undef unless same(\@again, \@st);
  my $mark = "";
  sysread($fh, $mark, 6);
  return [$fh, \@f, $mark eq "sweep\n" ? 1 : 0];
}
# Unlinks the lock path only while it is still the file we hold.
sub drop { my ($lk, $l) = @_; my @now = lstat($l); unlink($l) if @now && -f _ && same(\@now, $lk->[1]); }
# 0 = lsof positively shows no process using the folder (in time); 1 = anything else; undef = no lsof here.
sub in_use {
  my ($p) = @_;
  return undef unless $lsof && -x $lsof;
  my $pid = open(my $fh, "-|");
  return 1 unless defined $pid;
  if (!$pid) {
    open(STDERR, ">&", \*STDOUT);
    alarm($lsofsec);    # inherited by lsof: a slow look is cut off (a signal: kept)
    exec($lsof, "+D", $p);
    POSIX::_exit(127);
  }
  my $out = do { local $/; <$fh> };
  close($fh);
  return ($? & 127) == 0 && ($? >> 8) == 1 && !length($out // "") ? 0 : 1;
}
# Names after the resume point first, then the rest: a slow folder never starves the ones behind it.
my @all = sort keys %dirs;
$after = "-" unless defined $after && length $after;
my @order = $after eq "-" ? @all : ((grep { $_ gt $after } @all), (grep { $_ le $after } @all));
my $seen = 0;
for my $e (@order) {
  $finish->("-") unless wanted();
  # Out of budget (at least one folder judged per sweep, so a resumed sweep always moves on).
  $finish->($last) if $seen && clock_gettime(CLOCK_MONOTONIC) - $t0 > $budget;
  $last = $e;
  $seen++;
  my $p = "$root/$e";
  my @st = real_dir($p) or next;
  next if $st[9] > $old;
  my $lk = take_lock("$p.lock");
  next unless $lk;
  my $use = in_use($p);
  # A free lock: gone unless lsof shows a user. No lock (we made one): only when lsof positively shows none.
  my $keep = $lk->[2] ? (!defined $use || $use) : ($use // 0);
  my @again = real_dir($p);
  $keep = 1 unless same(\@again, \@st);
  if (!$keep) {
    File::Path::remove_tree($p);
    $keep = 1 if lstat($p);
    $n++ unless $keep;
  }
  # The folder gone: its lock goes. Kept: a lock the sweep made goes again (it was not there before).
  drop($lk, "$p.lock") if !$keep || $lk->[2];
}
for my $e (sort keys %locks) {
  my $l = "$root/$e.lock";
  next if lstat("$root/$e") || !$!{ENOENT};    # its folder is there (the loop above judged it), or unknown
  my @st = lstat($l) or next;
  next if $st[9] > $old;
  my $lk = take_lock($l);
  drop($lk, $l) if $lk && !$lk->[2];
}
$finish->("-");`;

export type SweepResult = { removed: number; next?: string };
/** Sweep knobs (tests: another lsof, short budgets). */
export type SweepOptions = {
  graceSec?: number;
  after?: string;
  budgetSec?: number;
  lsof?: string;
  lsofSec?: number;
};

/** One sweep run: its result, and a way to stop it (its whole process group, lsof included). */
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
          o.lsof ?? LSOF,
          String(process.pid),
          o.after ?? "-",
          String(budgetSec),
          String(o.lsofSec ?? SWEEP_LSOF_SEC),
        ],
        // Its own group (a stop takes lsof with it); stdin = the owner pipe (never written).
        { env: {}, detached: true, stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch {
      return resolve({ removed: 0 });
    }
    child.stdin!.on("error", () => {});
    // The server's own bound, past the sweep's (it also bounds itself, should this process die first).
    const timer = setTimeout(kill, (budgetSec + 20) * 1000);
    timer.unref();
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ removed: 0 });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const m = /^(\d+) (\S+)\n?$/.exec(out);
      if (!m) return resolve({ removed: 0 });
      resolve({ removed: Number(m[1]), ...(m[2] !== "-" ? { next: m[2] } : {}) });
    });
  });
  return { done, cancel: kill };
}

/** One sweep of `root` (default: the OS temp folder). Never throws; 0 when perl is missing or anything fails. */
export function sweepRenderDirs(root = os.tmpdir(), o: SweepOptions = {}): Promise<SweepResult> {
  return runSweep(root, o).done;
}

/**
 * The server's sweeps: now, then every `everyMs`, each resuming where a sweep that ran out of budget stopped.
 * Returns `stop`: no more sweeps, the running one (if any) is killed — its group — and awaited.
 */
export function startRenderSweeps(
  root = os.tmpdir(),
  everyMs = SWEEP_GRACE_SEC * 1000,
  o: Omit<SweepOptions, "after"> = {},
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
    });
  };
  once();
  const timer = setInterval(once, everyMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    const run = current;
    run?.cancel();
    await run?.done;
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
