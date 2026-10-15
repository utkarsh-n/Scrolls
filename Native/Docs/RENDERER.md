<!-- OWNER: N7 — the pipeline, shaders, budgets as measured, the G8 results -->
# Renderer

The Scroll as built by N7 (IOS-SPEC §4.5–§4.7, §4.19, §4.23). Everything the screen, the snapshot, VoiceOver, the table
alternative and G5 read is ONE display build per viewport.

## Pipeline

```
AtlasService.timelineQuery / tiles / marks / corpora            (N3's LiveAtlas, or MockAtlas's fixtures, labelled)
  └─ ScrollModel (app, main actor)        the axis, the tile LRU, the marks window, what rebuilds what
       └─ ScrollBuildJob.run              off the main actor (Task.detached): ScrollModelBuilder.build → LaneLayouts.phone
            │                             → DisplayBuilder.buildSync; over budget → one tier coarser, "Simplified: …"
            └─ DisplayBuild               top list (ruler, coverage track, seam tick + caption) + lanes list, PrimMeta,
                                          LaneSeries, HitGrids; built ONCE, without a vantage (revealDay = hiDay)
                 ├─ ScrollRenderer.install → Metal instance buffers (bg / data layers in emission order) + LabelAtlas quads
                 ├─ DisplayListCanvas / ScrollPainter → the Canvas fallback (-renderer canvas), ScrollSnapshot (PNG), G8
                 ├─ ScrollAccessibility / ScrollTableView / TapSentences (the same LaneSeries and tooltips)
                 └─ HitGrid.hits(_:tolerance:vantage:) (24 pt cells, content coordinates at the build zoom)
```

**What rebuilds what** (§4.23): pan, pinch within a tier, lane scroll, scrub, Play, strict/context and selection change
`ScrollFrame` only (uniforms). A tier crossing, a pan beyond the ±1-viewport built range, or a zoom more than ×1.6 from
the build's (and any zoom difference once the gesture ends, so ruler labels and fit tests match the final zoom) asks for
tiles and rebuilds off the main actor; the old tier stays drawn at 40% (`dim`) until the new tier's visible tiles arrive.
A new query key (strands, corpus, lanes, filters) re-queries, polling while the engine counts.

## Frames

`MTKView.isPaused = true`, `enableSetNeedsDisplay = true`: any change draws exactly one frame (`setNeedsDisplay`). A
`CADisplayLink` (80–120 Hz; 60 under Low Power or thermal `.serious`, LabKit `FramePacing`) runs only during a gesture,
momentum, Play, a fade (150 ms mark fade, the 200 ms first-paint fade of the whole data plane, none under Reduce Motion)
or an axis animation (double tap 250 ms, auto-pan 120 ms, rubber band), and stops itself when nothing moves. The idle row
of `-selftest perf` counts the frames drawn in 2 s at rest.

## One pass, seven draws

Per list (lanes, then top): one instanced draw of the bg layer, one of the data layer, one of the labels; then the overlay
(veil after the playhead, the playhead and its glow, the brush, the selection ring, the focus ring). Shapes share one
pipeline (`shapeVertex`/`shapeFragment`): box-filter edge coverage, a rounded-rect SDF for bars (2 pt corners on the run's
ends, a 1.5 pt glow, a top light and a bottom shade), and patterns in SCREEN space (hatch 6 pt, low hatch 4 pt, pending
dots 6 pt, estimated stripes 3 pt, synthetic stripes 8 pt) whose phase follows the content x at the current zoom, so a
hatch never stretches under pinch. Labels and caps come from the `LabelAtlas`: whole shaped `CTLine` runs (system font
with the Kohinoor Devanagari → Gujarati cascade) at 3× in one R8 2048² texture; caps get a 1.5 pt ground halo.

**The vantage is a uniform.** The shader's `vantageAlpha` is `visibility(revealDay:at:)`: strict hides what the vantage
has not reached, context draws it at 15%, archive primitives (`alwaysRevealed`: absence, coverage, "no sources", the
seam, lane bands) always show, and what Play just revealed fades in. The hit grid and VoiceOver apply the same predicate.

**Instance layouts** (`ScrollShaderTypes.h` = `ScrollUniforms.swift`): `SInstance` 40 bytes, `GInstance` 48, `SUniforms`
72 (tested). Days are stored relative to the build's integer origin (Float keeps sub-day accuracy at 40 pt/day).

## Gestures (ScrollGestureHost)

Direction-locked pan (|dx| > 1.2·|dy| → time, else the lanes scroll), momentum at `DecelerationRate.normal` stopping below
5 pt/s, a 0.55 rubber band beyond 10000 BCE – 2100 CE with `.boundary`; x-only pinch around the centroid's day with the
centroid's travel panning; tap (a second tap within 180 ms = one tier in), two-finger tap (one tier out); long press on a
mark = `UIContextMenuInteraction` (passage preview; Open · Annotate · Lineage · Compare from this bin · Copy citation);
long press on the ruler then drag = the brush (A / B slices, Compare). The playhead handle (SwiftUI, above the canvas)
wins over pan: drag to scrub by bin with a loupe; `.tick` per bin, `.soft` entering a stretch no lane covers,
`.boundary` at the seam. No haptic carries a magnitude.

## Budgets (§4.23) — device rows

The budget rows are steps of `-selftest perf` (`Diagnostics/Steps/N7Steps.swift`) and are PENDING_DEVICE until the
integrator's M1 device session (`Reports/device-queue.json`). Simulator and Mac numbers below are proxies only.

| Item | Budget | Mac / simulator proxy | Device |
|---|---|---|---|
| main-thread time per gesture frame | ≤ 1.0 ms p95 | see status/N7.md | PENDING_DEVICE |
| GPU time per frame at maximum load | ≤ 3.0 ms p95 | — | PENDING_DEVICE |
| DisplayBuilder, 20k cells, off main | ≤ 12 ms p95 | ScrollModelUnitTests "builder budget" (Mac proxy) | PENDING_DEVICE |
| tier change → first paint | warm ≤ 33 ms · cold ≤ 150 ms | — | PENDING_DEVICE |
| tap → selection drawn | ≤ 16 ms | — | PENDING_DEVICE |
| cold launch → first frame with demo data | ≤ 1.0 s | — | PENDING_DEVICE |
| idle | 0 frames | — | PENDING_DEVICE |
| renderer memory | ≤ 24 MB | label atlas 4 MB + instance buffers | PENDING_DEVICE |
| labels per frame | ≤ 150 | the builder's text budget is 150 | PENDING_DEVICE |

## G8

Metal (`OffscreenRenderer`) against the Canvas painter (`CanvasRaster`) on the demo's real display lists (the reference
server's payloads of g5.inputs, built through the phone's own model, layout and builder) at 6 tiers × 3 vantages ×
{strict, context} × {default, Increase Contrast}, plus no vantage, for two queries (carry the zero; two strands): the share of
pixels that differ by more than 8/255 in any channel, outside the text masks, must be ≤ 1%. Pattern phase is probed on a
hatch band and an absent line at two pans; the label atlas is compared with a Core Text raster for Devanagari and
Gujarati runs. Results: `Reports/g8-render.json` (written by `Tools/check.sh display`).
