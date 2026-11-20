# shellcheck shell=bash
# k6, verified and ready to run, for the capacity-ramp command. Sourced, not
# run: it leaves the binary at $K6 and its version at $K6_VERSION.
#
# The one pin of k6 in this house, which the command reads from the package
# every repo installs. A ramp is only comparable with another ramp of the same
# k6, which is why each result records the version.
#
# renovate: datasource=github-release-attachments depName=grafana/k6
K6_VERSION=v2.2.0
K6_SHA256=b5a8003c86f35f5cd5ceef1490312c48e587696c94d998cefc6d7b3b4cb1597d

# shellcheck source=.github/actions/_lib/pinned-tool.sh
. "$(dirname "${BASH_SOURCE[0]}")/pinned-tool.sh"

pinned_tool \
  "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-amd64.tar.gz" \
  "$K6_SHA256" "k6-${K6_VERSION}-linux-amd64/k6"

K6="$RUNNER_TEMP/k6"
export K6
