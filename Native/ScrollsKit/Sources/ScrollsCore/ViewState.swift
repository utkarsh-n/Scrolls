// OWNER: N0
// The reproducible view state of src/shared/viewstate.mjs (SPEC §8.2, D17), grammar v1 unchanged on the phone
// (ΔS-18), so web and phone links are interchangeable. This file holds the typed state, its defaults and its JSON form
// (the object the reference hashes); ViewState+Canonical.swift ports canonicalize() and the filter grammar, and
// ViewState+Hash.swift the URL hash. Invariant (tested): decode(encode(s)) == canonicalize(s).

/// A canonical view state (`ViewState` typedef of the reference). Build one through `canonicalize`, `defaultState`
/// or `init(hash:)`; `hash` and `stateHash` canonicalize first, as the reference does.
public struct ViewState: Sendable, Equatable {
  /// `VIEWSTATE_VERSION`.
  public static let version = 1
  /// Days per year of the axis arithmetic.
  public static let daysPerYear = 365.2425
  /// `AXIS_LIMITS`: the pan and zoom domain, 10000 BCE – 2100 CE; 0.05 px/year … 40 px/day.
  public static let minDay = DayMath.dayFromYMD(-9999, 1, 1)
  public static let maxDay = DayMath.dayFromYMD(2100, 12, 31)
  public static let minDaysPerPx = 1.0 / 40
  public static let maxDaysPerPx = daysPerYear / 0.05
  /// `VANTAGE_OPEN_DAY`: the vantage meaning "everything is visible".
  public static let vantageOpenDay = maxDay
  /// `MAX_STRANDS`.
  public static let maxStrands = 4
  public static let inspectorModes = ["tnn", "reader"]
  public static let reducedMotionModes = ["system", "on", "off"]

  /// A strand id: numeric strands carry a positive integer, the others a short string.
  public enum StrandID: Sendable, Hashable {
    case number(Int)
    case string(String)
  }

  /// Which variants an expression strand counts.
  public enum Variants: Sendable, Hashable {
    case `default`, identity, all
    case ids([Int])
  }

  public struct Strand: Sendable, Hashable {
    public var type: String
    public var id: StrandID
    public var variants: Variants
    public var glyph: String
    public init(type: String, id: StrandID, variants: Variants, glyph: String) {
      self.type = type
      self.id = id
      self.variants = variants
      self.glyph = glyph
    }
  }

  public struct Lanes: Sendable, Hashable {
    public var facet: String
    public var sub: String?
    public var run: Int?
    public var order: String
    public var manual: [String]
    public var max: Int
    public init(facet: String, sub: String?, run: Int?, order: String, manual: [String], max: Int) {
      self.facet = facet
      self.sub = sub
      self.run = run
      self.order = order
      self.manual = manual
      self.max = max
    }
  }

  /// `ViewState.f`: the filter grammar's lists (sorted, unique) and the synthetic switch.
  public struct Filters: Sendable, Hashable {
    public var lang: [String] = [], kind: [String] = [], coll: [String] = [], culture: [String] = [], field: [String] = []
    public var community: [String] = [], basis: [String] = []
    public var syn: Int = 1
    public init() {}

    subscript(list key: String) -> [String] {
      get {
        switch key {
        case "lang": lang
        case "kind": kind
        case "coll": coll
        case "culture": culture
        case "field": field
        case "community": community
        case "basis": basis
        default: []
        }
      }
      set {
        switch key {
        case "lang": lang = newValue
        case "kind": kind = newValue
        case "coll": coll = newValue
        case "culture": culture = newValue
        case "field": field = newValue
        case "community": community = newValue
        case "basis": basis = newValue
        default: break
        }
      }
    }
  }

  public enum Axis: Sendable, Hashable {
    case linear(centerDay: Int, daysPerPx: Double, keepLinear: Bool)
    case folded
  }

  public struct Vantage: Sendable, Hashable {
    public var day: Int
    public var strict: Bool
    public init(day: Int, strict: Bool) {
      self.day = day
      self.strict = strict
    }
  }

  public enum SelectionID: Sendable, Hashable {
    case number(Int)
    case string(String)
  }

  public struct Selection: Sendable, Hashable {
    public var type: String
    public var id: SelectionID
    public init(type: String, id: SelectionID) {
      self.type = type
      self.id = id
    }
  }

  public struct Panels: Sendable, Hashable {
    public var inspector: String?
    public var right: String?
    public init(inspector: String?, right: String?) {
      self.inspector = inspector
      self.right = right
    }
  }

  public struct Slice: Sendable, Hashable {
    public var years: [Int]
    public var f: String
    public init(years: [Int], f: String) {
      self.years = years
      self.f = f
    }
  }

  public struct Compare: Sendable, Hashable {
    public var a: Slice
    public var b: Slice
    public init(a: Slice, b: Slice) {
      self.a = a
      self.b = b
    }
  }

  public struct Constellation: Sendable, Hashable {
    public var layoutKey: String?
    public var size: String
    public var a: [Int]?
    public var b: [Int]?
    public init(layoutKey: String?, size: String, a: [Int]?, b: [Int]?) {
      self.layoutKey = layoutKey
      self.size = size
      self.a = a
      self.b = b
    }
  }

  public struct Lineage: Sendable, Hashable {
    public var root: String?
    public var depth: Int
    public var types: [String]
    public var status: [String]
    public init(root: String?, depth: Int, types: [String], status: [String]) {
      self.root = root
      self.depth = depth
      self.types = types
      self.status = status
    }
  }

  public struct Runs: Sendable, Hashable {
    /// Expression id → materialize run id.
    public var materialize: [Int: Int]
    public var cluster: Int?
    public var quotes: Int?
    public var vectors: Int?
    public init(materialize: [Int: Int], cluster: Int?, quotes: Int?, vectors: Int?) {
      self.materialize = materialize
      self.cluster = cluster
      self.quotes = quotes
      self.vectors = vectors
    }
  }

  public var corpus: String
  public var strands: [Strand]
  public var lanes: Lanes
  public var f: Filters
  /// TOGGLE_DEFAULTS keys (tr, ds, ap, dup, nm, est, bp) → 0/1.
  public var toggles: [String: Int]
  public var timeBasis: String
  public var axis: Axis
  public var tier: String
  public var vantage: Vantage
  public var range: [Int]?
  /// documented, computed, proposed, rejected, kindred → 0/1.
  public var evidence: [String: Int]
  /// arcs, feedback, washes, coverage, etymology, claims, baseline, variety, tone, superseded → 0/1.
  public var layers: [String: Int]
  public var selection: Selection?
  public var panels: Panels
  public var compare: Compare?
  public var constellation: Constellation
  public var lineage: Lineage
  public var runs: Runs
  public var asSaved: Bool
  /// The viewer's own setting; never part of a link or of `stateHash`.
  public var reducedMotion: String

  static let evidenceKeys = ["documented", "computed", "proposed", "rejected", "kindred"]
  static let evidenceLetters = ["d", "c", "p", "r", "k"]
  static let layerKeys = ["arcs", "feedback", "washes", "coverage", "etymology", "claims", "baseline", "variety", "tone", "superseded"]
  static let layerLetters = ["a", "f", "w", "c", "e", "k", "b", "v", "t", "s"]
  static let numericStrands: Set<String> = ["expression", "work", "cluster", "baseline"]
  static let variantModes = ["default", "identity", "all"]

  /// `defaultState(corpus)`: the demo opens on "carry the zero" territory (1890–2030, lanes = community, vantage 1925);
  /// real corpora open 1800–2030 with lanes = domain and no vantage limit; the virtual corpus `real` opens on the Term
  /// trail lanes.
  public static func defaultState(_ corpus: String = "demo") -> ViewState {
    let demo = corpus == "demo"
    return ViewState(
      corpus: corpus, strands: [],
      lanes: Lanes(facet: demo ? "community" : corpus == "real" ? "trail" : "domain", sub: nil, run: nil, order: "first_observed",
                   manual: [], max: 10),
      f: Filters(), toggles: Dictionary(uniqueKeysWithValues: zip(Vocab.toggleDefaults.keys, Vocab.toggleDefaults.values)),
      timeBasis: "publication",
      axis: demo ? .linear(centerDay: DayMath.dayFromYMD(1960, 1, 1), daysPerPx: 50, keepLinear: false)
        : .linear(centerDay: DayMath.dayFromYMD(1915, 1, 1), daysPerPx: 75, keepLinear: false),
      tier: "auto",
      // paused is context (§1.9): a link without t= opens in context, so a selected later mark is ghosted, never hidden
      vantage: Vantage(day: demo ? DayMath.dayFromYMD(1925, 12, 31) : vantageOpenDay, strict: false),
      range: nil,
      evidence: ["documented": 1, "computed": 1, "proposed": 1, "rejected": 0, "kindred": 0],
      layers: ["arcs": 1, "feedback": 1, "washes": 1, "coverage": 1, "etymology": 1, "claims": 1, "baseline": 0, "variety": 0,
               "tone": 0, "superseded": 0],
      selection: nil, panels: Panels(inspector: "tnn", right: nil), compare: nil,
      constellation: Constellation(layoutKey: nil, size: "occurrences", a: nil, b: nil),
      lineage: Lineage(root: nil, depth: 2, types: [], status: []),
      runs: Runs(materialize: [:], cluster: nil, quotes: nil, vectors: nil),
      asSaved: false, reducedMotion: "system")
  }

  /// A copy with every field validated, defaulted and canonical (`canonicalize(state)`).
  public func canonicalized() -> ViewState {
    var w: [String] = []
    return ViewState.canonicalize(jsonValue, warnings: &w)
  }

  /// `stateHash(state)`: 16 hex digits of the canonical state with the viewer's reduced-motion setting reset
  /// (saved_view.state_hash; a reload must reproduce it).
  public var stateHash: String {
    var s = canonicalized()
    s.reducedMotion = "system"
    return IDs.shortHash(CanonicalJSON.string(s.jsonValue), length: 16)
  }
}

// MARK: - JSON form (the reference's object)

extension ViewState {
  /// The state as the reference's JavaScript object: what `canonicalJson` hashes and what saved views store.
  public var jsonValue: JSONValue {
    func ints(_ a: [Int]) -> JSONValue { .array(a.map { .number(Double($0)) }) }
    func int(_ v: Int?) -> JSONValue { v.map { .number(Double($0)) } ?? .null }
    func str(_ v: String?) -> JSONValue { v.map(JSONValue.string) ?? .null }
    func bits(_ d: [String: Int]) -> JSONValue { .object(JSONObject(d.mapValues { .number(Double($0)) })) }
    let strandsJSON: [JSONValue] = strands.map { s in
      let id: JSONValue = switch s.id {
      case .number(let n): .number(Double(n))
      case .string(let t): .string(t)
      }
      let variants: JSONValue = switch s.variants {
      case .default: "default"
      case .identity: "identity"
      case .all: "all"
      case .ids(let a): ints(a)
      }
      return ["type": .string(s.type), "id": id, "variants": variants, "glyph": .string(s.glyph)]
    }
    let axisJSON: JSONValue = switch axis {
    case .folded: ["mode": "folded"]
    case .linear(let c, let d, let k): ["mode": "linear", "centerDay": .number(Double(c)), "daysPerPx": .number(d), "keepLinear": .bool(k)]
    }
    let selectionJSON: JSONValue = selection.map { s in
      let id: JSONValue = switch s.id {
      case .number(let n): .number(Double(n))
      case .string(let t): .string(t)
      }
      return ["type": .string(s.type), "id": id]
    } ?? .null
    let fJSON: JSONValue = .object([
      "lang": .array(f.lang.map(JSONValue.string)), "kind": .array(f.kind.map(JSONValue.string)),
      "coll": .array(f.coll.map(JSONValue.string)), "culture": .array(f.culture.map(JSONValue.string)),
      "field": .array(f.field.map(JSONValue.string)), "community": .array(f.community.map(JSONValue.string)),
      "basis": .array(f.basis.map(JSONValue.string)), "syn": .number(Double(f.syn)),
    ])
    let compareJSON: JSONValue = compare.map { c in
      ["a": ["years": ints(c.a.years), "f": .string(c.a.f)], "b": ["years": ints(c.b.years), "f": .string(c.b.f)]]
    } ?? .null
    return .object([
      "v": .number(Double(ViewState.version)),
      "corpus": .string(corpus),
      "strands": .array(strandsJSON),
      "lanes": ["facet": .string(lanes.facet), "sub": str(lanes.sub), "run": int(lanes.run), "order": .string(lanes.order),
                "manual": .array(lanes.manual.map(JSONValue.string)), "max": .number(Double(lanes.max))],
      "f": fJSON,
      "toggles": bits(toggles),
      "timeBasis": .string(timeBasis),
      "axis": axisJSON,
      "tier": .string(tier),
      "vantage": ["day": .number(Double(vantage.day)), "strict": .bool(vantage.strict)],
      "range": range.map(ints) ?? .null,
      "evidence": bits(evidence),
      "layers": bits(layers),
      "selection": selectionJSON,
      "panels": ["inspector": str(panels.inspector), "right": str(panels.right)],
      "compare": compareJSON,
      "constellation": ["layoutKey": str(constellation.layoutKey), "size": .string(constellation.size),
                        "a": constellation.a.map(ints) ?? .null, "b": constellation.b.map(ints) ?? .null],
      "lineage": ["root": str(lineage.root), "depth": .number(Double(lineage.depth)),
                  "types": .array(lineage.types.map(JSONValue.string)), "status": .array(lineage.status.map(JSONValue.string))],
      "runs": ["materialize": .object(JSONObject(runs.materialize.map { (String($0.key), JSONValue.number(Double($0.value))) })),
               "cluster": int(runs.cluster), "quotes": int(runs.quotes), "vectors": int(runs.vectors)],
      "asSaved": .bool(asSaved),
      "reducedMotion": .string(reducedMotion),
    ])
  }
}

extension ViewState: Codable {
  /// Decodes any JSON object and canonicalizes it (never fails on content, as the reference never throws).
  public init(from decoder: any Decoder) throws {
    var w: [String] = []
    self = ViewState.canonicalize(try JSONValue(from: decoder), warnings: &w)
  }

  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }
}
