#!/bin/zsh
# OWNER: N0
# Regenerates golden fixtures from the mirror's copy of the Node reference (IOS-SPEC §2.1, §8.4.8).
#   Tools/golden.sh [families]        default g1.core; a family, a group or 'all' (comma-separated)
# Regeneration is SERIALISED: only N0 or the integrator runs it, and a lock in ~/Developer/scrolls-golden refuses a second
# run. Output: ~/Developer/scrolls-golden/<commit>/ (all families, private ones under private/), the committed redacted
# subset in ScrollsKit/Tests/DifferentialTests/Golden/ with MANIFEST.json, the generated ScrollsCore sources, and
# Reports/golden-diff-<old>-<new>.json. A reference tree with uncommitted changes is recorded as <commit>+dirty.
# Env: SCROLLS_NODE_ENV (DYLD_LIBRARY_PATH for the broken Homebrew node) · SCROLLS_SNAPSHOTS · SCROLLS_GOLDEN_ROOT
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
SCROLLS="${NATIVE:h}"
WORK="${SCROLLS_BUILD_DIR:-$HOME/Developer/scrolls-build/default}"
FAMILIES="${1:-g1.core}"
GITDIR="${SCROLLS_GIT_DIR:-$HOME/Developer/git/Scrolls.git}"
GOLDEN_ROOT="${SCROLLS_GOLDEN_ROOT:-$HOME/Developer/scrolls-golden}"
export DYLD_LIBRARY_PATH="${SCROLLS_NODE_ENV:-/opt/homebrew/Cellar/simdjson/4.6.11/lib:/opt/homebrew/Cellar/hdrhistogram_c/0.11.10/lib}"

mkdir -p "$GOLDEN_ROOT"
LOCK="$GOLDEN_ROOT/.regenerating"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "golden.sh: another regeneration holds $LOCK ($(cat "$LOCK/owner" 2>/dev/null)); goldens are regenerated one run at a time" >&2
  exit 1
fi
print -r -- "pid $$ $(date -u +%FT%TZ) ${SCROLLS_AGENT:-unknown}" > "$LOCK/owner"
trap 'rm -rf "$LOCK"' EXIT

COMMIT="$(git --git-dir="$GITDIR" rev-parse HEAD)"
DIRTY="$(git --git-dir="$GITDIR" --work-tree="$SCROLLS" status --porcelain -- src server data tests 2>/dev/null | head -1 || true)"
REF="$COMMIT"
if [[ -n "$DIRTY" ]]; then
  REF="$COMMIT+dirty"
  echo "golden.sh: the reference tree has uncommitted changes; recording $REF" >&2
fi

"$NATIVE/Tools/build.sh" mirror >/dev/null
node "$WORK/src/Scrolls/Native/Golden/run.mjs" --families "$FAMILIES" --ref "$REF" --out "$GOLDEN_ROOT/$REF" \
  --commit-subset "$NATIVE/ScrollsKit/Tests/DifferentialTests/Golden" --native "$NATIVE" --reports "$NATIVE/Reports" \
  ${SCROLLS_SNAPSHOTS:+--snapshots "$SCROLLS_SNAPSHOTS"}
