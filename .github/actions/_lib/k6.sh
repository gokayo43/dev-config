# shellcheck shell=bash
# k6, verified and ready to run, for every ramp in this house. Sourced, not run:
# it leaves the binary at $K6.
#
# The pin lives beside the fetch rather than at each call site. There are three
# callers — db-gate's ramp, this repo's own execution of the shipped script, and
# project-template's ramp against a preview stack — and a version written out
# three times is a version that drifts twice. A ramp is only comparable with
# another ramp of the same k6, which is the whole reason those numbers are kept.
#
# renovate: datasource=github-release-attachments depName=grafana/k6
K6_VERSION=v2.3.0
K6_SHA256=39c3117b6af817592dcd0ce4242105c0a7af10948c2a425306f0be8f7a8a8ab1

# shellcheck source=.github/actions/_lib/pinned-tool.sh
. "$(dirname "${BASH_SOURCE[0]}")/pinned-tool.sh"

pinned_tool \
  "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-amd64.tar.gz" \
  "$K6_SHA256" "k6-${K6_VERSION}-linux-amd64/k6"

K6="$RUNNER_TEMP/k6"
export K6
