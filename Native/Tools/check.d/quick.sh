# OWNER: N0
# Stage `quick [--wp Nx]` (IOS-SPEC §2.7): mirror → one build of the package's targets and tests → its unit tests + G1
# (core goldens in ScrollsCoreTests) + C0 (ScrollsContractsTests and DifferentialTests) + the source lint. Without --wp,
# every declared target. Sourced by Tools/check.sh, which provides row/step and SCROLLS_BUILD_DIR.

WP=""
while (( $# )); do
  case "$1" in
    --wp) WP="${2:?--wp needs a package (N0…N8, I)}"; shift 2 ;;
    *) row "arguments" FAIL "unknown argument '$1' (quick [--wp Nx])"; shift ;;
  esac
done

# Targets and test targets each package owns (IOS-SPEC §8.1). The G1-core goldens run in ScrollsCoreTests for everyone.
# N1–N6 own LiveAtlas+<Area>.swift files inside ScrollsService (and N2, N3, N4, N6 own scrolls-cli commands), so their
# gate builds ScrollsService (and scrolls-cli) too: a package's gate compiles all of the package's code. Test targets
# stay narrowed to the package's own, so another package's broken test never blocks this gate.
typeset -A WP_TARGETS WP_TESTS
WP_TARGETS=(
  N0 "ScrollsCore ScrollsContracts ScrollsStore ScrollsJobs ScrollsService ScrollsScrollModel scrolls-cli"
  N1 "ScrollsIngest ScrollsService"
  N2 "ScrollsSources ScrollsStore ScrollsService scrolls-cli"
  N3 "ScrollsQuery ScrollsService scrolls-cli"
  N4 "ScrollsAnalysis ScrollsNL ScrollsService scrolls-cli"
  N5 "ScrollsLineage ScrollsService"
  N6 "ScrollsProvenance ScrollsService scrolls-cli"
  N7 "ScrollsScrollModel ScrollsRender" N8 "" I ""
)
WP_TESTS=(
  N0 "ScrollsCoreTests ScrollsContractsTests ScrollsStoreTests ScrollsJobsTests ScrollsServiceTests DifferentialTests"
  N1 "ScrollsIngestTests" N2 "ScrollsSourcesTests ScrollsStoreTests" N3 "ScrollsQueryTests" N4 "ScrollsAnalysisTests"
  N5 "ScrollsLineageTests" N6 "ScrollsProvenanceTests" N7 "ScrollsScrollModelTests ScrollsRenderTests" N8 "" I ""
)
DECLARED=(ScrollsCore ScrollsContracts ScrollsStore ScrollsJobs ScrollsIngest ScrollsSources ScrollsQuery ScrollsAnalysis
          ScrollsNL ScrollsLineage ScrollsProvenance ScrollsService ScrollsScrollModel ScrollsRender scrolls-cli
          ScrollsCoreTests ScrollsContractsTests ScrollsStoreTests ScrollsJobsTests ScrollsIngestTests ScrollsSourcesTests
          ScrollsQueryTests ScrollsAnalysisTests ScrollsLineageTests ScrollsProvenanceTests ScrollsServiceTests
          ScrollsScrollModelTests ScrollsRenderTests DifferentialTests)
if [[ -n "$WP" && -z "${WP_TARGETS[$WP]+x}" ]]; then row "--wp $WP" FAIL "unknown package (N0…N8, I)"; return 0; fi

# Embedded helpers (§8.2 rule 2 allows .sh files, not .py): the per-target test summaries and the source lint.
read -r -d '' TEST_SUMMARIES <<'PYEOF'
import re, sys
suites, skipped = [], 0
for line in sys.stdin:
    m = re.search(r'Suite "(.+?)" (passed|failed)', line)
    if m:
        suites.append(m.group(1))
        continue
    if re.search(r'Test ".+?" skipped', line):
        skipped += 1
        continue
    m = re.search(r"(Test run with ([0-9]+) tests? .*|Executed [0-9]+ tests.*)", line)
    if m:
        text = m.group(1).strip()
        name = ", ".join(suites[:3]) + (f" +{len(suites) - 3}" if len(suites) > 3 else "")
        ok = (" passed" in text and "failed" not in text) or ", with 0 failures" in text
        total = int(m.group(2)) if m.group(2) else None
        verdict = "PASS" if ok else "FAIL"
        if ok and skipped and total == skipped:
            verdict = "SKIP"  # a run whose every test was skipped (a stub target) is not a pass
        if skipped:
            text += f" ({skipped} skipped)"
        print(verdict + "\t" + (name or "tests") + "\t" + text)
        suites, skipped = [], 0
PYEOF
read -r -d '' SOURCE_LINT <<'PYEOF'
import os, re, sys
native = sys.argv[1]
# 1. every source file names its owner on its first line (the second after a #! line, and in Package.swift)
roots = {".swift": ["ScrollsKit/Sources", "ScrollsKit/Tests", "Scrolls", "ScrollsAppTests", "ScrollsUITests"],
         ".metal": ["ScrollsKit/Sources"], ".h": ["ScrollsKit/Sources"], ".mjs": ["Golden"], ".sh": ["Tools"]}
for ext, dirs in roots.items():
    for d in dirs:
        for base, subdirs, files in os.walk(os.path.join(native, d)):
            subdirs[:] = [x for x in subdirs if x not in (".build", ".swiftpm", "node_modules")]
            for f in files:
                if not f.endswith(ext):
                    continue
                p = os.path.join(base, f)
                with open(p, encoding="utf-8", errors="replace") as fh:
                    head = [fh.readline() for _ in range(2)]
                want = "# OWNER: " if ext == ".sh" else "// OWNER: "
                n = 2 if head[0].startswith("#!") or f == "Package.swift" else 1
                if not any(l.startswith(want) for l in head[:n]):
                    print(f"{os.path.relpath(p, native)}:1: no '{want.strip()} <package>' on its first line")
# 2. no inline SQL outside the statement catalogues (LintTests' rule, IOS-SPEC §1.4)
kw = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "PRAGMA", "WITH", "REPLACE", "ATTACH", "DETACH",
      "VACUUM", "ANALYZE", "REINDEX", "SAVEPOINT", "RELEASE", "BEGIN", "COMMIT", "ROLLBACK", "EXPLAIN"]
pat = re.compile(r'("""|")\s*(' + "|".join(kw) + r')\b\s+[A-Za-z(*_\'"]')
def code_lines(text):
    out, block = [], False
    for i, raw in enumerate(text.split("\n")):
        line = raw
        if block:
            j = line.find("*/")
            if j < 0:
                continue
            line, block = line[j + 2:], False
        code, ins, k = "", False, 0
        while k < len(line):
            c = line[k]
            if c == '"':
                ins = not ins
            if not ins and line.startswith("//", k):
                break
            if not ins and line.startswith("/*", k):
                block = True
                break
            code += c
            k += 1
        out.append((i + 1, code))
    return out
for base, subdirs, files in os.walk(os.path.join(native, "ScrollsKit/Sources")):
    for f in files:
        if not f.endswith(".swift"):
            continue
        p = os.path.join(base, f)
        text = open(p, encoding="utf-8").read()
        if f.endswith("SQL.swift") or ": SQLCatalog" in text:
            continue
        lines = text.split("\n")
        rel = os.path.relpath(p, native)
        for n, code in code_lines(text):
            if "lint: sql-ok" in lines[n - 1]:
                continue
            if pat.search(code):
                print(f"{rel}:{n}: inline SQL (move it into an `enum <Area>SQL: SQLCatalog` or mark `// lint: sql-ok (why)`)")
                continue
            if code.strip().endswith('"""') and code.count('"""') % 2 == 1 and n < len(lines):
                nxt = lines[n].strip()
                if any(nxt.startswith(k + " ") for k in kw) and "lint: sql-ok" not in lines[n]:
                    print(f"{rel}:{n + 1}: inline SQL in a multi-line literal")
PYEOF

KITDIR="$SCROLLS_BUILD_DIR/src/Scrolls/Native/ScrollsKit"
JOBS="${SCROLLS_JOBS:-4}"

# With --wp the mirror's package is narrowed to the package's targets, its tests and ScrollsCoreTests (G1). Each
# narrowing has its own scratch directory, so gates never invalidate each other's builds.
if [[ -n "$WP" ]]; then
  WANT=(${=WP_TARGETS[$WP]} ScrollsCoreTests ${=WP_TESTS[$WP]})
  export SCROLLS_TARGETS="${(u)WANT[*]}"
  SCRATCH="$SCROLLS_BUILD_DIR/kit-quick-$WP"
else
  unset SCROLLS_TARGETS
  SCRATCH="$SCROLLS_BUILD_DIR/kit"
fi

step "mirror" "$LOGS/mirror.log" "$NATIVE/Tools/build.sh" mirror || return 0

# Which declared targets the bring-up manifest builds today (Package.swift builds a target once its folder has sources).
BUILT=($(cd "$KITDIR" && swift package --scratch-path "$SCRATCH" dump-package 2>"$LOGS/manifest.log" | /usr/bin/python3 -I -c \
  'import json,sys; print(" ".join(t["name"] for t in json.load(sys.stdin)["targets"]))'))
if (( ${#BUILT} == 0 )); then row "manifest" FAIL "Package.swift did not evaluate (see log)" "$LOGS/manifest.log"; return 0; fi
if [[ -z "$WP" ]]; then
  MISSING=(${DECLARED:|BUILT})
  if (( ${#MISSING} )); then
    row "manifest" PENDING "${#BUILT}/${#DECLARED} declared targets built; not yet created: ${MISSING[*]}"
  else
    row "manifest" PASS "all ${#DECLARED} declared targets built (the manifest is exactly IOS-SPEC §8.4.3)"
  fi
else
  row "manifest" INFO "narrowed to $WP: ${BUILT[*]}"
  for t in ${=WP_TARGETS[$WP]} ${=WP_TESTS[$WP]}; do
    (( ${BUILT[(Ie)$t]} )) || row "target $t" PENDING "not created yet"
  done
fi
if [[ -n "$WP" && "$WP" != N0 ]]; then row "C0 contract round trip" INFO "runs in quick --wp N0 and in quick without --wp"; fi

# one build of every target and test target in the (narrowed) package, then the tests against that same build
step "build ${BUILT[*]}" "$LOGS/build.log" zsh -c \
  "cd '$KITDIR' && swift build -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --build-tests" || return 0

# DifferentialTests also holds the other tiers' families (G2–G8, each run by its owner's stage): quick runs only N0's
# suites there, C0 and the golden harness.
RUN=(${(M)BUILT:#*Tests})
if (( ${RUN[(Ie)DifferentialTests]} )); then
  RUN=(${RUN:#DifferentialTests} DifferentialTests.ContractRoundTripTests DifferentialTests.GoldenHarnessTests)
fi
if (( ${#RUN} )); then
  FILTER="${(j:|:)RUN}"
  touch "$LOGS/.tests-start"
  step "swift test ${RUN[*]}" "$LOGS/test.log" zsh -c \
      "cd '$KITDIR' && swift test -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCRATCH' --skip-build --filter '$FILTER'"
  # swift test runs each test target in its own process, and each prints its own "Test run with …" summary: one row
  # per summary, named by the suites that reported before it.
  sed 's/\x1b\[[0-9;]*m//g' "$LOGS/test.log" | /usr/bin/python3 -I -c "$TEST_SUMMARIES" \
    | while IFS=$'\t' read -r verdict name line; do row "  tests: $name" "$verdict" "$line" "$LOGS/test.log"; done
  # C0 (IOS-SPEC §2.2): ScrollsContractsTests and DifferentialTests both run the round trip and write this report
  C0="$SCROLLS_REPORTS_DIR/c0-contracts.json"
  if [[ -f "$C0" && "$C0" -nt "$LOGS/.tests-start" ]]; then
    /usr/bin/python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("PASS" if r["passed"] else "FAIL", r["bodies"], r["mismatches"], len(r.get("unshaped") or []))' "$C0" \
      | read -r verdict bodies mism unshaped && row "C0 contract round trip" "$verdict" "$bodies bodies, $mism mismatches, $unshaped without a Swift type" "$C0"
  fi
  # golden families read by ScrollsCoreTests: each writes Reports/golden-<family>.json; a private family absent here is SKIP
  for g in "$SCROLLS_REPORTS_DIR"/golden-g1.*.json(N); do
    [[ "$g" -nt "$LOGS/.tests-start" ]] || continue
    /usr/bin/python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["family"], "PASS" if r["passed"] else "FAIL", r["cases"], r["mismatches"])' "$g" \
      | read -r fam verdict checks mism && row "G1 $fam" "$verdict" "$checks checks, $mism mismatches" "$g"
  done
  if (( ${RUN[(Ie)ScrollsCoreTests]} )); then
    for fam in $(/usr/bin/python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1])); print(" ".join(k for k,v in m["families"].items() if v.get("private")))' \
        "$NATIVE/ScrollsKit/Tests/DifferentialTests/Golden/MANIFEST.json"); do
      [[ -f "$SCROLLS_REPORTS_DIR/golden-$fam.json" && "$SCROLLS_REPORTS_DIR/golden-$fam.json" -nt "$LOGS/.tests-start" ]] \
        || row "G1 $fam" SKIP "private family absent on this Mac (~/Developer/scrolls-golden/<ref>/private)"
    done
  fi
fi

# Source lint over the whole Native tree (IOS-SPEC §8.2, §8.4.10 item 3). The app-side LintTests repeat the Swift rules
# in xcodebuild; this is their Mac twin, so a package sees a finding in `quick` without a simulator.
LINT_LOG="$LOGS/lint.log"
: > "$LINT_LOG"
grep -rn --include='*.swift' -E '\.lowercased\(\)' "$NATIVE/ScrollsKit/Sources" >> "$LINT_LOG" 2>/dev/null
grep -rn --include='*.swift' -E 'URLSession|NWConnection|NWListener|import Network|CFSocket|CFStream|socket\(' "$NATIVE" >> "$LINT_LOG" 2>/dev/null
grep -rn --include='*.swift' -E '^\s*import LabKit' "$NATIVE/ScrollsKit" >> "$LINT_LOG" 2>/dev/null
/usr/bin/python3 -I -c "$SOURCE_LINT" "$NATIVE" >> "$LINT_LOG"
LINT_NAME="lint (lowercased(), networking, LabKit in engine, OWNER lines, inline SQL)"
if [[ -s "$LINT_LOG" ]]; then
  row "$LINT_NAME" FAIL "$(wc -l < "$LINT_LOG" | tr -d ' ') findings; first: $(head -n 1 "$LINT_LOG" | cut -c1-200)" "$LINT_LOG"
else
  row "$LINT_NAME" PASS "no findings"
fi
