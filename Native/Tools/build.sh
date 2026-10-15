#!/bin/zsh
# OWNER: N0
# xcodebuild and SwiftPM hang or misbehave inside the iCloud-synced folder, and the app depends on ../../LabKit by relative
# path, so mirror Scrolls/ (Native + the Node reference that the goldens import) and LabKit/ side by side into a local work
# directory and build there. Never build inside ~/Documents.
#   Tools/build.sh mirror             rsync only (the other tools call it first)
#   Tools/build.sh target <T…>        swift build -c release --target T for engine targets (a package's quick build;
#                                     built with the test flags, so `test` reuses them)
#   Tools/build.sh test [filter]      ScrollsKit tests on the Mac (swift test -c release; TOOLCHAINS=metal for ScrollsRender)
#   Tools/build.sh cli                swift build -c release --product scrolls-cli; prints the binary's path
#   Tools/build.sh xcodegen           mirror, then xcodegen generate in the mirror (no build)
#   Tools/build.sh sim                Debug app build for the simulator ($SCROLLS_SIM)
#   Tools/build.sh app-test           xcodebuild test (ScrollsAppTests + ScrollsUITests) on the simulator
#   Tools/build.sh device             Release app build for a connected iPhone
#   Tools/build.sh install            device build, then devicectl install on $SCROLLS_DEVICE (default: the one connected iPhone),
#                                     holding the device lock (Tools/device-lock.sh; IOS-SPEC-QWEN §7.2 rule 7) around the install;
#                                     exit 3 = PENDING_DEVICE (the lock stayed held by another task for SCROLLS_DEVICE_LOCK_WAIT s)
#   Tools/build.sh sim-create         creates $SCROLLS_SIM (default "Scrolls 15 Pro Max": iPhone 15 Pro Max device type,
#                                     iOS 27 runtime, his phone's 430×932 pt)
# Env: SCROLLS_BUILD_DIR (one per agent or task; default ~/Developer/scrolls-build/default, IOS-SPEC-QWEN ΔQ-14: never
#      $TMPDIR, which a reboot wipes, never ~/Documents) · SCROLLS_SIM · SCROLLS_DEVICE · SCROLLS_BUNDLE_PACKS=1|0 · SCROLLS_JOBS (4) · SCROLLS_DEST_TIMEOUT (300 s: xcodebuild waits for CoreSimulator under load)
#      SCROLLS_TARGETS="T …" narrows the mirror's package to those targets and their dependencies (check.sh quick --wp)
#      SCROLLS_BUILDINFO=dev|full (BuildInfo.swift values; default dev for target/test, full for cli and app builds)
set -e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"                  # …/AI Stuff
WORK="${SCROLLS_BUILD_DIR:-$HOME/Developer/scrolls-build/default}"
HOST_WORK="${SCROLLS_HOST_BUILD_DIR:-$HOME/Developer/offline-app-integration}"
SIM="${SCROLLS_SIM:-Scrolls 15 Pro Max}"
JOBS="${SCROLLS_JOBS:-4}"
PACKS="${SCROLLS_PACKS_DIR:-$HOME/Developer/scrolls-packs/current}"
KIT="$WORK/src/Scrolls/Native/ScrollsKit"
case "$WORK" in "$HOME/Documents"*|*"/Mobile Documents/"*) echo "build.sh: SCROLLS_BUILD_DIR must be outside iCloud ($WORK)" >&2; exit 2 ;; esac
[[ -n "${TMPDIR:-}" && "$WORK" == "${TMPDIR%/}"* ]] && echo "build.sh: warning: $WORK is under \$TMPDIR, which a reboot wipes; use ~/Developer/scrolls-build/<task> (ΔQ-14)" >&2
mkdir -p "$WORK/src"
# per-mirror module caches: parallel agents never contend for one cache (LabKit's lk.sh pattern)
export CLANG_MODULE_CACHE_PATH="$WORK/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$WORK/module-cache"
# Metal shaders in ScrollsRender need the metal toolchain (LabKit's rule). It is set for every SwiftPM call: a build and a
# test run whose TOOLCHAINS differ do not share their compiled targets (measured: each switch recompiles ScrollsCore).
export TOOLCHAINS="${TOOLCHAINS:-metal}"

mirror() {
  rsync -a --delete --exclude '.build' --exclude '.swiftpm' --exclude '* 2.*' --exclude '* 2' \
        "$ROOT/LabKit/" "$WORK/src/LabKit/"
  rsync -a --delete --exclude '.git' --exclude '.build' --exclude '.swiftpm' --exclude 'BenchmarkApp' \
        "$ROOT/OfflineIntelligenceKit/" "$WORK/src/OfflineIntelligenceKit/"
  # BuildInfo.swift is regenerated in the mirror (gen-buildinfo.sh); excluding it keeps its mtime, so builds stay incremental
  rsync -a --delete --exclude '.git' --exclude '.build' --exclude '.swiftpm' --exclude 'node_modules' \
        --exclude 'Native/Scrolls.xcodeproj' --exclude 'Native/Reports' --exclude 'Native/Scrolls/Resources/Bundled' \
        --exclude 'Native/ScrollsKit/Sources/ScrollsCore/Generated/BuildInfo.swift' --exclude 'Native/ScrollsKit/Package.swift' \
        --exclude 'Native/ScrollsKit/.scrolls-targets' \
        --exclude '* 2.*' --exclude '* 2' "$ROOT/Scrolls/" "$WORK/src/Scrolls/"
  "$WORK/src/Scrolls/Native/Tools/gen-buildinfo.sh" "$WORK/src/Scrolls" "${SCROLLS_BUILDINFO:-${1:-dev}}"
  # SwiftPM (and Xcode) cache an evaluated manifest by its text, and Package.swift builds a declared target only once its
  # folder holds sources: stamp the mirror's copy with the file layout, so a new folder or resource re-evaluates it.
  # The copy is replaced only when it changes, so nothing is rebuilt otherwise.
  # SCROLLS_TARGETS (space-separated) narrows the mirror's package to those targets and their dependencies.
  local kit="$WORK/src/Scrolls/Native/ScrollsKit" layout
  if [[ -n "${SCROLLS_TARGETS:-}" ]]; then print -r -- "$SCROLLS_TARGETS" > "$kit/.scrolls-targets"; else rm -f "$kit/.scrolls-targets"; fi
  layout="$( { cd "$kit" && find Sources Tests -type f ! -name '.*' | LC_ALL=C sort; cat "$kit/.scrolls-targets" 2>/dev/null; } | shasum -a 256 | cut -c1-16)"
  { cat "$ROOT/Scrolls/Native/ScrollsKit/Package.swift"; print -r -- "// mirror layout $layout (Tools/build.sh)"; } > "$kit/Package.swift.new"
  if cmp -s "$kit/Package.swift.new" "$kit/Package.swift"; then rm -f "$kit/Package.swift.new"; else mv -f "$kit/Package.swift.new" "$kit/Package.swift"; fi
  [[ -d "$ROOT/Scrolls/Native/Scrolls" ]] || return 0             # no app target yet: nothing to bundle
  local B="$WORK/src/Scrolls/Native/Scrolls/Resources/Bundled"; mkdir -p "$B"
  # starter.atlas is a directory (atlas.sqlite + ATLAS.json, `scrolls-cli starter`): replace it whole, never merge into it
  for f in starter.atlas cipher-meta.scrollspack; do [[ -e "$PACKS/$f" ]] && { rm -rf "$B/$f"; cp -cR "$PACKS/$f" "$B/"; }; done
  if [[ "${SCROLLS_BUNDLE_PACKS:-1}" == 1 && -e "$PACKS/cipher-text.scrollspack" ]]; then
    cp -c "$PACKS/cipher-text.scrollspack" "$B/"
  else
    rm -f "$B/cipher-text.scrollspack"
  fi
  [[ -e "$B/starter.atlas" ]] || echo "build.sh: no starter in $PACKS — the app will generate the demo on first launch (Tools/packs.sh builds it)" >&2
  if [[ "${SCROLLS_BUILDINFO:-${1:-dev}}" == full && "${SCROLLS_BUNDLE_MODELS:-1}" == 1 ]]; then
    /usr/bin/python3 "$WORK/src/Scrolls/Native/Tools/bundle-shared-models.py" \
      --destination "$WORK/src/Scrolls/Native/Scrolls/Resources/Models" \
      --generation-root "${SCROLLS_GENERATION_MODELS:-$HOME/Developer/offline-intelligence-models}" \
      --embedding-root "${SCROLLS_MODELS:-$HOME/Developer/scrolls-models}"
  fi
  return 0
}
xcode() {
  # the app's package pins start from ScrollsQwenKit's (AttentionMachine's proven MLX set) when the project has none yet
  local pins="$WORK/src/Scrolls/Native/Scrolls.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
  ( cd "$WORK/src/Scrolls/Native" && xcodegen generate --quiet \
      && { [[ -e "$pins" || ! -e ScrollsQwenKit/Package.resolved ]] || { mkdir -p "${pins:h}" && cp ScrollsQwenKit/Package.resolved "$pins"; }; } \
      && xcodebuild -project Scrolls.xcodeproj -scheme Scrolls \
      -derivedDataPath "$WORK/dd" -jobs "$JOBS" "$@" )
}
# Simulator hold: while ~/Developer/scrolls-build/.simulator-hold exists (kernel panics in simctl, 2026-10-14), nothing
# here runs simctl or a simulator-destination xcodebuild (which runs `simctl diagnose` after a failure). Exit 4.
SIM_HOLD="$HOME/Developer/scrolls-build/.simulator-hold"
sim_hold() { [[ -e "$SIM_HOLD" ]] || return 0; echo "build.sh $1: refused, simulator hold in force: $(head -1 "$SIM_HOLD")" >&2; exit 4; }
simctl() { sim_hold simctl; perl -e 'alarm shift; exec @ARGV' "${SCROLLS_SIMCTL_TIMEOUT:-300}" xcrun simctl "$@"; }  # simctl can hang under load
# devicectl also lists simulators and prints a table on stdout, so read its JSON from a file and keep physical iPhones
device_id() {
  local j; j="$(mktemp)"
  xcrun devicectl list devices --json-output "$j" >/dev/null 2>&1
  /usr/bin/python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1]))["result"]["devices"]
phones=[x for x in d if x["hardwareProperties"].get("platform")=="iOS" and x["hardwareProperties"].get("reality")=="physical"]
phones.sort(key=lambda x: x.get("connectionProperties",{}).get("tunnelState")!="connected")
print(phones[0]["identifier"] if phones else "")' "$j"
  rm -f "$j"
}

case "${1:-sim}" in
  mirror)     mirror ;;
  # target and test share kit/ and its flags (-enable-testing), so a test run reuses the targets a quick build compiled
  target)     mirror dev; shift; for t in "$@"; do (cd "$KIT" && swift build -c release -Xswiftc -enable-testing -j "$JOBS" --scratch-path "$WORK/kit" --target "$t"); done ;;
  # build, then test that build (--skip-build): `swift test` building by itself plans differently and recompiles
  test)       mirror dev; filter=(); [[ -n "${2:-}" ]] && filter=(--filter "$2")
              (cd "$KIT" && swift build -c release -Xswiftc -enable-testing -j "$JOBS" --scratch-path "$WORK/kit" --build-tests \
                && swift test -c release -Xswiftc -enable-testing -j "$JOBS" --scratch-path "$WORK/kit" --skip-build "${filter[@]}") ;;
  cli)        mirror full; (cd "$KIT" && swift build -c release -j "$JOBS" --scratch-path "$WORK/kit-cli" --product scrolls-cli) && echo "$WORK/kit-cli/release/scrolls-cli" ;;
  xcodegen)   mirror full; (cd "$WORK/src/Scrolls/Native" && xcodegen generate) && echo "$WORK/src/Scrolls/Native/Scrolls.xcodeproj" ;;
  sim)        sim_hold sim; mirror full; xcode -configuration Debug -destination "platform=iOS Simulator,name=$SIM" -destination-timeout "${SCROLLS_DEST_TIMEOUT:-300}" build ;;
  app-test)   sim_hold app-test; mirror full; xcode -configuration Debug -destination "platform=iOS Simulator,name=$SIM" -destination-timeout "${SCROLLS_DEST_TIMEOUT:-300}" test ;;
  device)     /usr/bin/python3 "$ROOT/OfflineIntelligenceKit/Tools/build_hosts.py" --app Scrolls --build-root "$HOST_WORK" ;;
  # the build needs no lock (it never touches the phone); the install runs under it (re-entrant for a caller that holds it)
  install)    "$0" device && "${0:h}/device-lock.sh" run "${SCROLLS_TASK:-build.sh-install}" -- \
                xcrun devicectl device install app --device "${SCROLLS_DEVICE:-$(device_id)}" \
                "$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact"])' "$HOST_WORK/Evidence/Scrolls.json")" ;;
  sim-create) sim_hold sim-create; simctl create "$SIM" com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro-Max \
                "$(simctl list runtimes | awk '/iOS 27/ {print $NF; exit}')" ;;
  *) echo "usage: build.sh mirror|target|test|cli|xcodegen|sim|app-test|device|install|sim-create" >&2; exit 2 ;;
esac
