# OWNER: N8
# Stage `app` (IOS-SPEC §2.7): xcodegen → the simulator build (build-for-testing) → ScrollsAppTests + ScrollsUITests
# (first minute, gestures, accessibility audit, state restoration, presentation, lint, …) on the simulator. Sourced by
# Tools/check.sh, which provides `row`, `step`, SCROLLS_BUILD_DIR, LOGS, NATIVE and SCROLLS_REPORTS_DIR.
#   Tools/check.sh app                       every app test (unit + UI) on $SCROLLS_SIM ("Scrolls 15 Pro Max")
#   Tools/check.sh app --unit                ScrollsAppTests only (no UI tests: minutes instead of a quarter hour)
#   Tools/check.sh app --only <id> …         xcodebuild -only-testing identifiers (e.g. ScrollsUITests/FirstMinuteTests)
#   Tools/check.sh app --sim "<name>"        another simulator (each agent uses its own)
# One row per test class: PASS when every test passed, SKIP when every test was skipped (never a pass), FAIL naming the
# failing tests and their first message. The first minute's timings (`FIRSTMINUTE …` lines printed by FirstMinuteTests)
# go to Reports/app-first-minute-<stamp>.json: simulator proxies, never device measurements. Swift warnings in the app's
# own sources are a FAIL row (§8.2: no warnings).

# Simulator hold (kernel panics in simctl, 2026-10-14): the whole stage needs the simulator, so it is a SKIP row while
# ~/Developer/scrolls-build/.simulator-hold exists (never a PASS).
if [[ -e "$HOME/Developer/scrolls-build/.simulator-hold" ]]; then
  row "app (simulator)" SKIP "simulator hold in force: $(head -1 "$HOME/Developer/scrolls-build/.simulator-hold")"
  return 0
fi
APP_SIM="${SCROLLS_SIM:-Scrolls 15 Pro Max}"
APP_ONLY=()
APP_UNIT=0
while (( $# )); do
  case "$1" in
    --sim) APP_SIM="${2:?--sim needs a simulator name}"; shift 2 ;;
    --only) APP_ONLY+=("${2:?--only needs a test identifier}"); shift 2 ;;
    --unit) APP_UNIT=1; shift ;;
    *) row "arguments" FAIL "unknown argument '$1' (app [--unit] [--only <id>]… [--sim <name>])"; shift ;;
  esac
done
if (( ${#APP_ONLY} == 0 )); then
  APP_ONLY=(ScrollsAppTests)
  (( APP_UNIT )) || APP_ONLY+=(ScrollsUITests)
fi

APP_SIMCTL=(perl -e 'alarm shift; exec @ARGV' "${SCROLLS_SIMCTL_TIMEOUT:-300}" xcrun simctl)
APP_PROJECT_DIR="$SCROLLS_BUILD_DIR/src/Scrolls/Native"
APP_DD="$SCROLLS_BUILD_DIR/dd"
APP_DEST="platform=iOS Simulator,name=$APP_SIM"

# 1. The simulator (an iPhone 15 Pro Max on iOS 27: his phone's 430 × 932 pt).
APP_UDID="$("${APP_SIMCTL[@]}" list devices available 2>/dev/null | grep -F "    $APP_SIM (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
if [[ -z "$APP_UDID" ]]; then
  step "simulator '$APP_SIM'" "$LOGS/sim-create.log" env SCROLLS_SIM="$APP_SIM" "$NATIVE/Tools/build.sh" sim-create || return 0
  APP_UDID="$("${APP_SIMCTL[@]}" list devices available 2>/dev/null | grep -F "    $APP_SIM (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
else
  row "simulator '$APP_SIM'" INFO "$APP_UDID"
fi

# 2. Mirror (full BuildInfo) + xcodegen, then one Debug build of the app and both test bundles.
step "mirror + xcodegen" "$LOGS/xcodegen.log" "$NATIVE/Tools/build.sh" xcodegen || return 0
# Continue after errors, so one failing build names every broken file; each error is attributed to the package in its
# file's `// OWNER:` line (one FAIL row per owner).
app_build() {
  ( cd "$APP_PROJECT_DIR" && xcodebuild -project Scrolls.xcodeproj -scheme Scrolls -configuration Debug \
      -derivedDataPath "$APP_DD" -jobs "${SCROLLS_JOBS:-4}" -destination "$APP_DEST" \
      -IDEBuildingContinueBuildingAfterErrors=YES build-for-testing )
}
if ! step "build for testing (Debug, $APP_SIM)" "$LOGS/build-for-testing.log" app_build; then
  /usr/bin/python3 -I - "$LOGS/build-for-testing.log" "$ROWS" <<'PY'
import re, sys
log, rows = sys.argv[1:3]
by = {}
for line in open(log, encoding="utf-8", errors="replace"):
    m = re.match(r"(/[^:]+\.(?:swift|metal|h)):(\d+):\d+: error: (.*)", line.strip())
    if not m:
        continue
    path, ln, msg = m.groups()
    if "Unable to resolve module dependency" in msg or "no such module" in msg:
        continue   # a cascade of another target's failure, not this file's error
    owner = "?"
    try:
        head = open(path, encoding="utf-8", errors="replace").read(400)
        o = re.search(r"OWNER:\s*([A-Za-z0-9]+)", head)
        owner = o.group(1) if o else "?"
    except OSError:
        pass
    short = path.split("/Native/", 1)[-1]
    by.setdefault(owner, {})[f"{short}:{ln}"] = msg
with open(rows, "a", encoding="utf-8") as out:
    for owner in sorted(by):
        errs = by[owner]
        detail = f"{len(errs)} error(s): " + " | ".join(f"{k}: {v}"[:200] for k, v in list(errs.items())[:4])
        out.write(f"build errors owned by {owner}\tFAIL\t{detail.replace(chr(9), ' ')}\t{log}\n")
PY
  return 0
fi
# Swift warnings in the app's own sources and test bundles (engine warnings belong to quick).
APP_WARN="$(grep -E '/Native/(Scrolls|ScrollsAppTests|ScrollsUITests)/[^:]+\.swift:[0-9]+:[0-9]+: warning:' "$LOGS/build-for-testing.log" | sort -u)"
if [[ -n "$APP_WARN" ]]; then
  row "app warnings" FAIL "$(print -r -- "$APP_WARN" | wc -l | tr -d ' ') warning(s): $(print -r -- "$APP_WARN" | head -3 | sed -E 's#.*/Native/##' | tr '\n' ' ' | cut -c1-400)" "$LOGS/build-for-testing.log"
else
  row "app warnings" PASS "0 Swift warnings in Scrolls/, ScrollsAppTests/, ScrollsUITests/"
fi

# 3. The tests, on a booted simulator, serially (UI tests share one simulator).
"${APP_SIMCTL[@]}" boot "$APP_UDID" >/dev/null 2>&1 || true
APP_RESULT="$LOGS/app-tests.xcresult"
APP_ONLY_ARGS=()
for t in "${APP_ONLY[@]}"; do APP_ONLY_ARGS+=("-only-testing:$t"); done
# xcodebuild can sit in its post-failure `simctl diagnose` for many minutes under load (N0, BUILD.md): a deadline
# (SCROLLS_APP_TEST_TIMEOUT, 5400 s) stops it; the result bundle is read either way.
app_test() {
  ( cd "$APP_PROJECT_DIR" && perl -e 'alarm shift; exec @ARGV' "${SCROLLS_APP_TEST_TIMEOUT:-5400}" \
      xcodebuild -project Scrolls.xcodeproj -scheme Scrolls -configuration Debug \
      -derivedDataPath "$APP_DD" -destination "$APP_DEST" -resultBundlePath "$APP_RESULT" -parallel-testing-enabled NO \
      "${APP_ONLY_ARGS[@]}" test-without-building )
}
APP_T0=$SECONDS
app_test > "$LOGS/test.log" 2>&1
APP_RC=$?
row "xcodebuild test (${APP_ONLY[*]})" INFO "$(( SECONDS - APP_T0 )) s, exit $APP_RC" "$LOGS/test.log"

# 4. One row per test class from the result bundle; the first-minute timings into a report.
if [[ -d "$APP_RESULT" ]]; then
  xcrun xcresulttool get test-results tests --path "$APP_RESULT" > "$LOGS/tests.json" 2> "$LOGS/xcresulttool.log"
  /usr/bin/python3 -I - "$LOGS/tests.json" "$LOGS/test.log" "$SCROLLS_REPORTS_DIR" "$APP_SIM" "$ROWS" <<'PY'
import json, re, sys, time
tests_path, log_path, reports, sim, rows_path = sys.argv[1:6]
try:
    data = json.load(open(tests_path, encoding="utf-8"))
except Exception as e:  # no readable result: one FAIL row
    open(rows_path, "a").write(f"result bundle\tFAIL\tunreadable test results: {e}\t{tests_path}\n")
    sys.exit(0)
classes = {}
def walk(node, bundle=None, suite=None):
    kind = node.get("nodeType", "")
    name = node.get("name", "")
    if kind in ("Unit test bundle", "UI test bundle"):
        bundle = name
    if kind == "Test Suite":   # the innermost suite: an XCTest class or a Swift Testing suite
        suite = name
    if kind == "Test Case":
        key = f"{bundle}/{suite}" if suite else (bundle or "tests")
        c = classes.setdefault(key, {"passed": 0, "failed": [], "skipped": 0, "total": 0, "secs": 0.0})
        c["total"] += 1
        r = node.get("result", "")
        dur = node.get("durationInSeconds")
        if isinstance(dur, (int, float)):
            c["secs"] += dur
        if r == "Passed" or r == "Expected Failure":
            c["passed"] += 1
        elif r == "Skipped":
            c["skipped"] += 1
        else:
            msgs = [ch.get("name", "") for ch in node.get("children", []) if ch.get("nodeType") == "Failure Message"]
            c["failed"].append(f"{name}: {msgs[0] if msgs else r}")
        return
    for ch in node.get("children", []):
        walk(ch, bundle, suite)
for n in data.get("testNodes", []):
    walk(n)
out = open(rows_path, "a", encoding="utf-8")
if not classes:
    out.write(f"tests\tFAIL\tno test case ran (see the log)\t{log_path}\n")
for key in sorted(classes):
    c = classes[key]
    detail = f"{c['passed']} passed, {len(c['failed'])} failed, {c['skipped']} skipped of {c['total']} ({c['secs']:.0f} s)"
    if c["failed"]:
        status = "FAIL"
        detail += "; " + " | ".join(f[:220] for f in c["failed"][:4])
    elif c["passed"] == 0:
        status = "SKIP"
    else:
        status = "PASS"
    detail = detail.replace("\t", " ").replace("\n", " ")
    out.write(f"{key}\t{status}\t{detail}\t{tests_path}\n")
timings = {}
for line in open(log_path, encoding="utf-8", errors="replace"):
    m = re.search(r"FIRSTMINUTE (\S+) (\{.*\})", line)
    if m:
        try:
            timings[m.group(1)] = json.loads(m.group(2))
        except ValueError:
            pass
if timings:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    path = f"{reports}/app-first-minute-{stamp}.json"
    json.dump({"simulator": sim, "note": "simulator proxies on contract fixtures (-ui-testing), not device measurements",
               "tests": timings}, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    out.write(f"first-minute timings\tINFO\t{len(timings)} test(s) recorded (simulator proxies)\t{path}\n")
PY
else
  row "result bundle" FAIL "xcodebuild wrote no result bundle (exit $APP_RC): $(tail -n 3 "$LOGS/test.log" | tr -s ' ' | cut -c1-300 | tr '\n' ' ')" "$LOGS/test.log"
fi
return 0
