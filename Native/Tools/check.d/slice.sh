# OWNER: N2
# Stage `slice` (IOS-SPEC §2.7): G2 on the Cipher slice — Golden/slices.mjs + gen-sources.mjs (the frozen reference's build
# of the slice, dumped) against this engine's build of the same files (DifferentialTests/Sources/CipherSliceTests: the
# slice packed as Tools/packs.sh packs Cipher, the bootstrap's phases A, A2 and B, LogicalDump per table, exact under the
# rules written in that file) — plus the Sources unit tests. Sourced by Tools/check.sh with `row` and `step`,
# SCROLLS_BUILD_DIR, SCROLLS_REPORTS_DIR, NATIVE and LOGS. The STEMM slice is M2 work (a PENDING row, never PASS). The
# slice's inputs and full rows are private families (~/Developer/scrolls-golden/<ref>/private); without them the
# comparison falls back to the committed digests and says so.

JOBS="${SCROLLS_JOBS:-4}"
KITDIR="$SCROLLS_BUILD_DIR/src/Scrolls/Native/ScrollsKit"
SCRATCH="$SCROLLS_BUILD_DIR/kit-slice"
export SCROLLS_TARGETS="ScrollsService ScrollsSources ScrollsSourcesTests DifferentialTests"

step "mirror" "$LOGS/mirror.log" "$NATIVE/Tools/build.sh" mirror || return 0
step "build ScrollsService, DifferentialTests, ScrollsSourcesTests" "$LOGS/build.log" zsh -c \
  "cd '$KITDIR' && swift build -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --build-tests" || return 0

touch "$LOGS/.tests-start"
step "swift test ScrollsSourcesTests + DifferentialTests.CipherSliceTests" "$LOGS/test.log" zsh -c \
  "cd '$KITDIR' && swift test -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --skip-build \
     --filter 'ScrollsSourcesTests|DifferentialTests.CipherSliceTests'"
sed 's/\x1b\[[0-9;]*m//g' "$LOGS/test.log" | grep -E 'Test run with [0-9]+ tests?' | while read -r line; do
  row "  tests" INFO "$line" "$LOGS/test.log"
done

report="$SCROLLS_REPORTS_DIR/golden-g2.cipher-slice.json"
if [[ -f "$report" && "$report" -nt "$LOGS/.tests-start" ]]; then
  /usr/bin/python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("PASS" if r["passed"] else "FAIL", r["cases"], r["mismatches"], ",".join(d["path"] for d in r["diffs"]))' "$report" \
    | read -r verdict tables mism which && row "G2 g2.cipher-slice" "$verdict" "$tables tables compared, $mism differ${which:+: $which}" "$report"
elif grep -q 'SKIP g2.cipher-slice' "$LOGS/test.log"; then
  row "G2 g2.cipher-slice" SKIP "the private slice inputs are absent on this Mac (~/Developer/scrolls-golden/<ref>/private)"
elif ! grep -q '"g2.cipher-slice"' "$NATIVE/ScrollsKit/Tests/DifferentialTests/Golden/MANIFEST.json"; then
  row "G2 g2.cipher-slice" FAIL "not generated: Tools/golden.sh g2.cipher-slice,g2.cipher-slice-rows,g2.cipher-slice-inputs"
else
  row "G2 g2.cipher-slice" FAIL "no report written by this run (the test did not run, skipped or crashed)" "$LOGS/test.log"
fi
row "G2 g2.stemm-slice" PENDING "M2 (package N2): the STEMM adapters and their slice are not written yet"
