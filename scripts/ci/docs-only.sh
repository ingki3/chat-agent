#!/usr/bin/env bash
# CI (#219): reads changed paths, NUL-separated, on stdin; prints "true" when every one is documentation only, else
# "false". An allow-list, not a deny-list: anything not listed (code, config, fixtures, instructions/*.md, scripts under
# docs/) runs the full suite. PRD.md and docs/traceability.md are read by scripts/test/traceability.test.ts, so they are
# not documentation only. Feed it `git -c core.quotepath=false diff --name-only --no-renames -z`: a rename shows its old
# path as well as its new, and a non-ASCII path (Korean) comes through as itself, not quoted. A path with a newline in
# it is not treated as documentation (full run).
set -euo pipefail

docs='^(docs/.+\.md|[^/]+\.md|mockup/.+\.md|\.github/pull_request_template\.md)$'
any=false
while IFS= read -r -d '' path || [ -n "$path" ]; do
  [ -z "$path" ] && continue
  any=true
  case "$path" in
    PRD.md | docs/traceability.md | *$'\n'*) echo false; exit 0 ;;
  esac
  [[ "$path" =~ $docs ]] || { echo false; exit 0; }
done
echo "$any"
