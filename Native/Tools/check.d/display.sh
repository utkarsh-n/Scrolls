# OWNER: N7
# Stage `display` (IOS-SPEC §2.7): G5 — ScrollsScrollModel's display lists against display.mjs over the reference
# server's own payloads (g5.display: the demo at 430 pt, every tier, the vantage sweep, hit probes; g5.display-wide,
# private: 932 and 1440 pt and Cipher machine on m5r) — and G8 — Metal against DisplayListCanvas on the demo's real
# display lists (ScrollsRenderTests, TOOLCHAINS=metal), plus the LabelAtlas (Indic), pattern-phase and snapshot tests.
# Sourced by Tools/check.sh with `row` and `step`, SCROLLS_BUILD_DIR, SCROLLS_REPORTS_DIR, NATIVE and LOGS. It builds in
# the same narrowed package and scratch as `quick --wp N7`, so the two share their compiled targets. A family whose
# files are absent (the private ones on another Mac) is a SKIP row, never PASS.

JOBS="${SCROLLS_JOBS:-4}"
KITDIR="$SCROLLS_BUILD_DIR/src/Scrolls/Native/ScrollsKit"
SCRATCH="$SCROLLS_BUILD_DIR/kit-quick-N7"
export SCROLLS_TARGETS="ScrollsScrollModel ScrollsRender ScrollsCoreTests ScrollsScrollModelTests ScrollsRenderTests"

step "mirror" "$LOGS/mirror.log" "$NATIVE/Tools/build.sh" mirror || return 0
step "build ScrollsScrollModel + ScrollsRender + tests" "$LOGS/build.log" zsh -c \
  "cd '$KITDIR' && swift build -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --build-tests" || return 0

touch "$LOGS/.tests-start"
step "swift test G5 (ScrollsScrollModelTests)" "$LOGS/g5.log" zsh -c \
  "cd '$KITDIR' && swift test -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --skip-build --filter ScrollsScrollModelTests"
step "swift test G8 (ScrollsRenderTests)" "$LOGS/g8.log" zsh -c \
  "cd '$KITDIR' && swift test -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --skip-build --filter ScrollsRenderTests"
for log in g5 g8; do
  summary="$(sed 's/\x1b\[[0-9;]*m//g' "$LOGS/$log.log" | grep -E 'Test run with [0-9]+ tests?' | tail -n 1)"
  [[ -n "$summary" ]] && row "  tests: $log" INFO "$summary" "$LOGS/$log.log"
done

MANIFEST="$NATIVE/ScrollsKit/Tests/DifferentialTests/Golden/MANIFEST.json"
for fam in g5.inputs g5.display g5.inputs-m5r g5.display-wide; do
  report="$SCROLLS_REPORTS_DIR/golden-$fam.json"
  if [[ -f "$report" && "$report" -nt "$LOGS/.tests-start" ]]; then
    /usr/bin/python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("PASS" if r["passed"] else "FAIL", r["cases"], r["mismatches"], json.dumps(r.get("accepted") or {}))' "$report" \
      | read -r verdict checks mism accepted && row "G5 $fam" "$verdict" "$checks checks, $mism mismatches, accepted $accepted" "$report"
  elif /usr/bin/python3 -I -c 'import json,sys; f=json.load(open(sys.argv[1]))["families"].get(sys.argv[2]); sys.exit(0 if f and f.get("private") else 1)' "$MANIFEST" "$fam"; then
    row "G5 $fam" SKIP "private family absent on this Mac (~/Developer/scrolls-golden/<ref>/private)"
  else
    row "G5 $fam" FAIL "no report written by this run (the test did not run or crashed)" "$LOGS/g5.log"
  fi
done

g8="$SCROLLS_REPORTS_DIR/g8-render.json"
if [[ -f "$g8" && "$g8" -nt "$LOGS/.tests-start" ]]; then
  /usr/bin/python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("PASS" if r["passed"] else "FAIL", r["cases"], r["worst_fraction"])' "$g8" \
    | read -r verdict cases worst && row "G8 Metal = Canvas" "$verdict" "$cases frames, worst $(printf '%.4f' $(( worst * 100 )))% of pixels > 8/255 (budget 1%)" "$g8"
else
  row "G8 Metal = Canvas" FAIL "no g8-render.json written by this run (no Metal device, or the test did not run)" "$LOGS/g8.log"
fi
