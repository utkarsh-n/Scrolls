#!/bin/zsh
# OWNER: Q (created by the bring-up, B2)
# Puts the two Qwen models into Scrolls' app container (IOS-SPEC-QWEN §2.10, the bring-up's layout: Documents/Models/<name>/).
# The app has no download code and verifies every file against the sha256 compiled into ScrollsQwen/ModelCatalog.swift
# before it loads a model; MANIFEST.json (the same values) is pushed beside each model for people reading the folder.
#   Tools/models.sh check                 sha256 of every model file on the Mac against the catalogue (no copy)
#   Tools/models.sh push [device]         devicectl copy into the phone's container (Scrolls must be installed; default:
#                                         the one connected iPhone); unchanged files are skipped by devicectl
#   Tools/models.sh push-sim [simulator]  copy into the simulator's data container (default "Scrolls Qwen"; app installed)
# Env: SCROLLS_MODELS (default ~/Developer/scrolls-models) · SCROLLS_BUNDLE_ID (com.utkarsh.scrolls)
set -euo pipefail
MODELS="${SCROLLS_MODELS:-$HOME/Developer/scrolls-models}"
GENERATION_MODELS="${SCROLLS_GENERATION_MODELS:-$HOME/Developer/offline-intelligence-models}"
BUNDLE="${SCROLLS_BUNDLE_ID:-com.utkarsh.scrolls}"
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
CATALOG="$NATIVE/ScrollsKit/Sources/ScrollsQwen/Models/ModelCatalog.swift"
NAMES=(Qwen3-Embedding-0.6B-8bit qwen-2b qwen-4b)
source_dir() {
  case "$1" in qwen-2b|qwen-4b) print -r -- "$GENERATION_MODELS/$1" ;; *) print -r -- "$MODELS/$1" ;; esac
}

# "name bytes sha" lines of one model, read from the catalogue (the single source of the expected values)
catalog() {
  /usr/bin/python3 -I - "$CATALOG" "$1" <<'PY'
import re, sys
src, name = open(sys.argv[1]).read(), sys.argv[2]
block = src[src.index(f'name: "{name}"'):]
block = block[:block.index('])')]
for f, b, h in re.findall(r'ModelFile\("([^"]+)", ([0-9_]+), "([0-9a-f]{64})"\)', block):
    print(f, b.replace('_', ''), h)
PY
}

manifest() {  # writes $2/MANIFEST.json for model $1
  local name="$1" out="$2"
  catalog "$name" | /usr/bin/python3 -I -c '
import json, sys
name = sys.argv[1]
files = [dict(name=a, bytes=int(b), sha256=c) for a, b, c in (l.split() for l in sys.stdin if l.strip())]
json.dump(dict(name=name, files=files, note="the app checks these against ModelCatalog.swift"), open(sys.argv[2], "w"), indent=1)' "$name" "$out"
}

check() {
  local bad=0 name f b h actual size source
  for name in $NAMES; do
    source="$(source_dir "$name")"
    while read -r f b h; do
      size=$(stat -f %z "$source/$f" 2>/dev/null || echo missing)
      actual=$(shasum -a 256 "$source/$f" 2>/dev/null | cut -c1-64 || true)
      if [[ "$size" == "$b" && "$actual" == "$h" ]]; then echo "ok   $name/$f"; else echo "BAD  $name/$f ($size B, ${actual:0:8})"; bad=1; fi
    done < <(catalog "$name")
  done
  return $bad
}

device_id() {
  local j; j="$(mktemp)"
  xcrun devicectl list devices --json-output "$j" >/dev/null 2>&1
  /usr/bin/python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1]))["result"]["devices"]
phones=[x for x in d if x["hardwareProperties"].get("platform")=="iOS" and x["hardwareProperties"].get("reality")=="physical"]
phones.sort(key=lambda x: x.get("connectionProperties",{}).get("tunnelState")!="connected")
print(phones[0]["identifier"] if phones else "")' "$j"
  rm -f "$j"
}

stage() {  # a folder holding exactly the catalogue's files (hard links, no copy) plus MANIFEST.json
  local name="$1" dir="$2" f b h source
  source="$(source_dir "$name")"
  rm -rf "$dir"; mkdir -p "$dir"
  while read -r f b h; do ln "$source/$f" "$dir/$f" 2>/dev/null || cp -c "$source/$f" "$dir/$f"; done < <(catalog "$name")
  [[ -f "$source/model-metadata.json" ]] && cp -c "$source/model-metadata.json" "$dir/"
  [[ -f "$source/LICENSE" ]] && cp -c "$source/LICENSE" "$dir/"
  manifest "$name" "$dir/MANIFEST.json"
}

case "${1:-}" in
  check) check ;;
  push)
    dev="${2:-$(device_id)}"; [[ -n "$dev" ]] || { echo "models.sh: no iPhone connected" >&2; exit 2; }
    tmp="$HOME/Developer/scrolls-build/models-stage"
    for name in $NAMES; do
      source="$(source_dir "$name")"
      stage "$name" "$tmp/$name"
      echo "pushing $name to $dev …"
      xcrun devicectl device copy to --device "$dev" --domain-type appDataContainer --domain-identifier "$BUNDLE" \
        --source "$tmp/$name" --destination "Documents/Models/$name"
    done ;;
  push-sim)
    # simulator hold (kernel panics in simctl, 2026-10-14): no simctl while the marker exists
    [[ -e "$HOME/Developer/scrolls-build/.simulator-hold" ]] && { echo "models.sh push-sim: refused, simulator hold in force: $(head -1 "$HOME/Developer/scrolls-build/.simulator-hold")" >&2; exit 4; }
    sim="${2:-Scrolls Qwen}"
    container="$(xcrun simctl get_app_container "$sim" "$BUNDLE" data)"
    for name in $NAMES; do
      source="$(source_dir "$name")"
      mkdir -p "$container/Documents/Models/$name"
      while read -r f b h; do cp -c "$source/$f" "$container/Documents/Models/$name/$f"; done < <(catalog "$name")
      [[ -f "$source/model-metadata.json" ]] && cp -c "$source/model-metadata.json" "$container/Documents/Models/$name/"
      manifest "$name" "$container/Documents/Models/$name/MANIFEST.json"
      echo "copied $name -> $container/Documents/Models/$name"
    done ;;
  *) echo "usage: models.sh check|push [device]|push-sim [simulator]" >&2; exit 2 ;;
esac
