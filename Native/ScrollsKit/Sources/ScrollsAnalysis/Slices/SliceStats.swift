// OWNER: N4
// Per-slice aggregation (slices.mjs `measureDoc`, `modalityConfig`, `modalityEvidence`, `sliceStats`): denominators,
// counts, documents, authors, dispersion, composition, prominence terciles, date-basis mix, every exclusion counted
// (§13 rule 9) and the coverage gate. Slice membership is fit-or-wash (§13 rule 4): a document is in a slice only when
// its whole interval [y_lo, y_hi] lies inside the slice's years; one that overlaps without fitting is a wash and is
// counted, never apportioned. Undated and scheduled documents never enter a slice.

import Foundation
import ScrollsCore

/// Field classes counted per modality before the describes/apparatus toggles (§4.6, §6.5, §10.2).
enum ModalityClasses {
  static let byModality: [String: [String]] = [
    "text": ["text"], "titles": ["title"], "abstracts": ["abstract", "title"], "lexical": ["text", "title"], "baseline": [],
  ]
  /// Default coverage gates by unit (§4.6; a collection's coverage_gate overrides).
  static let defaultGates = (tokens: 50000, works: 30, sampledWorks: 20)
  /// A modality holding at least this share of a slice's evidence is that slice's dominant modality (§2.E).
  static let dominantShare = 0.8

  static func fieldClasses(_ modality: String, _ toggles: Toggles) -> Set<String> {
    var set = Set(byModality[modality] ?? ["text"])
    if toggles.ds == 1 { set.insert("describes") }
    if toggles.ap == 1 && modality == "text" { set.insert("apparatus") }
    return set
  }
}

/// How one modality is measured in a scope (`modalityConfig`).
struct ModalityConfig {
  let modality: String
  /// "tokens" | "works"
  let unit: String
  let classes: Set<String>

  init(_ scope: Scope, _ modality: String, _ collIds: [Int]) {
    var units = Set<String>()
    for id in collIds {
      if let c = scope.collections[id], c.modality == modality { units.insert(c.unit == "tokens" ? "tokens" : "works") }
    }
    self.modality = modality
    unit = units.contains("tokens") ? "tokens" : "works"
    classes = ModalityClasses.fieldClasses(modality, scope.toggles)
  }
}

/// One document measured in one modality (`measureDoc`).
struct DocMeasure {
  var units = 0
  var n = 0
  var names = 0
  /// Per passage language (works: the document's text language): {units, n}.
  var byLang = JSMap<(units: Int, n: Int)>()
}

/// The aggregate of a slice in one modality (`sliceStats`).
final class SliceStats {
  let which: String
  let years: (Int, Int)
  let f: String
  let modality: String
  let unit: String
  let rateUnit: String
  let scale: Double
  let classes: [String]
  var units = 0, unitsNoTr = 0, n = 0, k = 0, names = 0, docs = 0, evidenceDocs = 0
  var perDoc: [(id: Int, units: Int, n: Int)] = []
  var authors = JSSet(), evidenceAuthors = JSSet()
  var strata = JSMap<(n: Int, units: Int, k: Int)>()
  var kinds = JSMap<Int>(objectOrder: true), langs = JSMap<Int>(objectOrder: true), colls = JSMap<Int>(objectOrder: true)
  var basis = JSMap<Int>(objectOrder: true)
  var terciles = JSMap<(n: Int, units: Int, k: Int)>(objectOrder: true)
  struct Bucket { var docs = 0, n = 0 }
  var translations = Bucket(), duplicates = Bucket(), estimated = Bucket(), washes = Bucket()
  var otherModality = Bucket()
  var otherModalities = JSMap<Int>(objectOrder: true)
  var describes = 0, apparatus = 0
  let notRateEligible: [String]
  var undated = Bucket(), scheduled = Bucket()
  var matching = 0, translationsIncluded = 0
  var collections = JSSet()
  /// Collection ids in first-seen order (a JS Set).
  var sampling: [Int] = []
  var gateUnits = 0
  var synthetic = false
  var topDoc: (id: Int, n: Int)?
  let filterWarnings: [String]
  // derived
  var rateN = 0
  var topDocShare: Double?
  var dp: Double?
  var mix = JSMap<Double>(objectOrder: true), languages = JSMap<Double>(objectOrder: true)
  var collectionMix = JSMap<Double>(objectOrder: true), basisMix = JSMap<Double>(objectOrder: true)
  var undatedShare = 0.0
  var composition = JSMap<Double>(objectOrder: true)
  var selection: [(collection: String, sampling: String, label: String, note: String?)] = []

  init(spec: SliceSpec, cfg: ModalityConfig) {
    which = spec.which
    years = spec.years
    f = spec.fStr
    modality = cfg.modality
    unit = cfg.unit
    rateUnit = cfg.unit == "tokens" ? "per_million_tokens" : "per_thousand_works"
    scale = Double(Vocab.rateUnits[rateUnit]!.scale)
    classes = Array(cfg.classes)
    notRateEligible = spec.notRateEligible
    filterWarnings = spec.warnings
  }

  subscript(bucket name: String) -> Bucket {
    get {
      switch name {
      case "translations": translations
      case "duplicates": duplicates
      case "estimated": estimated
      case "undated": undated
      case "scheduled": scheduled
      default: washes
      }
    }
    set {
      switch name {
      case "translations": translations = newValue
      case "duplicates": duplicates = newValue
      case "estimated": estimated = newValue
      case "undated": undated = newValue
      case "scheduled": scheduled = newValue
      default: washes = newValue
      }
    }
  }
}

/// Slice aggregation.
enum Slices {
  static let samplingLabels: [String: String] = [
    "complete": "complete collection", "prominence_selected": "selected by prominence",
    "top_cited_per_cell": "top-cited sample per field × period", "relation_endpoints": "works that appear in documented links",
    "curated": "curated selection", "user": "your import",
  ]

  /// Denominator and count of one document in one modality under a slice's language filter.
  static func measureDoc(_ doc: ScopeDoc, _ spec: SliceSpec, _ m: ModalityConfig, _ toggles: Toggles) -> DocMeasure {
    var out = DocMeasure()
    if m.unit == "tokens" {
      for t in doc.tok {
        if !m.classes.contains(t.fc) || !spec.langOk(t.plang, t.fc, doc.langText) { continue }
        out.units += t.tokens
        out.byLang.update(t.plang, default: (0, 0)) { $0.units += t.tokens }
      }
    } else {
      out.units = 1
      out.byLang[doc.langText ?? "und"] = (1, 0)
    }
    for h in doc.hits {
      let ok = m.unit == "works" || spec.langOk(h.plang, h.fc, doc.langText)
      if !ok { continue }
      if !m.classes.contains(h.fc) { continue }
      let c = h.n + (toggles.nm == 1 ? h.names : 0)
      out.n += c
      if toggles.nm == 0 { out.names += h.names }
      let key = m.unit == "tokens" ? h.plang : (doc.langText ?? "und")
      out.byLang.update(key, default: (0, 0)) { $0.n += c }
    }
    return out
  }

  /// `placeDoc(doc, years)`: 'in' | 'wash' | 'out' | 'undated' | 'scheduled'.
  static func place(_ doc: ScopeDoc, _ years: (Int, Int)) -> String {
    if doc.chrono != "dated" { return doc.chrono }
    let (lo, hi) = years
    guard let yLo = doc.yLo, let yHi = doc.yHi else { return "out" }
    if yLo >= lo && yHi <= hi { return "in" }
    if yLo <= hi && yHi >= lo { return "wash" }
    return "out"
  }

  /// `exclusionOf(doc, toggles)`.
  static func exclusion(_ doc: ScopeDoc, _ t: Toggles) -> String? {
    if t.tr == 0 && doc.tr { return "translations" }
    if t.dup == 0 && doc.dup { return "duplicates" }
    if t.est == 0 && doc.basis == "estimated" { return "estimated" }
    return nil
  }

  /// Evidence per modality in a slice: occurrences, covered documents and units (`modalityEvidence`).
  static func modalityEvidence(_ scope: Scope, _ spec: SliceSpec) -> JSMap<(n: Int, docs: Int, units: Int)> {
    var out = JSMap<(n: Int, docs: Int, units: Int)>(objectOrder: true)
    var configs: [String: ModalityConfig] = [:]
    for doc in scope.docs {
      if !spec.collSet.contains(doc.coll) || !spec.facetsPass(doc) { continue }
      if place(doc, spec.years) != "in" || exclusion(doc, scope.toggles) != nil { continue }
      let c = scope.collections[doc.coll]!
      let cfg = configs[c.modality] ?? ModalityConfig(scope, c.modality, spec.collIds)
      configs[c.modality] = cfg
      let m = measureDoc(doc, spec, cfg, scope.toggles)
      if !(m.units > 0) { continue }
      out.update(c.modality, default: (0, 0, 0)) {
        $0.n += m.n
        $0.docs += 1
        $0.units += m.units
      }
    }
    return out
  }

  /// `share(map, total)`: shares rounded to 4 decimals, positive entries only.
  static func share(_ map: JSMap<Int>, _ total: Int) -> JSMap<Double> {
    var out = JSMap<Double>(objectOrder: true)
    if !(total > 0) { return out }
    for (k, v) in map where v > 0 { out[k] = JSRound.fixed(Double(v) / Double(total), 4) }
    return out
  }

  /// `sliceStats(scope, spec, modality)`.
  static func stats(_ scope: Scope, _ spec: SliceSpec, _ modality: String) -> SliceStats {
    let cfg = ModalityConfig(scope, modality, spec.collIds)
    let st = SliceStats(spec: spec, cfg: cfg)
    let t = scope.toggles
    var otherConfigs: [String: ModalityConfig] = [:]
    for doc in scope.docs {
      if !spec.collSet.contains(doc.coll) || !spec.facetsPass(doc) { continue }
      let coll = scope.collections[doc.coll]!
      let place = place(doc, spec.years)
      if coll.modality != modality {
        if place == "in" && exclusion(doc, t) == nil {
          let oc = otherConfigs[coll.modality] ?? ModalityConfig(scope, coll.modality, spec.collIds)
          otherConfigs[coll.modality] = oc
          let m = measureDoc(doc, spec, oc, t)
          if m.units > 0 {
            st.otherModality.docs += 1
            st.otherModality.n += m.n
            st.otherModalities.update(coll.modality, default: 0) { $0 += 1 }
          }
        }
        continue
      }
      let m = measureDoc(doc, spec, cfg, t)
      if !(m.units > 0) && !(m.n > 0) { continue }
      let ex = exclusion(doc, t)
      if ex == nil { st.matching += 1 }
      if place == "out" { continue }
      if let ex {
        if place == "in" {
          st[bucket: ex].docs += 1
          st[bucket: ex].n += m.n
        }
        continue
      }
      if place == "undated" || place == "scheduled" {
        st[bucket: place].docs += 1
        st[bucket: place].n += m.n
        continue
      }
      if place == "wash" {
        st.washes.docs += 1
        st.washes.n += m.n
        continue
      }
      if !(m.units > 0) { continue }

      // included
      if doc.tr { st.translationsIncluded += 1 } else { st.unitsNoTr += m.units }
      st.units += m.units
      st.n += m.n
      st.names += m.names
      st.docs += 1
      st.collections.insert(coll.slug)
      if !st.sampling.contains(coll.id) { st.sampling.append(coll.id) }
      if doc.syn { st.synthetic = true }
      if doc.hasAuthor { st.authors.insert(doc.author!) }
      if m.n > 0 {
        st.k += 1
        st.evidenceDocs += 1
        if doc.hasAuthor { st.evidenceAuthors.insert(doc.author!) }
        if st.topDoc == nil || m.n > st.topDoc!.n { st.topDoc = (doc.id, m.n) }
      }
      st.perDoc.append((doc.id, m.units, m.n))
      for h in doc.hits {
        if !cfg.classes.contains(h.fc) && (h.fc == "describes" || h.fc == "apparatus")
          && (cfg.unit == "works" || spec.langOk(h.plang, h.fc, doc.langText)) {
          if h.fc == "describes" { st.describes += h.n } else { st.apparatus += h.n }
        }
      }
      for (plang, e) in m.byLang {
        let key = "\(doc.kind)|\(plang)|\(coll.slug)"
        st.strata.update(key, default: (0, 0, 0)) { s in
          s.units += e.units
          s.n += e.n
          if cfg.unit == "works" && e.n > 0 { s.k += 1 }
        }
        st.langs.update(plang, default: 0) { $0 += e.units }
      }
      st.kinds.update(doc.kind, default: 0) { $0 += m.units }
      st.colls.update(coll.slug, default: 0) { $0 += m.units }
      st.basis.update(doc.basis, default: 0) { $0 += 1 }
      let tk = doc.tercile.map(String.init) ?? "unknown"
      st.terciles.update(tk, default: (0, 0, 0)) { te in
        te.n += m.n
        te.units += m.units
        if m.n > 0 { te.k += 1 }
      }
      let gate = coll.coverageGate ?? (cfg.unit == "tokens" ? ModalityClasses.defaultGates.tokens
        : coll.sampling == "top_cited_per_cell" ? ModalityClasses.defaultGates.sampledWorks : ModalityClasses.defaultGates.works)
      st.gateUnits = max(st.gateUnits, gate)
    }
    if st.gateUnits == 0 {
      for id in spec.collIds {
        guard let c = scope.collections[id], c.modality == modality else { continue }
        st.gateUnits = max(st.gateUnits, c.coverageGate ?? (cfg.unit == "tokens" ? ModalityClasses.defaultGates.tokens
          : ModalityClasses.defaultGates.works))
      }
      if st.gateUnits == 0 { st.gateUnits = cfg.unit == "tokens" ? ModalityClasses.defaultGates.tokens : ModalityClasses.defaultGates.works }
    }
    st.rateN = cfg.unit == "tokens" ? st.n : st.k
    st.topDocShare = st.n > 0 && st.topDoc != nil ? Double(st.topDoc!.n) / Double(st.n) : nil
    st.dp = st.n > 0
      ? Intervals.griesDP(st.perDoc.map { (n: Double(cfg.unit == "tokens" ? $0.n : ($0.n > 0 ? 1 : 0)), size: Double($0.units)) })
      : nil
    st.mix = share(st.kinds, st.units)
    st.languages = share(st.langs, st.units)
    st.collectionMix = share(st.colls, st.units)
    st.basisMix = share(st.basis, st.docs)
    st.undatedShare = st.matching > 0 ? Double(st.undated.docs) / Double(st.matching) : 0
    var comp = JSMap<Double>(objectOrder: true)
    for (k, v) in st.strata { comp[k] = Double(v.units) }
    st.composition = comp
    st.selection = st.sampling.compactMap { scope.collections[$0] }
      .filter { !["complete", "user"].contains($0.sampling) }
      .map { c in (c.slug, c.sampling, samplingLabels[c.sampling] ?? c.sampling, c.selectionNote) }
    return st
  }
}
