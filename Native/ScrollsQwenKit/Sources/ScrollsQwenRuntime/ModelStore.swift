// OWNER: Q (created by the bring-up, B2)
// Where the models live and whether they may be loaded (IOS-SPEC-QWEN §2.10, the bring-up's layout): the Mac pushes
// each model folder into the app container's Documents/Models/<name>/ (`Tools/models.sh push`, devicectl on the phone,
// simctl's data container in the simulator). The app has no download code. A folder is loaded only after every file
// matched the sha256 compiled into `ModelCatalog`.

import Foundation
import ScrollsQwen

public final class ModelStore: Sendable {
  public let root: URL
  public let bundledRoot: URL?

  public init(root: URL, bundledRoot: URL? = Bundle.main.url(forResource: "Models", withExtension: nil)) {
    self.root = root
    self.bundledRoot = bundledRoot
  }

  /// Documents/Models in the app container.
  public static var defaultRoot: URL {
    URL.documentsDirectory.appendingPathComponent("Models", isDirectory: true)
  }

  public func folder(_ spec: ModelSpec) -> URL {
    let imported = root.appendingPathComponent(spec.name, isDirectory: true)
    if FileManager.default.fileExists(atPath: imported.path) { return imported }
    return bundledRoot?.appendingPathComponent(spec.name, isDirectory: true) ?? imported
  }

  public func isPresent(_ spec: ModelSpec) -> Bool {
    FileManager.default.fileExists(atPath: folder(spec).appendingPathComponent("model.safetensors").path)
  }

  /// Verifies (or trusts an unchanged earlier verification of) one model. Never loads it.
  public func verify(_ spec: ModelSpec, force: Bool = false, progress: @Sendable (Double) -> Void = { _ in }) -> ModelStatus {
    let dir = folder(spec)
    guard isPresent(spec) else { return ModelStatus(spec: spec, folder: dir.path, state: .missing, verification: nil) }
    let v = ModelVerify.verify(folder: dir, spec: spec, force: force, progress: progress)
    if v.ok { excludeFromBackup(dir) }
    return ModelStatus(spec: spec, folder: dir.path, state: v.ok ? .verified : .failed, verification: v)
  }

  public func status() -> [ModelStatus] { ModelCatalog.all.map { verify($0) } }

  private func excludeFromBackup(_ dir: URL) {
    var url = dir
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? url.setResourceValues(values)
  }
}
