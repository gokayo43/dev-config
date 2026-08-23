# shellcheck shell=bash
# The shellcheck binary, verified and ready to run, for everything in this house
# that is shell. Sourced, not run: it leaves it at $SHELLCHECK.
#
# The line above is a directive and this one is prose. The tool tells them apart
# by the first word of the comment, so no line here may open with its name —
# one that does is read as a directive and refused as unparseable.
#
# The pin lives beside the fetch rather than at each call site, for the reason
# k6.sh gives: two callers — the shell-scripts gate over a repo's tracked
# scripts, and this repo's own pass over the scripts inlined in its composite
# actions — and a version written out twice is a version that drifts. Why it is
# pinned at all is docs/gates/shell-scripts.md, under "Which shellcheck".
#
# renovate: datasource=github-release-attachments depName=koalaman/shellcheck
SHELLCHECK_VERSION=v0.11.0
SHELLCHECK_SHA256=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6

# shellcheck source=.github/actions/_lib/pinned-tool.sh
. "$(dirname "${BASH_SOURCE[0]}")/pinned-tool.sh"

pinned_tool \
  "https://github.com/koalaman/shellcheck/releases/download/${SHELLCHECK_VERSION}/shellcheck-${SHELLCHECK_VERSION}.linux.x86_64.tar.gz" \
  "$SHELLCHECK_SHA256" "shellcheck-${SHELLCHECK_VERSION}/shellcheck"

SHELLCHECK="$RUNNER_TEMP/shellcheck"
export SHELLCHECK
