#!/usr/bin/env bash
# Installs the Agent Lee server as a LaunchDaemon (#8). See docs/ops.md §5.
#
#   pnpm -s launchd print       # render the plist to stdout (no changes)
#   pnpm -s launchd install     # needs sudo; asks for confirmation (Access must protect the hostname)
#   pnpm -s launchd uninstall   # needs sudo
#   pnpm -s launchd status
#   pnpm -s launchd print-uptime | install-uptime | uninstall-uptime   # 5-minute uptime check (#46, §9)
#
# Overrides: AGENTLEE_USER (service account, default: you), AGENTLEE_NODE (node binary), AGENTLEE_LOG_DIR.
set -euo pipefail

LABEL=com.agentlee.server
UPTIME_LABEL=com.agentlee.uptime
UPTIME_TARGET="/Library/LaunchDaemons/$UPTIME_LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HELPER="$REPO/scripts/launchd-helper.mjs"
TARGET="/Library/LaunchDaemons/$LABEL.plist"
LOGDIR="${AGENTLEE_LOG_DIR:-/Library/Logs/agentlee}"
RUN_USER="${AGENTLEE_USER:-${SUDO_USER:-$(id -un)}}"

die() { echo "install-launchd: $*" >&2; exit 1; }

# The service account: a real, non-root account. Its home comes from the directory service, never from eval.
[[ "$RUN_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die "invalid user name"
RUN_UID="$(id -u "$RUN_USER" 2>/dev/null)" || die "no such user: $RUN_USER"
[ "$RUN_UID" != 0 ] || die "refusing to run the service as root"
if [ "$(uname)" = Darwin ]; then
  RUN_HOME="$(dscl . -read "/Users/$RUN_USER" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')"
else
  RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
fi
[ -d "$RUN_HOME" ] || die "home directory not found for $RUN_USER"
case "$LOGDIR" in /*) ;; *) die "AGENTLEE_LOG_DIR must be an absolute path";; esac

# A stable node binary: version-manager shims and per-shell paths (fnm_multishells) disappear after reboot.
resolve_node() {
  local n="${AGENTLEE_NODE:-$(command -v node || true)}"
  [ -n "$n" ] || die "node not found (set AGENTLEE_NODE)"
  n="$(realpath "$n" 2>/dev/null)" || die "node not found: ${AGENTLEE_NODE:-node}"
  case "$n" in *fnm_multishells*|*/shims/*) die "node resolves to a temporary path ($n); set AGENTLEE_NODE to the installed binary";; esac
  [ -x "$n" ] || die "node not executable: $n"
  echo "$n"
}
NODE="$(resolve_node)"

render() { AL_USER="$RUN_USER" AL_HOME="$RUN_HOME" AL_NODE="$NODE" AL_LOGDIR="$LOGDIR" "$NODE" "$HELPER" render "${1:-server}"; }

preflight() {
  [ -f "$REPO/apps/server/dist/index.js" ] || die "server not built — run: pnpm build"
  [ -f "$REPO/apps/web/dist/index.html" ] || die "web not built — run: pnpm build"
  # Same loaders as the server, as the service account, with the daemon's environment.
  (cd "$REPO" && sudo -u "$RUN_USER" /usr/bin/env -i HOME="$RUN_HOME" PATH="$(dirname "$NODE"):/usr/bin:/bin" \
    NODE_ENV=production "$NODE" "$HELPER" check) || die "configuration or master key check failed (docs/ops.md §3)"
}

case "${1:-}" in
  print) render ;;
  install)
    if [ "$(id -u)" != 0 ]; then
      exec sudo /usr/bin/env AGENTLEE_USER="$RUN_USER" AGENTLEE_NODE="$NODE" AGENTLEE_LOG_DIR="$LOGDIR" \
        bash "$0" install "${@:2}"
    fi
    preflight
    if [ "${2:-}" != "--yes" ]; then
      echo "This starts Agent Lee on 127.0.0.1:3000 at every boot. Through the Cloudflare Tunnel it is reachable at"
      echo "the public hostname — make sure a Cloudflare Access application protects it first (docs/ops.md §7)."
      read -r -p "Access is protecting the hostname? [y/N] " ok
      [ "$ok" = y ] || [ "$ok" = Y ] || die "aborted"
    fi
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    render > "$tmp"; plutil -lint "$tmp" >/dev/null || die "rendered plist is invalid"
    install -d -m 755 -o "$RUN_USER" -g staff "$LOGDIR"
    launchctl bootout system "$TARGET" 2>/dev/null || true
    install -m 644 -o root -g wheel "$tmp" "$TARGET"
    launchctl bootstrap system "$TARGET"
    echo "installed $TARGET — logs in $LOGDIR"
    ;;
  uninstall)
    [ "$(id -u)" = 0 ] || exec sudo bash "$0" uninstall
    launchctl bootout system "$TARGET" 2>/dev/null || true
    rm -f "$TARGET"; echo "removed $TARGET (logs kept in $LOGDIR)"
    ;;
  print-uptime) render uptime ;;
  install-uptime)
    if [ "$(id -u)" != 0 ]; then
      exec sudo /usr/bin/env AGENTLEE_USER="$RUN_USER" AGENTLEE_NODE="$NODE" AGENTLEE_LOG_DIR="$LOGDIR" \
        bash "$0" install-uptime
    fi
    [ -f "$REPO/node_modules/tsx/dist/cli.mjs" ] || die "tsx not installed — run: pnpm install"
    tok="$RUN_HOME/.agentlee/uptime-token"
    [ -f "$tok" ] || echo "note: $tok not found — checks record the local path only until it exists (docs/ops.md §9)"
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    render uptime > "$tmp"; plutil -lint "$tmp" >/dev/null || die "rendered plist is invalid"
    install -d -m 755 -o "$RUN_USER" -g staff "$LOGDIR"
    launchctl bootout system "$UPTIME_TARGET" 2>/dev/null || true
    install -m 644 -o root -g wheel "$tmp" "$UPTIME_TARGET"
    launchctl bootstrap system "$UPTIME_TARGET"
    echo "installed $UPTIME_TARGET — checks in $LOGDIR/uptime.jsonl"
    ;;
  uninstall-uptime)
    [ "$(id -u)" = 0 ] || exec sudo bash "$0" uninstall-uptime
    launchctl bootout system "$UPTIME_TARGET" 2>/dev/null || true
    rm -f "$UPTIME_TARGET"; echo "removed $UPTIME_TARGET (records kept in $LOGDIR)"
    ;;
  status)
    launchctl print "system/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit code" || echo "$LABEL not loaded"
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
