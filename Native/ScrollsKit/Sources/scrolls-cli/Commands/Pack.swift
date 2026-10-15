// OWNER: N2
// `scrolls-cli pack` (IOS-SPEC §3.5, ΔS-5, ΔS-6): wraps staged source files into one SPK1 `.scrollspack`. Each member is
// the staged file itself (its sha256 is the sha256 of the file on the Mac, so provenance and `import_once` behave as in
// the reference), under the relative path the adapters read (Cipher keeps its own layout: `culture-works.tsv`,
// `songs/relations_mb.json`, `texts/gutenberg/12.txt`, …). Tools/packs.sh drives it. Three ways to name the members:
//   --spec <pack.json>   {name, version, slot, adapter_ids, licences, attribution, caveats, reference_commit?, format_md?,
//                         sources: [{root, include: ["culture-works.tsv", "tags/*.jsonl", "texts/gutenberg/*.txt"], prefix?}]}
//   --from <staged dir>  every regular file under the directory (FORMAT.md and MANIFEST.json included), prefixed by the
//                        directory's name (STEMM: `openalex/works.jsonl`)
//   --demo               the demo pack from the engine's resources (data/demo/*, byte for byte)
// It reads the staged files and never writes beside them; the pack is written to `<out>.building` and renamed.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsSources
import ScrollsStore

enum PackCommand: CLICommand {
  static let name = "pack"
  static let summary = "wrap staged sources into a .scrollspack"
  static let usage = """
    usage: scrolls-cli pack --spec <pack.json> --out <file.scrollspack>
           scrolls-cli pack --name <pack> --version <v> --slot <n> --from <staged dir> --out <file.scrollspack>
                            [--adapters a,b] [--licence <text>] [--attribution <text>] [--reference-commit <sha>]
           scrolls-cli pack --demo --out <demo.scrollspack>
      Prints the pack's manifest facts and its sha256 as canonical JSON: {name, sha256, bytes, members, uncompressed}.
      --list prints the member list a spec resolves to (path, size) without writing a pack.
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["demo", "list"])
    if a.flag("demo") {
      let out = URL(fileURLWithPath: try a.required("out")).standardizedFileURL
      try AtlasLocation.refuseICloud(out)
      let pack = try DemoPack.write(to: out)
      report(pack.reader, sha: pack.sha256, at: out)
      return 0
    }
    let plan: PackPlan
    if let spec = a.value("spec") {
      plan = try PackPlan(spec: URL(fileURLWithPath: spec))
    } else if let from = a.value("from") {
      plan = try PackPlan(staged: URL(fileURLWithPath: from), name: try a.required("name"), version: try a.required("version"),
                          slot: try slot(a.required("slot")),
                          adapters: a.value("adapters")?.split(separator: ",").map(String.init) ?? [],
                          licence: a.value("licence"), attribution: a.value("attribution"),
                          referenceCommit: a.value("reference-commit"))
    } else {
      throw UsageError("name the members with --spec, --from or --demo")
    }
    if a.flag("list") {
      for m in plan.members { print("\(m.size)\t\(m.path)") }
      return 0
    }
    let out = URL(fileURLWithPath: try a.required("out")).standardizedFileURL
    try AtlasLocation.refuseICloud(out)
    let t0 = ContinuousClock.now
    var writer = try PackWriter(url: out, manifest: plan.manifest)
    if let format = plan.formatMD { try writer.add(member: "FORMAT.md", data: Data(format.utf8)) }
    var done: Int64 = 0
    for (i, m) in plan.members.enumerated() {
      try writer.add(member: m.path, from: m.file)
      done += m.size
      if i % 100 == 99 || i == plan.members.count - 1 {
        CLI.standardError("pack \(plan.manifest.name): \(i + 1) / \(plan.members.count) members, \(done >> 20) MiB")
      }
    }
    let sha = try writer.finish()
    let reader = try PackReader(url: out)
    let d = ContinuousClock.now - t0
    CLI.standardError("pack \(plan.manifest.name): written in \(d.components.seconds) s")
    report(reader, sha: sha, at: out)
    return 0
  }

  static func slot(_ s: String) throws -> SourceSlot {
    guard let n = Int(s), (0...14).contains(n) else { throw UsageError("--slot must be 0…14") }
    return SourceSlot(rawValue: n)
  }

  static func report(_ reader: PackReader, sha: String, at url: URL) {
    let o: JSONObject = ["name": .string(reader.manifest.name), "sha256": .string(sha), "bytes": .number(Double(reader.fileSize)),
                         "members": .number(Double(reader.manifest.members.count)),
                         "uncompressed": .number(Double(reader.manifest.uncompressedBytes)), "path": .string(url.path)]
    print(CanonicalJSON.string(.object(o)))
  }
}

/// The members and manifest of one pack, resolved from a spec or a staged directory.
struct PackPlan {
  struct Member {
    var path: String
    var file: URL
    var size: Int64
  }

  var manifest: PackManifest
  var members: [Member]
  var formatMD: String?

  /// From a JSON spec (Tools/packs.sh writes one per pack).
  init(spec url: URL) throws {
    let v = try JSONValue.parse(Data(contentsOf: url))
    func strings(_ k: String) -> [String] { v[k]?.arrayValue?.compactMap(\.stringValue) ?? [] }
    guard let name = v["name"]?.stringValue, let version = v["version"]?.stringValue,
          let slot = v["slot"]?.safeInteger, (0...14).contains(slot) else {
      throw UsageError("the spec needs name, version and slot (0…14)")
    }
    var members: [Member] = []
    var seen = Set<String>()
    for src in v["sources"]?.arrayValue ?? [] {
      guard let root = src["root"]?.stringValue else { throw UsageError("a spec source lacks root") }
      let prefix = src["prefix"]?.stringValue ?? ""
      let rootURL = URL(fileURLWithPath: root, isDirectory: true)
      for pattern in src["include"]?.arrayValue?.compactMap(\.stringValue) ?? [] {
        let found = try PackPlan.expand(pattern, in: rootURL)
        guard !found.isEmpty else { throw UsageError("'\(pattern)' matches no file under \(root)") }
        for rel in found {
          let path = prefix + rel
          guard seen.insert(path).inserted else { continue }
          let file = rootURL.appendingPathComponent(rel)
          members.append(Member(path: path, file: file, size: try PackPlan.size(file)))
        }
      }
    }
    guard !members.isEmpty else { throw UsageError("the spec names no member") }
    var counts = PackPlan.counts(members)
    for (k, n) in v["counts"]?.objectValue ?? [:] { if let n = n.safeInteger { counts[k] = n } }
    let format = v["format_md"]?.stringValue
    if format != nil { counts["members"] = members.count + 1 }
    manifest = PackManifest(
      packID: v["pack_id"]?.stringValue ?? name, name: name, version: version, slot: SourceSlot(rawValue: slot),
      adapterIDs: strings("adapter_ids"), createdBy: PackPlan.createdBy,
      referenceCommit: v["reference_commit"]?.stringValue ?? "", licences: strings("licences"),
      attribution: strings("attribution"), caveats: strings("caveats"), members: [], counts: counts)
    self.members = members
    formatMD = format
  }

  /// Every regular file under a staged directory, prefixed by the directory's name.
  init(staged dir: URL, name: String, version: String, slot: SourceSlot, adapters: [String], licence: String?,
       attribution: String?, referenceCommit: String?) throws {
    let root = dir.standardizedFileURL
    let prefix = root.lastPathComponent + "/"
    let files = try PackPlan.walk(root)
    guard files.contains("FORMAT.md"), files.contains("MANIFEST.json") else {
      throw UsageError("\(root.path) has no FORMAT.md and MANIFEST.json: a staged source carries both (SPEC §10.1)")
    }
    members = try files.map { rel in
      let f = root.appendingPathComponent(rel)
      return Member(path: prefix + rel, file: f, size: try PackPlan.size(f))
    }
    manifest = PackManifest(packID: name, name: name, version: version, slot: slot, adapterIDs: adapters,
                            createdBy: PackPlan.createdBy, referenceCommit: referenceCommit ?? "",
                            licences: licence.map { [$0] } ?? [], attribution: attribution.map { [$0] } ?? [], caveats: [],
                            members: [], counts: PackPlan.counts(members))
    formatMD = nil
  }

  /// "scrolls-cli <engine version> <git sha>".
  static var createdBy: String { "scrolls-cli \(BuildInfo.engineVersion) \(BuildInfo.gitCommit)" }

  /// Member counts: all members, and per top folder ("texts/gutenberg" → 691).
  static func counts(_ members: [Member]) -> [String: Int] {
    var c: [String: Int] = ["members": members.count]
    for m in members {
      let parts = m.path.split(separator: "/")
      guard parts.count > 1 else { continue }
      c["files:" + parts.dropLast().joined(separator: "/"), default: 0] += 1
    }
    return c
  }

  static func size(_ url: URL) throws -> Int64 {
    let a = try FileManager.default.attributesOfItem(atPath: url.path)
    guard (a[.type] as? FileAttributeType) == .typeRegular else { throw UsageError("\(url.path) is not a regular file") }
    return (a[.size] as? NSNumber)?.int64Value ?? 0
  }

  /// `dir/name`, `dir/*.ext` (one `*` in the last component only), or a plain relative path; sorted by code units.
  static func expand(_ pattern: String, in root: URL) throws -> [String] {
    guard pattern.contains("*") else {
      return FileManager.default.fileExists(atPath: root.appendingPathComponent(pattern).path) ? [pattern] : []
    }
    let parts = pattern.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let last = parts.last, !parts.dropLast().contains(where: { $0.contains("*") }) else {
      throw UsageError("'\(pattern)': only the last path component may hold '*'")
    }
    let dir = parts.dropLast().joined(separator: "/")
    let star = last.split(separator: "*", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
    let (head, tail) = (star[0], star.count > 1 ? star[1] : "")
    let names = (try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(dir).path)) ?? []
    return names.filter { $0.hasPrefix(head) && $0.hasSuffix(tail) && $0.count >= head.count + tail.count && !$0.hasPrefix(".") }
      .map { dir.isEmpty ? $0 : "\(dir)/\($0)" }
      .filter { (try? size(root.appendingPathComponent($0))) != nil }
      .sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
  }

  /// Every regular file under `root` (relative paths, hidden files skipped), sorted by code units.
  static func walk(_ root: URL) throws -> [String] {
    guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey],
                                                 options: [.skipsHiddenFiles]) else {
      throw UsageError("cannot read \(root.path)")
    }
    var out: [String] = []
    let base = root.path.hasSuffix("/") ? root.path : root.path + "/"
    for case let u as URL in e where (try? u.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
      let p = u.standardizedFileURL.path
      if p.hasPrefix(base) { out.append(String(p.dropFirst(base.count))) }
    }
    return out.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
  }
}
