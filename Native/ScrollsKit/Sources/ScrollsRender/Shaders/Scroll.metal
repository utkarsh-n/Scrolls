// OWNER: N7
// The Scroll's shaders (IOS-SPEC §4.23): instanced bands, washes, bars and ticks, diamonds and the overlay drawn from one
// shape pipeline (box-filter edge coverage, rounded-rect SDF for bars, patterns in screen space at a constant pitch), and
// glyphs and labels from the LabelAtlas. x-only zoom happens here: instances keep their days, the uniforms carry the
// centre and points per day, so pan, pinch within a tier, scrub, Play and selection change uniforms only.
// The vantage predicate is the one of `visibility(revealDay:at:)`: strict hides what the vantage has not reached,
// context draws it at 15%; archive primitives (reveal = INT32_MIN) always show.
// Colours are the SPEC §8.7 tokens, sRGB-encoded into a bgra8Unorm target; output is premultiplied.
#include <metal_stdlib>
#include "ScrollShaderTypes.h"
using namespace metal;

// ── tokens (SPEC §8.7, = Design/Tokens.swift) ──
constant float3 BG0 = float3(0x0E, 0x10, 0x13) / 255.0;
constant float3 BG1 = float3(0x16, 0x1A, 0x20) / 255.0;
constant float3 RULE = float3(0x34, 0x3A, 0x45) / 255.0;
constant float3 INK = float3(0xED, 0xE6, 0xD6) / 255.0;
constant float3 INK2 = float3(0xBD, 0xB5, 0xA5) / 255.0;
constant float3 INK3 = float3(0x8E, 0x88, 0x7B) / 255.0;
constant float3 CYAN = float3(0x4F, 0xD8, 0xE8) / 255.0;
constant float3 SYN = float3(0xD9, 0xCF, 0xB8) / 255.0;

// ── style ids (= ScrollStyle in ScrollsScrollModel/Styles.swift) ──
enum {
  S_NONE = 0, S_LANE0 = 1, S_LANE1 = 2, S_HATCH = 3, S_HATCHLOW = 4, S_DOTS = 5, S_LOADING = 6, S_COVSPAN = 7,
  S_COV0 = 8, S_COV1 = 9, S_COV2 = 10, S_COV3 = 11, S_COV4 = 12,
  S_BAR = 13, S_BARSPARSE = 14, S_BARBACKDROP = 15, S_ABSENT = 16, S_LOWTICK = 17,
  S_CAPSTART = 18, S_CAPCHEVRON = 19, S_CAPEND = 20,
  S_WASH = 21, S_WASHSYN = 22, S_MARKTEXT = 23, S_MARKEST = 24, S_MARKTITLE = 25,
  S_BRSTATED = 26, S_BREST = 27, S_BRDERIVED = 28, S_BRPERIOD = 29, S_COARSE = 30,
  S_RULERMAJOR = 31, S_RULERMINOR = 32, S_SEAMTICK = 33, S_SEAM = 34,
  S_RULERLABEL = 35, S_SUPERSCRIPT = 36, S_LOWN = 37, S_WASHLABEL = 38, S_COARSELABEL = 39, S_SEAMLABEL = 40, S_SPANLABEL = 41,
  // overlay (view coordinates)
  O_PLAYHEAD = 200, O_SELECTION = 201, O_BRUSH = 202, O_FOCUS = 203, O_PLAYHEAD_GLOW = 204, O_VEIL = 205,
};
enum { P_NONE = 0, P_HATCH = 1, P_HATCHLOW = 2, P_DOTS = 3, P_STRIPES = 4, P_SYN = 5 };
enum {
  F_SPARSE = 1, F_SINGLE = 2, F_ESTIMATED = 4, F_SYNTHETIC = 16, F_GHOST = 1 << 11, F_SELECTED = 1 << 12,
  F_ROUND_L = 1 << 14, F_ROUND_R = 1 << 15,
};

struct ShapeOut {
  float4 position [[position]];
  float2 local;        // points from the shape's top-left
  float2 size;         // shape size in points
  float2 view;         // view points
  float alpha;
  uint style [[flat]];
  uint flags [[flat]];
  uint pattern [[flat]];
  float p0 [[flat]];
  float p1 [[flat]];
};

/// The vantage predicate and fades: 0 hides; ghost alpha in context mode; a fade on what was just revealed.
static float vantageAlpha(int reveal, constant SUniforms &u) {
  if (u.vantageMode == 0 || reveal == INT_MIN || reveal <= u.vantageDay) {
    if (u.vantageMode != 0 && reveal != INT_MIN && reveal > u.fadeFrom && reveal <= u.vantageDay) return u.fade;
    return 1.0;
  }
  return u.vantageMode == 1 ? 0.0 : u.ghost;
}

/// How far a style's quad reaches beyond its box (glow, end ticks, hairlines), in points.
static float2 stylePad(uint style) {
  switch (style) {
    case S_BAR: return float2(1.5, 1.5);
    case S_COVSPAN: return float2(0.0, 3.0);
    case O_SELECTION: return float2(4.0, 4.0);
    default: return float2(0.0, 0.0);
  }
}

vertex ShapeOut shapeVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                            constant SInstance *inst [[buffer(0)]], constant SUniforms &u [[buffer(1)]]) {
  SInstance s = inst[iid];
  uint style = s.styleFlags & 0xFFFF, flags = s.styleFlags >> 16;
  uint kind = s.patternKind >> 16;
  float x0, x1, y0, y1;
  if (kind == SKindView) {
    x0 = s.d0; x1 = s.d1; y0 = s.y0; y1 = s.y1;
  } else {
    float cx0 = (s.d0 - u.centreRel) * u.ppd + u.viewW * 0.5;
    if (kind == SKindSpan) {
      x0 = cx0; x1 = (s.d1 - u.centreRel) * u.ppd + u.viewW * 0.5;
      y0 = s.y0; y1 = s.y1;
    } else if (kind == SKindCentre) {
      float hw = max(s.p0, 0.5);
      x0 = cx0 - hw; x1 = cx0 + hw; y0 = s.y0; y1 = s.y1;
    } else {
      x0 = cx0 - s.p0; x1 = cx0 + s.p0; y0 = s.y0 - s.p0; y1 = s.y0 + s.p0;
    }
    y0 += u.originY; y1 += u.originY;
  }
  float2 pad = stylePad(style) + 1.0 / u.scale;      // one pixel of room for the edge coverage
  float2 corner = float2((vid & 1) ? 1.0 : 0.0, (vid & 2) ? 1.0 : 0.0);
  float2 lo = float2(x0, y0) - pad, hi = float2(x1, y1) + pad;
  float2 p = mix(lo, hi, corner);
  ShapeOut o;
  o.position = float4(p.x / u.viewW * 2.0 - 1.0, 1.0 - p.y / u.viewH * 2.0, 0.0, 1.0);
  o.local = p - float2(x0, y0);
  o.size = float2(x1 - x0, y1 - y0);
  o.view = p;
  o.style = style;
  o.flags = flags;
  o.pattern = s.patternKind & 0xFFFF;
  o.p0 = s.p0;
  o.p1 = s.p1;
  float a = kind == SKindView ? 1.0 : vantageAlpha(s.reveal, u) * u.dim;
  if (kind != SKindView && (flags & F_GHOST)) a *= u.ghost;   // a list already viewed at a vantage (snapshots)
  o.alpha = a;
  if (a <= 0.003) o.position = float4(2.0, 2.0, 2.0, 1.0);   // culled: no fragments
  return o;
}

// ── coverage helpers (box filter of one pixel) ──
static float cover1(float x, float lo, float hi, float hp) {
  return clamp((min(x + hp, hi) - max(x - hp, lo)) / (2.0 * hp), 0.0, 1.0);
}
static float coverRect(float2 p, float2 lo, float2 hi, float hp) {
  return cover1(p.x, lo.x, hi.x, hp) * cover1(p.y, lo.y, hi.y, hp);
}
/// Signed distance to a rect [0,size] with left corners rl and right corners rr.
static float sdRoundRect(float2 p, float2 size, float rl, float rr) {
  float2 c = size * 0.5;
  float2 q = p - c;
  float r = q.x < 0.0 ? rl : rr;
  float2 d = abs(q) - c + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
static float coverSDF(float d, float hp) { return clamp(0.5 - d / (2.0 * hp), 0.0, 1.0); }

/// A diagonal line pattern at `pitch` points with lines `w` points wide; backslash = lines going down-right.
static float diagonal(float2 v, float pitch, float w, bool backslash, float hp) {
  float t = backslash ? (v.x - v.y) : (v.x + v.y);
  float f = fract(t / pitch) * pitch;
  float dist = min(f, pitch - f) * 0.70710678;
  return clamp((w * 0.5 - dist) / (2.0 * hp) + 0.5, 0.0, 1.0);
}
static float4 patternColor(uint pattern, float2 v, float hp) {
  switch (pattern) {
    case P_HATCH: return float4(INK, 0.09 * diagonal(v, 6.0, 1.0, false, hp));
    case P_HATCHLOW: return float4(INK, 0.07 * diagonal(v, 4.0, 1.0, false, hp));
    case P_STRIPES: return float4(INK, 0.30 * diagonal(v, 3.0, 1.0, true, hp));
    case P_SYN: return float4(SYN, 0.16 * diagonal(v, 8.0, 3.0, true, hp));
    case P_DOTS: {
      float2 c = fract(v / 6.0) * 6.0 - 3.0;
      return float4(INK, 0.26 * clamp((0.9 - length(c)) / (2.0 * hp) + 0.5, 0.0, 1.0));
    }
    default: return float4(0.0);
  }
}
/// Source-over of `top` on `base` (straight alpha in, straight alpha out).
static float4 over(float4 base, float4 top) {
  float a = top.a + base.a * (1.0 - top.a);
  if (a <= 0.0) return float4(0.0);
  return float4((top.rgb * top.a + base.rgb * base.a * (1.0 - top.a)) / a, a);
}
/// A dashed pattern along t (points): `on` points drawn, `off` points skipped.
static float dash(float t, float on, float off) { return fmod(max(t, 0.0), on + off) < on ? 1.0 : 0.0; }

fragment float4 shapeFragment(ShapeOut in [[stage_in]], constant SUniforms &u [[buffer(1)]]) {
  float hp = 0.5 / u.scale;
  float2 p = in.local, size = in.size;
  float w = size.x, h = size.y;
  float2 pv = float2(in.view.x - u.patternX, in.view.y);   // pattern space: content x at this zoom, view y
  bool contrast = (u.options & 1) != 0;
  float3 ink3 = contrast ? INK2 : INK3;
  float4 c = float4(0.0);
  switch (in.style) {
    case S_NONE: discard_fragment();
    case S_LANE0: case S_LANE1: {
      float cov = coverRect(p, float2(0.0), size, hp);
      c = float4(in.style == S_LANE0 ? BG0 : BG1, cov);
      float rule = coverRect(p, float2(0.0, h - 1.0), size, hp);
      c = over(c, float4(RULE, (contrast ? 0.9 : 0.55) * rule));
      break;
    }
    case S_HATCH: case S_HATCHLOW: case S_DOTS: case S_COV0: {
      float cov = coverRect(p, float2(0.0), size, hp);
      uint pat = in.style == S_HATCHLOW ? P_HATCHLOW : in.style == S_DOTS ? P_DOTS : P_HATCH;
      c = patternColor(pat, pv, hp);
      c.a *= cov;
      break;
    }
    case S_LOADING: c = float4(INK, 0.03 * coverRect(p, float2(0.0), size, hp)); break;
    case S_COV1: case S_COV2: case S_COV3: case S_COV4: {
      float alphas[5] = {0.0, 0.12, 0.24, 0.38, 0.56};
      c = float4(INK, alphas[in.style - S_COV0] * coverRect(p, float2(0.0), float2(max(w - 0.5, 0.5), h), hp));
      break;
    }
    case S_COVSPAN: {
      // the quad reaches 3 pt above and below the band for the end ticks
      float2 q = p;
      bool syn = (in.flags & F_SYNTHETIC) != 0;
      float hb = h;
      float body = coverRect(q, float2(0.0), float2(w, hb), hp);
      c = float4(INK, (syn ? 0.06 : 0.08) * body);
      if (syn) { float4 pc = patternColor(P_SYN, pv, hp); pc.a *= body; c = over(c, pc); }
      float rules = max(coverRect(q, float2(0.0), float2(w, 1.0), hp), coverRect(q, float2(0.0, hb - 1.0), float2(w, hb), hp));
      float ticks = max(coverRect(q, float2(0.0, -3.0), float2(1.0, hb + 3.0), hp), coverRect(q, float2(w - 1.0, -3.0), float2(w, hb + 3.0), hp));
      c = over(c, float4(INK, 0.32 * max(rules, ticks)));
      break;
    }
    case S_BAR: case S_BARSPARSE: case S_BARBACKDROP: {
      // local coordinates are the bar's own box; the quad reaches 1.5 pt beyond it for the glow
      float2 q = p;
      float bw = max(w - 0.75, 0.75);
      float r = min(min(2.0, bw * 0.5), h * 0.5);
      bool narrow = w < 6.0;   // narrow plain bars: no rounded corners, no glow (invisible at that width)
      float rl = (!narrow && (in.flags & F_ROUND_L)) ? r : 0.0, rr = (!narrow && (in.flags & F_ROUND_R)) ? r : 0.0;
      float d = sdRoundRect(q, float2(bw, h), rl, rr);
      float body = coverSDF(d, hp);
      if (in.style == S_BAR) {
        if (!narrow && h >= 4.0 && bw >= 2.0) {
          float g = coverSDF(sdRoundRect(q + 1.5, float2(bw + 3.0, h + 3.0), rl > 0 ? rl + 1.5 : 0.0, rr > 0 ? rr + 1.5 : 0.0), hp);
          c = float4(INK, 0.07 * g);
        }
        c = over(c, float4(INK, 0.88 * body));
        float inset = rl, topW = max(0.0, bw - rl - rr);
        float top = coverRect(q, float2(inset, 0.0), float2(inset + topW, 1.0), hp) * body;
        c = over(c, float4(1.0, 1.0, 1.0, 0.12 * top));
        if (h >= 6.0) c = over(c, float4(0.0, 0.0, 0.0, 0.14 * coverRect(q, float2(inset, h - 1.0), float2(inset + topW, h), hp) * body));
      } else if (in.style == S_BARSPARSE) {
        c = float4(INK, 0.25 * body);
        float inner = coverSDF(sdRoundRect(q - 1.0, float2(max(bw - 2.0, 0.0), max(h - 2.0, 0.0)), max(rl - 1.0, 0.0), max(rr - 1.0, 0.0)), hp);
        c = over(c, float4(INK, 0.88 * clamp(body - inner, 0.0, 1.0)));
      } else {
        c = float4(INK, 0.20 * body);
        c = over(c, float4(INK, 0.22 * coverRect(q, float2(rl, 0.0), float2(bw - rr, 1.0), hp) * body));
      }
      if (in.pattern != P_NONE) { float4 pc = patternColor(in.pattern, pv, hp); pc.a *= body; c = over(c, pc); }
      break;
    }
    case S_ABSENT: {
      // a 1 pt dotted baseline (1 on, 3 off) at the box's middle, from x0 + 1 to x1 − 1
      float mid = floor(h * 0.5) + 0.5;
      float line = cover1(p.y, mid - 0.5, mid + 0.5, hp) * cover1(p.x, 1.0, w - 1.0, hp);
      c = float4(ink3, line * dash(in.view.x - u.patternX, 1.0, 3.0));
      break;
    }
    case S_LOWTICK: {
      float outer = coverRect(p, float2(0.0), size, hp), inner = coverRect(p, float2(1.0), size - 1.0, hp);
      c = float4(INK2, clamp(outer - inner, 0.0, 1.0));
      break;
    }
    case S_CAPEND: c = float4(INK, coverRect(p, float2(0.0), float2(max(w, 2.0), h), hp)); break;
    case S_WASH: case S_WASHSYN: {
      float f = in.p0 > 0.0 ? min(w * in.p0, 40.0) : 0.0;
      float body = coverRect(p, float2(0.0), size, hp);
      float ramp = f > 0.5 ? clamp(min(p.x, w - p.x) / f, 0.0, 1.0) : 1.0;
      c = float4(INK, 0.18 * body * ramp);
      if (in.style == S_WASHSYN) { float4 pc = patternColor(P_SYN, pv, hp); pc.a *= body; c = over(c, pc); }
      c = over(c, float4(INK, 0.55 * coverRect(p, float2(f, 0.0), float2(max(f, w - f), 1.0), hp)));
      break;
    }
    case S_MARKTEXT: c = float4(INK, coverRect(p, float2(w * 0.5 - 0.5, 0.0), float2(w * 0.5 + 0.5, h), hp)); break;
    case S_MARKEST: {
      float outer = coverRect(p, float2(w * 0.5 - 1.0, 0.0), float2(w * 0.5 + 1.0, h), hp);
      float inner = coverRect(p, float2(w * 0.5 - 0.5, 1.0), float2(w * 0.5 + 0.5, h - 1.0), hp);
      c = float4(INK, clamp(outer - inner, 0.0, 1.0));
      break;
    }
    case S_MARKTITLE: {
      float2 q = abs(p - size * 0.5);
      float d = (q.x + q.y - w * 0.5) * 0.70710678;
      c = float4(INK, coverSDF(d, hp));
      break;
    }
    case S_BRSTATED: case S_BREST: case S_BRDERIVED: case S_BRPERIOD: {
      float mid = h * 0.5;
      float4 base = float4(0.0);
      if (in.style == S_BRPERIOD) { base = patternColor(P_HATCH, pv, hp); base.a *= coverRect(p, float2(0.0), size, hp); }
      float lv = cover1(p.x, 0.0, 1.0, hp) * cover1(p.y, 0.0, mid + 0.5, hp);
      float rv = cover1(p.x, w - 1.0, w, hp) * cover1(p.y, 0.0, mid + 0.5, hp);
      float hl = cover1(p.y, mid - 0.5, mid + 0.5, hp) * cover1(p.x, 0.0, w, hp);
      float line = max(max(lv, rv), hl);
      if (in.style == S_BREST) line *= dash(p.x + p.y, 3.0, 2.0);
      c = over(base, float4(INK, line));
      break;
    }
    case S_COARSE: c = float4(INK, 0.38 * coverRect(p, float2(0.0), size, hp)); break;
    case S_RULERMAJOR: case S_RULERMINOR: case S_SEAMTICK: {
      float lw = in.style == S_SEAMTICK ? 1.5 : 1.0;
      float3 col = in.style == S_RULERMAJOR ? ink3 : in.style == S_SEAMTICK ? INK2 : (contrast ? INK3 : RULE);
      c = float4(col, coverRect(p, float2(w * 0.5 - lw * 0.5, 0.0), float2(w * 0.5 + lw * 0.5, h), hp));
      break;
    }
    case S_SEAM: {
      float line = coverRect(p, float2(w * 0.5 - 0.5, 0.0), float2(w * 0.5 + 0.5, h), hp);
      c = float4(INK2, 0.85 * line * dash(in.view.y, 4.0, 3.0));
      break;
    }
    // ── the overlay (view coordinates) ──
    case O_PLAYHEAD: c = float4(CYAN, coverRect(p, float2(0.0), size, hp)); break;
    case O_PLAYHEAD_GLOW: c = float4(CYAN, 0.18 * coverRect(p, float2(0.0), size, hp)); break;
    case O_SELECTION: {
      // cyan 2 pt on the box's edge and a 6 pt halo at 20% (static, no pulse); the hover ring of the web is not drawn
      float d = sdRoundRect(p, size, 0.0, 0.0);
      float ring = coverSDF(abs(d) - 1.0, hp);
      float halo = coverSDF(abs(d) - 3.0, hp);
      c = over(float4(CYAN, 0.20 * halo), float4(CYAN, ring));
      break;
    }
    case O_VEIL: c = float4(BG0, in.p0 * coverRect(p, float2(0.0), size, hp)); break;
    case O_BRUSH: {
      float body = coverRect(p, float2(0.0), size, hp);
      float edges = max(coverRect(p, float2(0.0), float2(1.0, h), hp), coverRect(p, float2(w - 1.0, 0.0), size, hp));
      c = over(float4(CYAN, 0.10 * body), float4(CYAN, edges));
      break;
    }
    case O_FOCUS: {
      float outer = coverRect(p, float2(0.0), size, hp), inner = coverRect(p, float2(2.0), size - 2.0, hp);
      c = float4(CYAN, clamp(outer - inner, 0.0, 1.0));
      break;
    }
    default: discard_fragment();
  }
  float a = c.a * in.alpha;
  if (a <= 0.0) discard_fragment();
  return float4(c.rgb * a, a);
}

// ── glyphs and labels from the atlas ──
struct GlyphOut {
  float4 position [[position]];
  float2 uv;
  float2 uvLo [[flat]];
  float2 uvHi [[flat]];
  float alpha;
  uint style [[flat]];
};

vertex GlyphOut glyphVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                            constant GInstance *inst [[buffer(0)]], constant SUniforms &u [[buffer(1)]]) {
  GInstance g = inst[iid];
  uint style = g.styleFlags & 0xFFFF, flags = g.styleFlags >> 16;
  float ax = (g.d - u.centreRel) * u.ppd + u.viewW * 0.5;
  float ay = g.y + u.originY;
  float x0 = ax + g.ox, y0 = ay + g.oy;
  if (style == S_SEAMLABEL) {
    // right of its line where it fits, else left of it (seams.seamCaptionPlace over the visible view)
    bool right = ax + 4.0 + g.w <= u.viewW - 4.0 || ax - 4.0 - g.w < 4.0;
    x0 = right ? ax + 4.0 : ax - 4.0 - g.w;
  }
  float a = vantageAlpha(g.reveal, u) * u.dim;
  if (flags & F_GHOST) a *= u.ghost;
  // a ruler label gives way where the seam caption is painted (its tick stays)
  if (style == S_RULERLABEL && u.captionLo <= u.captionHi && x0 < u.captionHi + 4.0 && x0 + g.w > u.captionLo - 4.0) a = 0.0;
  float2 corner = float2((vid & 1) ? 1.0 : 0.0, (vid & 2) ? 1.0 : 0.0);
  float2 p = float2(x0, y0) + corner * float2(g.w, g.h);
  GlyphOut o;
  o.position = a <= 0.003 ? float4(2.0, 2.0, 2.0, 1.0) : float4(p.x / u.viewW * 2.0 - 1.0, 1.0 - p.y / u.viewH * 2.0, 0.0, 1.0);
  o.uv = mix(float2(g.u0, g.v0), float2(g.u1, g.v1), corner);
  o.uvLo = float2(g.u0, g.v0);
  o.uvHi = float2(g.u1, g.v1);
  o.alpha = a;
  o.style = style;
  return o;
}

fragment float4 glyphFragment(GlyphOut in [[stage_in]], texture2d<float> atlas [[texture(0)]], constant SUniforms &u [[buffer(1)]]) {
  constexpr sampler s(filter::linear, address::clamp_to_edge);
  float cov = atlas.sample(s, in.uv).r;
  bool contrast = (u.options & 1) != 0;
  float3 col = INK2;
  float alpha = 1.0;
  bool halo = false;
  switch (in.style) {
    case S_RULERLABEL: col = INK; alpha = 0.78; break;
    case S_LOWN: col = contrast ? INK2 : INK3; break;
    case S_CAPSTART: case S_CAPCHEVRON: col = INK; halo = true; break;
    case S_SPANLABEL: halo = true; break;
    default: break;
  }
  float4 c = float4(col, cov * alpha);
  if (halo) {
    // a 1.5 pt halo of the ground colour behind the glyph (the canvas strokes 3 pt of bg-0 under the fill)
    float2 texel = float2(1.0 / u.atlasW, 1.0 / u.atlasH) * 4.5;
    float h = 0.0;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.78539816;
      h = max(h, atlas.sample(s, clamp(in.uv + float2(cos(ang), sin(ang)) * texel, in.uvLo, in.uvHi)).r);
    }
    c = over(float4(BG0, h), c);
  }
  float a = c.a * in.alpha;
  if (a <= 0.0) discard_fragment();
  return float4(c.rgb * a, a);
}
