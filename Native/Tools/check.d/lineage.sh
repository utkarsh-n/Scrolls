# OWNER: N5
# Stage `lineage` (IOS-SPEC §2.7): the lineage families — G1 (g1.winnow, g1.minhash, g1.align, g1.cues, g1.filters),
# G2 (g2.boilerplate on the
# reference test's synthetic books, with the lineage of the widely shared text they record; g2.boilerplate-m1r, the canary
# on full Cipher), G3 (g3.lineage: lineage graph, chain of custody and genealogy on m1r) — plus ScrollsLineageTests' own unit tests. Sourced by Tools/check.sh with
# `row` and `step`, SCROLLS_BUILD_DIR, SCROLLS_REPORTS_DIR, NATIVE and LOGS. The snapshot-based families need
# ~/Developer/scrolls-snapshots/m1r (SCROLLS_SNAPSHOTS overrides); without it they are SKIP rows, never PASS.

JOBS="${SCROLLS_JOBS:-4}"
KITDIR="$SCROLLS_BUILD_DIR/src/Scrolls/Native/ScrollsKit"
SCRATCH="$SCROLLS_BUILD_DIR/kit-lineage"
SNAPS="${SCROLLS_SNAPSHOTS:-$HOME/Developer/scrolls-snapshots}"
export SCROLLS_TARGETS="ScrollsLineage ScrollsLineageTests"

step "mirror" "$LOGS/mirror.log" "$NATIVE/Tools/build.sh" mirror || return 0
step "build ScrollsLineage + tests" "$LOGS/build.log" zsh -c \
  "cd '$KITDIR' && swift build -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --build-tests" || return 0

HAVE_M1R=0
[[ -f "$SNAPS/m1r/scrolls.db" && -f "$SNAPS/m1r/SNAPSHOT.json" ]] && HAVE_M1R=1
touch "$LOGS/.tests-start"
step "swift test ScrollsLineageTests (with the m1r families)" "$LOGS/test.log" zsh -c \
  "cd '$KITDIR' && SCROLLS_LINEAGE_M1R=$HAVE_M1R SCROLLS_LINEAGE_G3=$HAVE_M1R swift test -c release -Xswiftc -enable-testing -j $JOBS \
     --scratch-path '$SCRATCH' --skip-build --filter ScrollsLineageTests"
summary="$(sed 's/\x1b\[[0-9;]*m//g' "$LOGS/test.log" | grep -E 'Test run with [0-9]+ tests?' | tail -n 1)"
[[ -n "$summary" ]] && row "  tests: ScrollsLineageTests" INFO "$summary" "$LOGS/test.log"

for fam in g1.winnow g1.minhash g1.align g1.cues g1.filters g2.boilerplate g2.boilerplate-m1r g3.lineage; do
  report="$SCROLLS_REPORTS_DIR/golden-$fam.json"
  if [[ -f "$report" && "$report" -nt "$LOGS/.tests-start" ]]; then
    /usr/bin/python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("PASS" if r["passed"] else "FAIL", r["cases"], r["mismatches"])' "$report" \
      | read -r verdict checks mism && row "${fam%%.*} $fam" "$verdict" "$checks checks, $mism mismatches" "$report"
  elif [[ "$fam" == g2.boilerplate-m1r || "$fam" == g3.lineage ]] && (( ! HAVE_M1R )); then
    row "${fam%%.*} $fam" SKIP "needs the m1r snapshot ($SNAPS/m1r)"
  elif [[ "$fam" == g3.lineage ]] && ! grep -q '"g3.lineage"' "$NATIVE/ScrollsKit/Tests/DifferentialTests/Golden/MANIFEST.json"; then
    row "g3 g3.lineage" PENDING "not generated yet (Tools/golden.sh g3.lineage)"
  else
    row "${fam%%.*} $fam" FAIL "no report written by this run (the test did not run or crashed)" "$LOGS/test.log"
  fi
done

g3t="$SCROLLS_REPORTS_DIR/lineage-g3-timings.json"
if [[ -f "$g3t" && "$g3t" -nt "$LOGS/.tests-start" ]]; then
  row "g3.lineage requests on m1r (Mac, release)" INFO "$(/usr/bin/python3 -I -c 'import json,sys; t=json.load(open(sys.argv[1])); print(t["requests"], "requests in", t["seconds"], "s; slowest", ", ".join(str(x["id"]) + " " + str(x["s"]) + " s" for x in t["slowest"][:3]))' "$g3t")" "$g3t"
fi

timings="$SCROLLS_REPORTS_DIR/lineage-boilerplate-m1r-timings.json"
if [[ -f "$timings" && "$timings" -nt "$LOGS/.tests-start" ]]; then
  row "boilerplate pass on m1r (Mac, release)" INFO "$(/usr/bin/python3 -I -c 'import json,sys; t=json.load(open(sys.argv[1]))["seconds"]; print(", ".join(f"{k} {v} s" for k,v in t.items()))' "$timings")" "$timings"
fi
