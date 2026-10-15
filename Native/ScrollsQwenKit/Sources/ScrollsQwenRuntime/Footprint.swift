// OWNER: Q (created by the bring-up, B2)
// Memory and heat as the phone accounts them (AttentionMachine's DeviceStabilityCheck pattern): task_vm_info
// phys_footprint and the ledger's peak, os_proc_available_memory() on iOS, MLX's allocator counters, the thermal state.

import Foundation
import MLX
import ScrollsQwen
#if os(iOS)
import os
#endif

public enum Footprint {
  public struct VM: Sendable { public var footprint: Int?; public var peak: Int? }

  public static func vm() -> VM {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard kr == KERN_SUCCESS else { return VM(footprint: nil, peak: nil) }
    return VM(footprint: Int(info.phys_footprint), peak: info.ledger_phys_footprint_peak > 0 ? Int(info.ledger_phys_footprint_peak) : nil)
  }

  public static var footprint: Int? { vm().footprint }

  /// os_proc_available_memory(): what the process may still allocate before jetsam (iOS only).
  public static var available: Int? {
    #if os(iOS) && !targetEnvironment(simulator)
    return Int(os_proc_available_memory())
    #else
    return nil
    #endif
  }

  public static var thermal: ThermalLevel {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: .nominal
    case .fair: .fair
    case .serious: .serious
    case .critical: .critical
    @unknown default: .serious
    }
  }

  public static func sample(_ label: String) -> MemorySample {
    let v = vm()
    let m = Memory.snapshot()
    return MemorySample(label: label, footprint: v.footprint, ledgerPeak: v.peak, available: available,
                        mlxActive: m.activeMemory, mlxCache: m.cacheMemory, mlxPeak: m.peakMemory, thermal: thermal.word)
  }

  /// "iPhone16,2" on the phone; the simulated or Mac model elsewhere.
  public static var machine: String {
    if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim + " (simulator)" }
    var size = 0
    sysctlbyname("hw.machine", nil, &size, nil, 0)
    var buf = [CChar](repeating: 0, count: max(1, size))
    sysctlbyname("hw.machine", &buf, &size, nil, 0)
    let s = String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    if s.hasPrefix("arm64") || s.hasPrefix("x86") {
      var msize = 0
      sysctlbyname("hw.model", nil, &msize, nil, 0)
      var mbuf = [CChar](repeating: 0, count: max(1, msize))
      sysctlbyname("hw.model", &mbuf, &msize, nil, 0)
      return String(decoding: mbuf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }
    return s
  }

  public static var osBuild: String {
    let v = ProcessInfo.processInfo.operatingSystemVersionString
    #if os(iOS)
    return "iOS " + v
    #else
    return "macOS " + v
    #endif
  }

  public static var builtOn: BuiltOn {
    #if targetEnvironment(simulator)
    return .simulator
    #elseif os(iOS)
    return .device
    #else
    return .mac
    #endif
  }
}
