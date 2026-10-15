// OWNER: N8
// The reader (IOS-SPEC §4.8 "Open in reader", §4.20; port of `panels/reader.mjs`): the document's original text in the
// passage face, in a TextKit 2 `UITextView` (`usingTextLayoutManager`), which lays out by viewport, so whole books stay
// cheap. The text arrives in slices of `documentText` (≤ 20k UTF-16 units each; a slice asks for one unit before it so a
// surrogate pair cut by a boundary is shown whole, in exactly one slice). It opens on the passage, scrolled to its
// offset, with the passage's matches highlighted at their offsets; Earlier and Later extend the window by a slice.

import ScrollsContracts
import ScrollsService
import SwiftUI
import UIKit

nonisolated enum ReaderSlices {
  /// Units per slice (`READER_CHUNK`; a request asks for one more: the overlap unit).
  static let size = 16_000

  static func index(of offset: Int) -> Int { max(0, offset) / size }

  /// The request for slice i: one unit of overlap before it, clipped to the document when its length is known.
  static func request(_ i: Int, length: Int?) -> (from: Int, to: Int) {
    let from = max(0, i * size - 1)
    let to = (i + 1) * size
    return (from, length.map { min($0, to) } ?? to)
  }

  /// What slice i shows of a fetched text (`chunkDisplay`): its nominal range moved back one unit at an end that would
  /// split a surrogate pair, so consecutive slices tile the document exactly.
  static func display(_ i: Int, text: String, from reqFrom: Int, length: Int) -> (start: Int, end: Int, text: String) {
    let units = Array(text.utf16)
    func unit(_ off: Int) -> UInt16? {
      let k = off - reqFrom
      return units.indices.contains(k) ? units[k] : nil
    }
    func isHigh(_ c: UInt16?) -> Bool { c.map { (0xD800...0xDBFF).contains($0) } ?? false }
    var start = min(length, i * size)
    var end = min(length, (i + 1) * size)
    if start > 0, isHigh(unit(start - 1)) { start -= 1 }
    if end < length, end > 0, isHigh(unit(end - 1)) { end -= 1 }
    let a = max(0, start - reqFrom), b = max(a, min(units.count, end - reqFrom))
    return (start, end, String(utf16CodeUnits: Array(units[a..<b]), count: b - a))
  }
}

/// What the reader opens on.
nonisolated struct ReaderTarget: Equatable, Sendable {
  var document: DocumentID
  /// The passage's offsets in the original, and its matches relative to the passage.
  var passageStart: Int
  var passageEnd: Int
  var highlights: [Highlight]
  var lang: String?
  var title: String
  var synthetic: Bool
}

@MainActor @Observable
final class ReaderModel {
  let target: ReaderTarget
  private(set) var length: Int?
  /// Loaded slices by index, contiguous.
  private(set) var slices: [Int: String] = [:]
  private(set) var error: ErrorCardModel?
  private(set) var loading = false
  /// Bumped on every text change; the text view rebuilds its storage.
  private(set) var version = 0

  init(target: ReaderTarget) {
    self.target = target
  }

  var loadedRange: ClosedRange<Int>? {
    guard let lo = slices.keys.min(), let hi = slices.keys.max() else { return nil }
    return lo...hi
  }

  /// The first unit of the loaded window in the original.
  var windowStart: Int { (loadedRange?.lowerBound ?? 0) * ReaderSlices.size }

  var text: String { (loadedRange.map { Array($0) } ?? []).compactMap { slices[$0] }.joined() }

  var canLoadEarlier: Bool { (loadedRange?.lowerBound ?? 0) > 0 }
  var canLoadLater: Bool {
    guard let r = loadedRange, let length else { return false }
    return (r.upperBound + 1) * ReaderSlices.size < length
  }

  /// The passage's slice and one on each side.
  func start(_ atlas: any AtlasService) async {
    let i = ReaderSlices.index(of: target.passageStart)
    await load(i, atlas)
    if i > 0 { await load(i - 1, atlas) }
    await load(i + 1, atlas)
  }

  func earlier(_ atlas: any AtlasService) async {
    guard let lo = loadedRange?.lowerBound, lo > 0 else { return }
    await load(lo - 1, atlas)
  }

  func later(_ atlas: any AtlasService) async {
    guard let hi = loadedRange?.upperBound, canLoadLater else { return }
    await load(hi + 1, atlas)
  }

  private func load(_ i: Int, _ atlas: any AtlasService) async {
    guard slices[i] == nil, i >= 0 else { return }
    if let length, i * ReaderSlices.size >= length { return }
    loading = true
    defer { loading = false }
    let req = ReaderSlices.request(i, length: length)
    do {
      let r = try await atlas.documentText(target.document, from: req.from, to: req.to)
      length = r.length
      slices[i] = ReaderSlices.display(i, text: r.text, from: r.from, length: r.length).text
      version += 1
    } catch {
      self.error = ErrorCardModel(any: error)
    }
  }
}

/// The reader inside the inspector (large detent): a header, Earlier/Later, and the TextKit 2 text.
struct ReaderView: View {
  let model: AppModel
  @State var reader: ReaderModel
  let onClose: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(reader.target.title).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
            if reader.target.synthetic { EvidenceBadge("SYN") }
          }
          if let length = reader.length, let r = reader.loadedRange {
            Text(ThenCopy.readerRange(r.lowerBound * ReaderSlices.size, min(length, (r.upperBound + 1) * ReaderSlices.size), length))
              .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          }
        }
        Spacer()
        Button(ThenCopy.done, action: onClose).font(Typography.chrome).foregroundStyle(Tokens.cyan.color)
          .frame(minWidth: Tokens.Geometry.minHit, minHeight: Tokens.Geometry.minHit)
          .accessibilityIdentifier("readerDone")
      }
      HStack {
        Button(ThenCopy.earlier) { Task { if let a = model.atlas { await reader.earlier(a) } } }
          .disabled(!reader.canLoadEarlier || reader.loading)
        Spacer()
        if reader.loading { CountingLabel(ThenCopy.loading, fraction: nil) }
        Spacer()
        Button(ThenCopy.later) { Task { if let a = model.atlas { await reader.later(a) } } }
          .disabled(!reader.canLoadLater || reader.loading)
      }
      .font(Typography.chrome)
      .frame(minHeight: Tokens.Geometry.minHit)
      if let error = reader.error {
        ErrorCard(error) { Task { if let a = model.atlas { await reader.start(a) } } }
      }
      ReaderTextView(reader: reader)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.bg0.color, in: RoundedRectangle(cornerRadius: Tokens.Radius.card))
        .syntheticFrame(reader.target.synthetic)
    }
    .padding(.horizontal, Tokens.Geometry.gutter)
    .task { if let a = model.atlas { await reader.start(a) } }
  }
}

/// The TextKit 2 text view: non-editable, selectable, scrolled to the passage once its slice is in.
struct ReaderTextView: UIViewRepresentable {
  let reader: ReaderModel
  @Environment(\.dynamicTypeSize) private var typeSize

  final class Coordinator {
    var version = -1
    var scrolled = false
    var windowStart = 0
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView(usingTextLayoutManager: true)
    view.isEditable = false
    view.isSelectable = true
    view.backgroundColor = .clear
    view.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 24, right: 10)
    view.adjustsFontForContentSizeCategory = true
    view.accessibilityIdentifier = "readerText"
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    let c = context.coordinator
    guard c.version != reader.version else { return }
    let previousStart = c.windowStart
    let previousOffset = view.contentOffset
    let previousHeight = view.contentSize.height
    c.version = reader.version
    c.windowStart = reader.windowStart
    let text = reader.text
    let attributed = NSMutableAttributedString(string: text, attributes: PassageStyle.attributes(lang: reader.target.lang, text: String(text.prefix(2000)), size: typeSize))
    // The passage's span, outlined by a faint background, and its matches at their offsets.
    let local = reader.target.passageStart - reader.windowStart
    let units = (text as NSString).length
    if local >= 0, local < units {
      let passageRange = NSRange(location: local, length: min(units - local, reader.target.passageEnd - reader.target.passageStart))
      attributed.addAttribute(.backgroundColor, value: UIColor(Tokens.bg2.color), range: passageRange)
      for hl in reader.target.highlights {
        let s = local + hl.start, e = local + hl.end
        guard s >= 0, e <= units, s < e else { continue }
        attributed.addAttributes(PassageStyle.markAttributes(selected: false), range: NSRange(location: s, length: e - s))
      }
    }
    view.attributedText = attributed
    if !c.scrolled, local >= 0, local < units {
      c.scrolled = true
      scroll(view, toUTF16: local)
    } else if previousStart > c.windowStart {
      // Earlier text was prepended: keep the reading position where it was.
      view.layoutIfNeeded()
      view.contentOffset = CGPoint(x: previousOffset.x, y: previousOffset.y + (view.contentSize.height - previousHeight))
    }
  }

  /// Scrolls the passage's first line a little below the top (TextKit 2 lays out only what it needs).
  private func scroll(_ view: UITextView, toUTF16 offset: Int) {
    DispatchQueue.main.async {
      guard let start = view.position(from: view.beginningOfDocument, offset: offset),
            let end = view.position(from: start, offset: 1),
            let range = view.textRange(from: start, to: end) else { return }
      let rect = view.firstRect(for: range)
      guard rect.origin.y.isFinite else { return }
      view.setContentOffset(CGPoint(x: 0, y: max(0, rect.minY - 48)), animated: false)
    }
  }
}
