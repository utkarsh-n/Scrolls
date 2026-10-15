// OWNER: Q (created by the bring-up, B2)
// scrolls-qwen: the Swift runtime on the Mac (MLX on the Mac's GPU), for checks that need the Python reference.
//   scrolls-qwen windows  --models ROOT --occurrences X.json --out inputs.json
//        R1 inputs (occ-instr@1, ±24 engine words, ≤ 128 Qwen tokens) for every occurrence of a qwen-ref.py file
//   scrolls-qwen embed    --models ROOT --in inputs.json --out vectors.json [--batch 8] [--dims 256]
//        Swift vectors for exactly those inputs (compare with `qwen-ref.py embed` + `compare`: S6 on the Mac)
//   scrolls-qwen demo     --models ROOT --demo bank-demo.json --out report.json
//   scrolls-qwen selftest --models ROOT --demo bank-demo.json [--parity qwen-parity.json] --out selftest.json

import Foundation
import ScrollsQwen
import ScrollsQwenRuntime

struct Args {
  var command = ""
  var options: [String: String] = [:]
  init(_ argv: [String]) {
    var i = 1
    if argv.count > 1 { command = argv[1]; i = 2 }
    while i < argv.count {
      let k = argv[i]
      if k.hasPrefix("--"), i + 1 < argv.count { options[String(k.dropFirst(2))] = argv[i + 1]; i += 2 } else { i += 1 }
    }
  }
  func url(_ k: String) -> URL? { options[k].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) } }
  func int(_ k: String, _ d: Int) -> Int { options[k].flatMap(Int.init) ?? d }
}

struct InputsFile: Codable { var schema: String; var inputs: [EmbeddingInput] }
struct OccurrencesFile: Codable { var schema: String; var passages: [DemoPassage] }
struct VectorRecord: Codable { var id: String; var tokens: Int; var vector: [Float] }
struct VectorsFile: Codable {
  var schema: String; var runtime: String; var plan: String; var dims: Int
  var load_seconds: Double; var embed_seconds: Double; var vectors: [VectorRecord]
}

func fail(_ s: String) -> Never {
  FileHandle.standardError.write(Data((s + "\n").utf8))
  exit(2)
}

let args = Args(CommandLine.arguments)
let models = args.url("models") ?? URL(fileURLWithPath: NSHomeDirectory() + "/Developer/scrolls-models")
let runtime = MLXQwenRuntime(modelsRoot: models)
let log: @Sendable (DemoStep) -> Void = { s in
  FileHandle.standardError.write(Data(("· " + s.text + (s.fraction.map { String(format: " (%.0f%%)", $0 * 100) } ?? "") + "\n").utf8))
}

switch args.command {
case "windows":
  guard let occ = args.url("occurrences"), let out = args.url("out") else { fail("windows --occurrences X --out Y") }
  let file = try JSONDecoder().decode(OccurrencesFile.self, from: Data(contentsOf: occ))
  var inputs: [EmbeddingInput] = []
  // group by word so each set renders with its own expression
  for word in Set(file.passages.map(\.word)).sorted() {
    let ps = file.passages.filter { $0.word == word }
    let set = DemoSet(schema: "x", word: word, source: "", selection: "", snapshot: "", occurrencesTotal: ps.count, passages: ps)
    inputs += try await QwenDemoRunner.inputs(set, runtime: runtime)
  }
  let order = Dictionary(uniqueKeysWithValues: file.passages.enumerated().map { ($1.id, $0) })
  inputs.sort { order[$0.id]! < order[$1.id]! }
  try ReportFile.write(InputsFile(schema: "scrolls.qwen.inputs@1", inputs: inputs), to: out)
  print("\(inputs.count) inputs (\(inputs.filter { $0.words < 24 }.count) shrunk under the cap, \(inputs.filter(\.thin).count) thin) -> \(out.path)")
case "embed":
  guard let inp = args.url("in"), let out = args.url("out") else { fail("embed --in X --out Y") }
  let file = try JSONDecoder().decode(InputsFile.self, from: Data(contentsOf: inp))
  let batch = args.int("batch", 8), dims = args.int("dims", 256)
  let t0 = Date()
  try await runtime.manager.ensure(.embedder)
  let loadS = Date().timeIntervalSince(t0)
  let t1 = Date()
  let (vs, toks) = try await runtime.manager.embed(file.inputs.map(\.input), plan: BatchPlan(batchSize: batch), dims: dims) { _, _ in }
  let secs = Date().timeIntervalSince(t1)
  let recs = file.inputs.indices.map { VectorRecord(id: file.inputs[$0].id, tokens: toks[$0], vector: vs[$0]) }
  try ReportFile.write(VectorsFile(schema: "scrolls.qwen.vectors@1", runtime: "mlx-swift (\(runtime.info.mlxDevice)) on \(runtime.info.device)",
                                   plan: BatchPlan(batchSize: batch).key, dims: dims, load_seconds: loadS, embed_seconds: secs, vectors: recs), to: out)
  print(String(format: "%d vectors in %.2f s (load %.2f s) -> %@", recs.count, secs, loadS, out.path))
case "demo":
  guard let demo = args.url("demo"), let out = args.url("out") else { fail("demo --demo X --out Y") }
  let set = try DemoSet.load(demo)
  let report = await QwenDemoRunner.run(set: set, runtime: runtime, appBuild: "scrolls-qwen", step: log)
  try ReportFile.write(report, to: out)
  print("demo \(report.status) in \(String(format: "%.1f", report.totalSeconds)) s -> \(out.path)")
  for l in report.labels {
    print("group \(l.group + 1): \(l.verified?.label ?? "—") · \(l.verified?.gloss ?? l.rejection.joined(separator: "; ")) [\(l.result.stop.rawValue), \(l.result.tokensIn) in / \(l.result.tokensOut) out, grammar \(l.result.grammar)]")
  }
  for p in report.problems { print("problem: \(p)") }
case "selftest":
  guard let demo = args.url("demo"), let out = args.url("out") else { fail("selftest --demo X --out Y") }
  let set = try DemoSet.load(demo)
  let parity = try args.url("parity").map { try JSONDecoder().decode(ParitySample.self, from: Data(contentsOf: $0)) }
  let report = await QwenSelfTest.run(demo: set, parity: parity, runtime: runtime, appBuild: "scrolls-qwen", step: log)
  try ReportFile.write(report, to: out)
  for r in report.rows { print("\(r.status.rawValue.padding(toLength: 15, withPad: " ", startingAt: 0)) \(r.id): \(r.detail)") }
  print("selftest \(report.status) -> \(out.path)")
default:
  fail("usage: scrolls-qwen windows|embed|demo|selftest …")
}
