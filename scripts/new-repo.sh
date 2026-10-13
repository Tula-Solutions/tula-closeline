#!/usr/bin/env bash
# Create a Closeline repo next to the hub from the templates, with the shared setup synced in.
#
#   scripts/new-repo.sh [--publish] <short-name> <library|service|bare> "<description>"
#
# Creates ../tula-closeline-<short-name> on branch `develop`, installs, runs `bun run verify`
# and makes one commit. With --publish it also creates the private GitHub repo under
# Tula-Solutions, pushes `develop`, and for a library tags and pushes v0.1.0.
#
# Libraries must be published before a service is created: a service installs them by tag.
set -euo pipefail

hub=$(cd "$(dirname "$0")/.." && pwd)
publish=0
if [ "${1:-}" = "--publish" ]; then
  publish=1
  shift
fi

short=${1:?usage: new-repo.sh [--publish] <short-name> <library|service|bare> "<description>"}
kind=${2:?kind is required: library, service or bare}
desc=${3:?description is required}

case "$kind" in
  library | service | bare) ;;
  *)
    echo "new-repo: kind must be library, service or bare" >&2
    exit 2
    ;;
esac
case "$desc" in
  *\"* | *\\*)
    echo "new-repo: the description goes into package.json; leave out quotes and backslashes" >&2
    exit 2
    ;;
esac

name="tula-closeline-$short"
parent=$(cd "$hub/.." && pwd)
dir="$parent/$name"
if [ -e "$dir" ]; then
  echo "new-repo: $dir already exists" >&2
  exit 1
fi

mkdir -p "$dir"
cp -R "$hub/templates/common/." "$dir/"
cp -R "$hub/templates/$kind/." "$dir/"
mv "$dir/gitignore" "$dir/.gitignore"

export NAME="$name" SHORT="$short" KIND="$kind" DESC="$desc"
find "$dir" -type f -print0 | xargs -0 perl -pi -e \
  's/__NAME__/$ENV{NAME}/g; s/__SHORT__/$ENV{SHORT}/g; s/__KIND__/$ENV{KIND}/g; s/__DESC__/$ENV{DESC}/g'
find "$dir" -name '*.sh' -exec chmod +x {} +

# Private libraries are declared as git+ssh URLs; fetch them over https with the gh login, for
# this run only, so the script works on a machine with no SSH key and no global rewrite.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='url.https://github.com/Tula-Solutions/.insteadOf'
export GIT_CONFIG_VALUE_0='ssh://git@github.com/Tula-Solutions/'

git -C "$dir" init -q -b develop
"$hub/scripts/sync-shared.sh" "$dir"

(
  cd "$dir"
  bun install
  if [ "$kind" = library ]; then
    bun run build
  fi
  bun run verify
)

git -C "$dir" add -A
git -C "$dir" commit -q \
  -m "chore: scaffold $name from the hub templates" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
echo "new-repo: created $dir"

if [ $publish -eq 1 ]; then
  gh repo create "Tula-Solutions/$name" --private --description "$desc" \
    --source "$dir" --remote origin --push
  if [ "$kind" = library ]; then
    git -C "$dir" tag v0.1.0
    git -C "$dir" push -q origin v0.1.0
  fi
  echo "new-repo: published https://github.com/Tula-Solutions/$name"
fi
