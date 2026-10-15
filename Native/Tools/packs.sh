#!/bin/zsh
# OWNER: N2
# Builds the source packs with `scrolls-cli pack` (IOS-SPEC §3.5) and the starter with `scrolls-cli starter` (§3.6):
#   demo         the SYNTHETIC demo (engine resources = data/demo/*, byte for byte)
#   cipher-meta  slot 1/2: culture-works.tsv, culture-themes.tsv, roots.tsv, tags/*.jsonl, songs/relations_{mb,wiki,itwofs}.json,
#                texts/gutenberg.json, pg_catalog.csv                         ($SCROLLS_CIPHER_ROOT, read only)
#   cipher-text  slot 3: texts/gutenberg/*.txt (691), texts/wikisource-{hi,gu}.jsonl
#   starter      starter.atlas: slot 0 = the seeded vocab and the demo world, built by this engine
# into ~/Developer/scrolls-packs/v<version>/ ($SCROLLS_PACKS_ROOT), and points ~/Developer/scrolls-packs/current at it;
# Tools/build.sh copies starter.atlas and the Cipher packs from `current` into the app's Resources/Bundled.
# A pack is rebuilt only when its inputs change: `<name>.inputs` holds the sha256 of its spec and of every input file's
# path, size and modification time. It reads the Cipher folder and never writes there (nor in ~/Documents at all).
#   Tools/packs.sh [all | demo | cipher-meta | cipher-text | starter]…   (default: all)
#   Env: SCROLLS_BUILD_DIR (the mirror the CLI is built in) · SCROLLS_CLI (an already-built scrolls-cli) ·
#        SCROLLS_CIPHER_ROOT · SCROLLS_PACKS_ROOT · SCROLLS_PACKS_VERSION (1) · SCROLLS_PACKS_FORCE=1 (rebuild all)
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
CIPHER="${SCROLLS_CIPHER_ROOT:-$HOME/Documents/AI Stuff/Cipher}"
R="$CIPHER/Cipher/Resources"
T="$CIPHER/Tools/data/culture"
PACKS_ROOT="${SCROLLS_PACKS_ROOT:-$HOME/Developer/scrolls-packs}"
VERSION="${SCROLLS_PACKS_VERSION:-1}"
OUT="$PACKS_ROOT/v$VERSION"
case "$OUT" in "$HOME/Documents"*|*"/Mobile Documents/"*) echo "packs.sh: the packs must live outside iCloud ($OUT)" >&2; exit 2 ;; esac
mkdir -p "$OUT"
REF_COMMIT="$(git -C "$NATIVE/.." rev-parse 'ref-freeze-1^{commit}' 2>/dev/null || echo unknown)"

cli() {
  if [[ -z "${SCROLLS_CLI:-}" ]]; then
    SCROLLS_CLI="$("$NATIVE/Tools/build.sh" cli | tail -n 1)"
    [[ -x "$SCROLLS_CLI" ]] || { echo "packs.sh: building scrolls-cli failed" >&2; exit 1; }
  fi
  "$SCROLLS_CLI" "$@"
}

# The inputs key of a spec: its text, then "path size mtime" of every file its sources include.
inputs_key() {
  /usr/bin/python3 -I - "$1" <<'PY'
import glob, hashlib, json, os, sys
spec = open(sys.argv[1], encoding="utf-8").read()
h = hashlib.sha256(("SPK1\n" + spec).encode())
for s in json.loads(spec).get("sources", []):
    for pat in s["include"]:
        for f in sorted(glob.glob(os.path.join(s["root"], pat))):
            st = os.stat(f)
            h.update(f"{os.path.relpath(f, s['root'])}\t{st.st_size}\t{int(st.st_mtime)}\n".encode())
print(h.hexdigest())
PY
}

build_spec() {   # build_spec <name> <spec file>
  local name="$1" spec="$2" key
  key="$(inputs_key "$spec")"
  if [[ "${SCROLLS_PACKS_FORCE:-0}" != 1 && -e "$OUT/$name.scrollspack" && "$(cat "$OUT/$name.inputs" 2>/dev/null)" == "$key" ]]; then
    echo "packs.sh: $name is current (inputs ${key:0:12})"
    return 0
  fi
  echo "packs.sh: building $name (inputs ${key:0:12})"
  cli pack --spec "$spec" --out "$OUT/$name.scrollspack" > "$OUT/$name.json"
  print -r -- "$key" > "$OUT/$name.inputs"
  cat "$OUT/$name.json"
}

spec_file() { local f="$OUT/$1.spec.json"; cat > "$f"; print -r -- "$f"; }

pack_demo() {
  echo "packs.sh: building demo"
  cli pack --demo --out "$OUT/demo.scrollspack" > "$OUT/demo.json"
  cat "$OUT/demo.json"
}

pack_cipher_meta() {
  [[ -f "$R/culture-works.tsv" && -f "$T/texts/gutenberg.json" ]] || { echo "packs.sh: Cipher files not found under $CIPHER" >&2; exit 1; }
  build_spec cipher-meta "$(spec_file cipher-meta <<JSON
{"name": "cipher-meta", "version": "1.0.0", "slot": 1,
 "adapter_ids": ["cipher.works", "cipher.themes", "cipher.roots", "cipher.relations", "cipher.books", "cipher.wikisource"],
 "licences": ["Wikidata CC0", "Wikipedia CC BY-SA", "MusicBrainz CC0", "ItwoFS CC BY 2.5", "Wiktionary via kaikki.org CC BY-SA",
              "Project Gutenberg catalogue (public domain)"],
 "attribution": ["Cipher (Utkarsh Nimavat), built from Wikidata, Wikipedia, MusicBrainz, ItwoFS, Wiktionary (kaikki.org) and the Project Gutenberg catalogue"],
 "caveats": ["Cipher's metadata: titles, relations, themes and etymology; no song text.",
             "Members are Cipher's own files, byte for byte (sha256 in this manifest)."],
 "reference_commit": "$REF_COMMIT",
 "format_md": "# cipher-meta (SPK1)\\n\\nCipher's metadata files, each the file in Cipher's folder byte for byte, under Cipher's own relative paths:\\nculture-works.tsv, culture-themes.tsv and roots.tsv (Cipher/Resources), tags/*.jsonl, songs/relations_{mb,wiki,itwofs}.json,\\ntexts/gutenberg.json and pg_catalog.csv (Tools/data/culture). Read by the adapters cipher.works, cipher.themes, cipher.roots,\\ncipher.relations and (with cipher-text) cipher.books and cipher.wikisource. Mapping: Docs/CIPHER-MAPPING.md, SPEC §6.\\n",
 "sources": [
   {"root": "$R", "include": ["culture-works.tsv", "culture-themes.tsv", "roots.tsv"]},
   {"root": "$T", "include": ["tags/*.jsonl", "songs/relations_mb.json", "songs/relations_wiki.json", "songs/relations_itwofs.json",
                              "texts/gutenberg.json", "pg_catalog.csv"]}]}
JSON
)"
}

pack_cipher_text() {
  [[ -d "$T/texts/gutenberg" ]] || { echo "packs.sh: Cipher texts not found under $T/texts" >&2; exit 1; }
  build_spec cipher-text "$(spec_file cipher-text <<JSON
{"name": "cipher-text", "version": "1.0.0", "slot": 3, "adapter_ids": ["cipher.books", "cipher.wikisource"],
 "licences": ["Project Gutenberg texts (public domain in the US)", "Wikisource CC BY-SA"],
 "attribution": ["Project Gutenberg", "Hindi and Gujarati Wikisource contributors (CC BY-SA)"],
 "caveats": ["691 public-domain Gutenberg books (en, fr, es) and the transcribed pages of 450 Hindi and 375 Gujarati Wikisource index books."],
 "reference_commit": "$REF_COMMIT",
 "format_md": "# cipher-text (SPK1)\\n\\nCipher's full texts, each the file in Cipher's folder byte for byte: texts/gutenberg/<id>.txt (one per book of\\ntexts/gutenberg.json, which ships in cipher-meta) and texts/wikisource-{hi,gu}.jsonl (one JSON line per index book, pages joined\\nby form feeds). Read by cipher.books and cipher.wikisource in bootstrap phase B (SPEC §6.3, §6.4).\\n",
 "sources": [{"root": "$T", "include": ["texts/gutenberg/*.txt", "texts/wikisource-hi.jsonl", "texts/wikisource-gu.jsonl"]}]}
JSON
)"
}

build_starter() {
  echo "packs.sh: building the starter"
  rm -rf "$OUT/starter.atlas.building"
  cli starter --out "$OUT/starter.atlas.building" > "$OUT/starter.json"
  rm -rf "$OUT/starter.atlas"
  mv "$OUT/starter.atlas.building" "$OUT/starter.atlas"
  cat "$OUT/starter.json"
}

(( $# )) || set -- all
for what in "$@"; do
  case "$what" in
    all)         pack_demo; pack_cipher_meta; pack_cipher_text; build_starter ;;
    demo)        pack_demo ;;
    cipher-meta) pack_cipher_meta ;;
    cipher-text) pack_cipher_text ;;
    starter)     build_starter ;;
    *) echo "usage: packs.sh [all | demo | cipher-meta | cipher-text | starter]…" >&2; exit 2 ;;
  esac
done
ln -sfn "v$VERSION" "$PACKS_ROOT/current"
ls -l "$OUT" | grep -E 'scrollspack|starter' || true
