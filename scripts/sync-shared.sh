#!/usr/bin/env bash
# Copy the hub's canonical workflow setup into repos and record what was copied.
#
#   scripts/sync-shared.sh [--check] [<repo-dir>...]
#
# With no directories it targets the hub itself and every sibling tula-closeline-* clone.
# --check copies nothing and exits 1 if any target differs from the hub's copy.
#
# Everything under shared/ is mirrored to the same path in the target. Repos other than the hub
# also receive GLOSSARY.md, biome.json and docs/agents/*.md from the hub root. Each target gets
# .claude/shared.lock ("<sha256>  <path>" per line), which protect-files.sh and shared-check.sh read.
set -euo pipefail

hub=$(cd "$(dirname "$0")/.." && pwd)
check=0
if [ "${1:-}" = "--check" ]; then
  check=1
  shift
fi

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=("$hub")
  for dir in "$hub"/../tula-closeline-*/; do
    [ -d "$dir/.git" ] && targets+=("${dir%/}")
  done
fi

hub_rev=$(git -C "$hub" rev-parse --short HEAD 2>/dev/null || echo unknown)

# Print "<absolute source><TAB><path in target>" for every file a target should hold.
files_for() {
  local target=$1 rel
  (cd "$hub/shared" && find . -type f ! -name .DS_Store | sed 's|^\./||' | LC_ALL=C sort) |
    while IFS= read -r rel; do
      printf '%s\t%s\n' "$hub/shared/$rel" "$rel"
    done
  if [ "$target" != "$hub" ]; then
    # biome.json is canonical at the hub root, not under shared/: Biome refuses a second root
    # config nested inside a project.
    for rel in GLOSSARY.md biome.json docs/agents/domain.md docs/agents/issue-tracker.md docs/agents/triage-labels.md; do
      printf '%s\t%s\n' "$hub/$rel" "$rel"
    done
  fi
}

status=0
for target in "${targets[@]}"; do
  target=$(cd "$target" && pwd)
  name=$(basename "$target")
  lock=$(mktemp)
  echo "# hub: $hub_rev" >"$lock"
  drift=0

  while IFS=$'\t' read -r src rel; do
    if [ $check -eq 1 ]; then
      if ! cmp -s "$src" "$target/$rel"; then
        echo "$name: $rel differs from the hub" >&2
        drift=1
      fi
    else
      mkdir -p "$(dirname "$target/$rel")"
      cp -p "$src" "$target/$rel"
    fi
    printf '%s  %s\n' "$(shasum -a 256 "$src" | cut -d' ' -f1)" "$rel" >>"$lock"
  done < <(files_for "$target")

  if [ $check -eq 1 ]; then
    if [ $drift -eq 1 ]; then
      status=1
    else
      echo "$name: in sync"
    fi
    rm -f "$lock"
  else
    mkdir -p "$target/.claude"
    mv "$lock" "$target/.claude/shared.lock"
    echo "$name: synced at hub $hub_rev"
  fi
done
exit $status
