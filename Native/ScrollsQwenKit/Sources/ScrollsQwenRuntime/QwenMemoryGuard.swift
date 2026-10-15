// OWNER: Q (created by the bring-up, B2)
// Unload triggers (IOS-SPEC-QWEN §2.6): background, didReceiveMemoryWarning, a critical memory-pressure event and
// thermal critical unload the resident model; thermal fair/serious restrict work (`QwenMemoryPolicy`). Idle timers
// and role switches live in `ModelManager`. Every action is recorded so the screen and the self-test can show it.

import Foundation
import ScrollsQwen
#if canImport(UIKit)
import UIKit
#endif

public final class QwenMemoryGuard: @unchecked Sendable {
  public struct Record: Codable, Sendable, Equatable {
    public var at: String
    public var event: String
    public var action: String
  }

  private let manager: ModelManager
  private let lock = NSLock()
  private var observers: [NSObjectProtocol] = []
  private var pressure: DispatchSourceMemoryPressure?
  private var _records: [Record] = []
  private var cancelOwner: @Sendable () async -> Void = {}

  public init(manager: ModelManager) {
    self.manager = manager
  }

  public var records: [Record] {
    lock.lock()
    defer { lock.unlock() }
    return _records
  }

  /// The app's outer pipeline may be hashing files or grouping vectors between manager operations.
  /// Cancel that owner before unloading, so it cannot admit a fresh model after memory pressure.
  public func setOwnerCancellation(_ cancel: @escaping @Sendable () async -> Void) {
    lock.lock()
    cancelOwner = cancel
    lock.unlock()
  }

  public func start() {
    let nc = NotificationCenter.default
    #if canImport(UIKit)
    observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.handle(.background, name: "background")
    })
    observers.append(nc.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil) { [weak self] _ in
      self?.handle(.memoryWarning, name: "memory warning")
    })
    #endif
    observers.append(nc.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { [weak self] _ in
      let t = Footprint.thermal
      self?.handle(.thermal(t), name: "thermal \(t.word)")
    })
    let source = DispatchSource.makeMemoryPressureSource(eventMask: [.critical], queue: .global(qos: .userInitiated))
    source.setEventHandler { [weak self] in self?.handle(.memoryPressureCritical, name: "memory pressure critical") }
    source.resume()
    pressure = source
    handle(.thermal(Footprint.thermal), name: "thermal at start \(Footprint.thermal.word)")
  }

  public func stop() {
    for o in observers { NotificationCenter.default.removeObserver(o) }
    observers.removeAll()
    pressure?.cancel()
    pressure = nil
  }

  func handle(_ event: QwenMemoryPolicy.Event, name: String) {
    let action = QwenMemoryPolicy.action(for: event)
    let words: String
    switch action {
    case .unload(let r): words = "unload (\(r.rawValue))"
    case .restrict(let t): words = "restrict (\(t.word))"
    case .none: words = "none"
    }
    lock.lock()
    _records.append(Record(at: ISO8601DateFormatter().string(from: Date()), event: name, action: words))
    if _records.count > 50 { _records.removeFirst(_records.count - 50) }
    let cancelOwner = cancelOwner
    lock.unlock()
    let manager = manager
    Task {
      switch action {
      case .unload(let r):
        await cancelOwner()
        await manager.unloadNow(r)
      case .restrict(let t): await manager.setThermalRestriction(t)
      case .none:
        if case .thermal(let t) = event { await manager.setThermalRestriction(t) }
      }
    }
  }
}
