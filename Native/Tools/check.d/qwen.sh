# OWNER: Q (created by the bring-up, B2)
# Tools/check.sh qwen — the MLX-free gate of the Qwen layer (IOS-SPEC-QWEN §2.1): ScrollsQwen's unit tests and the
# Qwen lint. Sourced by check.sh (helpers `row` and `step`). The MLX runtime is built by xcodebuild (build.sh sim /
# device), never here.
NATIVE="${NATIVE:-$(cd "$(dirname "$0")/.." && pwd)}"
step "ScrollsQwen tests (swift test)" "$LOGS/qwen-tests.log" \
  env SCROLLS_TARGETS="ScrollsQwenTests" "$NATIVE/Tools/build.sh" test

QLINT="$LOGS/qwen-lint.log"
: > "$QLINT"
# MLX and Tokenizers are imported only by ScrollsQwenKit and the app's Scrolls/Qwen
grep -rln --include='*.swift' -E '^\s*import (MLX|Tokenizers)' "$NATIVE/ScrollsKit" "$NATIVE/Scrolls" 2>/dev/null \
  | grep -v '/Scrolls/Qwen/' | sed 's/$/: imports MLX or Tokenizers outside ScrollsQwenKit and Scrolls\/Qwen/' >> "$QLINT"
# no downloader, no hub client, no networking in the Qwen code
grep -rn --include='*.swift' -E 'HubClient|Downloader|#huggingFace|URLSession' "$NATIVE/ScrollsQwenKit" "$NATIVE/Scrolls/Qwen" \
  "$NATIVE/ScrollsKit/Sources/ScrollsQwen" 2>/dev/null >> "$QLINT"
# the measured memory rules: no KV quantisation, no closing bias
grep -rn --include='*.swift' -E 'closingBias:|kvBits:' "$NATIVE/ScrollsQwenKit" 2>/dev/null >> "$QLINT"
# one caller of the guided loop: the file declaring `enum GuidedRun`
grep -rln --include='*.swift' 'GuidedGenerationLoop.run(' "$NATIVE/ScrollsQwenKit" 2>/dev/null \
  | while read -r f; do grep -q 'enum GuidedRun' "$f" || echo "$f: calls GuidedGenerationLoop.run outside GuidedRun"; done >> "$QLINT"
if [[ -s "$QLINT" ]]; then
  row "qwen lint (imports, networking, kvBits/closingBias, GuidedRun)" FAIL "$(wc -l < "$QLINT" | tr -d ' ') findings; first: $(head -n 1 "$QLINT" | cut -c1-200)" "$QLINT"
else
  row "qwen lint (imports, networking, kvBits/closingBias, GuidedRun)" PASS "no findings"
fi
