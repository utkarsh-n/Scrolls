// OWNER: N8
// Settings' and How Scrolls works' own words (IOS-SPEC §4.21, §4.22 LabInfoSheet order 01–09). British English; no
// mental-state verbs; the honesty rules in plain words.

nonisolated enum SettingsCopy {
  static let title = "Settings"
  static let done = "Done"
  static let motion = "Motion"
  static let motionSystem = "Follow the system"
  static let motionOn = "Reduce motion"
  static let motionOff = "Full motion"
  static let motionNote = "Reduce motion: Play steps every 1.2 s, Step ▸ becomes the primary control, nothing fades or glides."
  static let seam = "Modality seam"
  static let seamLine = "Line"
  static let seamTick = "Tick"
  static let seamNote = "Where full text ends (1928) and titles continue. It can shrink to a tick on the ruler; it is never hidden."
  static let slot = "Strand height"
  static let slotCompact = "Compact"
  static let slotDefault = "Default"
  static let slotComfortable = "Comfortable"
  static let slotNote = "Heights are linear in each lane's unit; every observed bin stays at least 1 pt."
  static let tour = "Tour"
  static let showCoachMarks = "Show the first-minute coach marks again"
  static let haptics = "Haptics"
  static let hapticsNote = "Taps answer what you do: a tier change, a bin stepped, a selection. Nothing scales with a count, a rate or a score."
  static let strength = "Strength"
  static let feelDetent = "Feel a detent"
  static let soundNote = "Scrolls makes no sound."
}

nonisolated enum HowItWorksCopy {
  static let title = "How Scrolls works"
  static let p01 = "What you\u{2019}re looking at"
  static let p02 = "Touch"
  static let p03 = "What you\u{2019}re seeing"
  static let p04 = "Controls"
  static let p05 = "Presets"
  static let p06 = "What\u{2019}s documented, computed and proposed"
  static let p07 = "On this phone"
  static let p08 = "Sound & feel"
  static let p09 = "Sources & licences"

  static let lookingAt = "A living atlas of meaning: each lane is a community, a language or a medium, and time runs left to right on one linear axis. A bar spans where an expression was observed in this corpus; its height is a rate in the lane\u{2019}s own unit, with its denominator one tap away. The vantage — the cyan playhead, \u{201C}as of 1925” — is the reading clock: strict hides what was dated later, context shows it faintly."
  static let firstObserved = "A first observation is the first observation in this corpus: not a date of coinage, and not evidence of borrowing."

  static let touch: [(icon: String, title: String, text: String)] = [
    ("hand.draw", "Pan", "Drag sideways to move through time; drag up and down to scroll the lanes."),
    ("arrow.left.and.right", "Pinch", "Zoom time only; the bins change tier (decades, years, months) and say so."),
    ("hand.tap", "Tap", "A bar, gap, wash, cap, arc or seam answers with its sentence; a mark opens its passage."),
    ("hand.point.up.left", "Long press", "A mark: preview, annotate, lineage, compare from this bin. The ruler: brush a range."),
    ("line.diagonal", "Playhead", "Drag the cyan handle to scrub the vantage one bin at a time."),
  ]
  static let controls: [(icon: String, title: String, text: String)] = [
    ("play.fill", "Play and Step", "Play moves the vantage a bin at a time (400 ms, 1.2 s with Reduce Motion), strict while playing; long-press ▶ for the speed."),
    ("eye", "Strict and context", "Strict hides evidence dated after the vantage; context shows it at 15%."),
    ("magnifyingglass", "Search", "Expressions, works, makers, themes, etymology and annotations; romanised Hindi and Gujarati find their native forms as suggestions, never merged."),
    ("rectangle.split.1x2", "Lanes and Filters", "Lanes by facet, with the order rule printed; default exclusions visible and switchable."),
    ("ellipsis.circle", "More", "Saved views, links, import, sources and storage, the Tour, this sheet, Settings, Jobs, Diagnostics."),
  ]
  static let presets: [(icon: String, title: String, text: String)] = [
    ("person.3", "Community (demo)", "The synthetic demo\u{2019}s communities: classroom, office and lab, hip-hop, criticism, software."),
    ("square.grid.2x2", "Domains", "Literature, STEMM, culture and the other domains of the loaded corpora."),
    ("character.book.closed", "Languages", "English, French, Spanish, Hindi and Gujarati, detected per passage."),
    ("point.topleft.down.to.point.bottomright.curvepath", "Term trail (all real corpora)", "One word across every real corpus on fixed lanes, each in its own unit; co-presence in two lanes is never drawn as a link."),
  ]
  static let evidence: [(icon: String, title: String, text: String)] = [
    ("line.diagonal", "Documented (DOC)", "An external record states the link: solid line, filled dot, source and locator shown."),
    ("line.3.horizontal", "Computed (CALC)", "An algorithmic estimate with its run, method and score: dashed line, hollow square."),
    ("questionmark", "Proposed (PROP)", "A hypothesis, with who proposed it: dotted line, ?. Attribution cues are proposed + CUE."),
    ("checkmark.seal", "Reviews", "Confirm, reject and dispute are overlays (✓ ✕ ⚖); the evidence status never changes."),
    ("square.dashed", "Synthetic (SYN)", "The demo corpus is invented — people, texts, dates and links — and says so wherever it appears."),
    ("hand.raised", "Refusals", "A measure that the evidence cannot support shows a gate card — what it needs, what it has, a suggestion — never a numeral."),
  ]
  static let onPhone = "The whole engine runs on this phone: import, search, counting, Compare and lineage. Cipher\u{2019}s titles, relations and etymology load first; its full text follows. The atlas lives outside your backups; your notebook is backed up and replayed into every new atlas."
  static let onPhoneEngine = "Engine"
  static let onPhoneData = "Data version"
  static let onPhoneJobs = "Jobs"
  static let hapticMap = "What each tap means"
  static let sources: [(title: String, text: String)] = [
    ("Project Gutenberg", "public domain in the United States; licence boilerplate removed before counting"),
    ("Wikisource (Hindi, Gujarati)", "CC BY-SA"),
    ("Wikidata (culture works)", "CC0; years marked unverified where the list is unchecked"),
    ("Wiktionary", "CC BY-SA: an external claim, never a first observation"),
    ("ItwoFS", "CC BY 2.5, with a link back per row"),
    ("Google Books Ngram", "CC BY 3.0: an external baseline on its own track"),
    ("OpenAlex", "CC0 metadata; abstracts are publishers\u{2019}, read locally and never exported"),
    ("Cipher", "your own corpus and lists, on this phone"),
    ("The demo world", "synthetic, CC0: invented people, texts, dates and links"),
  ]
  static let localOnly = "Scrolls makes no network request. Two surfaces are opt-in and labelled: Apple\u{2019}s language assets (offered on the Tone gate card) and a source link, which opens in Safari."
}
