// OWNER: N0
// Port of mulberry32 (src/shared/ids.mjs). Every seeded draw in the engine (bootstrap resamples, k-means seeding,
// layout jitter) starts here, so the stream must be bit-exact: JavaScript's Math.imul and `>>> 0` are wrapping
// UInt32 arithmetic.

/// The reference's deterministic PRNG: `Mulberry32(seed: 1994).next()` is a double in [0, 1).
public struct Mulberry32: Sendable {
  private var a: UInt32

  /// `mulberry32(seed)`; the seed is taken `>>> 0`, so pass `JSNumber.toUint32(x)` for a JavaScript number.
  public init(seed: UInt32) { a = seed }

  /// The next draw in [0, 1), exactly as the reference's `next()`.
  public mutating func next() -> Double {
    a = a &+ 0x6D2B_79F5
    var t = a
    t = (t ^ (t >> 15)) &* (t | 1)
    t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
    return Double(t ^ (t >> 14)) / 4_294_967_296
  }
}
