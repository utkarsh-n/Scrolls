// swift-tools-version: 6.4
// OWNER: N0
// .iOS(.v27)/.macOS(.v27) need tools 6.4 (LabKit's note). A package edits only its own targets' settings, via N0.
//
// Every target and product of IOS-SPEC §1.2 / §8.4.3 is declared below. Bring-up rule (parallel packages): a declared
// target is built once its folder holds a Swift source file and every target it depends on is built; a declared
// resource is bundled once it exists on disk. Packages therefore add files, never manifest entries, and one package's
// missing folder never breaks another package's build. When every folder and resource exists the evaluated manifest
// is exactly §8.4.3. `Tools/check.sh quick` lists what is still missing (PENDING until the M0 merge).
// In a build mirror, `.scrolls-targets` (written by Tools/build.sh from SCROLLS_TARGETS) narrows the package to the
// listed targets and what they depend on, so `swift test` for one package never compiles another package's code.
import Foundation
import PackageDescription

let engine: [SwiftSetting] = [
  .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
  .unsafeFlags(["-O"], .when(configuration: .debug)),  // Loom's rule: the engine is arithmetic; -Onone is ≈ 20× slower
]
let numeric: [SwiftSetting] = engine + [.unsafeFlags(["-Xcc", "-DACCELERATE_NEW_LAPACK"])]

/// A target as declared by the spec, before the bring-up filter.
struct Declared {
  enum Kind { case library, executable, test }
  enum Res { case copy(String), process(String) }
  var name: String
  var kind: Kind
  var deps: [String] = []
  var resources: [Res] = []
  var settings: [SwiftSetting] = []
  var linker: [LinkerSetting] = []
}

let declared: [Declared] = [
  .init(name: "ScrollsCore", kind: .library, resources: [.copy("Resources/vocab.json")], settings: engine),
  .init(name: "ScrollsContracts", kind: .library, deps: ["ScrollsCore"], settings: engine),
  .init(name: "ScrollsStore", kind: .library, deps: ["ScrollsCore", "ScrollsContracts"],
        resources: [.copy("Resources/schema.sql"), .copy("Resources/device-profile.sql"), .copy("Resources/dump-spec.json")],
        settings: engine, linker: [.linkedLibrary("sqlite3")]),
  .init(name: "ScrollsJobs", kind: .library, deps: ["ScrollsStore"], settings: engine),
  .init(name: "ScrollsIngest", kind: .library, deps: ["ScrollsJobs"], resources: [.copy("Resources/stopwords")], settings: engine),
  .init(name: "ScrollsSources", kind: .library, deps: ["ScrollsIngest"],
        resources: [.copy("Resources/demo"), .copy("Resources/field-taxonomy.json")], settings: engine),
  .init(name: "ScrollsQuery", kind: .library, deps: ["ScrollsJobs"], settings: engine),
  .init(name: "ScrollsAnalysis", kind: .library, deps: ["ScrollsQuery"], settings: numeric),
  .init(name: "ScrollsNL", kind: .library, deps: ["ScrollsAnalysis"], settings: engine),
  .init(name: "ScrollsLineage", kind: .library, deps: ["ScrollsAnalysis"], settings: numeric),
  .init(name: "ScrollsProvenance", kind: .library, deps: ["ScrollsQuery"], settings: engine),
  .init(name: "ScrollsService", kind: .library,
        deps: ["ScrollsSources", "ScrollsQuery", "ScrollsAnalysis", "ScrollsNL", "ScrollsLineage", "ScrollsProvenance"],
        resources: [.copy("Resources/contract-fixtures")],  // the 65 tests/contract/*.json, for MockAtlas
        settings: engine),
  .init(name: "ScrollsScrollModel", kind: .library, deps: ["ScrollsCore", "ScrollsContracts"], settings: engine),
  .init(name: "ScrollsRender", kind: .library, deps: ["ScrollsScrollModel"], resources: [.process("Shaders")],
        settings: engine + [.defaultIsolation(MainActor.self)]),  // SVGWriter is declared nonisolated
  .init(name: "scrolls-cli", kind: .executable, deps: ["ScrollsService", "ScrollsScrollModel"], settings: engine),
  // IOS-SPEC-QWEN §2.1: every Qwen decision, MLX-free and swift-testable (the bring-up's shape: depends on Core only;
  // the MLX runtime is the local package Native/ScrollsQwenKit, built only by xcodebuild)
  .init(name: "ScrollsQwen", kind: .library, deps: ["ScrollsCore"], resources: [.copy("Resources/prompts")], settings: engine),

  .init(name: "ScrollsCoreTests", kind: .test, deps: ["ScrollsCore"]),
  .init(name: "ScrollsContractsTests", kind: .test, deps: ["ScrollsContracts"]),
  .init(name: "ScrollsStoreTests", kind: .test, deps: ["ScrollsStore"]),
  .init(name: "ScrollsJobsTests", kind: .test, deps: ["ScrollsJobs"]),
  .init(name: "ScrollsIngestTests", kind: .test, deps: ["ScrollsIngest"]),
  .init(name: "ScrollsSourcesTests", kind: .test, deps: ["ScrollsSources"]),
  .init(name: "ScrollsQueryTests", kind: .test, deps: ["ScrollsQuery"]),
  .init(name: "ScrollsAnalysisTests", kind: .test, deps: ["ScrollsAnalysis", "ScrollsNL"]),
  .init(name: "ScrollsLineageTests", kind: .test, deps: ["ScrollsLineage"]),
  .init(name: "ScrollsProvenanceTests", kind: .test, deps: ["ScrollsProvenance"]),
  .init(name: "ScrollsServiceTests", kind: .test, deps: ["ScrollsService"]),
  .init(name: "ScrollsScrollModelTests", kind: .test, deps: ["ScrollsScrollModel"]),
  .init(name: "ScrollsRenderTests", kind: .test, deps: ["ScrollsRender"]),
  .init(name: "ScrollsQwenTests", kind: .test, deps: ["ScrollsQwen"], resources: [.copy("Fixtures")]),
  .init(name: "DifferentialTests", kind: .test, deps: ["ScrollsService", "ScrollsScrollModel", "ScrollsRender"],
        resources: [.copy("Golden")]),  // committed, redacted subset (§2.6)
]

let declaredProducts: [(name: String, executable: Bool, target: String)] = [
  ("ScrollsCore", false, "ScrollsCore"),
  ("ScrollsContracts", false, "ScrollsContracts"),
  ("ScrollsService", false, "ScrollsService"),
  ("ScrollsScrollModel", false, "ScrollsScrollModel"),
  ("ScrollsRender", false, "ScrollsRender"),
  ("scrolls-cli", true, "scrolls-cli"),
  ("ScrollsQwen", false, "ScrollsQwen"),
]

// ── bring-up filter ──────────────────────────────────────────────────────────────────────────────────────────────
let packageRoot = Context.packageDirectory

func folder(of t: Declared) -> String { "\(packageRoot)/\(t.kind == .test ? "Tests" : "Sources")/\(t.name)" }

func holdsSwiftSource(_ dir: String) -> Bool {
  guard let walk = FileManager.default.enumerator(atPath: dir) else { return false }
  for case let path as String in walk where path.hasSuffix(".swift") { return true }
  return false
}

/// The targets a mirror's `.scrolls-targets` asks for, closed over their dependencies; nil = every target.
let allowed: Set<String>? = {
  guard let text = FileManager.default.contents(atPath: "\(packageRoot)/.scrolls-targets").flatMap({ String(data: $0, encoding: .utf8) })
  else { return nil }
  var wanted = Set(text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "," }).map(String.init))
  var grew = true
  while grew {
    let next = wanted.union(declared.filter { wanted.contains($0.name) }.flatMap(\.deps))
    grew = next.count > wanted.count
    wanted = next
  }
  return wanted
}()

var built = Set<String>()
var targets: [Target] = []
for t in declared where (allowed?.contains(t.name) ?? true) && holdsSwiftSource(folder(of: t)) && t.deps.allSatisfy(built.contains) {
  built.insert(t.name)
  let resources: [Resource] = t.resources.compactMap { r in
    switch r {
    case .copy(let p): FileManager.default.fileExists(atPath: "\(folder(of: t))/\(p)") ? .copy(p) : nil
    case .process(let p): FileManager.default.fileExists(atPath: "\(folder(of: t))/\(p)") ? .process(p) : nil
    }
  }
  var deps = t.deps.map { Target.Dependency(stringLiteral: $0) }
  if t.name == "ScrollsQwen" || t.name == "ScrollsQwenTests" {
    deps.append(.product(name: "OfflineIntelligence", package: "OfflineIntelligenceKit"))
  }
  switch t.kind {
  case .library:
    targets.append(.target(name: t.name, dependencies: deps, resources: resources, swiftSettings: t.settings,
                           linkerSettings: t.linker))
  case .executable:
    targets.append(.executableTarget(name: t.name, dependencies: deps, resources: resources, swiftSettings: t.settings,
                                     linkerSettings: t.linker))
  case .test:
    targets.append(.testTarget(name: t.name, dependencies: deps, resources: resources, swiftSettings: t.settings))
  }
}

let products: [Product] = declaredProducts.filter { built.contains($0.target) }.map {
  $0.executable ? .executable(name: $0.name, targets: [$0.target]) : .library(name: $0.name, targets: [$0.target])
}

let package = Package(
  name: "ScrollsKit",
  platforms: [.iOS(.v27), .macOS(.v27)],
  products: products,
  dependencies: [.package(path: "../../../OfflineIntelligenceKit")],
  targets: targets,
  swiftLanguageModes: [.v6]
)
