#!/usr/bin/env bash
# Production releases of Agent Lee from git (#143). See docs/ops.md §43.
#
#   pnpm -s release install [--ref main] [--no-start] [--fresh] [--force]
#   pnpm -s release status
#   pnpm -s release rollback [--to <release>]
#   pnpm -s release prune [--keep 3]
#   pnpm -s release restart | stop
#   pnpm -s release migrate-data --from <old DATA_DIR>      (one time, server stopped)
#
# Layout: $AGENTLEE_HOME (default ~/.chat-agent, 700) — src.git (mirror), releases/<UTC date>-<sha>/ (never changed
# after install), current -> releases/…, shared/.env (600, linked into every release), data/, backups/, logs/, run/.
# Overrides: AGENTLEE_HOME, AGENTLEE_SOURCE (git URL or path), AGENTLEE_NODE, AGENTLEE_HEALTH_TIMEOUT (seconds),
# AGENTLEE_LAUNCHD_PLIST (the installed daemon; launchd mode when it exists).
# Never prints .env contents, cookies or headers; never writes or changes any .env file.
set -euo pipefail
umask 077

LABEL=com.agentlee.server
ROOT="${AGENTLEE_HOME:-$HOME/.chat-agent}"
SOURCE="${AGENTLEE_SOURCE:-https://github.com/ingki3/chat-agent.git}"
PLIST="${AGENTLEE_LAUNCHD_PLIST:-/Library/LaunchDaemons/$LABEL.plist}"
HEALTH_TIMEOUT="${AGENTLEE_HEALTH_TIMEOUT:-90}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
VERIFY="$SELF_DIR/release-verify.mjs"
NAME_RE='^[0-9]{8}-[0-9]{6}-[0-9a-f]{12}$'

die() { echo "release: $*" >&2; exit 1; }
note() { echo "release: $*"; }

[ "$(id -u)" != 0 ] || die "run as the service account, not root (sudo is asked for only where needed)"
case "$ROOT" in /*) ;; *) die "AGENTLEE_HOME must be an absolute path" ;; esac
ROOT="${ROOT%/}"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "AGENTLEE_HEALTH_TIMEOUT must be a number of seconds"

# The same stable node rule as scripts/install-launchd.sh: no per-shell version-manager paths.
resolve_node() {
  local n="${AGENTLEE_NODE:-$(command -v node || true)}"
  [ -n "$n" ] || die "node not found (set AGENTLEE_NODE)"
  n="$(realpath "$n" 2>/dev/null)" || die "node not found: ${AGENTLEE_NODE:-node}"
  case "$n" in *fnm_multishells*|*/shims/*) die "node resolves to a temporary path ($n); set AGENTLEE_NODE to the installed binary";; esac
  [ -x "$n" ] || die "node not executable: $n"
  echo "$n"
}
NODE="$(resolve_node)"
NODE_DIR="$(dirname "$NODE")"
DAEMON_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ---- helpers ----

perm_of() { if [ "$(uname)" = Darwin ]; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }
owner_of() { if [ "$(uname)" = Darwin ]; then stat -f %u "$1"; else stat -c %u "$1"; fi; }

# One release command at a time: a kernel lock (flock) on fd 9, released when this shell exits (kill -9 included).
take_lock() {
  command -v perl >/dev/null || die "perl not found (needed for the release lock)"
  exec 9>>"$ROOT/.release.lock"
  perl -MFcntl=:flock -e 'open(my $f, ">&=", 9) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1; exit 0' \
    || die "another release command is running (lock: $ROOT/.release.lock)"
}

ensure_root() {
  mkdir -p "$ROOT"
  [ ! -L "$ROOT" ] || die "$ROOT must be a real directory, not a symlink"
  chmod 700 "$ROOT"
  mkdir -p "$ROOT/releases" "$ROOT/shared" "$ROOT/logs" "$ROOT/run"
}

# shared/.env: exists, a regular file of ours, mode 600. Checked, never written or chmod-ed here.
check_env_file() {
  local f="$ROOT/shared/.env"
  [ -e "$f" ] || die "$f not found — create it from your current .env (docs/ops.md §43.4); this script never writes it"
  [ -f "$f" ] && [ ! -L "$f" ] || die "$f must be a regular file (not a link)"
  [ "$(owner_of "$f")" = "$(id -u)" ] || die "$f must be owned by $(id -un)"
  [ "$(perm_of "$f")" = 600 ] || die "$f must have mode 600 (run: chmod 600 $f)"
}

current_name() {
  [ -L "$ROOT/current" ] || return 0
  basename "$(readlink "$ROOT/current")"
}

info_get() { # info_get <release dir> <key>
  [ -f "$1/.release-info" ] || return 0
  sed -n "s/^$2=//p" "$1/.release-info" | head -n 1
}

usable() { # a complete release that did not fail its own install
  local d="$ROOT/releases/$1"
  [[ "$1" =~ $NAME_RE ]] && [ -d "$d" ] && [ ! -L "$d" ] && [ ! -e "$d/.incomplete" ] && [ ! -e "$d/.failed" ]
}

releases_desc() { # names, newest first
  local n
  for n in $(ls -1 "$ROOT/releases" 2>/dev/null | sort -r); do [[ "$n" =~ $NAME_RE ]] && echo "$n"; done
  return 0
}

# Atomic switch: a new link renamed over `current` (rename(2) replaces the link itself, never follows it).
switch_current() {
  local tmp="$ROOT/.current.tmp.$$"
  rm -f "$tmp"
  ln -s "releases/$1" "$tmp"
  "$NODE" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$tmp" "$ROOT/current" \
    || die "could not switch current"
}

# Node in a release with the daemon's environment: only .env (→ shared/.env) decides the configuration.
app_node() { # app_node <release dir> <args…>
  local dir="$1"; shift
  (exec 9>&-; cd "$dir" && env -i HOME="$HOME" PATH="$DAEMON_PATH" NODE_ENV=production "$NODE" "$@")
}

CFG_HOST="" CFG_PORT="" CFG_DATA_DIR="" CFG_BACKUP_DIR="" CFG_DATABASE="" CFG_WORKER="" CFG_PYTHON=""
read_config() { # read_config <release dir>
  local out k v
  out="$(app_node "$1" apps/server/dist/cli/release.js config)" || return 1
  while IFS='=' read -r k v; do
    case "$k" in
      host) CFG_HOST="$v" ;; port) CFG_PORT="$v" ;; data_dir) CFG_DATA_DIR="$v" ;; backup_dir) CFG_BACKUP_DIR="$v" ;;
      database) CFG_DATABASE="$v" ;; worker_run_user) CFG_WORKER="$v" ;; python_run) CFG_PYTHON="$v" ;;
    esac
  done <<< "$out"
  [[ "$CFG_PORT" =~ ^[0-9]+$ ]] || return 1
}

base_url() {
  case "$CFG_HOST" in *:*) echo "http://[$CFG_HOST]:$CFG_PORT" ;; *) echo "http://$CFG_HOST:$CFG_PORT" ;; esac
}

# Migration tags (drizzle journal) in release $1 that release $2 does not have, one per line.
new_migrations() {
  "$NODE" -e '
    const fs = require("fs");
    const tags = (d) => { try { return JSON.parse(fs.readFileSync(d + "/apps/server/drizzle/meta/_journal.json", "utf8")).entries.map((e) => e.tag); } catch { return []; } };
    const old = new Set(tags(process.argv[2]));
    for (const t of tags(process.argv[1])) if (!old.has(t)) console.log(t);
  ' "$1" "$2"
}

launchd_mode() { [ -f "$PLIST" ]; }

port_open() {
  "$NODE" -e '
    const s = require("net").connect(+process.argv[2], process.argv[1]);
    s.setTimeout(2000, () => process.exit(1));
    s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(1));
  ' "$CFG_HOST" "$CFG_PORT"
}

is_ours() { # is_ours <pid>: a server started from this install
  local cmd
  cmd="$(ps -o command= -p "$1" 2>/dev/null)" || return 1
  case "$cmd" in *"$ROOT/current/apps/server/dist/index.js"*|*"$ROOT/releases/"*"/apps/server/dist/index.js"*) return 0 ;; esac
  return 1
}

our_pid() {
  local pid
  pid="$(cat "$ROOT/run/server.pid" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && is_ours "$pid" && echo "$pid"
  return 0
}

# Our server: the pid file's process, or — the file lost — the listener on our port if it is one of ours.
server_pid() {
  local pid i
  pid="$(our_pid)"
  if [ -z "$pid" ] && command -v lsof >/dev/null; then
    for i in $(lsof -nP -t -iTCP:"$CFG_PORT" -sTCP:LISTEN 2>/dev/null || true); do
      if is_ours "$i"; then pid="$i"; break; fi
    done
  fi
  echo "$pid"
}

# Something answers on our port and it is not our server (e.g. a server still running from a dev checkout).
port_foreign() { [ -z "$(server_pid)" ] && port_open; }

stop_ours() {
  local pid i
  pid="$(server_pid)"
  if [ -n "$pid" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; sleep 1; fi
    note "stopped server (pid $pid)"
  fi
  rm -f "$ROOT/run/server.pid"
  for i in $(seq 1 20); do port_open || return 0; sleep 0.5; done
  echo "release: port $CFG_PORT is in use by a process that is not this install's server — stop it first (lsof -nP -iTCP:$CFG_PORT -sTCP:LISTEN)" >&2
  return 1
}

start_detached() {
  local pid
  # fd 9 (the lock) closed first: the server must not hold the release lock (`cmd 9>&-` alone keeps a saved copy).
  ( exec 9>&-; cd "$ROOT/current" && exec nohup env -i HOME="$HOME" PATH="$DAEMON_PATH" NODE_ENV=production \
      "$NODE" --enable-source-maps "$ROOT/current/apps/server/dist/index.js" \
      </dev/null >>"$ROOT/logs/server.out.log" 2>&1 ) &
  pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$ROOT/run/server.pid"
  note "started server (pid $pid, output in $ROOT/logs/server.out.log)"
}

restart_server() {
  if launchd_mode; then
    note "restarting the LaunchDaemon (sudo)"
    sudo launchctl kickstart -k "system/$LABEL" || return 1
  else
    stop_ours || return 1
    start_detached
  fi
}

# Health 200 and the web assets of *this* release served with JS/CSS types (a stale server answers them as
# text/html). Prints status codes and paths only.
verify_live() {
  local args=(--url "$(base_url)" --index "$ROOT/current/apps/web/dist/index.html" --timeout "$HEALTH_TIMEOUT")
  if ! launchd_mode; then
    local pid; pid="$(cat "$ROOT/run/server.pid" 2>/dev/null || true)"
    [ -n "$pid" ] && args+=(--pid "$pid")
  fi
  "$NODE" "$VERIFY" "${args[@]}"
}

warn_restore() { # warn_restore <from release> <to release>
  local tags backup
  tags="$(new_migrations "$ROOT/releases/$1" "$ROOT/releases/$2")"
  [ -n "$tags" ] || return 0
  backup="$(info_get "$ROOT/releases/$1" predeploy_backup)"
  echo "release: WARNING — $1 added database migrations that $2 does not have:" >&2
  echo "$tags" | sed 's/^/release:   /' >&2
  echo "release: if it started, the database has the newer schema. To return the data to the state before $1 was" >&2
  echo "release: installed, restore the pre-deploy backup (docs/ops.md §21.4, §43.3) — writes since then are lost:" >&2
  if [ -n "$backup" ]; then
    echo "release:   stop the server, then: cd $ROOT/current && pnpm -s restore check $backup && pnpm -s restore apply $backup --yes" >&2
  else
    echo "release:   (no pre-deploy backup recorded for $1 — use the newest backup before its install time)" >&2
  fi
}

prune_releases() { # prune_releases <keep>
  local keep="$1" cur n kept=0
  cur="$(current_name)"
  for n in $(releases_desc); do
    if [ "$n" = "$cur" ]; then continue; fi
    if usable "$n" && [ "$kept" -lt $((keep - 1)) ]; then kept=$((kept + 1)); continue; fi
    rm -rf "${ROOT:?}/releases/$n"
    note "removed release $n"
  done
}

# ---- commands ----

cmd_install() {
  local ref=main start=1 fresh=0 force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) [ $# -ge 2 ] || die "--ref needs a value"; ref="$2"; shift 2 ;;
      --no-start) start=0; shift ;;
      --fresh) fresh=1; shift ;;
      --force) force=1; shift ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [[ "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "invalid ref"
  ensure_root
  take_lock
  check_env_file
  if launchd_mode && ! grep -q "<string>$ROOT/current/apps/server/dist/index.js</string>" "$PLIST"; then
    die "the LaunchDaemon ($PLIST) does not run $ROOT/current — reinstall it from the release (docs/ops.md §5.2)"
  fi

  # Source: the mirror, never a working tree (uncommitted changes cannot reach a release).
  if [ ! -d "$ROOT/src.git" ]; then
    git clone --quiet --mirror "$SOURCE" "$ROOT/src.git" || die "could not clone the source"
  fi
  git -C "$ROOT/src.git" fetch --quiet --prune "$SOURCE" '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' \
    || die "could not fetch the source"
  local sha
  sha="$(git -C "$ROOT/src.git" rev-parse --verify --quiet "$ref^{commit}")" || die "unknown ref: $ref"
  local prev; prev="$(current_name)"
  if [ -n "$prev" ] && [ "$(info_get "$ROOT/releases/$prev" sha)" = "$sha" ] && [ "$force" = 0 ]; then
    note "already installed: current is $prev ($sha) — --force to reinstall"
    return 0
  fi

  local name dir
  name="$(date -u +%Y%m%d-%H%M%S)-${sha:0:12}"
  dir="$ROOT/releases/$name"
  mkdir "$dir" || die "release folder $name exists — try again"
  : > "$dir/.incomplete"
  abort() { echo "release: $* — nothing switched; removing $name" >&2; rm -rf "$dir"; exit 1; }

  note "installing $name from $ref ($sha)"
  local tar="$ROOT/run/$name.tar"
  git -C "$ROOT/src.git" archive --format=tar -o "$tar" "$sha" || abort "git archive failed"
  tar -xf "$tar" -C "$dir" || { rm -f "$tar"; abort "unpacking failed"; }
  rm -f "$tar"
  printf 'sha=%s\nref=%s\ninstalled_at=%s\nprevious=%s\n' "$sha" "$ref" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$prev" \
    > "$dir/.release-info"

  (exec 9>&-; cd "$dir" && env -u NODE_ENV pnpm install --frozen-lockfile --prefer-offline) || abort "pnpm install failed"
  (exec 9>&-; cd "$dir" && env -u NODE_ENV pnpm build) || abort "build failed"
  local f
  for f in apps/server/dist/index.js apps/server/dist/cli/release.js apps/web/dist/index.html scripts/launchd-helper.mjs; do
    [ -f "$dir/$f" ] || abort "build output missing: $f"
  done
  [ ! -e "$dir/.env" ] || abort "the source contains a .env"
  ln -s ../../shared/.env "$dir/.env"

  # The launchd install's own check (config + master key, as the service account, the daemon's environment).
  app_node "$dir" scripts/launchd-helper.mjs check || abort "configuration or master key check failed (docs/ops.md §3)"
  read_config "$dir" || abort "configuration check failed"
  note "config: port $CFG_PORT, DATA_DIR $CFG_DATA_DIR, BACKUP_DIR $CFG_BACKUP_DIR, database $CFG_DATABASE"
  if [ "$CFG_DATABASE" = absent ] && [ "$start" = 1 ] && [ "$fresh" = 0 ]; then
    abort "no database at DATA_DIR — for the move from an old data folder use install --no-start, then migrate-data (docs/ops.md §43.4); --fresh starts empty"
  fi

  # Pre-deploy backup (read-only on the live database, safe while the server runs) + full check.
  if [ "$CFG_DATABASE" = present ]; then
    local out backup="" pending=0 k v
    out="$(app_node "$dir" apps/server/dist/cli/release.js backup)" || abort "pre-deploy backup failed"
    while IFS='=' read -r k v; do
      case "$k" in backup_id) backup="$v" ;; pending_migrations) pending="$v" ;; esac
    done <<< "$out"
    [ -n "$backup" ] || abort "pre-deploy backup did not report an id"
    echo "predeploy_backup=$backup" >> "$dir/.release-info"
    note "pre-deploy backup $backup in $CFG_BACKUP_DIR (integrity ok; $pending migration(s) to apply on start)"
  fi
  if [ -n "$prev" ]; then
    local tags; tags="$(new_migrations "$dir" "$ROOT/releases/$prev")"
    [ -z "$tags" ] || note "this release adds database migrations: $(echo "$tags" | tr '\n' ' ')— a rollback will need the pre-deploy backup"
  fi
  if [ "$start" = 1 ] && ! launchd_mode && port_foreign; then
    abort "port $CFG_PORT is in use by a process that is not this install's server — stop it first (lsof -nP -iTCP:$CFG_PORT -sTCP:LISTEN)"
  fi
  rm -f "$dir/.incomplete"

  switch_current "$name"
  note "current -> releases/$name"
  if [ "$start" = 0 ]; then
    note "not started (--no-start)"
    post_install_notes
    return 0
  fi
  if restart_server && verify_live; then
    note "installed $name ($sha) — healthy"
    prune_releases 3
    post_install_notes
    return 0
  fi

  # Failed: back to the previous release.
  : > "$dir/.failed"
  echo "release: $name failed its checks (logs: $ROOT/logs/, /Library/Logs/agentlee/)" >&2
  if [ -z "$prev" ] || ! usable "$prev"; then
    if ! launchd_mode; then stop_ours || true; fi
    die "no previous release to return to — server left stopped"
  fi
  echo "release: switching back to $prev" >&2
  switch_current "$prev"
  if restart_server && verify_live; then
    echo "release: rolled back to $prev — it is serving again; $name is kept for inspection (prune removes it)" >&2
    warn_restore "$name" "$prev"
    exit 1
  fi
  die "rollback to $prev failed its checks too — the server needs attention (logs: $ROOT/logs/)"
}

post_install_notes() {
  [ "$CFG_WORKER" != set ] || note "WORKER_RUN_USER is set: rebuild and reinstall the worker bundle from $ROOT/current (docs/ops.md §41.2 1–2)"
  [ "$CFG_PYTHON" != on ] || note "python_run is on: if apps/server/scratchpad/runner.py changed, copy it again (docs/ops.md §35.2)"
  return 0
}

cmd_rollback() {
  local to=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) [ $# -ge 2 ] || die "--to needs a value"; to="$2"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  ensure_root
  take_lock
  local cur; cur="$(current_name)"
  [ -n "$cur" ] || die "no current release"
  if [ -z "$to" ]; then
    to="$(info_get "$ROOT/releases/$cur" previous)"
    if [ -z "$to" ] || ! usable "$to"; then
      to=""
      local n
      for n in $(releases_desc); do if [[ "$n" < "$cur" ]] && usable "$n"; then to="$n"; break; fi; done
    fi
  fi
  [ -n "$to" ] || die "no earlier release to roll back to"
  usable "$to" || die "not an installed release: $to"
  [ "$to" != "$cur" ] || die "$to is already current"
  read_config "$ROOT/releases/$to" || die "configuration check failed for $to"
  warn_restore "$cur" "$to"
  switch_current "$to"
  note "current -> releases/$to (was $cur)"
  restart_server || die "restart failed — current is $to"
  verify_live || die "$to failed its checks after the rollback — the server needs attention (logs: $ROOT/logs/)"
  note "rolled back to $to — healthy"
}

cmd_prune() {
  local keep=3
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep) [ $# -ge 2 ] || die "--keep needs a value"; keep="$2"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "--keep must be 1 or more"
  ensure_root
  take_lock
  prune_releases "$keep"
}

cmd_status() {
  [ -d "$ROOT" ] || { echo "not installed ($ROOT)"; return 0; }
  local cur n mark
  cur="$(current_name)"
  echo "home:     $ROOT"
  if [ -n "$cur" ]; then
    echo "current:  $cur (sha $(info_get "$ROOT/releases/$cur" sha), ref $(info_get "$ROOT/releases/$cur" ref), installed $(info_get "$ROOT/releases/$cur" installed_at))"
  else
    echo "current:  none"
  fi
  echo "releases:"
  for n in $(releases_desc); do
    mark=""
    [ "$n" != "$cur" ] || mark=" (current)"
    [ ! -e "$ROOT/releases/$n/.incomplete" ] || mark="$mark (incomplete)"
    [ ! -e "$ROOT/releases/$n/.failed" ] || mark="$mark (failed)"
    echo "  $n$mark"
  done
  if launchd_mode; then
    echo "service:  LaunchDaemon $LABEL ($PLIST)"
    launchctl print "system/$LABEL" 2>/dev/null | grep -E "state =|pid =" | sed 's/^[[:space:]]*/          /' || echo "          not loaded"
  else
    local pid; pid="$(our_pid)"
    if [ -n "$pid" ]; then echo "service:  running (pid $pid, started by this script)"; else echo "service:  not running (no LaunchDaemon)"; fi
  fi
  if [ -n "$cur" ] && read_config "$ROOT/current" 2>/dev/null; then
    if "$NODE" "$VERIFY" --url "$(base_url)" --index "$ROOT/current/apps/web/dist/index.html" --timeout 0 >/dev/null 2>&1; then
      echo "health:   ok ($(base_url))"
    else
      echo "health:   failing ($(base_url))"
    fi
  fi
  if [ -e "$ROOT/.release.lock" ] && ! perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or exit 0; flock($f, LOCK_EX | LOCK_NB) or exit 1' "$ROOT/.release.lock"; then
    echo "lock:     held — a release command is running"
  fi
}

cmd_restart() {
  ensure_root
  take_lock
  [ -n "$(current_name)" ] || die "no current release"
  read_config "$ROOT/current" || die "configuration check failed"
  restart_server || die "restart failed"
  verify_live || die "the server failed its checks (logs: $ROOT/logs/)"
  note "running $(current_name) — healthy"
}

cmd_stop() {
  ensure_root
  take_lock
  if launchd_mode; then die "the LaunchDaemon runs the server: sudo launchctl bootout system/$LABEL"; fi
  [ -n "$(current_name)" ] || die "no current release"
  read_config "$ROOT/current" || die "configuration check failed"
  stop_ours
}

cmd_migrate_data() {
  local from=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --from) [ $# -ge 2 ] || die "--from needs a value"; from="$2"; shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$from" ] || die "usage: migrate-data --from <old DATA_DIR>"
  case "$from" in /*) ;; *) die "--from must be an absolute path" ;; esac
  ensure_root
  take_lock
  check_env_file
  [ -n "$(current_name)" ] || die "no current release — run: install --no-start (docs/ops.md §43.4)"
  read_config "$ROOT/current" || die "configuration check failed"
  if launchd_mode; then die "stop the LaunchDaemon first: sudo launchctl bootout system/$LABEL"; fi
  [ -z "$(server_pid)" ] || die "the server is running — stop it first: pnpm -s release stop"
  local out
  out="$(app_node "$ROOT/current" apps/server/dist/cli/release.js migrate-data --from "$from")" || die "data move failed — the original is untouched"
  echo "$out" | sed 's/^/release: /'
  cat <<EOF
release: copied. The original at $from is untouched (delete it yourself once everything checks out).
release: next steps (docs/ops.md §43.4):
release:   1) start:   pnpm -s release restart          (or the LaunchDaemon: cd $ROOT/current && pnpm -s launchd install)
release:   2) check:   log in, open a conversation and an attachment, Settings → runtime connections → test
release:   3) skills:  cd $ROOT/current && pnpm skills:install
release:   4) python/worker accounts (if set up): point scratch= in /usr/local/etc/agentlee-*.conf at the new DATA_DIR
EOF
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  status) shift; cmd_status "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  prune) shift; cmd_prune "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  migrate-data) shift; cmd_migrate_data "$@" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
