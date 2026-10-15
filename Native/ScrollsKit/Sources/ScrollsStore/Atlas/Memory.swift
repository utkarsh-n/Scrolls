// OWNER: N0
// Memory and virtual-memory budgets (IOS-SPEC §3.8). `MemoryBudget` admits a job only when the process can still grow
// by its declared peak plus 600 MB of headroom (`os_proc_available_memory()` on iOS, net of the peaks already
// reserved); `MappedFileRegistry` accounts every file mapping — SQLite reader mmap windows, cubes, spaces, token
// streams, indexes — against 2 GiB, and a mapping that would exceed it throws `.overBudget`, so the caller streams
// with pread instead (slower, same result). No budget depends on the increased-memory entitlements.

import Darwin
import Foundation
import Synchronization

/// Why memory could not be reserved.
public enum MemoryBudgetError: Error, Sendable, Equatable, CustomStringConvertible {
  case insufficient(requested: Int, available: Int)
  case overBudget(requested: Int, used: Int, budget: Int)
  case unmappable(path: String, errno: Int32)

  public var description: String {
    switch self {
    case .insufficient(let r, let a):
      "needs \(r >> 20) MB of memory with headroom; \(a >> 20) MB are available"
    case .overBudget(let r, let u, let b): "mapping \(r >> 20) MB would exceed the \(b >> 20) MB budget (\(u >> 20) MB mapped)"
    case .unmappable(let p, let e): "cannot map \(p) (errno \(e))"
    }
  }
}

/// Dirty-memory admission for jobs.
public enum MemoryBudget {
  private static let reserved = Mutex<Int>(0)

  /// Reserves `bytes` (a job's declared peak): requires available memory ≥ outstanding reservations + bytes + headroom.
  public static func reserve(bytes: Int, headroom: Int = 600 << 20) throws -> MemoryReservation {
    let available = availableBytes()
    try reserved.withLock { r in
      let free = available - r
      guard free >= bytes + headroom else { throw MemoryBudgetError.insufficient(requested: bytes + headroom, available: max(0, free)) }
      r += bytes
    }
    return MemoryReservation(bytes: bytes) { n in reserved.withLock { $0 -= n } }
  }

  /// Peaks reserved and not yet released.
  public static var reservedBytes: Int { reserved.withLock { $0 } }

  /// How far this process may still grow: `os_proc_available_memory()` on an iOS device; on the Mac (CLI, tests) and
  /// in the iOS simulator, physical memory minus this process's footprint. The simulator has no jetsam limit and its
  /// `os_proc_available_memory()` answers 0, which would refuse every job (measured, Scrolls N0 simulator).
  public static func availableBytes() -> Int {
    #if os(iOS) && !targetEnvironment(simulator)
      return Int(os_proc_available_memory())
    #else
      return max(0, Int(ProcessInfo.processInfo.physicalMemory) - Int(physFootprint()))
    #endif
  }

  /// `task_vm_info.phys_footprint`: the number jetsam judges.
  public static func physFootprint() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) { p in
      p.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
    }
    return kr == KERN_SUCCESS ? info.phys_footprint : 0
  }
}

/// A reservation of memory or mapping budget; released once (explicitly or when dropped).
public final class MemoryReservation: Sendable {
  public let bytes: Int
  private let onRelease: @Sendable (Int) -> Void
  private let released = Atomic<Bool>(false)

  init(bytes: Int, onRelease: @escaping @Sendable (Int) -> Void) {
    self.bytes = bytes
    self.onRelease = onRelease
  }

  /// Returns the bytes to the budget (idempotent).
  public func release() {
    guard !released.exchange(true, ordering: .relaxed) else { return }
    onRelease(bytes)
  }

  deinit { release() }
}

/// A reservation of mapping budget without a file (the SQLite readers' mmap windows).
public typealias MappingReservation = MemoryReservation

/// The ledger of file mappings (≤ 2 GiB in total).
public enum MappedFileRegistry {
  public static let budgetBytes = 2 << 30

  private struct Ledger {
    var used = 0
    var purposes: [String: Int] = [:]
  }
  private static let ledger = Mutex(Ledger())

  /// Maps `url` read-only. Throws `.overBudget` when the budget cannot hold it (callers then stream with pread).
  public static func map(_ url: URL, purpose: String) throws -> MappedFile {
    let fd = open(url.path, O_RDONLY)
    guard fd >= 0 else { throw MemoryBudgetError.unmappable(path: url.path, errno: errno) }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0 else { throw MemoryBudgetError.unmappable(path: url.path, errno: errno) }
    let size = Int(st.st_size)
    let reservation = try reserve(bytes: size, purpose: purpose)
    if size == 0 { return MappedFile(base: nil, count: 0, reservation: reservation) }
    guard let p = mmap(nil, size, PROT_READ, MAP_PRIVATE, fd, 0), p != MAP_FAILED else {
      reservation.release()
      throw MemoryBudgetError.unmappable(path: url.path, errno: errno)
    }
    return MappedFile(base: p, count: size, reservation: reservation)
  }

  /// Accounts `bytes` of mappings made elsewhere (SQLite's mmap windows) under `purpose`.
  public static func reserve(bytes: Int, purpose: String) throws -> MappingReservation {
    try ledger.withLock { l in
      guard l.used + bytes <= budgetBytes else {
        throw MemoryBudgetError.overBudget(requested: bytes, used: l.used, budget: budgetBytes)
      }
      l.used += bytes
      l.purposes[purpose, default: 0] += bytes
    }
    return MappingReservation(bytes: bytes) { n in
      ledger.withLock { l in
        l.used -= n
        l.purposes[purpose, default: 0] -= n
        if l.purposes[purpose] == 0 { l.purposes[purpose] = nil }
      }
    }
  }

  /// Bytes mapped or reserved now.
  public static var usedBytes: Int { ledger.withLock { $0.used } }

  /// Mapped bytes by purpose (diagnostics).
  public static var byPurpose: [String: Int] { ledger.withLock { $0.purposes } }
}

/// A read-only file mapping.
public final class MappedFile: @unchecked Sendable {
  private let mapped: Atomic<UInt>  // the base address while mapped, 0 once unmapped
  private let count: Int
  private let reservation: MemoryReservation
  private let base: UnsafeRawPointer?

  init(base: UnsafeMutableRawPointer?, count: Int, reservation: MemoryReservation) {
    self.base = base.map { UnsafeRawPointer($0) }
    self.count = count
    self.reservation = reservation
    mapped = Atomic(UInt(bitPattern: base))
  }

  /// The mapped bytes; valid until `unmap()`.
  public var bytes: UnsafeRawBufferPointer { UnsafeRawBufferPointer(start: base, count: count) }

  /// Unmaps and returns the budget (idempotent).
  public func unmap() {
    let p = mapped.exchange(0, ordering: .acquiringAndReleasing)
    if p != 0, let raw = UnsafeMutableRawPointer(bitPattern: p) { munmap(raw, count) }
    reservation.release()
  }

  deinit { unmap() }
}
