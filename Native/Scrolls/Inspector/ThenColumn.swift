// OWNER: N8
// Then / Now / Next (IOS-SPEC §4.8; `panels/inspector.mjs`, `passage-card.mjs`). Then (amber accents) holds the date chip,
// the document card (title, author, collection, licence, SYN), the passage with its matches at their UTF-16 offsets,
// ±1 passage, Open in reader, the "refers to 1911" chip, the contemporary uses under their denominator line, and the
// machine annotations under "Machine annotations (fallible)". Now and Next arrive at M3 and say so. The fixed footer
// closes the column. Every panel is opaque; demo material carries SYN and the dashed synthetic frame.

import ScrollsContracts
import ScrollsCore
import SwiftUI

struct ThenColumn: View {
  let model: AppModel
  let ref: InspectedRef
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let experience = model.experience
    @Bindable var e = experience
    VStack(alignment: .leading, spacing: 14) {
      if ref.type != "relationship" {
        if typeSize.isAccessibilitySize {
          // At accessibility sizes Then/Now/Next is one vertical scroll with section headers (§4.19).
          section(ThenCopy.thenTab) { thenBody(experience) }
          section(ThenCopy.nowTab) { laterNote }
          section(ThenCopy.nextTab) { laterNote }
        } else {
          Picker(ThenCopy.thenTab, selection: $e.tab) {
            ForEach(InspectorTab.allCases, id: \.self) { tab in Text(Self.title(tab)).tag(tab) }
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("inspectorTabs")
          switch experience.tab {
          case .then: thenBody(experience)
          case .now, .next: laterNote
          }
        }
      } else {
        EdgeCardView(relationship: RelationshipID(ref.id), atlas: model.atlas)
          .frame(minHeight: 200)
      }
      Text(ThenCopy.footer)
        .font(Typography.meta)
        .foregroundStyle(Tokens.ink3.color)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("thenFooter")
    }
  }

  static func title(_ tab: InspectorTab) -> String {
    switch tab {
    case .then: ThenCopy.thenTab
    case .now: ThenCopy.nowTab
    case .next: ThenCopy.nextTab
    }
  }

  private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.headline).foregroundStyle(Tokens.ink.color).accessibilityAddTraits(.isHeader)
      content()
    }
  }

  private var laterNote: some View {
    Text(ThenCopy.nowLater)
      .font(Typography.cardBody)
      .foregroundStyle(Tokens.ink2.color)
      .fixedSize(horizontal: false, vertical: true)
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .opaquePanel()
  }

  @ViewBuilder
  private func thenBody(_ experience: ExperienceModel) -> some View {
    let then = experience.then
    switch ref.type {
    case "document":
      switch then.document {
      case .idle, .loading: CountingLabel(ThenCopy.openingDocument, fraction: nil)
      case .failed(let card): ErrorCard(card) { then.retry() }
      case .loaded(let d): DocumentCardView(model: model, document: d)
      }
    default:
      switch then.passage {
      case .idle, .loading: CountingLabel(ThenCopy.opening, fraction: nil)
      case .failed(let card): ErrorCard(card) { then.retry() }
      case .loaded(let p):
        PassageCardView(model: model, passage: p, selectedOcc: then.selectedOcc, selectedSpan: then.selectedSpan)
        UsesSection(model: model, passage: p)
      }
    }
  }
}

// MARK: - The passage card

nonisolated enum PassageNotes {
  /// `passageNotes(p)`: non-body fields, retrospective descriptions, apparatus, excluded qualities, translations.
  static func notes(_ p: PassageResponse) -> [String] {
    var notes: [String] = []
    if p.field != "body" { notes.append(ThenCopy.field(p.field)) }
    if p.timeRole == "describes" { notes.append(ThenCopy.describes) }
    if p.timeRole == "apparatus" { notes.append(ThenCopy.apparatus) }
    if p.quality != "ok" { notes.append(ThenCopy.quality(p.quality)) }
    if p.document.isTranslation { notes.append(ThenCopy.translation) }
    return notes
  }

  /// The "refers to" label: the passage's own, else the document's referenced date.
  static func referenced(_ p: PassageResponse) -> String? {
    if let l = p.refersTo?.objectValue?["label"]?.stringValue { return l }
    return p.document.dates.first { $0.role == "referenced" }?.label
  }

  /// Machine annotations: label, a reader's rename, and "kind · run 14 · margin 0.22".
  static func machine(_ p: PassageResponse) -> [(label: String, renamed: String?, meta: String)] {
    (p.machine?.arrayValue ?? []).map { m in
      let o = m.objectValue ?? [:]
      let kind = o["kind"]?.stringValue
      let meta = [kind, o["run"]?.numberValue.map { "run \(Int($0))" }, o["margin"]?.numberValue.map { "margin \(Format.number($0))" }]
        .compactMap { $0 }.joined(separator: " · ")
      return (o["label"]?.stringValue ?? kind ?? "machine annotation", o["human_label"]?.stringValue, meta)
    }
  }
}

struct PassageCardView: View {
  let model: AppModel
  let passage: PassageResponse
  let selectedOcc: OccurrenceID?
  let selectedSpan: Range<Int>?

  var body: some View {
    let p = passage
    let experience = model.experience
    VStack(alignment: .leading, spacing: 10) {
      DocumentHeader(title: p.document.title, author: p.document.author, kind: p.document.kind,
                     collection: p.document.collection, license: p.document.license, lang: p.lang, synthetic: p.synthetic || p.document.synthetic,
                     dateChip: DateChipModel(json: dateCardJSON(p.document.dateCard), isTranslation: p.document.isTranslation))
      if let referenced = PassageNotes.referenced(p) {
        Text(ThenCopy.refersTo(referenced))
          .font(Typography.meta.weight(.medium))
          .foregroundStyle(Tokens.amber.color)
          .padding(.horizontal, 8)
          .padding(.vertical, 3)
          .overlay { Capsule().strokeBorder(Tokens.amber.opacity(0.6), lineWidth: 1) }
          .accessibilityIdentifier("refersTo")
      }
      if let reread = p.reread?.objectValue?["label"]?.stringValue {
        Text(reread).font(Typography.meta).foregroundStyle(Tokens.violet.color)
      }
      ForEach(PassageNotes.notes(p), id: \.self) { note in
        Text(note).font(Typography.meta).foregroundStyle(Tokens.ink3.color).fixedSize(horizontal: false, vertical: true)
      }
      if let before = p.before?.objectValue?["text"]?.stringValue {
        Text(before).font(Typography.cardBody).foregroundStyle(Tokens.ink3.color).fixedSize(horizontal: false, vertical: true)
      }
      PassageTextView(segments: PassageSegments.segments(p.text, p.highlights, selectedOcc: selectedOcc, selectedSpan: selectedSpan),
                      lang: p.lang)
      if let after = p.after?.objectValue?["text"]?.stringValue {
        Text(after).font(Typography.cardBody).foregroundStyle(Tokens.ink3.color).fixedSize(horizontal: false, vertical: true)
      }
      Text(ThenCopy.offsets(field: p.field, start: p.start, end: p.end))
        .font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      actions(experience)
      let machine = PassageNotes.machine(p)
      if !machine.isEmpty {
        DisclosureGroup(ThenCopy.machineTitle) {
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(machine.enumerated()), id: \.offset) { _, m in
              Text("\(Text(m.label).foregroundStyle(Tokens.ink2.color))\(Text(m.renamed.map(ThenCopy.renamedBy) ?? "").foregroundStyle(Tokens.ink.color))\(Text(m.meta.isEmpty ? "" : " (\(m.meta))").foregroundStyle(Tokens.ink3.color))")
                .font(Typography.meta)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          .padding(.top, 4)
        }
        .font(Typography.cardBody)
        .tint(Tokens.ink2.color)
        .accessibilityIdentifier("machineAnnotations")
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .syntheticFrame(p.synthetic || p.document.synthetic)
    .overlay(alignment: .leading) {
      // Then's accent: amber (historical reference).
      Rectangle().fill(Tokens.amber.color).frame(width: 2).padding(.vertical, 12).accessibilityHidden(true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("passageCard")
  }

  private func actions(_ experience: ExperienceModel) -> some View {
    let p = passage
    return ViewThatFits(in: .horizontal) {
      HStack(spacing: 8) { actionButtons(experience, p) }
      VStack(alignment: .leading, spacing: 4) { actionButtons(experience, p) }
    }
    .font(Typography.chrome)
  }

  @ViewBuilder
  private func actionButtons(_ experience: ExperienceModel, _ p: PassageResponse) -> some View {
    Button(experience.then.withContext ? ThenCopy.hideNeighbours : ThenCopy.showNeighbours) { experience.then.toggleContext() }
      .accessibilityIdentifier("neighbours")
    Button(ThenCopy.openReader) {
      experience.readerOpen = true
      experience.raise(to: .large)
    }
    .accessibilityIdentifier("openReader")
    Button(ThenCopy.lineage) { experience.openLineage(NodeRef(kind: "passage", id: p.id.rawValue)) }
    Button(ThenCopy.annotate) { experience.annotate(AnnotationTarget(type: "passage", id: p.id.rawValue)) }
  }

  private func dateCardJSON(_ c: DateCard) -> JSONValue {
    var o: JSONObject = ["label": .string(c.label), "precision": .string(c.precision), "basis": .string(c.basis), "notes": c.notes]
    if let role = c.role { o["role"] = .string(role) }
    return .object(o)
  }
}

/// The document card: title, byline, date chip, then collection · licence · language, and SYN.
struct DocumentHeader: View {
  let title: String?
  let author: String?
  let kind: String
  let collection: String
  let license: String?
  let lang: String?
  let synthetic: Bool
  let dateChip: DateChipModel

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title ?? "(untitled)").font(.headline).foregroundStyle(Tokens.ink.color)
          .fixedSize(horizontal: false, vertical: true)
        if synthetic { EvidenceBadge("SYN") }
      }
      let byline = [author, kind].compactMap { $0 }.joined(separator: " · ")
      if !byline.isEmpty { Text(byline).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color) }
      DateChip(model: dateChip)
      let meta = [ThenCopy.collection(collection), license.map(ThenCopy.licence), lang.map(ThenCopy.language)].compactMap { $0 }
      Text(meta.joined(separator: " · ")).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .contain)
  }
}

/// A selected document (a work or a book): its card, tags and size; works offer their Genealogy.
struct DocumentCardView: View {
  let model: AppModel
  let document: DocumentResponse

  var body: some View {
    let d = document
    let experience = model.experience
    VStack(alignment: .leading, spacing: 10) {
      DocumentHeader(title: d.title ?? ThenCopy.documentTitle(Int(d.id.rawValue)), author: d.author, kind: d.kind, collection: d.collection,
                     license: d.license, lang: d.langText, synthetic: d.synthetic,
                     dateChip: DateChipModel(label: d.dateCard?.label, precision: d.dateCard?.precision ?? "unknown",
                                             basis: d.dateCard?.basis ?? "unknown", role: d.dateCard?.role,
                                             notes: d.dateCard?.notes.arrayValue?.compactMap(\.stringValue) ?? [],
                                             isTranslation: d.isTranslation ?? false))
      if let note = d.textNote { Text(note).font(Typography.meta).foregroundStyle(Tokens.ink2.color) }
      let size = [d.passages.map(ThenCopy.passages), d.tokens.map(ThenCopy.tokens)].compactMap { $0 }
      if !size.isEmpty { Text(size.joined(separator: " · ")).font(Typography.count).foregroundStyle(Tokens.ink2.color) }
      let tags = (d.tags.arrayValue ?? []).compactMap { t -> String? in
        guard let o = t.objectValue, let v = o["value"]?.stringValue else { return nil }
        return [o["scheme"]?.stringValue, v].compactMap { $0 }.joined(separator: ": ")
      }
      if !tags.isEmpty {
        Text(ThenCopy.tags).font(Typography.meta.weight(.semibold)).foregroundStyle(Tokens.ink3.color)
        Text(tags.joined(separator: " · ")).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
      }
      if ["song", "film", "tv", "album", "work", "channel", "sport"].contains(d.kind) {
        Button(ThenCopy.genealogy) { experience.openGenealogy(document: Int(d.id.rawValue)) }.font(Typography.chrome)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .syntheticFrame(d.synthetic)
  }
}

// MARK: - Contemporary uses

struct UsesSection: View {
  let model: AppModel
  let passage: PassageResponse

  var body: some View {
    let then = model.experience.then
    VStack(alignment: .leading, spacing: 8) {
      Text(ThenCopy.contemporaryUses).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color).accessibilityAddTraits(.isHeader)
      if let absence = then.usesAbsence {
        switch absence {
        case .noDate(let label): note(ThenCopy.noYear(label))
        case .noExpression: note(ThenCopy.noExpression)
        }
      } else {
        switch then.uses {
        case .idle: EmptyView()
        case .loading:
          if let w = ThenRules.contemporaryWindow(ThenRules.cardYears(passage.document.dateCard.label)) {
            CountingLabel(ThenCopy.lookingIn(w.from, w.to), fraction: nil)
          }
        case .failed(let card): ErrorCard(card) { then.retryUses() }
        case .loaded(let u):
          let denominator = ThenRules.usesDenominator(total: u.total, tokens: u.tokens, from: u.from, to: u.to)
          if u.rows.isEmpty {
            Text(denominator).font(Typography.count).foregroundStyle(Tokens.ink2.color)
            note((u.total ?? 0) > 0 ? ThenCopy.noOtherUse(u.from, u.to) : ThenCopy.noUses(u.from, u.to))
          } else {
            Text("\(denominator) · \(ThenCopy.showing(u.rows.count, perLane: ThenRules.usesPerLane))")
              .font(Typography.count).foregroundStyle(Tokens.ink2.color)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("usesDenominator")
            ForEach(u.rows, id: \.passage) { row in
              KwicRowView(row: row) { r in model.experience.select(InspectedRef(type: "passage", id: Int(r.passage.rawValue)).selection) }
              Divider().overlay(Tokens.rule.color)
            }
          }
        }
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
  }

  private func note(_ s: String) -> some View {
    Text(s).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color).fixedSize(horizontal: false, vertical: true)
  }
}
