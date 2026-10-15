// OWNER: N0
// The date chip of the Then column (SPEC §1.7, §1.11, §2.D; IOS-SPEC §4.8): "17 May 1994 · stated · day", the date's
// role, "unverified" when the year comes from an unchecked list, "translation — dated by the original" for a
// translation, and the card's notes in plain view (never only in a tooltip). Port of src/ui/panels/date-chip.mjs.

import ScrollsCore
import SwiftUI

nonisolated enum DateChipCopy {
  static let undated = "undated"
  static let undatedAccessibility = "Undated: outside chronology"
  static let translationFlag = "translation — dated by the original"
  static let unverifiedFlag = "unverified"
  /// Glyph per date basis (§1.7 uncertain-date brackets); stated dates carry none.
  static let basisGlyphs: [String: String] = [
    "estimated": "≈", "derived": "⇄", "period": "▤", "announced": "⟦", "unknown": "?",
  ]
}

/// The strings of a date chip (`dateChipModel`).
nonisolated struct DateChipModel: Sendable, Equatable {
  let text: String
  let label: String
  let basis: String
  let precision: String
  let roleLabel: String?
  let glyph: String?
  let flags: [String]
  let notes: [String]
  let accessibilityLabel: String

  /// A chip from a `date_card` (label, precision, basis, role, notes); nil label = undated.
  init(label: String?, precision: String, basis: String, role: String?, notes: [String], isTranslation: Bool = false) {
    guard let label, !label.isEmpty else {
      text = DateChipCopy.undated
      self.label = DateChipCopy.undated
      self.basis = "unknown"
      self.precision = "unknown"
      roleLabel = nil
      glyph = nil
      flags = []
      self.notes = []
      accessibilityLabel = DateChipCopy.undatedAccessibility
      return
    }
    let notes = notes.filter { !$0.isEmpty }
    var flags: [String] = []
    if notes.contains(where: { $0.range(of: #"\bunverified\b"#, options: [.regularExpression, .caseInsensitive]) != nil }) {
      flags.append(DateChipCopy.unverifiedFlag)
    }
    if isTranslation { flags.append(DateChipCopy.translationFlag) }
    let roleLabel = role.map { $0.replacing("_", with: " ") }
    self.label = label
    self.basis = basis
    self.precision = precision
    self.roleLabel = roleLabel
    self.flags = flags
    self.notes = notes
    text = "\(label) · \(basis) · \(precision)"
    glyph = DateChipCopy.basisGlyphs[basis]
    accessibilityLabel = (["Date \(label)", "basis \(basis)", "precision \(precision)", roleLabel.map { "role \($0)" }]
      .compactMap { $0 } + flags).joined(separator: ", ")
  }

  /// A chip from a contract `date_card` object; nil or a non-object reads as undated.
  init(json: JSONValue?, isTranslation: Bool = false) {
    let o = json?.objectValue
    self.init(label: o?["label"]?.stringValue, precision: o?["precision"]?.stringValue ?? "unknown",
              basis: o?["basis"]?.stringValue ?? "unknown", role: o?["role"]?.stringValue,
              notes: o?["notes"]?.arrayValue?.compactMap(\.stringValue) ?? [], isTranslation: isTranslation)
  }
}

/// The chip, with its role, flags and notes unless `compact` (lists and KWIC rows show the chip only).
struct DateChip: View {
  let model: DateChipModel
  var compact = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      chip
      if !compact, model.roleLabel != nil || !model.flags.isEmpty {
        HStack(spacing: 6) {
          if let role = model.roleLabel { Text(role).font(Typography.meta).foregroundStyle(Tokens.ink2.color) }
          ForEach(model.flags, id: \.self) { flag in
            Text(flag)
              .font(Typography.meta)
              .foregroundStyle(Tokens.amber.color)
              .padding(.horizontal, 6)
              .overlay { Capsule().strokeBorder(Tokens.amber.opacity(0.6), lineWidth: 1) }
          }
        }
      }
      if !compact {
        ForEach(model.notes, id: \.self) { note in
          Text(note).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private var chip: some View {
    HStack(spacing: 4) {
      if let glyph = model.glyph { Text(verbatim: glyph).accessibilityHidden(true) }
      Text(model.text).monospacedDigit()
    }
    .font(Typography.meta.weight(.medium))
    .foregroundStyle(Tokens.amber.color)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(Tokens.amber.opacity(Tokens.Alpha.amberTint), in: Capsule())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.accessibilityLabel)
  }
}
