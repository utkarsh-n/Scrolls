# OWNER: N6
# Stage `journey` (IOS-SPEC §2.7, §2.2 G7): the API journeys, writes included, replayed in process by
# `scrolls-cli api --golden <family>` on fresh `cp -c` clones of the snapshot each family was recorded on, and compared
# with the reference's answers (normalised by natural keys, timestamps and data_version). Every answer the engine gives
# is also checked by the reference's own contract validator (Golden/validate-contracts.mjs). Plus N6's unit tests.
#   g7.notebook-m1r  N6's notebook script (saved views, annotations, relationships, a restart): N6's routes only, exact.
#   g7.journey-m1r   R's RF-3 recording of the whole verify journey: every package's routes. N6's cases must match; the
#                    other packages' cases are reported by owner (PENDING while their routes are not built, FAIL when an
#                    implemented route answers differently).
#   g7.journey-m5r   M2 (private family; skipped until the m5r rows are due).
# The atlas is the snapshot clone opened as a reference-profile atlas (InlineTextStore). The device-profile run (`scrolls-cli
# convert-reference`, N2) is a PENDING row until that command lands.
# Sourced by Tools/check.sh with `row` and `step`, SCROLLS_BUILD_DIR, SCROLLS_REPORTS_DIR, NATIVE and LOGS.

JOBS="${SCROLLS_JOBS:-4}"
KITDIR="$SCROLLS_BUILD_DIR/src/Scrolls/Native/ScrollsKit"
SNAPS="${SCROLLS_SNAPSHOTS:-$HOME/Developer/scrolls-snapshots}"
GOLDEN="$NATIVE/ScrollsKit/Tests/DifferentialTests/Golden"

step "mirror" "$LOGS/mirror.log" "$NATIVE/Tools/build.sh" mirror || return 0
export SCROLLS_TARGETS="ScrollsProvenance ScrollsProvenanceTests"
step "build ScrollsProvenance + tests" "$LOGS/build-tests.log" zsh -c \
  "cd '$KITDIR' && swift build -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCROLLS_BUILD_DIR/kit-journey-tests' --build-tests" \
  && step "swift test ScrollsProvenanceTests" "$LOGS/test.log" zsh -c \
    "cd '$KITDIR' && swift test -c release -Xswiftc -enable-testing -j $JOBS --scratch-path '$SCROLLS_BUILD_DIR/kit-journey-tests' --skip-build --filter ScrollsProvenanceTests"
summary="$(sed 's/\x1b\[[0-9;]*m//g' "$LOGS/test.log" 2>/dev/null | grep -E 'Test run with [0-9]+ tests?' | tail -n 1)"
[[ -n "$summary" ]] && row "  tests: ScrollsProvenanceTests" INFO "$summary" "$LOGS/test.log"
unset SCROLLS_TARGETS

if ! step "build scrolls-cli" "$LOGS/cli.log" "$NATIVE/Tools/build.sh" cli; then return 0; fi
CLI="$(tail -n 1 "$LOGS/cli.log")"
[[ -x "$CLI" ]] || { row "scrolls-cli" FAIL "no binary at '$CLI'" "$LOGS/cli.log"; return 0; }

if [[ ! -f "$SNAPS/m1r/scrolls.db" || ! -f "$SNAPS/m1r/SNAPSHOT.json" ]]; then
  row "G7 m1r" SKIP "needs the m1r snapshot ($SNAPS/m1r)"
  return 0
fi

for fam in g7.notebook-m1r g7.journey-m1r; do
  if [[ ! -d "$GOLDEN/$fam" ]]; then
    row "G7 $fam" FAIL "the family is not generated (Tools/golden.sh $fam)"
    continue
  fi
  report="$SCROLLS_REPORTS_DIR/golden-$fam.json"
  answers="$LOGS/$fam-answers.jsonl"
  "$CLI" api --golden "$GOLDEN/$fam" --snapshots "$SNAPS" --report "$report" --responses "$answers" > "$LOGS/$fam.log" 2>&1
  rc=$?
  if [[ ! -f "$report" || "$report" -ot "$LOGS/$fam.log" && $rc -ne 0 && ! -s "$report" ]]; then
    row "G7 $fam" FAIL "scrolls-cli api stopped (exit $rc): $(tail -n 2 "$LOGS/$fam.log" | tr '\n' ' ' | cut -c1-300)" "$LOGS/$fam.log"
    continue
  fi
  /usr/bin/python3 -I - "$report" "$fam" <<'PY' > "$LOGS/$fam.rows"
import json, sys
r = json.load(open(sys.argv[1])); fam = sys.argv[2]
rows = r["rows"]
def fmt(counts): return ", ".join(f"{v} {k}" for k, v in sorted(counts.items()))
n6 = [x for x in rows if x["owner"] == "N6" and x["verdict"] != "restart"]
bad6 = [x for x in n6 if x["verdict"] not in ("exact", "gap", "blocked")]
wait6 = [x for x in n6 if x["verdict"] == "blocked"]
gaps = sorted({g for x in rows for g in x["contract_gaps"]})
first = "; ".join(f"#{x['seq']} {x['method']} {x['path'][:60]}: {(x['detail'] or x['verdict'])[:160]}" for x in (bad6 or wait6)[:3])
status = "FAIL" if bad6 else ("PENDING" if wait6 else "PASS")
print("\t".join(["G7 %s: N6 routes" % fam, status,
                  f"{len(n6) - len(bad6) - len(wait6)}/{len(n6)} N6 cases match"
                  + (f", {len(wait6)} wait on another package's failed step" if wait6 else "") + (f"; {first}" if bad6 or wait6 else "")]))
others = {}
for x in rows:
    if x["owner"] in ("N6",) or x["verdict"] == "restart": continue
    others.setdefault(x["owner"], {}).setdefault(x["verdict"], 0)
    others[x["owner"]][x["verdict"]] += 1
for owner, counts in sorted(others.items()):
    bad = {k: v for k, v in counts.items() if k not in ("exact", "gap")}
    status = "PASS" if not bad else ("PENDING" if set(bad) <= {"not-implemented"} else "FAIL")
    print("\t".join([f"G7 {fam}: {owner} routes", status, fmt(counts) + ("" if status == "PASS" else f" (owner {owner})")]))
if gaps:
    print("\t".join([f"G7 {fam}: contract gaps", "INFO", f"{len(gaps)} member(s) the contract types drop (requests to N0): " + ", ".join(gaps[:8])]))
print("\t".join([f"G7 {fam}: whole journey", "PASS" if r["passed"] else "INFO",
                 f"{r['matching']}/{r['cases']} cases match on {r['snapshot']} ({r['profile']} profile); ids remapped: {len(r['id_map']['remapped'])}"]))
PY
  while IFS=$'\t' read -r name verdict detail; do row "$name" "$verdict" "$detail" "$report"; done < "$LOGS/$fam.rows"

  # every answer the engine gave must also pass the reference's contract validator
  if [[ -s "$answers" ]]; then
    if node "$SCROLLS_BUILD_DIR/src/Scrolls/Native/Golden/validate-contracts.mjs" "$answers" --report "$LOGS/$fam-contracts.json" > "$LOGS/$fam-contracts.log" 2>&1; then
      row "G7 $fam: contract shapes" PASS "$(tail -n 1 "$LOGS/$fam-contracts.log")" "$LOGS/$fam-contracts.json"
    else
      /usr/bin/python3 -I - "$LOGS/$fam-contracts.json" "$report" <<'PY' > "$LOGS/$fam-contracts.rows"
import json, sys
v = json.load(open(sys.argv[1])); r = json.load(open(sys.argv[2]))
owner = {x["id"]: x["owner"] for x in r["rows"]}
bad = [x for x in v["rows"] if x.get("errors")]
mine = [x for x in bad if owner.get(x["id"]) == "N6"]
print("\t".join(["PASS" if not mine else "FAIL", f"N6 answers: {len(mine)} shape error(s)" + (f"; first: {mine[0]['id']} {mine[0]['shape']}: {'; '.join(mine[0]['errors'][:2])}" if mine else "")]))
others = sorted({owner.get(x["id"], "?") for x in bad if owner.get(x["id"]) != "N6"})
print("\t".join(["INFO", f"{len(bad) - len(mine)} shape error(s) in other packages' answers ({', '.join(others) or 'none'}); most are error bodies of routes not built yet"]))
PY
      { read -r v1 d1; read -r v2 d2; } < <(sed 's/\t/ /' "$LOGS/$fam-contracts.rows")
      row "G7 $fam: contract shapes (N6)" "$v1" "$d1" "$LOGS/$fam-contracts.json"
      row "G7 $fam: contract shapes (others)" "$v2" "$d2" "$LOGS/$fam-contracts.json"
    fi
  fi
done

row "G7 device profile (convert-reference)" PENDING "the same families on a device-profile atlas need \`scrolls-cli convert-reference\` (N2); this run used the reference profile"
row "G7 g7.journey-m5r" PENDING "M2: the m5r journey (private family)"
