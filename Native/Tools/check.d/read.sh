# OWNER: N3
# Stage `read` (IOS-SPEC §2.7): G3 of the read path. `scrolls-cli diff-read` replays the recorded reference requests
# (g3.read-m1r; g3.read-m5r at M2) in process on a cp -c clone of the snapshot through InlineTextStore and compares every
# response (exact for counts, states, ids, labels, copy and sort orders; §2.4 tolerance for floats). Also runs
# ScrollsQueryTests with the m1r-based suites switched on: conservation at every tier for 50 filter combinations,
# offsets exact, cube = SQL denominators on 1,000 slices, export_text_allowed = 0 in every format, and the SQLCatalog
# plans on m1r. Sourced by Tools/check.sh with `row` and `step`, SCROLLS_BUILD_DIR, SCROLLS_REPORTS_DIR, NATIVE and LOGS.
# Without ~/Developer/scrolls-snapshots/m1r (SCROLLS_SNAPSHOTS overrides) or the private golden the rows are SKIP,
# never PASS.

JOBS="${SCROLLS_JOBS:-4}"
KITDIR="$SCROLLS_BUILD_DIR/src/Scrolls/Native/ScrollsKit"
SCRATCH="$SCROLLS_BUILD_DIR/kit-read"
SNAPS="${SCROLLS_SNAPSHOTS:-$HOME/Developer/scrolls-snapshots}"
GOLDEN_ROOT="${SCROLLS_GOLDEN_ROOT:-$HOME/Developer/scrolls-golden}"
MANIFEST="$NATIVE/ScrollsKit/Tests/DifferentialTests/Golden/MANIFEST.json"

step "mirror" "$LOGS/mirror.log" "$NATIVE/Tools/build.sh" mirror || return 0
step "build scrolls-cli + ScrollsQueryTests" "$LOGS/build.log" zsh -c \
  "cd '$KITDIR' && swift build -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --build-tests" || return 0
CLI="$SCRATCH/release/scrolls-cli"

HAVE_M1R=0
[[ -f "$SNAPS/m1r/scrolls.db" && -f "$SNAPS/m1r/SNAPSHOT.json" ]] && HAVE_M1R=1
touch "$LOGS/.tests-start"
if (( HAVE_M1R )); then
  step "swift test ScrollsQueryTests (with the m1r suites)" "$LOGS/test.log" zsh -c \
    "cd '$KITDIR' && SCROLLS_QUERY_M1R=1 SCROLLS_SNAPSHOTS='$SNAPS' swift test -c release -Xswiftc -enable-testing -j $JOBS \
       --scratch-path '$SCRATCH' --skip-build --filter ScrollsQueryTests"
  summary="$(sed 's/\x1b\[[0-9;]*m//g' "$LOGS/test.log" | grep -E 'Test run with [0-9]+ tests?' | tail -n 1)"
  [[ -n "$summary" ]] && row "  tests: ScrollsQueryTests" INFO "$summary" "$LOGS/test.log"
else
  row "ScrollsQueryTests (m1r suites)" SKIP "needs the m1r snapshot ($SNAPS/m1r)"
fi

# The private G3 family: the files MANIFEST.json lists, under the reference commit it was generated at.
golden_dir() {
  /usr/bin/python3 -I -c '
import hashlib, json, os, sys
m = json.load(open(sys.argv[1])); fam = sys.argv[2]; root = sys.argv[3]
e = m.get("families", {}).get(fam)
if not e: print("MISSING not in MANIFEST.json"); sys.exit()
d = os.path.join(root, e["reference_commit"], "private")
for f, sha in e["files"].items():
    p = os.path.join(d, fam, f)
    if not os.path.exists(p): print("MISSING " + p); sys.exit()
    if hashlib.sha256(open(p, "rb").read()).hexdigest() != sha: print("STALE " + p + " (sha256 differs from MANIFEST.json)"); sys.exit()
print("OK " + d)' "$MANIFEST" "$1" "$GOLDEN_ROOT"
}

for fam in g3.read-m1r g3.read-m5r; do
  snap="${fam#g3.read-}"
  res="$(golden_dir "$fam")"
  if [[ "$res" != OK* ]]; then
    if [[ "$fam" == g3.read-m5r ]]; then row "g3 $fam" PENDING "milestone M2 (${res})"; else row "g3 $fam" SKIP "$res"; fi
    continue
  fi
  if [[ ! -f "$SNAPS/$snap/scrolls.db" ]]; then row "g3 $fam" SKIP "needs the $snap snapshot ($SNAPS/$snap)"; continue; fi
  if step "g3 $fam (scrolls-cli diff-read)" "$LOGS/diff-$snap.log" "$CLI" diff-read --family "$fam" --golden "${res#OK }" \
       --snapshots "$SNAPS" --reports "$SCROLLS_REPORTS_DIR" --report "$SCROLLS_REPORTS_DIR/g3-read-$snap-cases.json"; then :; fi
  line="$(grep -E "^$fam: " "$LOGS/diff-$snap.log" | tail -n 1)"
  [[ -n "$line" ]] && row "  $fam" INFO "$line" "$SCROLLS_REPORTS_DIR/golden-$fam.json"
done
