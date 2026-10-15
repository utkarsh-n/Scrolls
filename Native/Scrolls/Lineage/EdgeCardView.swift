// OWNER: N5
// The edge card (IOS-SPEC §4.11, SPEC §2.C; port of src/ui/panels/edge-card.mjs): type and direction; the evidence
// status in words with its badge (DOC, DOC* "source not recorded", CALC, PROP, PROP · CUE); origin; method or annotator;
// run id with its parameters; the score with its kind ("similarity 0.71 — not a probability"); the external locator,
// labelled external (it opens in Safari only when tapped, ΔS-17); the supporting spans side by side with an aligned
// diff; the quoted cue; the revision history; Confirm / Reject / Dispute / Attach evidence, each with a note of at least
// 10 characters, written through N6's API (journaled); and the fixed caution sentence. A review changes only the review
// layer: the evidence status and the line pattern never change.

import ScrollsContracts
import ScrollsCore
import ScrollsService
import SwiftUI

extension RootSlots {
  func edgeCard(_ id: RelationshipID) -> some View {
    NavigationStack { EdgeCardView(relationship: id, atlas: model.atlas) }
  }
}

/// The card's words (pure; `edgeCardModel`).
nonisolated struct EdgeCardContent: Sendable, Equatable {
  var heading: String
  var glyph: String
  var typeLabel: String
  var typeDescription: String
  var directed: Bool
  var badge: String
  var badgeTitle: String
  var statusWords: String
  var origin: String
  var method: String?
  var run: String?
  var score: String?
  var locator: String?
  var cue: String?
  var group: Int64?
  var dateConflict: Bool
  var reviewStatus: String
  var synthetic: Bool
  var source: String?
  var target: String?

  /// 'Felmark Bulletin, June 1963 (1963)' or the ref.
  static func endpoint(_ end: RelationshipEnd) -> String {
    let name = end.doc?.stringValue ?? end.label ?? end.ref
    return end.y.map { "\(name) (\($0))" } ?? name
  }

  /// "run 5 · reuse-index@1.0.0 · k 8 · w 6".
  static func runText(_ r: RelationshipResponse) -> String? {
    let run = r.run
    guard let id = run?["id"]?.safeInteger ?? r.runId.map({ Int($0.rawValue) }) else { return nil }
    var parts = ["run \(id)"]
    if let v = run?["pipeline_version"]?.stringValue ?? run?["stage"]?.stringValue { parts.append(v) }
    if let params = run?["params"]?.objectValue, !params.isEmpty {
      parts.append(params.keys.sorted().map { k in
        let v = params[k] ?? .null
        let text: String = switch v {
        case .string(let s): s
        case .number(let n): JSNumber.format(n)
        case .bool(let b): b ? "true" : "false"
        case .null: "null"
        default: CanonicalJSON.string(v)
        }
        return "\(k.replacingOccurrences(of: "_", with: " ")) \(text)"
      }.joined(separator: " · "))
    }
    if let s = run?["status"]?.stringValue, s != "succeeded" { parts.append(s) }
    return parts.joined(separator: " · ")
  }

  init(_ r: RelationshipResponse) {
    let type = Vocab.relTypeByCode[r.relType]
    let cueRow = r.evidence.first { $0.role == "citation_cue" }
    cue = r.cue?["quote"]?.stringValue ?? cueRow?.quote
    let style = EvidenceStyle.style(EvidenceStyleKey(evidenceStatus: r.evidenceStatus, reviewStatus: r.reviewStatus,
                                                     provenanceQuality: r.provenanceQuality, family: r.family, cue: cue != nil,
                                                     isSynthetic: r.synthetic, dateConflict: r.dateConflict, origin: r.origin))
    badge = style.conflict ? String(style.badge.dropLast(2)) : style.badge
    badgeTitle = Copy.badges[badge]?.title ?? r.evidenceStatus
    glyph = r.glyph ?? type?.glyph ?? ""
    typeLabel = r.label ?? type?.label ?? r.relType
    typeDescription = type?.description ?? ""
    heading = "\(Self.endpoint(r.src)) \(typeLabel) \(Self.endpoint(r.dst))"
    directed = r.directed
    statusWords = r.statusWords ?? "\(r.evidenceStatus)\(r.provenanceQuality == "source_unrecorded" ? " — source not recorded" : "")"
    origin = LineageCopy.origin(r.origin, createdBy: r.createdBy, dataset: r.sourceDataset, method: r.method,
                                run: r.runId?.rawValue)
    method = r.method
    run = Self.runText(r)
    score = r.score.map { r.scoreLabel ?? LineageCopy.score($0.value, kind: $0.kind) }
    locator = r.sourceLocator
    group = r.hypothesisGroup?.rawValue
    dateConflict = r.dateConflict
    reviewStatus = r.reviewStatus
    synthetic = r.synthetic
    source = r.evidence.first { $0.role == "source_span" && $0.quote != nil }?.quote
    target = r.evidence.first { $0.role == "target_span" && $0.quote != nil }?.quote
  }

  /// A diff op of two spans (`alignTokens`): shared, substituted, inserted, omitted.
  enum Op: Sendable, Equatable {
    case same(String, String)
    case sub(String, String)
    case ins(String)
    case del(String)
  }

  /// `alignTokens(a, b)`: LCS over case-folded words, in reading order.
  static func alignTokens(_ a: String, _ b: String) -> [Op] {
    let A = a.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    let B = b.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    func fold(_ t: String) -> String {
      let lower = JSString.toLowerCase(t)
      let scalars = Array(lower.unicodeScalars)
      func keep(_ u: Unicode.Scalar) -> Bool { u.properties.isAlphabetic || u.properties.numericType != nil }
      guard let s = scalars.firstIndex(where: keep), let e = scalars.lastIndex(where: keep) else { return "" }
      var v = String.UnicodeScalarView()
      v.append(contentsOf: scalars[s...e])
      return String(v)
    }
    let fa = A.map(fold), fb = B.map(fold)
    let n = A.count, m = B.count
    var L = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
    if n > 0 && m > 0 {
      for i in stride(from: n - 1, through: 0, by: -1) {
        for j in stride(from: m - 1, through: 0, by: -1) {
          L[i][j] = fa[i] == fb[j] ? L[i + 1][j + 1] + 1 : max(L[i + 1][j], L[i][j + 1])
        }
      }
    }
    var ops: [Op] = []
    var i = 0, j = 0
    while i < n || j < m {
      if i < n && j < m && fa[i] == fb[j] {
        ops.append(.same(A[i], B[j])); i += 1; j += 1
      } else if i < n && j < m && L[i + 1][j + 1] == L[i][j] {
        ops.append(.sub(A[i], B[j])); i += 1; j += 1
      } else if j < m && (i >= n || L[i][j + 1] >= L[i + 1][j]) {
        ops.append(.ins(B[j])); j += 1
      } else {
        ops.append(.del(A[i])); i += 1
      }
    }
    return ops
  }
}

@MainActor @Observable
final class EdgeCardModel {
  enum Action: String, CaseIterable, Identifiable {
    case confirm, reject, dispute, attach
    var id: String { rawValue }
    var title: String {
      switch self {
      case .confirm: LineageCopy.confirm
      case .reject: LineageCopy.reject
      case .dispute: LineageCopy.dispute
      case .attach: LineageCopy.attach
      }
    }
  }

  let id: RelationshipID
  let atlas: (any AtlasService)?
  private(set) var relationship: RelationshipResponse?
  private(set) var error: ErrorCardModel?
  var action: Action?
  var note = ""
  var passage = ""
  var start = ""
  var end = ""
  var role = "supporting"
  private(set) var formError: String?
  private(set) var done: String?
  private(set) var sending = false

  init(id: RelationshipID, atlas: (any AtlasService)?) {
    self.id = id
    self.atlas = atlas
  }

  func load() async {
    guard let atlas else { return }
    error = nil
    do {
      relationship = try await atlas.relationship(id)
    } catch {
      self.error = ErrorCardModel(any: error, what: LineageCopy.linkFailed)
    }
  }

  func submit() async {
    guard let atlas, let action else { return }
    formError = LineageCopy.noteProblem(note)
    done = nil
    guard formError == nil else { return }
    sending = true
    defer { sending = false }
    do {
      switch action {
      case .attach:
        guard let p = Int64(passage), let s = Int(start), let e = Int(end), s < e else {
          formError = "Give a passage id and a start offset before the end offset."
          return
        }
        let r = try await atlas.addEvidence(id, EvidenceRequest(passage: PassageID(rawValue: p), start: s, end: e, role: role,
                                                                note: JSString.trim(note), relative: true))
        done = LineageCopy.attachDone(r.id)
      default:
        let r = try await atlas.review(id, ReviewRequest(action: action.rawValue, note: JSString.trim(note)))
        done = LineageCopy.reviewDone(revision: r.revision, status: r.reviewStatus)
      }
      note = ""
      self.action = nil
      await load()
    } catch {
      formError = (error as? ScrollsError)?.message ?? String(describing: error)
    }
  }
}

struct EdgeCardView: View {
  @State private var model: EdgeCardModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  init(relationship: RelationshipID, atlas: (any AtlasService)?) {
    _model = State(initialValue: EdgeCardModel(id: relationship, atlas: atlas))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if let e = model.error {
          ErrorCard(e) { Task { await model.load() } }
        } else if let r = model.relationship {
          card(r, EdgeCardContent(r))
        } else {
          HStack { ProgressView(); Text(LineageCopy.loadingLink).font(Typography.meta) }
        }
      }
      .padding(Tokens.Geometry.gutter)
    }
    .background(Tokens.bg0.color)
    .navigationTitle("Link \(model.id.rawValue)")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    .task { await model.load() }
    .accessibilityIdentifier("edgeCard")
  }

  private func row(_ label: String, _ value: String?) -> some View {
    Group {
      if let value, !value.isEmpty {
        VStack(alignment: .leading, spacing: 1) {
          Text(label).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          Text(value).font(Typography.cardBody).foregroundStyle(Tokens.ink.color).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  @ViewBuilder
  private func card(_ r: RelationshipResponse, _ c: EdgeCardContent) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(verbatim: c.glyph).font(.title3)
        Text(c.heading).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      }
      .accessibilityElement(children: .combine)
      HStack(spacing: 6) {
        EvidenceBadge(c.badge)
        if c.dateConflict { EvidenceBadge("⚠") }
        if r.origin == "human" { EvidenceBadge("✎") }
        switch c.reviewStatus {
        case "confirmed": EvidenceBadge("✓")
        case "rejected": EvidenceBadge("✕")
        case "disputed": EvidenceBadge("⚖")
        default: EmptyView()
        }
        if c.synthetic { EvidenceBadge("SYN") }
      }
      row("Evidence status", "\(c.badgeTitle) — \(c.statusWords)")
      row("Type", "\(c.typeLabel)\(c.directed ? "" : " (direction unknown)") — \(c.typeDescription)")
      row("Origin", c.origin)
      row("Method", c.method)
      row("Run", c.run)
      row("Score", c.score)
      row("Review", c.reviewStatus)
      if let g = c.group { row("Hypothesis group", "#\(g)") }
      if let locator = c.locator {
        VStack(alignment: .leading, spacing: 1) {
          Text("Source locator (\(LineageCopy.external))").font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          if let url = URL(string: locator), url.scheme == "https" || url.scheme == "http" {
            Button {
              openURL(url)
            } label: {
              Label(locator, systemImage: "arrow.up.right.square").font(Typography.cardBody).multilineTextAlignment(.leading)
            }
            .accessibilityHint("Opens the source in Safari (external)")
          } else {
            Text(locator).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
          }
        }
      }
      if let cue = c.cue {
        VStack(alignment: .leading, spacing: 2) {
          HStack { EvidenceBadge("PROP · CUE"); Text(LineageCopy.cue).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
          Text(verbatim: "“\(cue)”").font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
          Text(LineageCopy.cueNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
      }
      if c.source != nil || c.target != nil { spans(c) }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .syntheticFrame(c.synthetic)

    reviewActions
    if !r.revisions.isEmpty { revisions(r.revisions) }
    Text(r.caution.isEmpty ? LineageCopy.caution : r.caution).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier("edgeCard.caution")
  }

  private func spans(_ c: EdgeCardContent) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(LineageCopy.supportingSpans).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      let ops = EdgeCardContent.alignTokens(c.source ?? "", c.target ?? "")
      HStack(alignment: .top, spacing: 8) {
        diffColumn(ops, side: .a).frame(maxWidth: .infinity, alignment: .leading)
        diffColumn(ops, side: .b).frame(maxWidth: .infinity, alignment: .leading)
      }
      Text(LineageCopy.diffNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
    }
  }

  private enum Side { case a, b }

  private func diffColumn(_ ops: [EdgeCardContent.Op], side: Side) -> some View {
    var text = AttributedString()
    for op in ops {
      var piece: AttributedString
      switch (op, side) {
      case (.same(let a, _), .a), (.same(_, let a), .b):
        piece = AttributedString(a + " ")
      case (.sub(let a, _), .a), (.sub(_, let a), .b):
        piece = AttributedString(a + " ")
        piece.underlineStyle = .single
      case (.del(let a), .a), (.ins(let a), .b):
        piece = AttributedString(a + " ")
        piece.underlineStyle = Text.LineStyle(pattern: .dot)
      default:
        continue
      }
      text += piece
    }
    return Text(text).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
      .padding(8).background(Tokens.bg2.color, in: RoundedRectangle(cornerRadius: Tokens.Radius.small, style: .continuous))
  }

  private var reviewActions: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        ForEach(EdgeCardModel.Action.allCases) { a in
          Button(a.title) { model.action = model.action == a ? nil : a }
            .buttonStyle(.bordered).controlSize(.small)
            .tint(model.action == a ? Tokens.cyan.color : nil)
            .accessibilityIdentifier("edgeCard.\(a.rawValue)")
        }
      }
      if let a = model.action {
        Text(a == .attach ? "Attach a span of text as evidence." : "\(a.title) this link. \(LineageCopy.reviewNote)")
          .font(Typography.meta).foregroundStyle(Tokens.ink2.color)
        if a == .attach {
          HStack {
            TextField("passage", text: $model.passage).keyboardType(.numberPad)
            TextField("start", text: $model.start).keyboardType(.numberPad)
            TextField("end", text: $model.end).keyboardType(.numberPad)
          }
          .textFieldStyle(.roundedBorder).font(Typography.meta)
          Picker("Role", selection: $model.role) {
            ForEach(Vocab.evidenceRoles.filter { $0 != "external_record" && $0 != "citation_cue" }, id: \.self) {
              Text($0.replacingOccurrences(of: "_", with: " ")).tag($0)
            }
          }
          Text(LineageCopy.attachNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
        TextField(LineageCopy.notePlaceholder, text: $model.note, axis: .vertical)
          .lineLimit(2...5).textFieldStyle(.roundedBorder)
          .accessibilityLabel("Note (at least 10 characters)")
        if let p = model.formError { Text(p).font(Typography.meta).foregroundStyle(Tokens.danger.color) }
        Button(model.sending ? "Sending…" : a.title) { Task { await model.submit() } }
          .buttonStyle(.borderedProminent).controlSize(.small)
          .disabled(model.sending || LineageCopy.noteProblem(model.note) != nil)
      }
      if let d = model.done { Text(d).font(Typography.meta).foregroundStyle(Tokens.ok.color) }
    }
  }

  private func revisions(_ revs: [RelationshipRevision]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(LineageCopy.revisions).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      ForEach(revs, id: \.rev) { v in
        Text(verbatim: "rev \(v.rev) · \(v.action) · \(v.actor)\(v.at.map { " · \($0)" } ?? "")\(v.reason.map { " — \($0)" } ?? "")")
          .font(Typography.meta).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(12).frame(maxWidth: .infinity, alignment: .leading).opaquePanel()
  }
}
