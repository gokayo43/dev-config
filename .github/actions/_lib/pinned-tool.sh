# shellcheck shell=bash
# A released binary, verified against the checksum the caller pinned.
#
# The four tools this repo reaches for — gitleaks, actionlint, k6, shellcheck —
# are Go and Haskell binaries rather than npm packages, so none of them are in a
# lockfile and none are covered by the install policy. The pin is the whole of their supply-chain
# story: the version string is a label, the SHA-256 is the contract, and
# Renovate's pinned-binary manager moves the two together.
#
# `pinned_tool <directory> <url> <sha256> <member>` extracts one member into
# the directory, stripping any leading directories, so the tool lands at
# <directory>/<basename of member>. It returns non-zero on a failed fetch,
# checksum or extract by itself, whatever the caller's shell options: sourced
# under `&&` or without errexit, a step that only failed when errexit was on
# ran whatever a substituted archive held, and left a receipt vouching for it.
pinned_tool() {
  local dir=$1 url=$2 sha256=$3 member=$4
  local tool="$dir/${member##*/}"
  local receipt="$tool.pinned"

  # Already fetched under this exact pin into this directory. In a job, that is
  # a workflow with two callers — one scanning its checkout and one scanning a
  # tree it generated — which otherwise makes a second trip to a release CDN for
  # a byte-identical file and doubles its exposure to that CDN hanging up. For
  # the capacity-ramp command, whose directory is the user's own cache, it is
  # every run after the first: the checksum is checked when the archive is
  # fetched, and the receipt is what later runs trust. The receipt holds the
  # checksum that was verified, so a caller asking for a different pin still
  # fetches.
  if [ -f "$tool" ] && [ "$(cat "$receipt" 2> /dev/null)" = "$sha256" ]; then
    return 0
  fi

  # Dropped before the fetch, not after it: a receipt is a claim that the binary
  # beside it was verified, and a fetch that dies half way through would
  # otherwise leave the previous one standing over a tool it no longer
  # describes. Gone, the next caller fetches again, which is the safe way to be
  # wrong.
  rm -f "$receipt"

  # A directory of this call's own, so two first runs into one directory never
  # share a download or a half-extracted binary, and the binary and then its
  # receipt reach their names by rename, whole.
  local work depth
  work=$(mktemp -d "$dir/.pinned-tool.XXXXXX") || return 1
  depth=$(tr -cd '/' <<< "$member" | wc -c)

  # A release CDN resets a connection now and then, and that is a retry rather
  # than a supply-chain event. --retry-all-errors because the failure this has
  # actually taken is a reset mid-transfer, which plain --retry does not count
  # as transient. What arrived is still only the pinned artefact if the checksum
  # says so, however many attempts it took.
  if curl -sSfL --retry 3 --retry-all-errors --retry-delay 2 -o "$work/archive" "$url" \
    && echo "${sha256}  $work/archive" | sha256sum -c - \
    && tar -xzf "$work/archive" -C "$work" --strip-components="$depth" "$member" \
    && printf '%s' "$sha256" > "$work/receipt" \
    && mv -f "$work/${member##*/}" "$tool" \
    && mv -f "$work/receipt" "$receipt"; then
    rm -rf "$work"
    return 0
  fi
  rm -rf "$work"
  return 1
}
