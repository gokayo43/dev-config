# A released binary, verified against the checksum the caller pinned.
#
# The three tools this repo reaches for — gitleaks, actionlint, k6 — are Go
# binaries rather than npm packages, so none of them are in a lockfile and none
# are covered by the install policy. The pin is the whole of their supply-chain
# story: the version string is a label, the SHA-256 is the contract, and
# Renovate's pinned-binary manager moves the two together.
#
# Extracts one member into $RUNNER_TEMP, stripping any leading directories, so
# the tool lands at $RUNNER_TEMP/<basename of member>.
pinned_tool() {
  local url=$1 sha256=$2 member=$3
  local tool="$RUNNER_TEMP/${member##*/}"
  local receipt="$tool.pinned"

  # Already fetched under this exact pin, earlier in this job. A workflow with
  # two callers — one scanning its checkout and one scanning a tree it
  # generated — otherwise makes a second trip to a release CDN for a
  # byte-identical file, and doubles its exposure to that CDN hanging up. The
  # receipt holds the checksum that was verified, so a caller asking for a
  # different pin still fetches.
  if [ -f "$tool" ] && [ "$(cat "$receipt" 2> /dev/null)" = "$sha256" ]; then
    return 0
  fi

  # Dropped before the fetch, not after it: a receipt is a claim that the binary
  # beside it was verified, and a fetch that dies half way through would
  # otherwise leave the previous one standing over a tool it no longer
  # describes. Gone, the next caller fetches again, which is the safe way to be
  # wrong.
  rm -f "$receipt"

  local archive="$RUNNER_TEMP/pinned-tool.tar.gz"
  local depth
  depth=$(tr -cd '/' <<< "$member" | wc -c)

  # A release CDN resets a connection now and then, and that is a retry rather
  # than a supply-chain event. --retry-all-errors because the failure this has
  # actually taken is a reset mid-transfer, which plain --retry does not count
  # as transient. What arrived is still only the pinned artefact if the checksum
  # below says so, however many attempts it took.
  curl -sSfL --retry 3 --retry-all-errors --retry-delay 2 -o "$archive" "$url"
  echo "${sha256}  ${archive}" | sha256sum -c -
  tar -xzf "$archive" -C "$RUNNER_TEMP" --strip-components="$depth" "$member"
  rm -f "$archive"
  printf '%s' "$sha256" > "$receipt"
}
