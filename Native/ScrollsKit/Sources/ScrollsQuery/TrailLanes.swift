// OWNER: N3
// The Term trail's lanes (C2; lanes.mjs trail helpers, trail.mjs): the fixed lane set of vocab.TRAIL_LANES, the trail lane
// of a row (collection domain and sampling, STEMM field, field class) and its unit class. The trail's lane set, share
// cells (C3) and the baseline row are M2 (IOS-SPEC §8.5 N3); M1 ships the row → lane rules every slice needs, and the
// strand extras (baseline link and Wiktionary claim markers) every timeline query carries.

import ScrollsCore

/// The Term trail's lane definitions and row rules.
public enum TrailLanes {
  /// Unit class of each trail lane kind.
  static let unitClassOfKind: [String: String] = ["literature-text": "text", "stemm-text": "text", "stemm-abstracts": "cells",
                                                  "culture-titles": "titles", "music-relations": "titles", "etymology": "none"]
  static let textFields: [String] = Vocab.stemmLanes.map(\.key)
  static let cellFields: [String] = Vocab.stemmLanes.filter { !$0.openalex.isEmpty }.map(\.key)

  /// `trailLane(keyOrValue)`: the TRAIL_LANES row of a lane key or value.
  public static func lane(_ keyOrValue: String) -> TrailLane? {
    let k = JSString.hasPrefix(keyOrValue, "trail:") ? keyOrValue : "trail:\(keyOrValue)"
    return Vocab.trailLanes.first { JSString.equal($0.key, k) }
  }

  /// `trailUnitClass(value)`: 'text' | 'titles' | 'cells' | 'none'.
  public static func unitClass(_ value: String) -> String {
    guard let l = lane(value) else { return "text" }
    return unitClassOfKind[l.kind] ?? "text"
  }

  /// `trailValueOfRow(r)`: the trail lane value of a row, or nil outside every trail lane.
  public static func value(sampling: String?, domain: String?, field: String?, fieldClass fc: String) -> String? {
    let textish = fc != "title" && fc != "abstract"
    if sampling == "relation_endpoints" { return fc == "title" ? "music-relations" : nil }
    if sampling == "top_cited_per_cell" {
      if let field, fc == "title" || fc == "abstract", cellFields.contains(field) { return "stemm-abstracts:\(field)" }
      return nil
    }
    if domain == "literature" { return textish ? "literature-text" : nil }
    if domain == "stemm" {
      if let field, textish, textFields.contains(field) { return "stemm-text:\(field)" }
      return nil
    }
    if domain == "culture" { return fc == "title" ? "culture-titles" : nil }
    return nil
  }

  /// The trail order note: its lanes have a fixed order.
  public static let orderNote = "Lane order is fixed for the Term trail (etymology → literature → STEMM fields → culture), not a scale of meaning."
}
