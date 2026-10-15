#!/bin/zsh
# OWNER: N0
# Runs a self-test suite on his iPhone 15 Pro Max and copies the result back (IOS-SPEC §2.7).
#   Tools/device-check.sh <suite> [--wp Nx] [--fresh] [--no-install]
#   suites: probe first-minute journey perf packs generation background full
# 1. Availability: `devicectl list devices` must show the physical iPhone paired, connected, in Developer Mode, with DDI
#    services. If it does not, the request is appended to Native/Reports/device-queue.json, PENDING_DEVICE is printed and
#    the script exits 3. A pending row is never recorded as PASS; no agent waits for the phone.
# 2. Install (Tools/build.sh install; --fresh uninstalls first) and launch with
#    `-selftest <suite> -atlasRoot selftest[-fresh] -perf`. The app's SelfTestRunner writes
#    Documents/selftest/<run>/result.json, <run> being the UTC start time (yyyyMMdd'T'HHmmss'Z'); the newest run that
#    starts after the launch is copied back.
# 3. Report: the result's rows, signpost timings, peak phys_footprint and thermal log; Reports/device-<suite>-<stamp>.json.
# The device lock (IOS-SPEC-QWEN §7.2 rule 7; Tools/device-lock.sh) is held from the uninstall/install to the copy-back,
# so no other agent installs or launches in between; `build.sh install` inside re-enters it. A lock still held by another
# task after SCROLLS_DEVICE_LOCK_WAIT s (900) is queued as PENDING_DEVICE (exit 3), like an absent phone.
# Env: SCROLLS_DEVICE (identifier or name; default: the one physical iPhone) · SCROLLS_DEVICE_TIMEOUT (s, default 1800) ·
#      SCROLLS_TASK (the lock's task name; default device-check-<suite>) · SCROLLS_DEVICE_LOCK_WAIT
set -uo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
SUITES=(probe first-minute journey perf packs generation background full)
SUITE="${1:?usage: device-check.sh <suite> [--wp Nx] [--fresh] [--no-install]; suites: ${SUITES[*]}}"
shift
(( ${SUITES[(Ie)$SUITE]} )) || { echo "device-check.sh: unknown suite '$SUITE' (${SUITES[*]})" >&2; exit 2; }
WP="${SCROLLS_AGENT:-unknown}"; FRESH=0; INSTALL=1
while (( $# )); do
  case "$1" in
    --wp) WP="${2:?--wp needs a package}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    *) echo "device-check.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
BUNDLE=com.utkarsh.scrolls
REPORTS="$NATIVE/Reports"
QUEUE="$REPORTS/device-queue.json"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/scrolls-device.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
OUTER_TOKEN="${SCROLLS_DEVICE_LOCK_TOKEN:-}"   # set when a caller already holds the device lock (re-entry)
mkdir -p "$REPORTS"
devicectl() { perl -e 'alarm shift; exec @ARGV' "${SCROLLS_DEVICECTL_TIMEOUT:-300}" xcrun devicectl "$@"; }

# ── 1. availability ──────────────────────────────────────────────────────────────────────────────────────────────
devicectl list devices --json-output "$TMP/devices.json" > "$TMP/devices.log" 2>&1
STATE="$(/usr/bin/python3 -I - "$TMP/devices.json" "${SCROLLS_DEVICE:-}" <<'PY'
import json, sys
path, wanted = sys.argv[1], sys.argv[2]
try:
    devices = json.load(open(path))["result"]["devices"]
except Exception as e:  # devicectl failed or timed out
    print(json.dumps({"ok": False, "reason": f"devicectl list devices failed ({e.__class__.__name__})", "device": None})); sys.exit()
phones = [d for d in devices if d.get("hardwareProperties", {}).get("platform") == "iOS"
          and d.get("hardwareProperties", {}).get("reality") == "physical"]
if wanted:
    phones = [d for d in phones if wanted in (d.get("identifier"), d.get("deviceProperties", {}).get("name"))]
if not phones:
    print(json.dumps({"ok": False, "reason": "no physical iPhone is paired with this Mac" + (f" matching '{wanted}'" if wanted else ""), "device": None})); sys.exit()
def summary(d):
    c, p, h = d.get("connectionProperties", {}), d.get("deviceProperties", {}), d.get("hardwareProperties", {})
    return {"identifier": d.get("identifier"), "name": p.get("name"), "productType": h.get("productType"),
            "pairingState": c.get("pairingState"), "tunnelState": c.get("tunnelState"), "transportType": c.get("transportType"),
            "developerMode": p.get("developerModeStatus"), "ddiServicesAvailable": p.get("ddiServicesAvailable")}
def problems(s):
    out = []
    if s["pairingState"] != "paired": out.append(f"not paired ({s['pairingState']})")
    if s["tunnelState"] != "connected": out.append(f"not connected (tunnel {s['tunnelState']})")
    if s["developerMode"] != "enabled": out.append(f"Developer Mode {s['developerMode']}")
    if not s["ddiServicesAvailable"]: out.append("DDI services unavailable (locked, asleep or not on its cable)")
    return out
ranked = sorted((summary(d) for d in phones), key=lambda s: len(problems(s)))
best = ranked[0]
issues = problems(best)
print(json.dumps({"ok": not issues, "reason": "; ".join(issues), "device": best}))
PY
)"
OK="$(print -r -- "$STATE" | /usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["ok"])')"
queue_pending() {  # appends {suite, wp, requested_at, reason, fresh, device, status: PENDING_DEVICE}; $1 = the state JSON
  /usr/bin/python3 -I - "$QUEUE" "$SUITE" "$WP" "$STAMP" "$1" "$FRESH" <<'PY'
import fcntl, json, os, sys
queue, suite, wp, stamp, state, fresh = sys.argv[1:7]
state = json.loads(state)
entry = {"suite": suite, "wp": wp, "requested_at": stamp, "reason": state["reason"], "fresh": fresh == "1",
         "device": state["device"], "status": "PENDING_DEVICE"}
with open(queue + ".lock", "w") as lock:  # several agents may append at once
    fcntl.flock(lock, fcntl.LOCK_EX)
    entries = []
    if os.path.exists(queue) and os.path.getsize(queue) > 0:
        entries = json.load(open(queue))
    entries.append(entry)
    tmp = queue + ".tmp"
    json.dump(entries, open(tmp, "w"), indent=2, ensure_ascii=False)
    os.replace(tmp, queue)
print(f"PENDING_DEVICE  {suite} ({wp}): {state['reason']} — queued in {queue}")
PY
}
if [[ "$OK" != True ]]; then queue_pending "$STATE"; exit 3; fi
DEVICE="$(print -r -- "$STATE" | /usr/bin/python3 -I -c 'import json,sys; print(json.load(sys.stdin)["device"]["identifier"])')"
echo "device-check: $SUITE on $(print -r -- "$STATE" | /usr/bin/python3 -I -c 'import json,sys; d=json.load(sys.stdin)["device"]; print(d["name"], d["productType"], d["identifier"])')"

# ── 2. the device lock, then install and launch ──────────────────────────────────────────────────────────────────
LOCKTASK="${SCROLLS_TASK:-device-check-$SUITE}"
if ! LOCKTOKEN="$(SCROLLS_DEVICE_LOCK_PID=$$ "$NATIVE/Tools/device-lock.sh" acquire "$LOCKTASK" 2> "$TMP/lock.err")"; then
  queue_pending "$(print -r -- "$STATE" | /usr/bin/python3 -I -c 'import json,sys; s=json.load(sys.stdin); s["reason"]="device lock: "+sys.argv[1]; print(json.dumps(s))' \
    "$(grep -v '^device-lock: waiting' "$TMP/lock.err" | tail -n 1)")"
  exit 3
fi
export SCROLLS_DEVICE_LOCK_TOKEN="$LOCKTOKEN"
# released on every exit, unless a caller holds it (then we only re-entered it, and it stays the caller's)
trap '[[ -z "$OUTER_TOKEN" ]] && "$NATIVE/Tools/device-lock.sh" release "$LOCKTOKEN" >/dev/null 2>&1; rm -rf "$TMP"' EXIT
if (( FRESH )); then devicectl device uninstall app --device "$DEVICE" "$BUNDLE" > "$TMP/uninstall.log" 2>&1 || true; fi
if (( INSTALL )); then
  SCROLLS_DEVICE="$DEVICE" "$NATIVE/Tools/build.sh" install > "$TMP/install.log" 2>&1 \
    || { echo "FAIL  install (see $REPORTS/device-$SUITE-$STAMP-install.log)" >&2; cp "$TMP/install.log" "$REPORTS/device-$SUITE-$STAMP-install.log"; exit 1; }
fi
LAUNCHED="$(date -u +%Y%m%dT%H%M%SZ)"
ROOT="selftest"; (( FRESH )) && ROOT="selftest-fresh"
if ! devicectl device process launch --device "$DEVICE" --terminate-existing "$BUNDLE" -- -selftest "$SUITE" -atlasRoot "$ROOT" -perf \
    > "$TMP/launch.log" 2>&1; then
  if grep -qiE 'locked|passcode' "$TMP/launch.log"; then
    echo "PENDING_DEVICE  $SUITE: the iPhone is locked" >&2; exit 3
  fi
  echo "FAIL  launch: $(tail -n 3 "$TMP/launch.log" | tr '\n' ' ')" >&2; exit 1
fi

# ── wait for Documents/selftest/<run>/result.json ────────────────────────────────────────────────────────────────
DEADLINE=$(( SECONDS + ${SCROLLS_DEVICE_TIMEOUT:-1800} ))
RUN=""
while (( SECONDS < DEADLINE )); do
  sleep 10
  devicectl device info files --device "$DEVICE" --domain-type appDataContainer --domain-identifier "$BUNDLE" \
    --subdirectory Documents/selftest --json-output "$TMP/files.json" > /dev/null 2>&1 || continue
  RUN="$(/usr/bin/python3 -I - "$TMP/files.json" "$LAUNCHED" <<'PY'
import json, sys
try:
    files = json.load(open(sys.argv[1]))["result"]["files"]
except Exception:
    sys.exit()
runs = sorted({f.get("relativePath", "").split("/")[0] for f in files if f.get("relativePath", "").endswith("/result.json")})
runs = [r for r in runs if r >= sys.argv[2]]
print(runs[-1] if runs else "")
PY
)"
  [[ -n "$RUN" ]] && break
done
[[ -n "$RUN" ]] || { echo "FAIL  $SUITE: no Documents/selftest/<run>/result.json within ${SCROLLS_DEVICE_TIMEOUT:-1800} s" >&2; exit 1; }
OUT="$REPORTS/device/$SUITE-$RUN"
mkdir -p "$OUT"
devicectl device copy from --device "$DEVICE" --domain-type appDataContainer --domain-identifier "$BUNDLE" \
  --source "Documents/selftest/$RUN" --destination "$OUT" > "$TMP/copy.log" 2>&1 \
  || { echo "FAIL  copy of Documents/selftest/$RUN: $(tail -n 2 "$TMP/copy.log" | tr '\n' ' ')" >&2; exit 1; }

# ── 3. report ────────────────────────────────────────────────────────────────────────────────────────────────────
/usr/bin/python3 -I - "$OUT/result.json" "$REPORTS/device-$SUITE-$STAMP.json" "$STATE" <<'PY'
import json, sys
result_path, report_path, state = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
r = json.load(open(result_path))
rows = r.get("rows", [])
for row in rows:
    print(f"{row.get('status', '?'):<15} {row.get('name', '')}  {row.get('detail', '')}")
for k, v in (r.get("signposts") or {}).items():
    print(f"{'signpost':<15} {k}  {v}")
if "peak_phys_footprint" in r:
    print(f"{'memory':<15} peak phys_footprint {r['peak_phys_footprint']}")
for t in r.get("thermal", []):
    print(f"{'thermal':<15} {t}")
status = "PASS" if r.get("status") == "PASS" and all(x.get("status") in ("PASS", "INFO") for x in rows) else "FAIL"
print(f"{status:<15} {r.get('suite')} on {state['device']['name']} ({state['device']['productType']})")
json.dump({"result": status, "device": state["device"], "selftest": r}, open(report_path, "w"), indent=2, ensure_ascii=False)
print(f"report: {report_path}")
sys.exit(0 if status == "PASS" else 1)
PY
