#!/bin/zsh
# OWNER: N2
# Moving packs, atlases and notebooks between the Mac and his iPhone (IOS-SPEC §3.5, §3.11), and fingerprints (G6).
#   Tools/atlas.sh push-pack <name>        devicectl copy of ~/Developer/scrolls-packs/current/<name>.scrollspack into the app's
#                                          Documents/Import/ (the Sources page then lists it; Install verifies and moves it)
#   Tools/atlas.sh push-baseline           the Ngram baseline (ngram-eng-1.sqlite) into Documents/Import/
#   Tools/atlas.sh pull-notebook <dir>     copies the app's Library/Application Support/Notebook/ (and Documents/Diagnostics/) to <dir>
#   Tools/atlas.sh fingerprint <atlas.sqlite> [ATLAS.json]   scrolls-cli fingerprint (compare when an ATLAS.json is given)
#   Tools/atlas.sh transfer-bench [file]   MB/s of one devicectl copy into Documents/Import (default: the cipher-text pack)
#   Tools/atlas.sh build | push-atlas      M2 (generations): not in this build
# A re-push of an unchanged file is skipped: its name, sha256 and destination go into
# ~/Developer/scrolls-packs/pushed/<device>.tsv only after the copy succeeded, so a failed push is retried.
# SCROLLS_PUSH_FORCE=1 pushes anyway (after the app was reinstalled, or the file was deleted on the phone).
# Pushes go to Documents/Import/, the app's own drop folder (AtlasLocation.prepare creates it at every launch), not to
# Documents/Inbox/: iOS reserves that one for AirDrop and "Open in" copies and the app cannot create or write it.
# Device commands need his iPhone connected, paired, unlocked and in Developer Mode; otherwise they print PENDING_DEVICE
# and exit 3 (the integrator runs them in a device session, IOS-SPEC §2.7). Env: SCROLLS_DEVICE · SCROLLS_PACKS_ROOT ·
# SCROLLS_CLI · SCROLLS_BUILD_DIR · SCROLLS_PUSH_FORCE.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
PACKS="${SCROLLS_PACKS_ROOT:-$HOME/Developer/scrolls-packs}"
BUNDLE_ID="com.utkarsh.scrolls"

device_id() {
  [[ -n "${SCROLLS_DEVICE:-}" ]] && { print -r -- "$SCROLLS_DEVICE"; return 0; }
  local j; j="$(mktemp)"
  perl -e 'alarm 120; exec @ARGV' xcrun devicectl list devices --json-output "$j" >/dev/null 2>&1 || true
  /usr/bin/python3 -I - "$j" <<'PY'
import json, sys
try:
    devs = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    sys.exit(0)
for d in devs:
    hp, cp = d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    if hp.get("reality") == "physical" and hp.get("platform") == "iOS" and cp.get("tunnelState") == "connected":
        print(d["identifier"]); break
PY
  rm -f "$j"
}

need_device() {
  DEV="$(device_id)"
  if [[ -z "$DEV" ]]; then
    echo "PENDING_DEVICE: his iPhone is not connected (paired, unlocked, tunnel connected); the integrator runs: Tools/atlas.sh $*" >&2
    exit 3
  fi
}

DROP_DIR="Documents/Import"   # the app's drop folder (IOS-SPEC §3.9); the Sources page lists it before the system Inbox

copy_to_import() {   # copy_to_import <file>; prints seconds
  local f="$1" t0 t1
  t0=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
  xcrun devicectl device copy to --device "$DEV" --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
    --source "$f" --destination "$DROP_DIR/${f:t}" >/dev/null
  t1=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
  perl -e "printf '%.3f', $t1 - $t0"
}

pushed_line() {   # pushed_line <file> → its ledger line: name, sha256, destination folder
  print -r -- "${1:t}	$(shasum -a 256 "$1" | cut -d' ' -f1)	$DROP_DIR"
}

pushed_before() {   # pushed_before <file> → 0 when this exact file was already pushed to this device's drop folder
  [[ "${SCROLLS_PUSH_FORCE:-0}" == 1 ]] && return 1
  grep -qxF -- "$(pushed_line "$1")" "$PACKS/pushed/$DEV.tsv" 2>/dev/null
}

record_push() {   # record_push <file>: called only after copy_to_import succeeded
  mkdir -p "$PACKS/pushed"
  pushed_line "$1" >> "$PACKS/pushed/$DEV.tsv"
}

cli() {
  if [[ -z "${SCROLLS_CLI:-}" ]]; then SCROLLS_CLI="$("$NATIVE/Tools/build.sh" cli | tail -n 1)"; fi
  "$SCROLLS_CLI" "$@"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  push-pack)
    name="${1:?usage: atlas.sh push-pack <name>}"; f="$PACKS/current/$name.scrollspack"
    [[ -f "$f" ]] || { echo "atlas.sh: no $f (Tools/packs.sh $name builds it)" >&2; exit 1; }
    need_device push-pack "$name"
    if pushed_before "$f"; then echo "atlas.sh: $name is already on the phone (same sha256); skipped (SCROLLS_PUSH_FORCE=1 pushes it again)"; exit 0; fi
    s="$(copy_to_import "$f")"
    record_push "$f"
    echo "atlas.sh: pushed $name ($(( $(stat -f %z "$f") / 1048576 )) MiB) in $s s" ;;
  push-baseline)
    f="${1:-$HOME/Developer/scrolls-data/sources/ngram/ngram-eng-1.sqlite}"
    [[ -f "$f" ]] || { echo "atlas.sh: no baseline at $f" >&2; exit 1; }
    need_device push-baseline
    if pushed_before "$f"; then echo "atlas.sh: the baseline is already on the phone; skipped (SCROLLS_PUSH_FORCE=1 pushes it again)"; exit 0; fi
    s="$(copy_to_import "$f")"   # assigned first: a failed copy stops here (errexit), never reports success
    record_push "$f"
    echo "atlas.sh: pushed the baseline in $s s" ;;
  pull-notebook)
    out="${1:?usage: atlas.sh pull-notebook <dir>}"; mkdir -p "$out"
    need_device pull-notebook "$out"
    xcrun devicectl device copy from --device "$DEV" --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
      --source "Library/Application Support/Notebook" --destination "$out/Notebook"
    xcrun devicectl device copy from --device "$DEV" --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
      --source "Documents/Diagnostics" --destination "$out/Diagnostics" || true
    echo "atlas.sh: notebook pulled into $out" ;;
  fingerprint)
    atlas="${1:?usage: atlas.sh fingerprint <atlas.sqlite> [ATLAS.json]}"
    if [[ -n "${2:-}" ]]; then cli fingerprint --atlas "$atlas" --immutable --compare "$2"; else cli fingerprint --atlas "$atlas" --immutable; fi ;;
  transfer-bench)
    f="${1:-$PACKS/current/cipher-text.scrollspack}"
    [[ -f "$f" ]] || { echo "atlas.sh: no $f" >&2; exit 1; }
    need_device transfer-bench "$f"
    bytes=$(stat -f %z "$f"); s="$(copy_to_import "$f")"
    mbs=$(perl -e "printf '%.1f', $bytes / 1048576 / $s")
    mkdir -p "$NATIVE/Reports"
    print -r -- "{\"file\":\"${f:t}\",\"bytes\":$bytes,\"seconds\":$s,\"mb_per_s\":$mbs,\"device\":\"$DEV\",\"at\":\"$(date -u +%FT%TZ)\"}" \
      > "$NATIVE/Reports/transfer-bench-$(date -u +%Y%m%dT%H%M%SZ).json"
    echo "atlas.sh: ${f:t}: $(( bytes / 1048576 )) MiB in $s s = $mbs MB/s" ;;
  build|push-atlas)
    echo "atlas.sh $cmd: generations (scrolls-cli atlas build, .scrollsatlas, the swap) are M2 work, not in this build" >&2; exit 1 ;;
  *)
    echo "usage: atlas.sh push-pack <name> | push-baseline | pull-notebook <dir> | fingerprint <atlas> [ATLAS.json] | transfer-bench [file]" >&2
    exit 2 ;;
esac
