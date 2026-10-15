import Foundation

/// Samples phys_footprint every 25 ms on a utility queue; `stop()` returns the largest sample.
final class PeakSampler: @unchecked Sendable {
  private let lock = NSLock()
  private var peak = 0
  private var timer: DispatchSourceTimer?

  func start() {
    let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    t.schedule(deadline: .now(), repeating: .milliseconds(25))
    t.setEventHandler { [weak self] in
      guard let self, let f = Footprint.footprint else { return }
      self.lock.lock()
      self.peak = max(self.peak, f)
      self.lock.unlock()
    }
    timer = t
    t.resume()
  }

  func stop() -> Int? {
    timer?.cancel()
    timer = nil
    if let f = Footprint.footprint {
      lock.lock()
      peak = max(peak, f)
      lock.unlock()
    }
    lock.lock()
    defer { lock.unlock() }
    return peak > 0 ? peak : nil
  }
}
