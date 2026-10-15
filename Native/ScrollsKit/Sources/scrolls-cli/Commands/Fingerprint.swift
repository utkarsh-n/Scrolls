// OWNER: N2
// `scrolls-cli fingerprint` (IOS-SPEC §2.2 G6, §3.5 step 7): the per-table LogicalDump {rows, sha256} of an atlas's
// evidence and user tables (GenerationManifest.fingerprints: every table but the operational, cache and chunk tables),
// printed as canonical JSON, and compared with another generation's ATLAS.json when asked. It opens the atlas read-only
// (immutable for a clone) and never writes to it.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsService
import ScrollsStore

enum FingerprintCommand: CLICommand {
  static let name = "fingerprint"
  static let summary = "LogicalDump fingerprints of an atlas (G6)"
  static let usage = """
    usage: scrolls-cli fingerprint --atlas <atlas.sqlite> [--compare <ATLAS.json>] [--write <ATLAS.json>] [--immutable]
      Prints {table: {rows, sha256}}. --compare exits 1 and names the tables whose fingerprints differ from that
      generation's; --write writes this atlas's ATLAS.json (generation facts + fingerprints).
    """

  static func run(_ args: [String]) async throws -> Int32 {
    let a = try Arguments(args, flags: ["immutable"])
    let atlas = URL(fileURLWithPath: try a.required("atlas")).standardizedFileURL
    guard FileManager.default.fileExists(atPath: atlas.path) else { throw UsageError("no atlas at \(atlas.path)") }
    try AtlasLocation.refuseICloud(atlas)
    let probe = try Connection(path: atlas.path, mode: a.flag("immutable") ? .readOnlyImmutable : .readOnly, profile: .reference)
    let profile: StoreProfile = try Migrations.hasDeviceProfile(probe) ? .device : .reference
    probe.close()
    let c = try Connection(path: atlas.path, mode: a.flag("immutable") ? .readOnlyImmutable : .readOnly, profile: profile)
    defer { c.close() }
    let text: any TextStore = profile == .device ? ChunkedTextStore() : InlineTextStore()
    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("scrolls-fingerprint-\(UUID().uuidString)")
    let fp = try GenerationManifest.fingerprints(c, text: text, scratch: scratch)
    let manifest = try GenerationManifest.read(c, fingerprints: fp)
    if let w = a.value("write") { try manifest.write(to: URL(fileURLWithPath: w)) }
    var out: JSONObject = ["fingerprints": manifest.jsonValue["fingerprints"] ?? .null, "generation": .string(manifest.generation)]
    var status: Int32 = 0
    if let other = a.value("compare") {
      let them = try GenerationManifest.read(at: URL(fileURLWithPath: other))
      let differ = manifest.differingTables(them)
      out["compare"] = ["with": .string(them.generation), "differ": .array(differ.map(JSONValue.string)),
                        "result": .string(differ.isEmpty ? "PASS" : "FAIL")]
      status = differ.isEmpty ? 0 : 1
    }
    print(CanonicalJSON.string(.object(out)))
    return status
  }
}
