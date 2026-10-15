// OWNER: Q (created by the bring-up, B2)
// The pure Qwen layer, without MLX: templates and windows, pooling arithmetic, k-means, plans and policy, the label
// schema and validator, the grounding verifier, the model catalogue and sha verification, the demo's pure steps.

import Foundation
import ScrollsCore
@testable import ScrollsQwen
import Testing

private func fixture(_ name: String) throws -> URL {
  try #require(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"))
}

@Suite("Templates and windows")
struct TemplateTests {
  @Test func r1TemplateIsTheLabsInstr() {
    let text = "He sat on the bank of the river."
    let w = ContextWindow.make(passageText: text, target: 14..<18, rule: .words(24))
    #expect(w.mid == "bank")
    #expect(EmbeddingTemplate.occInstr1.render(w, expression: "bank")
      == "Instruct: Represent the meaning of the word 'bank' in this passage\nQuery: He sat on the bank of the river.")
    #expect(EmbeddingTemplate.occInstr1.render(w, expression: "carry the zero").contains("of the expression 'carry the zero'"))
    #expect(EmbeddingTemplate.renderQuery("why?") == "Instruct: Given a question, retrieve passages that answer the question\nQuery: why?")
  }

  @Test func windowClipsToWordsAndCollapsesWhitespace() {
    let words = (1...40).map { "w\($0)" }
    let text = words[0..<30].joined(separator: " ") + "  the\n\nbank   " + words[30...].joined(separator: "\t")
    let start = (text as NSString).range(of: "bank").location
    let w = ContextWindow.make(passageText: text, target: start..<(start + 4), rule: .words(3))
    #expect(w.left == "w29 w30 the ")
    #expect(w.mid == "bank")
    #expect(w.right == " w31 w32 w33")
    #expect(w.clippedLeft && w.clippedRight)
    #expect(w.wordsLeft == 3 && w.wordsRight == 3)
    let whole = ContextWindow.make(passageText: "  bank  ", target: 2..<6, rule: .words(24))
    #expect(whole.text == "bank")
    #expect(!whole.clippedLeft && !whole.clippedRight)
    #expect(whole.isThin)
  }

  @Test func fitShrinksSymmetricallyUnderTheCap() {
    let words = (1...100).map { "word\($0)" }
    let text = words[0..<50].joined(separator: " ") + " bank " + words[50...].joined(separator: " ")
    let start = (text as NSString).range(of: " bank ").location + 1
    // a fake tokenizer: one token per space-separated piece
    let count: (String) -> Int = { $0.split(separator: " ").count }
    let fit = EmbeddingInput.fit(id: "x", passageText: text, target: start..<(start + 4), expression: "bank",
                                 words: 24, maxTokens: 40, count: count)
    #expect(count(fit.input) + 1 <= 40)
    #expect(fit.words < 24)
    let roomy = EmbeddingInput.fit(id: "y", passageText: text, target: start..<(start + 4), expression: "bank",
                                   words: 24, maxTokens: 128, count: count)
    #expect(roomy.words == 24)
  }

  @Test func representationKeyRoundTrips() {
    #expect(RepresentationKey.r1.description == "qe06-q8@fe956e8d/occ-instr@1/w24w/d256")
    #expect(RepresentationKey("qe06-q8@fe956e8d/occ-instr@1/w24w/d256") == .r1)
    #expect(RepresentationKey("qe06-q8@fe956e8d/doc@1/w32t/d256")?.window == .qwenTokens(32))
    #expect(RepresentationKey("nonsense") == nil)
  }
}

@Suite("Vectors and groups")
struct VectorTests {
  @Test func matryoshkaCutRenormalises() {
    let v: [Float] = [3, 4, 12, 0]
    let cut = VectorMath.matryoshka(v, dims: 2)
    #expect(abs(cut[0] - 0.6) < 1e-6 && abs(cut[1] - 0.8) < 1e-6)
    #expect(abs(VectorMath.norm(VectorMath.normalized(v)) - 1) < 1e-6)
    #expect(abs(VectorMath.cosine([1, 0], [0, 1])) < 1e-12)
  }

  @Test func centringRemovesTheMean() {
    let rows: [[Float]] = [[1, 0.1], [1, -0.1]]
    let c = VectorMath.centred(rows)
    #expect(abs(c[0][0]) < 1e-6 && abs(c[0][1] - 1) < 1e-6)
    #expect(abs(c[1][1] + 1) < 1e-6)
  }

  @Test func kMeansFindsTwoSeparatedGroupsDeterministically() {
    var rows: [[Float]] = []
    var truth: [Int] = []
    var rng = Mulberry32(seed: 9)
    for i in 0..<40 {
      let a = i < 20 ? 0.0 : Double.pi / 2
      let jitter = (rng.next() - 0.5) * 0.3
      rows.append(VectorMath.normalized([Float(cos(a + jitter)), Float(sin(a + jitter)), Float(rng.next() * 0.05)]))
      truth.append(i < 20 ? 0 : 1)
    }
    let a = SphericalKMeans.fit(rows, k: 2, seed: 42)
    let b = SphericalKMeans.fit(rows, k: 2, seed: 42)
    #expect(a == b)
    #expect(ARI.score(a.labels, truth) == 1)
    #expect(SphericalKMeans.silhouette(rows, labels: a.labels) > 0.5)
    let gate = GateCheck.evaluate(rows, documents: (0..<40).map(Int64.init), k: 2, thresholds: GateThresholds.forKey(.r1)!)
    #expect(gate.passes, "\(gate)")
  }

  @Test func ariBasics() {
    #expect(ARI.score([0, 0, 1, 1], [1, 1, 0, 0]) == 1)
    #expect(ARI.score([0, 0, 1, 1], [0, 1, 0, 1]) < 0)
  }
}

@Suite("Plans and policy")
struct PolicyTests {
  @Test func batchesSortByLengthThenIndex() {
    let plan = BatchPlan.standard
    #expect(plan.key == "b8/len/right/128")
    let b = BatchPlan(batchSize: 2).batches(tokenCounts: [5, 3, 5, 1, 9])
    #expect(b == [[3, 1], [0, 2], [4]])
    #expect(BatchPlan.interactive.batchSize == 4)
  }

  @Test func prefillStepFollowsTheLab() {
    #expect(PrefillPlan.step(promptTokens: 550) == 256)
    #expect(PrefillPlan.step(promptTokens: 1_024) == 256)
    #expect(PrefillPlan.step(promptTokens: 1_025) == 128)
  }

  @Test func admissionCountsGrowthOnceLoaded() {
    let b = QwenBudgets.provisional.generator
    #expect(ModelAdmission.canLoad(b, available: 4_000_000_000, headroom: 600_000_000) == .admit)
    #expect(ModelAdmission.canLoad(b, available: 3_000_000_000, headroom: 600_000_000)
      == .refuse(needed: 3_565_000_000, available: 3_000_000_000))
    #expect(ModelAdmission.canLoad(b, available: nil, headroom: 600_000_000) == .admit)
    #expect(ModelAdmission.heldAfterLoad(b, measuredResidentDelta: 2_200_000_000, measuredPeak: 3_100_000_000) == 900_000_000)
    #expect(ModelAdmission.heldAfterLoad(b, measuredResidentDelta: 2_200_000_000, measuredPeak: nil) == 700_000_000)
  }

  @Test func memoryPolicyUnloadsAndRestricts() {
    #expect(QwenMemoryPolicy.action(for: .background) == .unload(.background))
    #expect(QwenMemoryPolicy.action(for: .memoryWarning) == .unload(.memoryWarning))
    #expect(QwenMemoryPolicy.action(for: .memoryPressureCritical) == .unload(.memoryPressureCritical))
    #expect(QwenMemoryPolicy.action(for: .thermal(.critical)) == .unload(.thermalCritical))
    #expect(QwenMemoryPolicy.action(for: .thermal(.serious)) == .restrict(.serious))
    #expect(QwenMemoryPolicy.action(for: .thermal(.nominal)) == .none)
    #expect(!QwenMemoryPolicy.mayStart(.labels, generation: true, thermal: .serious, lowPower: false, explicitRequest: true))
    #expect(QwenMemoryPolicy.mayStart(.waiting, generation: true, thermal: .serious, lowPower: false, explicitRequest: true))
    #expect(!QwenMemoryPolicy.mayStart(.reading, generation: false, thermal: .nominal, lowPower: true, explicitRequest: false))
    #expect(QwenMemoryPolicy.restAfterBatch(batchSeconds: 1, thermal: .fair) == 0.2)
    #expect(ResidencyPolicy.standard.cacheLimitBytes == 16 << 20)
  }

  @Test func yieldWaitsWhileInteracting() {
    #expect(YieldPolicy.nextBatch(interacting: true, scrollVisible: true, thermal: .nominal, lowPower: false, priority: .waiting) == nil)
    #expect(YieldPolicy.nextBatch(interacting: false, scrollVisible: true, thermal: .nominal, lowPower: false, priority: .reading) == .interactive)
    #expect(YieldPolicy.nextBatch(interacting: false, scrollVisible: false, thermal: .nominal, lowPower: false, priority: .readAll) == .standard)
    let s = InteractionSignal()
    s.set(interacting: true, scrollVisible: true)
    #expect(s.interacting && s.scrollVisible)
    let t0 = Date()
    s.waitWhileInteracting(limit: 0.05)
    #expect(Date().timeIntervalSince(t0) >= 0.04)
  }

  @Test func gateThresholdsAreFrozenPerKey() {
    let g = GateThresholds.forKey(.r1)
    #expect(g?.minStability == 0.8 && g?.minMargin == 0.03 && g?.floor == 0.10 && g?.provisional == true)
    #expect(GateThresholds.forKey(RepresentationKey(model: "x", sha8: "y", template: "z", window: .passage, dims: 256)) == nil)
  }
}

@Suite("Schema, validator and verifier")
struct GenerateTests {
  let ids = ["P1", "P2", "P3", "P4", "P5"]

  @Test func everySchemaVariantIsValidJSON() throws {
    for v in LabelSchema.Variant.allCases {
      let s = LabelSchema.json(ids: ids, variant: v)
      let obj = try #require(try JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any])
      let props = try #require(obj["properties"] as? [String: Any])
      let cites = try #require(props["cites"] as? [String: Any])
      let items = try #require(cites["items"] as? [String: Any])
      #expect(items["enum"] as? [String] == ids)
      let label = try #require(props["label"] as? [String: Any])
      switch v {
      case .unicodeDigitClass: #expect(label["pattern"] as? String == #"^[^\p{Nd}\s]+( [^\p{Nd}\s]+){0,4}$"#)
      case .explicitDigitRanges: #expect((label["pattern"] as? String)?.contains("\u{0966}-\u{096F}") == true)
      case .noPatterns: #expect(label["pattern"] == nil)
      }
    }
  }

  @Test func validatorAcceptsAGoodLabel() throws {
    let raw = #"{"label": "edge of a river", "gloss": "The raised ground along a stream, where people sit or land boats.", "cites": ["P1", "P3"]}"#
    let out = try LabelValidator.validate(raw: raw, ids: ids).get()
    #expect(out.label == "edge of a river")
    #expect(LabelValidator.canonical(out) == #"{"cites":["P1","P3"],"gloss":"The raised ground along a stream, where people sit or land boats.","label":"edge of a river"}"#)
  }

  @Test func validatorRejects() {
    func reasons(_ raw: String) -> [String] {
      if case .failure(let r) = LabelValidator.validate(raw: raw, ids: ids) { return r.reasons }
      return []
    }
    #expect(reasons("not json").first == "not a JSON object")
    #expect(reasons(#"{"label":"money in 1890","gloss":"x","cites":["P1","P2"]}"#).contains("label has a digit"))
    #expect(reasons(#"{"label":"a b c d e f","gloss":"x","cites":["P1","P2"]}"#).contains("label longer than 5 words"))
    #expect(reasons(#"{"label":"bank","gloss":"x","cites":["P1","P9"]}"#).contains { $0.contains("P9") })
    #expect(reasons(#"{"label":"bank","gloss":"x","cites":["P1"]}"#).contains { $0.contains("needs 2–4") })
    #expect(reasons(#"{"label":"bank","gloss":"x","cites":["P1","P2"],"kind":"usage"}"#).contains { $0.hasPrefix("keys") })
    #expect(reasons(#"{"label":"bank","gloss":"in ١٩٠٠","cites":["P1","P2"]}"#).contains("gloss has a digit"))
  }

  @Test func verifierWithholdsWhatIsNotGrounded() {
    let ps = [PromptPassage(id: "P1", slot: "{A}", source: "book", title: "T", text: "He sat on the bank by the Thames."),
              PromptPassage(id: "P2", slot: "{B}", source: "book", title: "T", text: "The bank of the stream was steep.")]
    let ok = Verifier.verifyLabel(LabelOutput(label: "river edge", gloss: "The ground beside the Thames or a stream.", cites: ["P1", "P2"]), passages: ps)
    #expect(ok.verdict == .shown && ok.gloss != nil)
    let name = Verifier.verifyLabel(LabelOutput(label: "river edge", gloss: "The banks of the Danube.", cites: ["P1", "P2"]), passages: ps)
    #expect(name.verdict == .partlyWithheld && name.gloss == nil && name.label == "river edge")
    let cause = Verifier.verifyLabel(LabelOutput(label: "river edge", gloss: "Used because rivers flood.", cites: ["P1"]), passages: ps)
    #expect(cause.verdict == .partlyWithheld)
    let century = Verifier.verifyLabel(LabelOutput(label: "river edge", gloss: "A nineteenth century usage, from the second book.", cites: ["P1"]), passages: ps)
    #expect(century.gloss == nil)
    let refused = Verifier.verifyLabel(LabelOutput(label: "first bank", gloss: "x", cites: ["P1", "P2"]), passages: ps)
    #expect(refused.verdict == .refused && refused.label == nil)
  }

  @Test func quotesMatchVerbatim() {
    let p = "She said, \u{201C}the bank\n  is closed\u{201D} and left."
    let r = QuoteMatcher.match("\"the bank is closed\"", in: p)
    #expect(r != nil)
    if let r { #expect(String(decoding: Array(p.utf16)[r], as: UTF16.self) == "\u{201C}the bank\n  is closed\u{201D}") }
    #expect(QuoteMatcher.match("the bank is open", in: p) == nil)
    #expect(QuoteMatcher.match("The bank", in: p) == nil)
  }

  @Test func labelPromptRendersFromTheResource() {
    let ps = [PromptPassage(id: "P1", slot: "{A}", source: "book (Project Gutenberg)", title: "Emma", text: "… the bank …")]
    let p = PromptLibrary.label(word: "bank", computedWords: ["river", "water"], passages: ps)
    #expect(p.promptID == "label@1")
    #expect(p.system.hasPrefix("You label groups of uses of one word"))
    #expect(p.user.contains("Word: \"bank\""))
    #expect(p.user.contains("(computed): river, water"))
    #expect(p.user.contains("One passages from this group:") || p.user.contains("One passage"))
    #expect(p.user.contains("[P1] (period {A}; book (Project Gutenberg); title: Emma) … the bank …"))
    #expect(!p.user.contains("{{"))
    #expect(p.promptSHA256.count == 64)
    let chat = QwenChat.render(system: "S", user: "U")
    #expect(chat == "<|im_start|>system\nS<|im_end|>\n<|im_start|>user\nU<|im_end|>\n<|im_start|>assistant\n")
  }

  @Test func periodSlotsFollowDateOrder() {
    #expect(PromptLibrary.slots(years: [1890, nil, 1850, 1890]) == ["{B}", "{U}", "{A}", "{B}"])
  }
}

@Suite("Models")
struct ModelTests {
  @Test func catalogueIsConsistent() {
    for spec in ModelCatalog.all {
      #expect(spec.bytes == spec.files.reduce(0) { $0 + $1.bytes }, "\(spec.name)")
      #expect(spec.weights?.sha256 == spec.sha256)
      #expect(spec.files.allSatisfy { $0.sha256.count == 64 && $0.sha256.allSatisfy(\.isHexDigit) })
      #expect(Set(spec.files.map(\.name)).count == spec.files.count)
    }
    #expect(ModelCatalog.embedder.sha8 == "fe956e8d" && ModelCatalog.generator.sha8 == "713fe7e5")
    #expect(ModelCatalog.generator4B.sha8 == "5fb9acd0")
  }

  @Test func verifyHashesThenTrustsTheStamp() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("qwen-verify-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let a = Data("alpha".utf8), b = Data(repeating: 7, count: 3 << 20)
    try a.write(to: dir.appendingPathComponent("a.json"))
    try b.write(to: dir.appendingPathComponent("model.safetensors"))
    let shaA = try #require(ModelVerify.sha256(of: dir.appendingPathComponent("a.json")))
    let shaB = try #require(ModelVerify.sha256(of: dir.appendingPathComponent("model.safetensors")))
    #expect(shaA == IDs.sha256Hex("alpha"))
    let spec = ModelSpec(name: "toy", role: .embedder, sha256: shaB, bytes: a.count + b.count, upstream: "test", display: "toy",
                         files: [ModelFile("a.json", a.count, shaA), ModelFile("model.safetensors", b.count, shaB)])
    let first = ModelVerify.verify(folder: dir, spec: spec)
    #expect(first.ok && first.hashedNow)
    let second = ModelVerify.verify(folder: dir, spec: spec)
    #expect(second.ok && !second.hashedNow)
    try Data("alphA".utf8).write(to: dir.appendingPathComponent("a.json"))
    let tampered = ModelVerify.verify(folder: dir, spec: spec)
    #expect(!tampered.ok && tampered.hashedNow)
    #expect(tampered.files.first { $0.name == "a.json" }?.status == .wrongSHA)
    // rule 25: the file check's words never include "verified"
    for r in [first, second, tampered] { #expect(!r.summary.lowercased().contains("verified")) }
    try FileManager.default.removeItem(at: dir.appendingPathComponent("a.json"))
    #expect(ModelVerify.verify(folder: dir, spec: spec).files.first { $0.name == "a.json" }?.status == .missing)
  }
}

@Suite("Bank demo")
struct DemoTests {
  @Test func fixtureHoldsSixtyRealPassages() throws {
    let set = try DemoSet.load(fixture("bank-demo.json"))
    #expect(set.passages.count == 60)
    #expect(Set(set.passages.map(\.documentID)).count == 60, "one occurrence per book")
    for p in set.passages {
      let u = Array(p.text.utf16)
      let mid = Fold.fold(String(decoding: u[p.matchStart..<p.matchEnd], as: UTF16.self))
      #expect(mid.hasPrefix("bank"), "\(p.id): \(mid)")
      #expect(p.title?.isEmpty == false)
      #expect(p.license == "Public domain in the USA (Project Gutenberg)")
      #expect(p.yearLo != nil)
    }
    let inputs = set.passages.map { p in
      EmbeddingInput.fit(id: p.id, passageText: p.text, target: p.target, expression: set.word, count: { $0.utf8.count / 4 })
    }
    #expect(inputs.allSatisfy { $0.input.hasPrefix("Instruct: Represent the meaning of the word 'bank' in this passage\nQuery: ") })
  }

  @Test func groupingIsDeterministicAndCardsHaveFive() throws {
    let set = try DemoSet.load(fixture("bank-demo.json"))
    // synthetic vectors standing in for the model: two directions by whether "river" or "money"-like words are near
    var rng = Mulberry32(seed: 3)
    let vectors: [[Float]] = set.passages.indices.map { i in
      let base: [Float] = i % 2 == 0 ? [1, 0, 0, 0] : [0, 1, 0, 0]
      return VectorMath.normalized(base.map { $0 + Float(rng.next() * 0.2) })
    }
    let a = DemoGrouping.make(set, vectors: vectors)
    let b = DemoGrouping.make(set, vectors: vectors)
    #expect(a == b)
    #expect(a.groups.count == 2)
    #expect(a.groups.allSatisfy { $0.cardMembers.count == 5 })
    #expect(a.groups.map(\.members.count).reduce(0, +) == 60)
    let pp = DemoGrouping.promptPassages(a.groups[0], set: set)
    #expect(pp.map(\.id) == ["P1", "P2", "P3", "P4", "P5"])
    #expect(pp.allSatisfy { $0.slot.hasPrefix("{") && $0.text.contains("ank") })
  }
}

@Suite("Copy")
struct CopyTests {
  @Test func runtimeCheckHeaderIsTheSpecsOnThePhone() {
    #expect(QwenCopy.runtimeCheckHeader(passages: 60, builtOn: .device)
      == "Runtime check: two groups forced (k = 2) on 60 passages, with no reliability test. This shows that Qwen runs on this iPhone; it is not how Scrolls finds context groups.")
    #expect(!QwenCopy.runtimeCheckHeader(passages: 60, builtOn: .simulator).contains("this iPhone"))
  }

  @Test func machineCardWordsAreRule27s() {
    #expect(QwenCopy.machineFooter(.device)
      == "Machine reading by Qwen3-4B (2025), on this iPhone — not evidence. A modern model's reading of these passages: it can be wrong, and it reads old text with today's sense of words. Quotes and dates come from the atlas, not the model.")
    #expect(QwenCopy.machineBadge(.device) == "machine reading (Qwen3-4B, on this iPhone) — not evidence")
    #expect(QwenCopy.machineChip == "machine reading")
    #expect(!QwenCopy.machineFooter(.simulator).contains("this iPhone"))
  }
}
