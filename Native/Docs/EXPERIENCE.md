<!-- OWNER: N8 — first-minute timings as measured, copy decisions, the haptic map as built -->
# Experience

What package N8 built for the iPhone experience (IOS-SPEC §4.1–§4.9, §4.15, §4.17–§4.22), how it plugs into the shell,
what was measured, and every place the phone's words differ from the reference's.

## How the experience plugs into the shell (no N0 file edited)

| Slot (N0) | N8 member | What it shows |
|---|---|---|
| `ScrollScreenSlots.topChrome()` | `TopChrome` (`Shell/TopBar.swift`) | the corpus chip (a menu; Cipher disabled with its reason until phase A), up to four strand chips morphing with `glassEffectID` in one `GlassEffectContainer`, N0's status chip (→ Jobs tray), More; the SYNTHETIC ribbon under it whenever demo material is in scope |
| `ScrollScreenSlots.inspector()` | `InspectorContent` | the peek row (search field + transport: ▶ · Step ▸ · "as of 1925" · strict/context eye), the Scroll's tap sentence, then the `SheetMode` content |
| `ScrollScreenSlots.landscapeInspector()` | `LandscapeShell` | the 360 pt column (any mode but idle) or the trailing-bottom transport capsule |
| `RootSlots.scene(_:)` | `ExperienceHost` (`Shell/StateRestoration.swift`) | state restoration, deep links (`onOpenURL`), the coach-mark overlay, the follow-the-bus observers, the first minute's launch |
| `RootSlots.{lanes,filters,legend,howItWorks,settings,jobsTray,yearPicker}()` | the sheets of `Lanes/`, `Legend/`, `Settings/`, `Jobs/`, `Inspector/YearPicker.swift` | one system presentation at a time, through the coordinator |

The experience's state is one `@MainActor @Observable ExperienceModel` per `AppModel` (`model.experience`), holding the
`SheetMode` machine (idle · search · inspector · drawer · shelf · yourTurn), `SearchModel`, `ThenModel`, `ListModel` (bin
drawer and shelves), `TourModel`, `TransportModel`, the haptic map and `ScrollBridge`. It follows the frozen bus,
`AppModel.viewState`: a selection made anywhere (the Scroll, search, a KWIC row, a link, a restore) opens Then; a `bin`
selection opens its drawer; clearing it returns the sheet to idle.

`ScrollBridge` is the seam to N7's Scroll for what the view state cannot carry: the Scroll's transport (once it registers
one; until then the transport row steps the vantage itself and never claims a gap it cannot see), the tap sentence for
the peek row, the registered query key, the coach marks' anchor rectangles and static outlines, and resolved strand
labels. Every member is optional and every reader has a stated fallback, so N8 runs before N7 lands.

## The first minute (§4.17)

| t (after the Scroll is ready) | On screen | Implementation |
|---|---|---|
| 0 | the demo, step 1's strand of `tour()` pinned (never an id written in N8) | `TourModel.launched` → `seedStrands` |
| 2 s | coach ① ("Bars span where ‘carry the zero’ was **observed**. Gaps are real: …") | `CoachTiming.first` |
| 12 s | coach ② naming the documented and the computed arc **from `arcs` on the query on screen** | `CoachTiming.second`, `CoachWords.text(.second, …)` |
| 40 s (25 s + 15 s once a passage was opened during ②) | coach ③ "Press ▶ to watch the phrase acquire history." over the peek row | `CoachTiming.third`, `thirdAfterOpen` |
| 58 s, or 1.5 s after a Play started from ③ ends | **Your turn.** in the inspector: the search field focused, the start chips that a search of Cipher confirms (virus · zero · sample), **Switch to Cipher (real data)** (enabled once phase A is done, otherwise the live percentage), Full tour (4 min) | `CoachTiming.final`, `afterPlay`, `YourTurnView` |

Coach cards never block (only the card takes touches), never cover the inspector (placed above the sheet; hidden while a
pushed screen or a sheet is up), never pulse, and once shown they never return unless he asks for the Tour (More → Tour,
Settings → 05). `-tour`, `-tourStep n` and `-ui-testing` behave as §4.17 says; a `-selftest first-minute` run ignores the
stored dismissal.

### Measured

Simulator numbers are proxies on contract fixtures, never device numbers; the device rows are queued
(`Reports/device-queue.json`, suite `first-minute`, wp N8).

(The table below is filled from `Reports/app-first-minute-*.json` and `Reports/selftest-sim-first-minute-N8-*.json`.)

## Copy decisions (where the phone's words differ from the reference's)

| Reference | Phone | Why |
|---|---|---|
| coach ②: "Click any mark to read its source." | "Tap any mark to read its source." | touch (§4.1 rule 5) |
| coach ①: `'carry the zero'` (straight quotes) | `‘carry the zero’` | typographic quotes in the app's own copy; the label itself comes from the data |
| Your turn without an engine: "Waiting for the local server." | "Waiting for the engine." | there is no server on the phone (ΔS-1) |
| tour steps 3, 5, 7, 9 name keys (`E` twice, `L`, a brush with A/B, `G`/`N`/`S`) | "taps the Evidence chip twice", "Taps the Lanes chip", "Brushes 1955–1985 and 1994–2026 on the ruler, then Compare", "Long-presses the mark: Lineage, then Annotate; then More → Save view" | §4.17's phone versions of the steps (`TourCopy.phoneAction`) |
| coach ③ at 26 s, the card at 46 s (`COACH_DELAYS` 2/10/14/20 s) | ③ at ≈ 40 s, Your turn at ≈ 58 s | IOS-SPEC §4.17's table (~40 s, 55–60 s) |
| search suggestion counts are bare numbers ("340") | "340 matches · Demo", "47 documents", "4 documents", "2 annotations" | §4.1 rule 6 and §4.9 "count, unit and corpus" |
| shelf columns `UNDATED` / `SCHEDULED` beside the Scroll | `⊘ 172 undated` / `⇥ 1 scheduled` per lane in the Lanes sheet (and N7's header chips) → the list opens in the inspector, titled "UNDATED · <lane>" | narrow screen (§4.3, §4.8) |
| "Machine annotations" | "Machine annotations (fallible)" | §4.8 |
| the empty-search note, the drawer's denominator line, the date chip, the badge words | verbatim from the engine / `Copy` | ported byte-equal; never re-worded on the phone |

Every app string lives in a `*Copy` enum (`ThenCopy`, `SearchCopy`, `TourCopy`, `SettingsCopy`, `HowItWorksCopy`,
`LegendCopy`, `LanesCopy`, `FiltersCopy`, `JobsTrayCopy`, `TopBarCopy`, `StrandCopy`, `MoreCopy`, `TransportCopy`,
`YearPickerCopy`, `DeepLinkCopy`, `StartCopy`), linted by N0's `LintTests` for British spelling and for the mental-state
verbs and forbidden phrases of SPEC §13 rule 11.

## The haptic map as built (§4.21; `Shell/HapticsMap.swift`)

| Act (`ScrollsHaptic`) | Tap (LabKit `HapticTap`) | Played by | Why |
|---|---|---|---|
| `tierChange` | `.detent` | N7 (pinch across a tier) | zoom has detents, like a knob |
| `vantageStep` | `.tick` (LabKit's 45 ms gap: ≤ 22 a second) | the transport row's stepper, the year picker; N7's scrub and Play | time advancing |
| `noCoverage` | `.soft` | N7 (Play or scrub entering an uncovered stretch) | an honest "nothing here" |
| `boundary` | `.boundary` | N7 (seam, domain edge, folded overview) | a change of medium or regime, not of meaning |
| `halo` | `.ripple` | N7 (a feedback halo appears) | an event, never a magnitude |
| `select` | `.select` | `ExperienceModel.selectionChanged` | a mark or edge is selected |
| `success` | `HapticEngine.success()` | saves, reviews, pack loads (N6, N2) | — |
| `gateShown` | none | — | a refusal is information, not an error buzz |

No case carries a value, so no haptic can encode a data magnitude. The engine stops while the app is not active (N0's
`Lifecycle`). The strength slider, the on/off switch and the map itself are in How Scrolls works → 08 and Settings → 04;
there is no sound and no sound control.
