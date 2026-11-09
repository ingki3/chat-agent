#!/usr/bin/env bash
# Installs the Agent Lee server as a LaunchDaemon (#8). See docs/ops.md §5.
#
#   pnpm launchd print       # render the plist to stdout (no changes)
#   pnpm launchd install     # needs sudo; asks for confirmation (Access must protect the hostname)
#   pnpm launchd uninstall   # needs sudo
#   pnpm launchd status
set -euo pipefail

LABEL=com.agentlee.server
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEMPLATE="$REPO/ops/launchd/$LABEL.plist"
TARGET="/Library/LaunchDaemons/$LABEL.plist"
LOGDIR="${AGENTLEE_LOG_DIR:-/Library/Logs/agentlee}"
RUN_USER="${AGENTLEE_USER:-${SUDO_USER:-$(id -un)}}"
RUN_HOME="$(eval echo "~$RUN_USER")"

die() { echo "install-launchd: $*" >&2; exit 1; }
case "$REPO$RUN_HOME$LOGDIR" in *[\#\&]*) die "paths containing # or & are not supported";; esac

# A stable node binary: version-manager shims and per-shell paths (fnm_multishells) disappear after reboot.
resolve_node() {
  local n="${AGENTLEE_NODE:-$(command -v node || true)}"
  [ -n "$n" ] || die "node not found (set AGENTLEE_NODE)"
  n="$(realpath "$n")"
  case "$n" in *fnm_multishells*|*/shims/*) die "node resolves to a temporary path ($n); set AGENTLEE_NODE to the installed binary";; esac
  [ -x "$n" ] || die "node not executable: $n"
  echo "$n"
}

render() {
  local node; node="$(resolve_node)"
  sed -e "s#__USER__#$RUN_USER#g" -e "s#__HOME__#$RUN_HOME#g" -e "s#__REPO__#$REPO#g" \
      -e "s#__NODE_DIR__#$(dirname "$node")#g" -e "s#__NODE__#$node#g" -e "s#__LOGDIR__#$LOGDIR#g" \
      "$TEMPLATE" | sed '/^<!--$/,/^-->$/d'
}

preflight() {
  [ -f "$REPO/apps/server/dist/index.js" ] || die "server not built — run: pnpm build"
  [ -f "$REPO/apps/web/dist/index.html" ] || die "web not built — run: pnpm build"
  local key
  key="$(cd "$REPO" && sudo -u "$RUN_USER" env HOME="$RUN_HOME" NODE_ENV=production "$(resolve_node)" -e '
    import("./apps/server/dist/config.js").then(async ({ loadConfig }) => {
      await import("./apps/server/dist/env.js"); console.log(loadConfig().masterKeyPath);
    }).catch((e) => { console.error(e.message); process.exit(1); });')" || die "configuration invalid"
  [ -f "$key" ] || die "master key missing at $key — run: pnpm keygen"
  [ "$(stat -f %Lp "$key")" = "600" ] || die "master key $key must be mode 600"
}

case "${1:-}" in
  print) render ;;
  install)
    [ "$(id -u)" = 0 ] || exec sudo -E bash "$0" install "${@:2}"
    preflight
    if [ "${2:-}" != "--yes" ]; then
      echo "This starts Agent Lee on 127.0.0.1:3000 at every boot. Through the Cloudflare Tunnel it is reachable at"
      echo "the public hostname — make sure a Cloudflare Access application protects it first (docs/ops.md §7)."
      read -r -p "Access is protecting the hostname? [y/N] " ok
      [ "$ok" = y ] || [ "$ok" = Y ] || die "aborted"
    fi
    tmp="$(mktemp)"; render > "$tmp"; plutil -lint "$tmp" >/dev/null || die "rendered plist is invalid"
    install -d -m 755 -o "$RUN_USER" -g staff "$LOGDIR"
    launchctl bootout system "$TARGET" 2>/dev/null || true
    install -m 644 -o root -g wheel "$tmp" "$TARGET"; rm -f "$tmp"
    launchctl bootstrap system "$TARGET"
    echo "installed $TARGET — logs in $LOGDIR"
    ;;
  uninstall)
    [ "$(id -u)" = 0 ] || exec sudo bash "$0" uninstall
    launchctl bootout system "$TARGET" 2>/dev/null || true
    rm -f "$TARGET"; echo "removed $TARGET (logs kept in $LOGDIR)"
    ;;
  status)
    launchctl print "system/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit code" || echo "$LABEL not loaded"
    ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
