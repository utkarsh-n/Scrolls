// OWNER: N0
// The launch trail: one JSON line per launch step in Documents/Diagnostics/launch.jsonl, written and synced at once, so
// a launch the system ends early (a watchdog, a kill without a report) still says how far it got and what the engine
// said. devicectl copies the file back (`devicectl device copy from … --source Documents/Diagnostics/launch.jsonl`).

import Foundation

nonisolated enum LaunchTrail {
  /// Appends `{"t": seconds since 1970, "pid", "step", "detail"}`; never throws, never blocks on anything but the file.
  static func note(_ step: String, _ detail: String = "") {
    let fm = FileManager.default
    guard let docs = try? fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else { return }
    let dir = docs.appendingPathComponent("Diagnostics", isDirectory: true)
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("launch.jsonl")
    let line: [String: Any] = ["t": (Date.now.timeIntervalSince1970 * 1000).rounded() / 1000,
                               "pid": Int(ProcessInfo.processInfo.processIdentifier), "step": step, "detail": detail]
    guard var data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    if let handle = try? FileHandle(forWritingTo: url) {
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: data)
      try? handle.synchronize()
    } else {
      try? data.write(to: url, options: .atomic)
    }
  }
}
