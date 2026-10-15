// OWNER: N0
// V8 computes Math.log and Math.log10 with its fdlibm port (v8/src/base/ieee754.cc), not with the platform libm, and
// the arm64 Node build compiles it with clang's default -ffp-contract=on: inside one expression, a multiplication that
// feeds an addition or subtraction is fused into one fma (the left operand first, as clang's tryEmitFMulAdd picks it).
// Format.number reads floor(Math.log10(x)), so this is the same code with the same fusions, bit-identical with the
// reference (golden g1.js-math). `fused(a, b, c)` = a·b + c with one rounding.

/// Math functions bit-identical with the reference's V8 (`Math.log`, `Math.log10`).
public enum JSMath {
  /// a·b + c, rounded once (llvm.fmuladd as clang emits it under -ffp-contract=on).
  @inline(__always)
  static func fused(_ a: Double, _ b: Double, _ c: Double) -> Double { c.addingProduct(a, b) }

  /// `Math.log(x)` (fdlibm `__ieee754_log`).
  public static func log(_ x: Double) -> Double {
    let ln2Hi = 6.93147180369123816490e-01  // 3fe62e42 fee00000
    let ln2Lo = 1.90821492927058770002e-10  // 3dea39ef 35793c76
    let two54 = 1.80143985094819840000e+16  // 43500000 00000000
    let lg1 = 6.666666666666735130e-01, lg2 = 3.999999999940941908e-01, lg3 = 2.857142874366239149e-01
    let lg4 = 2.222219843214978396e-01, lg5 = 1.818357216161805012e-01, lg6 = 1.531383769920937332e-01
    let lg7 = 1.479819860511658591e-01

    var x = x
    var hx = highWord(x)
    let lx = lowWord(x)
    var k: Int32 = 0
    if hx < 0x0010_0000 {  // x < 2**-1022
      if ((hx & 0x7FFF_FFFF) | Int32(bitPattern: lx)) == 0 { return -Double.infinity }  // log(±0) = -inf
      if hx < 0 { return .nan }  // log(-#) = NaN
      k -= 54
      x *= two54  // subnormal: scale up
      hx = highWord(x)
    }
    if hx >= 0x7FF0_0000 { return x + x }
    k &+= (hx >> 20) &- 1023
    hx &= 0x000F_FFFF
    let i0 = (hx &+ 0x95F64) & 0x10_0000
    x = withHighWord(x, hx | (i0 ^ 0x3FF0_0000))  // normalize x or x/2
    k &+= (i0 >> 20)
    let f = x - 1.0
    if (0x000F_FFFF & (2 &+ hx)) < 3 {  // -2**-20 <= f < 2**-20
      if f == 0 {
        if k == 0 { return 0 }
        let dk = Double(k)
        return fused(dk, ln2Hi, dk * ln2Lo)  // dk*ln2_hi + dk*ln2_lo
      }
      let r = f * f * fused(-0.33333333333333333, f, 0.5)  // f*f*(0.5 - 0.333…*f)
      if k == 0 { return f - r }
      let dk = Double(k)
      return fused(dk, ln2Hi, -(fused(-dk, ln2Lo, r) - f))  // dk*ln2_hi - ((R - dk*ln2_lo) - f)
    }
    let s = f / (2.0 + f)
    let dk = Double(k)
    let z = s * s
    var i = hx &- 0x6147A
    let w = z * z
    let j = 0x6B851 &- hx
    let t1 = w * fused(w, fused(w, lg6, lg4), lg2)  // w*(Lg2 + w*(Lg4 + w*Lg6))
    let t2 = z * fused(w, fused(w, fused(w, lg7, lg5), lg3), lg1)  // z*(Lg1 + w*(Lg3 + w*(Lg5 + w*Lg7)))
    i |= j
    let r = t2 + t1
    if i > 0 {
      let hfsq = 0.5 * f * f
      if k == 0 { return f - fused(-s, hfsq + r, hfsq) }  // f - (hfsq - s*(hfsq + R))
      // dk*ln2_hi - ((hfsq - (s*(hfsq + R) + dk*ln2_lo)) - f)
      return fused(dk, ln2Hi, -((hfsq - fused(s, hfsq + r, dk * ln2Lo)) - f))
    }
    if k == 0 { return fused(-s, f - r, f) }  // f - s*(f - R)
    return fused(dk, ln2Hi, -(fused(s, f - r, -(dk * ln2Lo)) - f))  // dk*ln2_hi - ((s*(f - R) - dk*ln2_lo) - f)
  }

  /// `Math.log10(x)` (fdlibm `__ieee754_log10`): exact for every power of ten 10⁰…10²².
  public static func log10(_ x: Double) -> Double {
    let two54 = 1.80143985094819840000e+16
    let ivln10 = 4.34294481903251816668e-01
    let log10_2hi = 3.01029995663611771306e-01  // 0x3FD34413, 0x509F6000
    let log10_2lo = 3.69423907715893078616e-13  // 0x3D59FEF3, 0x11F12B36

    var x = x
    var hx = highWord(x)
    var lx = lowWord(x)
    var k: Int32 = 0
    if hx < 0x0010_0000 {  // x < 2**-1022
      if ((hx & 0x7FFF_FFFF) | Int32(bitPattern: lx)) == 0 { return -Double.infinity }
      if hx < 0 { return .nan }
      k -= 54
      x *= two54
      hx = highWord(x)
      lx = lowWord(x)
    }
    if hx >= 0x7FF0_0000 { return x + x }
    if hx == 0x3FF0_0000 && lx == 0 { return 0 }  // log10(1) = +0
    k &+= (hx >> 20) &- 1023
    let i: Int32 = k < 0 ? 1 : 0  // (k & 0x80000000) >> 31 on the unsigned bit pattern
    hx = (hx & 0x000F_FFFF) | ((0x3FF &- i) << 20)
    let y = Double(k &+ i)
    x = Double(bitPattern: UInt64(UInt32(bitPattern: hx)) << 32 | UInt64(lx))
    let z = fused(y, log10_2lo, ivln10 * log(x))  // y*log10_2lo + ivln10*log(x)
    return fused(y, log10_2hi, z)  // z + y*log10_2hi
  }

  private static func highWord(_ x: Double) -> Int32 { Int32(bitPattern: UInt32(truncatingIfNeeded: x.bitPattern >> 32)) }
  private static func lowWord(_ x: Double) -> UInt32 { UInt32(truncatingIfNeeded: x.bitPattern) }
  private static func withHighWord(_ x: Double, _ hi: Int32) -> Double {
    Double(bitPattern: UInt64(UInt32(bitPattern: hi)) << 32 | (x.bitPattern & 0xFFFF_FFFF))
  }
}
