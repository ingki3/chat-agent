#!/usr/bin/env bash
# CI (#219), the `changes` job: prints "true" when the pull request (the checked-out merge commit against its first
# parent, the base) changes documentation only, else "false". Any failure exits non-zero with nothing printed, so the
# job fails and with it the required checks `test` and `e2e` — never a "true" from a partial file list.
set -euo pipefail

list=$(mktemp)
trap 'rm -f "$list"' EXIT
# --no-renames: a rename lists its old path too (moving docs/traceability.md must run the tests).
# core.quotepath=false and -z: Korean paths and any other bytes come through as they are, NUL-separated.
if ! git -c core.quotepath=false diff --name-only --no-renames -z HEAD^1 HEAD > "$list"; then
  echo "git diff failed: cannot tell what changed" >&2
  exit 1
fi
echo "changed files:" >&2
tr '\0' '\n' < "$list" >&2
verdict=$(bash "$(dirname "$0")/docs-only.sh" < "$list")
case "$verdict" in
  true | false) echo "$verdict" ;;
  *) echo "unexpected verdict: $verdict" >&2; exit 1 ;;
esac
