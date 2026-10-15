// OWNER: N7
// Types shared by Scroll.metal and the Swift renderer (IOS-SPEC §4.23, §8.4.7). Every field is a 4-byte scalar, so the
// Swift mirrors in ScrollUniforms.swift have the same layout without padding rules (ScrollsRenderTests check the
// strides: SInstance 40, GInstance 48, SUniforms 72 bytes).
#ifndef SCROLL_SHADER_TYPES_H
#define SCROLL_SHADER_TYPES_H

#ifdef __METAL_VERSION__
#include <metal_stdlib>
typedef uint uint32_t;
typedef int int32_t;
#else
#include <stdint.h>
#endif

/// How the vertex shader places an instance.
enum SKind {
  /// x from d0…d1 (days relative to the list origin), y from y0…y1 (content points).
  SKindSpan = 0,
  /// x centred on d0 with half-width p0 (points, constant under zoom), y from y0…y1.
  SKindCentre = 1,
  /// a diamond centred on (d0, y0) with half-diagonal p0 points.
  SKindDiamond = 2,
  /// view points directly (the overlay: playhead, selection, brush).
  SKindView = 3,
};

/// One shape instance (bands, washes, bars, ticks, diamonds, overlay). 40 bytes.
typedef struct {
  float d0, d1;          // days relative to the list origin (x), or view points for SKindView
  float y0, y1;          // content points (view points for SKindView)
  float p0, p1;          // per-style parameters: feather (washes), half-width (ticks), half-diagonal (diamonds)
  uint32_t styleFlags;   // style | flags << 16
  uint32_t patternKind;  // pattern | kind << 16
  int32_t reveal;        // the vantage predicate's day (INT32_MIN: always shown)
  uint32_t id;
} SInstance;

/// One glyph or label quad from the label atlas. 48 bytes.
typedef struct {
  float d, y;            // anchor: days relative to the origin, baseline in content points
  float w, h;            // quad size in points
  float ox, oy;          // the quad's top-left relative to the anchor, in points
  float u0, v0, u1, v1;  // atlas texture coordinates
  uint32_t styleFlags;   // style | flags << 16
  int32_t reveal;
} GInstance;

/// Per-list, per-frame uniforms. 72 bytes.
typedef struct {
  float viewW, viewH;    // the drawable in points
  float centreRel;       // the view centre's day − the list's origin day
  float ppd;             // points per day now
  float originY;         // view y of content y = 0
  float scale;           // pixels per point
  int32_t vantageDay;
  uint32_t vantageMode;  // 0 none · 1 strict · 2 context
  int32_t fadeFrom;      // primitives revealed in (fadeFrom, vantageDay] are multiplied by `fade`
  float fade;
  float dim;             // 1, or 0.4 while an older tier stands in for one still loading
  float ghost;           // 0.15
  uint32_t options;      // bit 0 Increase Contrast · bit 1 Differentiate Without Colour
  float captionLo, captionHi;  // the seam caption's box in view x (ruler labels under it give way); lo > hi = none
  float patternX;        // view x of content x = 0 at the current zoom (patterns move with the content, never stretch)
  float atlasW, atlasH;  // the label atlas size in pixels
} SUniforms;

#endif
