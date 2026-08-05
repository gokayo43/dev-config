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
  local archive="$RUNNER_TEMP/pinned-tool.tar.gz"
  local depth
  depth=$(tr -cd '/' <<< "$member" | wc -c)

  curl -sSfL -o "$archive" "$url"
  echo "${sha256}  ${archive}" | sha256sum -c -
  tar -xzf "$archive" -C "$RUNNER_TEMP" --strip-components="$depth" "$member"
  rm -f "$archive"
}
