# OWNER: N4
# Stage `analysis` (IOS-SPEC §2.7): N4's differential families within §2.4.
#   G1 g1.stats      ScrollsAnalysisTests (pure statistics on the reference's seeded inputs)
#   G3 g3.compare    `scrolls-cli diff-analysis`: POST /api/compare replayed through LiveAtlas (compare_log in the atlas,
#      g3.collocations  sessions in order) on cp -c clones of m1r and m5r, InlineTextStore, the reference's environment
#                    (no NL adapter, no Ngram store, the snapshot's token streams); plus ScrollsAnalysisTests' own m1r
#                    replay through CompareEngine and the no-numeral checks
#   G4               M3 (vectors, clustering on the reference's vectors, drift, convergence, constellation, tone): PENDING
# Sourced by Tools/check.sh with `row` and `step`, SCROLLS_BUILD_DIR, SCROLLS_REPORTS_DIR, NATIVE and LOGS. Without the
# snapshots (~/Developer/scrolls-snapshots, SCROLLS_SNAPSHOTS overrides) the G3 rows are SKIP, never PASS.

JOBS="${SCROLLS_JOBS:-4}"
KITDIR="$SCROLLS_BUILD_DIR/src/Scrolls/Native/ScrollsKit"
SCRATCH="$SCROLLS_BUILD_DIR/kit-analysis"
SNAPS="${SCROLLS_SNAPSHOTS:-$HOME/Developer/scrolls-snapshots}"
GOLDEN="$NATIVE/ScrollsKit/Tests/DifferentialTests/Golden"

# 1. ScrollsAnalysisTests (G1 g1.stats, the m1r replay, the no-numeral tests) on a narrowed package
export SCROLLS_TARGETS="ScrollsAnalysis ScrollsNL ScrollsAnalysisTests"
step "mirror" "$LOGS/mirror.log" "$NATIVE/Tools/build.sh" mirror || return 0
step "build ScrollsAnalysis + tests" "$LOGS/build.log" zsh -c \
  "cd '$KITDIR' && swift build -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --build-tests" || return 0
touch "$LOGS/.tests-start"
step "swift test ScrollsAnalysisTests" "$LOGS/test.log" zsh -c \
  "cd '$KITDIR' && SCROLLS_SNAPSHOTS='$SNAPS' swift test -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --skip-build --filter ScrollsAnalysisTests"
summary="$(sed 's/\x1b\[[0-9;]*m//g' "$LOGS/test.log" | grep -E 'Test run with [0-9]+ tests?' | tail -n 1)"
[[ -n "$summary" ]] && row "  tests: ScrollsAnalysisTests" INFO "$summary" "$LOGS/test.log"
report="$SCROLLS_REPORTS_DIR/golden-g1.stats.json"
if [[ -f "$report" && "$report" -nt "$LOGS/.tests-start" ]]; then
  /usr/bin/python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("PASS" if r["passed"] else "FAIL", r["cases"], r["mismatches"])' "$report" \
    | read -r verdict checks mism && row "G1 g1.stats" "$verdict" "$checks checks, $mism mismatches" "$report"
else
  row "G1 g1.stats" FAIL "no report written by this run" "$LOGS/test.log"
fi

# 2. G3 through the CLI (LiveAtlas, both snapshots)
unset SCROLLS_TARGETS
if [[ ! -f "$SNAPS/m1r/SNAPSHOT.json" || ! -f "$SNAPS/m5r/SNAPSHOT.json" ]]; then
  row "G3 g3.compare" SKIP "needs the m1r and m5r snapshots ($SNAPS)"
  row "G3 g3.collocations" SKIP "needs the m1r and m5r snapshots ($SNAPS)"
else
  step "build scrolls-cli" "$LOGS/cli.log" "$NATIVE/Tools/build.sh" cli || return 0
  CLI="$SCROLLS_BUILD_DIR/kit-cli/release/scrolls-cli"
  touch "$LOGS/.g3-start"
  step "scrolls-cli diff-analysis (m1r, m5r)" "$LOGS/diff-analysis.log" "$CLI" diff-analysis --golden "$GOLDEN" \
    --families g3.compare,g3.collocations --snapshots "$SNAPS" --reports "$SCROLLS_REPORTS_DIR" \
    --report "$SCROLLS_REPORTS_DIR/analysis-g3-cases.json"
  for fam in g3.compare g3.collocations; do
    report="$SCROLLS_REPORTS_DIR/golden-$fam.json"
    if [[ -f "$report" && "$report" -nt "$LOGS/.g3-start" ]]; then
      /usr/bin/python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); lost=r.get("contract_lost") or {}; print("PASS" if r["passed"] else "FAIL", r["cases"], r["mismatches"], len(lost))' "$report" \
        | read -r verdict checks mism lost && row "G3 $fam" "$verdict" "$checks cases, $mism mismatches; $lost payload keys the contract types drop" "$report"
    else
      row "G3 $fam" FAIL "no report written by this run" "$LOGS/diff-analysis.log"
    fi
  done
fi

# 3. G4: N4's M3 family
row "G4 g4.analysis" PENDING "M3: vectors, clustering on the reference's exported vectors, drift, convergence, constellation, tone"
