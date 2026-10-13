#!/usr/bin/env bash
# Fail if dist/ is not what a fresh build of the current source produces (ADR 0006).
# Part of `bun run verify`. On failure dist/ has already been rebuilt: commit it.
set -euo pipefail
cd "$(dirname "$0")/.."

before=$(mktemp -d)
trap 'rm -rf "$before"' EXIT
[ -d dist ] && cp -R dist/. "$before"/

bun run build >/dev/null

if ! diff -r "$before" dist >/dev/null 2>&1; then
  echo "dist-check: dist/ was stale and has been rebuilt. Commit dist/ and rerun." >&2
  diff -rq "$before" dist >&2 || true
  exit 1
fi
