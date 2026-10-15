# shellcheck shell=bash
# `bun run build`, with the paths the build tool caches in (BUILD_CACHE, one
# repository-relative path per line) kept on the runner's own disk between runs.
#
# Measured on wmstcs (run 38732060284, 2026-10-15): the gate's cold build took
# 75 s in the static job and 131 s in the database job on the garage's 8-vCPU
# runner; on the ops box a cold `next build` took 29 s and one with only
# `.next/cache` (408 MB) kept took 5 s.
#
# The runner's tool cache rather than actions/cache: every fleet job runs on a
# persistent self-hosted machine, and actions/cache would carry those ~400 MB
# through GitHub's cache service over the garage's uplink on every run. A
# runner's first run has an empty store and builds cold.
#
# The key is bun.lock alone. A dependency change starts a fresh cache; a cache
# stale against the source is what the build tool itself invalidates by content
# hash, so keying on the source would only throw away hits.
#
# The store is best effort and the build is not. A restore that fails warns,
# drops the cache it could not read, and the build runs cold; a save or an
# eviction that fails warns and leaves the store as the last good save left
# it. Either way the step's verdict is the build's. Only the caller's own input
# (a path that is not one directory inside the repository, or no bun.lock) is
# refused, before anything runs.
set -euo pipefail
shopt -s nullglob dotglob

# The log lines go here from inside the subshells that capture a copy's error.
exec 3>&1

refuse() {
  echo "::error::$1"
  exit 1
}

warn() {
  echo "::warning::build cache: $1"
}

# Removes a tree this script wrote, warning rather than failing. A build tool
# may write read-only directories, and cp -a keeps their mode, so a removal
# that fails is tried once more with the owner's write access given back.
discard() {
  local message
  rm -rf -- "$1" 2> /dev/null && return
  message=$({ chmod -R u+w -- "$1" && rm -rf -- "$1"; } 2>&1) || warn "could not remove $1: $message"
}

paths=()
while IFS= read -r line; do
  path=${line#"${line%%[![:space:]]*}"}
  path=${path%"${path##*[![:space:]]}"}
  [ -n "$path" ] || continue
  [[ $path != /* ]] || refuse "the build cache path $path is absolute; name a path relative to the repository root, such as .next/cache"
  IFS=/ read -ra segments <<< "$path"
  normal=
  for segment in "${segments[@]}"; do
    case $segment in
      "" | .) ;;
      ..) refuse "the build cache path $path has a .. segment; name a path inside the repository, such as .next/cache" ;;
      *) normal+=${normal:+/}$segment ;;
    esac
  done
  [ -n "$normal" ] || refuse "the build cache path $path is the repository root itself; name the directory the build tool caches in, such as .next/cache"
  # Copied into a directory that already exists, a second copy of one tree
  # lands inside the first, and every run nests it one level deeper.
  for named in "${paths[@]}"; do
    if [[ $normal == "$named" || $normal == "$named"/* || $named == "$normal"/* ]]; then
      refuse "the build cache path $path overlaps $named, named before it; name each directory once, and none inside another"
    fi
  done
  paths+=("$normal")
done <<< "$BUILD_CACHE"

if [ "${#paths[@]}" -eq 0 ]; then
  exec bun run build
fi

[ -f bun.lock ] || refuse "the build cache is keyed on bun.lock, and the repository root has none; commit the lockfile bun install writes"

key=$(sha256sum bun.lock | cut -c1-16)

# One store per runner: two runners on one host each have their own tool cache
# (`_work/_tool` under the runner), and a runner runs one job at a time, so no
# two jobs ever write one store and no lock is taken.
#
# A save lands in a directory of its own, `<key>.<nonce>`, and `current` is a
# link naming the one a restore reads. Replacing that link is one rename, so a
# run killed at any point leaves `current` naming a whole save.
store=$RUNNER_TOOL_CACHE/build-cache/$GITHUB_REPOSITORY

live=
if [ -L "$store/current" ]; then
  live=$(readlink -- "$store/current")
fi
[[ $live == "$key".* ]] || live=

restore() {
  local path
  for path in "${paths[@]}"; do
    if [ -n "$live" ] && [ -e "$store/$live/$path" ]; then
      mkdir -p -- "$(dirname -- "$path")" || return
      rm -rf -- "$path" || return
      cp -a -- "$store/$live/$path" "$path" || return
      echo "build cache: restored $path ($(du -sh -- "$path" | cut -f1))"
    else
      echo "build cache: no cache for $path under key $key"
    fi
  done
}

if ! message=$(restore 2>&1 >&3); then
  warn "the restore failed, so this build runs cold and the cache is dropped: $message"
  for path in "${paths[@]}"; do
    discard "$path"
  done
  discard "$store/$live"
fi

bun run build

save() {
  local path staged link
  mkdir -p -- "$store" || return
  staged=$(mktemp -d "$store/$key.XXXXXX") || return
  for path in "${paths[@]}"; do
    if [ -e "$path" ]; then
      mkdir -p -- "$staged/$(dirname -- "$path")" || return
      # A copy, never a move: a later step may start the built app, and Next
      # writes under .next/cache while it serves.
      cp -a -- "$path" "$staged/$path" || return
      echo "build cache: saved $path ($(du -sh -- "$path" | cut -f1))"
    else
      echo "build cache: $path not written by this build"
    fi
  done
  link=$staged.current
  ln -s -- "${staged##*/}" "$link" || return
  mv -T -- "$link" "$store/current" || return
}

if ! message=$(save 2>&1 >&3); then
  warn "the save failed, so the next run restores the last save that finished: $message"
fi

if [ -d "$store" ]; then
  live=
  if [ -L "$store/current" ]; then
    live=$(readlink -- "$store/current")
  fi
  for entry in "$store"/*; do
    case ${entry##*/} in
      current | "$live") ;;
      *) discard "$entry" ;;
    esac
  done
fi
