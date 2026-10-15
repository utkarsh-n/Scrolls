#!/usr/bin/env python3
"""Stage existing local models only, checking Scrolls' compiled size/SHA catalog before bundling."""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--destination", required=True, type=pathlib.Path)
parser.add_argument("--generation-root", type=pathlib.Path,
                    default=pathlib.Path.home() / "Developer/offline-intelligence-models")
parser.add_argument("--embedding-root", type=pathlib.Path,
                    default=pathlib.Path.home() / "Developer/scrolls-models")
parser.add_argument("--models", choices=("both", "2b"), default="both",
                    help="Bundle 2B only, or both text models; the specialist embedder is always included.")
args = parser.parse_args()
native = pathlib.Path(__file__).resolve().parent.parent
catalog = (native / "ScrollsKit/Sources/ScrollsQwen/Models/ModelCatalog.swift").read_text()

def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()

names = ("Qwen3-Embedding-0.6B-8bit", "qwen-2b") + (("qwen-4b",) if args.models == "both" else ())
for name in names:
    root = args.generation_root if name.startswith("qwen-") else args.embedding_root
    source = root / name
    block = catalog.split(f'name: "{name}"', 1)[1].split("])", 1)[0]
    files = re.findall(r'ModelFile\("([^"]+)", ([0-9_]+), "([0-9a-f]{64})"\)', block)
    if not files:
        raise RuntimeError(f"No compiled file catalog for {name}")
    destination = args.destination / name
    destination.mkdir(parents=True, exist_ok=True)
    stamps = {}
    for filename, raw_size, expected in files:
        path = source / filename
        size = int(raw_size.replace("_", ""))
        if not path.is_file() or path.stat().st_size != size or digest(path) != expected:
            raise RuntimeError(f"Local file does not match compiled provenance: {path}")
        target = destination / filename
        if not target.is_file() or target.stat().st_size != size or digest(target) != expected:
            subprocess.run(["/bin/cp", "-c", "-p", str(path), str(target)], check=True)
        if target.stat().st_size != size or digest(target) != expected:
            raise RuntimeError(f"Staged file failed integrity verification: {target}")
        stamps[filename] = [size, target.stat().st_mtime]
    for filename in ("model-metadata.json", "LICENSE"):
        path = source / filename
        if path.is_file():
            subprocess.run(["/bin/cp", "-c", "-p", str(path), str(destination / filename)], check=True)
    if name.startswith("qwen-"):
        metadata = json.loads((destination / "model-metadata.json").read_text())
        revision = re.search(r'upstream: "[^"]*revision ([0-9a-f]{40})', block).group(1)
        if metadata.get("revision") != revision or metadata.get("quantizationBits") != 4:
            raise RuntimeError(f"Staged metadata differs from pinned generation checkpoint: {name}")
    # Verified build stamp is useful when resource timestamps survive bundling. Runtime rehashes if they change.
    weight_sha = next(expected for filename, _, expected in files if filename == "model.safetensors")
    stamp = {"model": name, "sha256": weight_sha, "files": stamps,
             "verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (destination / ".scrolls-verified.json").write_text(json.dumps(stamp, sort_keys=True))
    print(f"Checked and staged {name}: {len(files)} files", flush=True)
