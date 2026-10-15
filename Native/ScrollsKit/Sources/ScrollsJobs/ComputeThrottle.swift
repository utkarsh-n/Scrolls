// OWNER: N0
// Thermal state and Low Power Mode as the job system sees them (IOS-SPEC §3.7). The engine never imports LabKit: the app
// bridges LabKitCore's DeviceConditions into `DeviceConditionsSource`; the CLI passes `Unthrottled`.

/// Thermal state and Low Power Mode, as the job system sees them (§3.7).
public enum ComputeThrottle: Sendable, Equatable {
  case nominal, fair, serious, critical, lowPower

  /// Worker threads for compute fan-out: 6, 4, 1, 0, 2.
  public var workers: Int {
    switch self {
    case .nominal: 6
    case .fair: 4
    case .serious: 1
    case .critical: 0
    case .lowPower: 2
    }
  }

  /// Whether jobs nobody asked for may start (none in Low Power Mode or when the phone is critically hot).
  public var allowsAutomaticStarts: Bool { self != .lowPower && self != .critical }
}

/// Where the throttle comes from: the app bridges LabKitCore's `DeviceConditions`; the CLI passes `Unthrottled`.
public protocol DeviceConditionsSource: Sendable {
  var current: ComputeThrottle { get }
}

/// Always `.nominal` (the CLI and tests).
public struct Unthrottled: DeviceConditionsSource {
  public init() {}
  public var current: ComputeThrottle { .nominal }
}
