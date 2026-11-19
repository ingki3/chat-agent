#!/usr/bin/env bash
# CI (#219): reads changed paths, one per line, on stdin; prints "true" when every one is documentation only, else
# "false". An allow-list, not a deny-list: anything not listed (code, config, fixtures, instructions/*.md, scripts under
# docs/) runs the full suite. PRD.md and docs/traceability.md are read by scripts/test/traceability.test.ts, so they are
# not documentation only. Feed it `git diff --name-only --no-renames`, so a rename shows its old path as well as its new.
set -euo pipefail

any=false
while IFS= read -r path || [ -n "$path" ]; do
  [ -z "$path" ] && continue
  any=true
  case "$path" in
    PRD.md | docs/traceability.md) echo false; exit 0 ;;
  esac
  if ! printf '%s\n' "$path" | grep -qE '^(docs/.+\.md|[^/]+\.md|mockup/.+\.md|\.github/pull_request_template\.md)$'; then
    echo false
    exit 0
  fi
done
echo "$any"
