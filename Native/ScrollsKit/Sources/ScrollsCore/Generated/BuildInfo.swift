// OWNER: N0
// The committed copy holds "dev" values. Native/Tools/gen-buildinfo.sh rewrites this file in the build mirror only
// (full values for app, CLI and device builds; see Native/Docs/BUILD.md).

/// The identity of this engine build: runs record `codeHash(stage:)` as their `code_hash` (ΔS-7).
public enum BuildInfo {
  /// MARKETING_VERSION of Native/project.yml.
  public static let engineVersion = "dev"
  /// HEAD of ~/Developer/git/Scrolls.git when the mirror was made.
  public static let gitCommit = "dev"
  /// sha256 over every engine source file (path and content).
  public static let sourceDigest = "dev"
  /// sha256 of each stage's source files, the analogue of the reference's MATCHING_CODE_FILES.
  public static let stageCodeHashes: [String: String] = [:]

  /// The code hash a run of `stage` records: its own hash, or the source digest for a stage without one.
  public static func codeHash(stage: String) -> String { stageCodeHashes[stage] ?? sourceDigest }
}
