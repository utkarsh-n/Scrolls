#!/bin/sh
# OWNER: WP4
# tools/nl-adapter/build.sh — `npm run build:nl`: compiles the optional on-device NL adapter (main.swift) into
# $SCROLLS_DATA/bin/scrolls-nl (default data dir ~/Developer/scrolls-data) and records what it supports in
# bin/scrolls-nl.probe.json (SPEC §4.10). macOS only; needs the Xcode command-line tools (swiftc).
# Scrolls works without it: tone then says "Tone needs the optional on-device adapter (not installed)".
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${SCROLLS_DATA:-"$HOME/Developer/scrolls-data"}
OUT="$DATA/bin"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "scrolls-nl uses Apple's NaturalLanguage framework and builds on macOS only." >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode command-line tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$OUT"
TMP="$OUT/scrolls-nl.tmp.$$"
trap 'rm -f "$TMP"' EXIT
echo "compiling $HERE/main.swift …"
swiftc -O -module-name ScrollsNL "$HERE/main.swift" -o "$TMP"
PROBE=$(printf '{"op":"probe"}\n' | "$TMP")
case "$PROBE" in
  *'"ok":true'*) ;;
  *) echo "the adapter built but its probe failed: $PROBE" >&2; exit 1 ;;
esac
mv "$TMP" "$OUT/scrolls-nl"
printf '%s\n' "$PROBE" > "$OUT/scrolls-nl.probe.json"
echo "built $OUT/scrolls-nl"
echo "probe: $PROBE"
