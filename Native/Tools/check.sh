#!/bin/zsh
# OWNER: N0
# The gates of IOS-SPEC §2.7. Runs in the caller's mirror (SCROLLS_BUILD_DIR), prints a PASS/FAIL table and writes
# Native/Reports/check-<stage>-<timestamp>.json. Exit codes: 0 pass · 1 fail · 3 pending device · 4 every row skipped
# (e.g. the simulator hold: a stage that ran nothing is never a pass).
#   Tools/check.sh quick [--wp Nx]     build that package's targets, its unit tests, G1, C0, lint (check.d/quick.sh)
#   Tools/check.sh golden [families]   regenerate goldens (serialised; N0 or the integrator only), then quick
#   Tools/check.sh device <suite>      delegates to Tools/device-check.sh
#   Tools/check.sh <stage> [args]      any other stage runs check.d/<stage>.sh, owned by the package that owns the code
# A stage script is sourced with two helpers:
#   row <name> <PASS|FAIL|SKIP|PENDING|PENDING_DEVICE|INFO> <detail> [evidence file]
#   step <name> <log file> <command…>     runs the command, records PASS/FAIL with its duration and log
# A row that is FAIL fails the stage; PENDING_DEVICE (and no FAIL) exits 3; SKIP is never counted as a pass.
set -uo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${1:?usage: check.sh <stage> [args] — stages: quick golden slice read analysis lineage journey display app full device}"
shift
export SCROLLS_BUILD_DIR="${SCROLLS_BUILD_DIR:-$HOME/Developer/scrolls-build/default}"
# IOS-SPEC-QWEN ΔQ-14: mirrors and derived data live in ~/Developer/scrolls-build/<agent-or-task>; never iCloud, never $TMPDIR
case "$SCROLLS_BUILD_DIR" in "$HOME/Documents"*|*"/Mobile Documents/"*) echo "check.sh: SCROLLS_BUILD_DIR must be outside iCloud ($SCROLLS_BUILD_DIR)" >&2; exit 2 ;; esac
[[ -n "${TMPDIR:-}" && "$SCROLLS_BUILD_DIR" == "${TMPDIR%/}"* ]] && echo "check.sh: warning: $SCROLLS_BUILD_DIR is under \$TMPDIR, which a reboot wipes; use ~/Developer/scrolls-build/<task> (ΔQ-14)" >&2
export SCROLLS_REPORTS_DIR="$NATIVE/Reports"
# the same environment as Tools/build.sh, so stage scripts and build.sh share the mirror's compiled targets
export CLANG_MODULE_CACHE_PATH="$SCROLLS_BUILD_DIR/module-cache" SWIFTPM_MODULECACHE_OVERRIDE="$SCROLLS_BUILD_DIR/module-cache"
export TOOLCHAINS="${TOOLCHAINS:-metal}"
mkdir -p "$SCROLLS_REPORTS_DIR" "$SCROLLS_BUILD_DIR/logs"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOGS="$SCROLLS_BUILD_DIR/logs/check-$STAGE-$STAMP"
mkdir -p "$LOGS"
ROWS="$LOGS/rows.tsv"
: > "$ROWS"

row() {
  local detail="${3//$'\t'/ }"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "${detail//$'\n'/ }" "${4:-}" >> "$ROWS"
}

step() {
  local name="$1" log="$2"
  shift 2
  local t0=$SECONDS
  if "$@" > "$log" 2>&1; then
    row "$name" PASS "$(( SECONDS - t0 )) s" "$log"
    return 0
  fi
  row "$name" FAIL "$(( SECONDS - t0 )) s; last lines: $(tail -n 3 "$log" | tr -s ' ' | cut -c1-300 | tr '\n' ' ')" "$log"
  return 1
}

case "$STAGE" in
  device)
    exec "$NATIVE/Tools/device-check.sh" "$@" ;;
  golden)
    step "regenerate goldens (${1:-g1.core})" "$LOGS/golden.log" "$NATIVE/Tools/golden.sh" "${1:-g1.core}"
    SCRIPT="$NATIVE/Tools/check.d/quick.sh"
    set -- ;;
  *)
    SCRIPT="$NATIVE/Tools/check.d/$STAGE.sh" ;;
esac

if [[ -f "$SCRIPT" ]]; then
  source "$SCRIPT" "$@"
  rc=$?
  (( rc == 0 )) || row "stage script" FAIL "${SCRIPT:t} stopped with an error (status $rc); its remaining rows are missing"
else
  row "stage $STAGE" FAIL "Tools/check.d/$STAGE.sh does not exist yet (owned by the package that owns the code it checks)"
fi

# ── table, report, exit code ─────────────────────────────────────────────────────────────────────────────────────
REPORT="$SCROLLS_REPORTS_DIR/check-$STAGE-$STAMP.json"
/usr/bin/python3 -I - "$ROWS" "$REPORT" "$STAGE" "$STAMP" "$(uptime | sed 's/.*load averages*: //')" <<'PY'
import json, sys
rows_path, report_path, stage, stamp, load = sys.argv[1:6]
rows = []
for line in open(rows_path, encoding="utf-8"):
    name, status, detail, evidence = (line.rstrip("\n").split("\t") + ["", "", "", ""])[:4]
    rows.append({"name": name, "status": status, "detail": detail, "evidence": evidence or None})
fails = [r for r in rows if r["status"] == "FAIL"]
pending_device = [r for r in rows if r["status"] == "PENDING_DEVICE"]
skipped_only = all(r["status"] == "SKIP" for r in rows)
result = "FAIL" if fails or not rows else ("PENDING_DEVICE" if pending_device else ("SKIP" if skipped_only else "PASS"))
width = max([len(r["name"]) for r in rows] + [10])
for r in rows:
    print(f"{r['status']:<15} {r['name']:<{width}}  {r['detail']}")
print(f"{'':-<15} {'':-<{width}}")
print(f"{result:<15} {stage} ({len(rows)} rows, load {load})")
json.dump({"stage": stage, "at": stamp, "result": result, "load_average": load, "rows": rows},
          open(report_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
print(f"report: {report_path}")
sys.exit(1 if result == "FAIL" else 3 if result == "PENDING_DEVICE" else 4 if result == "SKIP" else 0)
PY
