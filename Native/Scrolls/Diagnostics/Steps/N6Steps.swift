// OWNER: N6
// Package N6's device self-test steps (IOS-SPEC §2.7, §6.6, §6.7, §8.5 N6): the acceptance rows that need the phone, as
// commands. Every step works in the run's isolated root or in a private root of its own under
// `Application Support/SelfTest/` — never in his notebook or his atlas.
//
// journey suite
//   N6 write-ahead          a view saved through AtlasService is in the journal (fsync'd before the atlas commit), and
//                           the atlas has applied exactly what the journal holds (journal head = applied seq).
//   N6 reopen identical     the saved view read back twice, as saved, is byte-identical (canonical JSON, state_hash).
//   N6 force quit           two launches: phase 1 saves a view in a private root and leaves the atlas open; the
//                           integrator force-quits the app (devicectl device process terminate) and runs the suite again;
//                           phase 2 reopens that root (the journal catch-up runs) and compares the view byte for byte.
//   N6 live journal         his live notebook's journal files are unchanged by N6's steps (size and modification date).
// generation suite
//   N6 restore simulation   a private root acts (annotate, revise, save a view, review a link); then the atlas is
//                           "lost": the base atlas plus the kept Notebook/ is rebuilt by replaying the journal, and the
//                           notes, revisions, views and as-saved counts must be identical.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsService
import ScrollsStore

/// N6's steps, registered in `SelfTestCatalog.n6`.
enum N6Steps: SelfTestSteps {
  static func steps(for suite: SelfTestSuite) -> [SelfTestStep] {
    switch suite {
    case .journey:
      return [SelfTestStep("N6 live journal (start)", run: liveJournalStart), SelfTestStep("N6 write-ahead", run: writeAhead),
              SelfTestStep("N6 reopen identical", run: reopenIdentical), SelfTestStep("N6 force quit", run: forceQuit),
              SelfTestStep("N6 live journal", run: liveJournalEnd)]
    case .generation:
      return [SelfTestStep("N6 live journal (start)", run: liveJournalStart), SelfTestStep("N6 restore simulation", run: restore),
              SelfTestStep("N6 live journal", run: liveJournalEnd)]
    default:
      return []
    }
  }

  // MARK: helpers

  /// The live engine of this run, in its isolated root (a step never runs on his atlas or on the fixtures).
  static func isolatedAtlas(_ ctx: SelfTestContext, _ name: String) -> Result<LiveAtlas, SelfTestRow> {
    switch ctx.model.engine.kind {
    case .fixtures:
      return .failure(.pending(name, "the shell runs on contract fixtures (\(ctx.model.engine.note ?? "no live atlas")); needs the live engine"))
    case .unavailable(let why):
      return .failure(.pending(name, "no engine: \(why)"))
    case .live:
      guard ctx.model.launch.atlasRoot != nil else {
        return .failure(.fail(name, "refused: the suite runs on the live atlas; device suites must run with -atlasRoot"))
      }
      guard let live = ctx.model.atlas as? LiveAtlas else { return .failure(.pending(name, "the engine is not a LiveAtlas")) }
      return .success(live)
    }
  }

  /// A suffix that orders runs and never collides.
  static func stamp() -> String {
    StoreClock.isoNow().replacingOccurrences(of: ":", with: "").replacingOccurrences(of: ".", with: "")
  }

  /// The canonical JSON of an answer, with the data-version members masked (they count commits, not content).
  static func canonical<T: Encodable>(_ v: T) throws -> String {
    func mask(_ v: JSONValue) -> JSONValue {
      switch v {
      case .object(let o):
        var out = JSONObject()
        for (k, x) in o { out[k] = ["dataVersion", "currentDataVersion", "data_version"].contains(k) ? "<dv>" : mask(x) }
        return .object(out)
      case .array(let a): return .array(a.map(mask))
      default: return v
      }
    }
    return CanonicalJSON.string(mask(try ScrollsJSON.value(v)))
  }

  /// A private root holding a copy of `live`'s atlas and notebook (checkpointed first, so the copy is the committed
  /// state). Its journal continues the run's journal, so its seqs never collide with the atlas's applied rows.
  static func privateRoot(from live: LiveAtlas, name: String) async throws -> AtlasLocation {
    _ = try? await live.writer.checkpoint(.truncate)
    let loc = try AtlasLocation.selfTest(name, cloneLive: false)
    let fm = FileManager.default
    for file in ["atlas.sqlite", "atlas.sqlite-wal"] {
      let from = live.location.atlasDir.appendingPathComponent(file)
      guard fm.fileExists(atPath: from.path) else { continue }
      let to = loc.atlasDir.appendingPathComponent(file)
      try? fm.removeItem(at: to)
      try fm.copyItem(at: from, to: to)
    }
    for f in (try? fm.contentsOfDirectory(atPath: live.location.notebookDir.path)) ?? [] where f.hasPrefix("journal-") {
      try fm.copyItem(at: live.location.notebookDir.appendingPathComponent(f), to: loc.notebookDir.appendingPathComponent(f))
    }
    return loc
  }

  static func open(_ loc: AtlasLocation) async throws -> LiveAtlas {
    let atlas = try await LiveAtlas.open(loc, conditions: Unthrottled(),
                                         launch: EngineLaunchOptions(selfTest: "journey", startBootstrap: false))
    _ = try await JournalReplayer.catchUp(atlas)
    return atlas
  }

  /// The root folder of a location (`…/SelfTest/<name>-<run>`).
  static func rootURL(_ loc: AtlasLocation) -> URL { loc.atlasDir.deletingLastPathComponent() }

  /// A view state of the atlas's own corpus (the demo when it has one), selecting `passage`.
  static func viewState(_ passage: PassageID?) -> JSONValue {
    var s = ViewState.defaultState("demo")
    if let passage { s.selection = ViewState.Selection(type: "passage", id: .number(Int(passage.rawValue))) }
    return s.jsonValue
  }

  // MARK: his live notebook is untouched

  /// Sizes and modification dates of his live journal files, read without opening the journal (opening it could
  /// truncate a torn line, which is a write).
  static func liveJournalFingerprint() -> String {
    guard let live = try? AtlasLocation.live() else { return "unavailable" }
    let fm = FileManager.default
    let files = ((try? fm.contentsOfDirectory(atPath: live.notebookDir.path)) ?? []).filter { $0.hasPrefix("journal-") }.sorted()
    return files.map { f in
      let a = try? fm.attributesOfItem(atPath: live.notebookDir.appendingPathComponent(f).path)
      let size = (a?[.size] as? NSNumber)?.int64Value ?? -1
      let date = (a?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
      return "\(f):\(size):\(date)"
    }.joined(separator: ",")
  }

  @MainActor static var liveAtStart: String?

  static func liveJournalStart(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    liveAtStart = liveJournalFingerprint()
    return [.info("N6 live journal (start)", liveAtStart.map { $0.isEmpty ? "no journal files yet" : "\($0.split(separator: ",").count) journal file(s)" } ?? "")]
  }

  static func liveJournalEnd(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let now = liveJournalFingerprint()
    guard let start = liveAtStart else { return [.pending("N6 live journal", "no start fingerprint")] }
    return [now == start
      ? .pass("N6 live journal", "his live journal files are unchanged by N6's steps (\(now.isEmpty ? "none exist" : now))")
      : .fail("N6 live journal", "his live journal changed during the self-test: \(start) → \(now)")]
  }

  // MARK: journey

  static func writeAhead(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let name = "N6 write-ahead"
    let live: LiveAtlas
    switch isolatedAtlas(ctx, name) { case .success(let a): live = a; case .failure(let row): return [row] }
    do {
      let before = try await live.diagnostics()
      if before.journalAppliedSeq > before.journalHead {
        return [.fail(name, "the isolated root's journal (head \(before.journalHead)) starts below the cloned atlas's applied seq "
          + "(\(before.journalAppliedSeq)): its next act would reuse a journal_applied seq (finding for N0, -atlasRoot selftest)")]
      }
      let targets = try await live.notebookSelfTestTargets()
      let viewName = "self-test write-ahead \(stamp())"
      let saved = try await live.saveView(SaveViewRequest(name: viewName, state: viewState(targets.passage)))
      let after = try await live.diagnostics()
      var last: JournalEntry?
      for try await e in live.journal.entries(after: before.journalHead) { last = e }
      guard let e = last, case .viewSave(let request, let portable) = e.op else {
        return [.fail(name, "no viewSave line was appended to the journal (head \(before.journalHead) → \(after.journalHead))")]
      }
      var rows: [SelfTestRow] = []
      rows.append(e.seq == before.journalHead + 1 && request.name == viewName
        ? .pass(name, "journal line \(e.seq) is the save of \(saved.slug) (CRC \(String(e.crc32, radix: 16)))")
        : .fail(name, "journal line \(e.seq) holds '\(request.name)', expected '\(viewName)' at \(before.journalHead + 1)"))
      rows.append(after.journalAppliedSeq == after.journalHead
        ? .pass("N6 applied = journal", "meta.journal_applied_seq \(after.journalAppliedSeq) = journal head \(after.journalHead)")
        : .fail("N6 applied = journal", "applied \(after.journalAppliedSeq), journal head \(after.journalHead)"))
      rows.append(.info("N6 portable cutoffs", "generation \(portable.generation), \(portable.runKeys.count) pinned run key(s), "
        + "\(portable.strands.count) strand key(s), selection \(portable.selection == nil ? "none" : "by stable key")"))
      return rows
    } catch {
      return [.fail(name, String(describing: error))]
    }
  }

  static func reopenIdentical(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let name = "N6 reopen identical"
    let live: LiveAtlas
    switch isolatedAtlas(ctx, name) { case .success(let a): live = a; case .failure(let row): return [row] }
    do {
      let targets = try await live.notebookSelfTestTargets()
      let saved = try await live.saveView(SaveViewRequest(name: "self-test reopen \(stamp())", state: viewState(targets.passage)))
      let one = try await live.view(saved.slug, asSaved: true)
      let two = try await live.view(saved.slug, asSaved: true)
      let (a, b) = (try canonical(one), try canonical(two))
      guard a == b, one.stateHash == saved.stateHash else {
        return [.fail(name, "two reads of \(saved.slug) differ, or its state_hash changed (\(saved.stateHash ?? "?") → \(one.stateHash ?? "?"))")]
      }
      return [.pass(name, "\(saved.slug): as-saved answer identical across reads (\(a.utf8.count) bytes, state_hash \(one.stateHash ?? "?"))")]
    } catch {
      return [.fail(name, String(describing: error))]
    }
  }

  /// What phase 1 leaves for phase 2 (`Documents/selftest/n6-force-quit.json`).
  struct ForceQuitRecord: Codable {
    var root: String
    var slug: String
    var answer: String
    var journalHead: UInt64
    var savedAt: String
  }

  /// Phase 1's atlas, kept open until the process is killed.
  @MainActor static var keptOpen: LiveAtlas?

  static func forceQuit(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let name = "N6 force quit"
    let record = ctx.runDirectory.deletingLastPathComponent().appendingPathComponent("n6-force-quit.json")
    let fm = FileManager.default
    if let data = try? Data(contentsOf: record), let r = try? JSONDecoder().decode(ForceQuitRecord.self, from: data) {
      // phase 2: the app was force-quit with that atlas open; reopen it and compare
      defer {
        try? fm.removeItem(at: record)
        try? fm.removeItem(atPath: r.root)
      }
      do {
        let atlas = try await open(try AtlasLocation.at(root: URL(fileURLWithPath: r.root)))
        let answer = try canonical(try await atlas.view(r.slug, asSaved: true))
        let d = try await atlas.diagnostics()
        await atlas.close()
        var rows: [SelfTestRow] = []
        rows.append(answer == r.answer
          ? .pass(name, "after the force quit, \(r.slug) (saved \(r.savedAt)) reopens byte-identical (\(answer.utf8.count) bytes)")
          : .fail(name, "\(r.slug) differs after the force quit: \(JSONDiffLine.first(r.answer, answer))"))
        rows.append(d.journalHead == r.journalHead && d.journalAppliedSeq == r.journalHead
          ? .pass("N6 force quit journal", "journal head \(d.journalHead) = applied \(d.journalAppliedSeq), as before the quit")
          : .fail("N6 force quit journal", "journal head \(d.journalHead), applied \(d.journalAppliedSeq); expected \(r.journalHead)"))
        return rows
      } catch {
        return [.fail(name, "phase 2: \(error)")]
      }
    }
    // phase 1: save in a private root, record the answer, keep the atlas open for the kill
    let live: LiveAtlas
    switch isolatedAtlas(ctx, name) { case .success(let a): live = a; case .failure(let row): return [row] }
    do {
      let loc = try await privateRoot(from: live, name: "n6-force-quit")
      let atlas = try await open(loc)
      let targets = try await atlas.notebookSelfTestTargets()
      let saved = try await atlas.saveView(SaveViewRequest(name: "self-test force quit \(stamp())", state: viewState(targets.passage)))
      let answer = try canonical(try await atlas.view(saved.slug, asSaved: true))
      let head = try await atlas.diagnostics().journalHead
      let r = ForceQuitRecord(root: rootURL(loc).path, slug: saved.slug, answer: answer, journalHead: head, savedAt: saved.savedAt ?? "")
      try JSONEncoder().encode(r).write(to: record, options: .atomic)
      keptOpen = atlas
      return [.pending(name, "phase 1 done: \(saved.slug) saved in \(rootURL(loc).lastPathComponent) with the atlas left open. "
        + "Force-quit the app now (devicectl device process terminate, or simctl terminate) and run -selftest journey again for phase 2.")]
    } catch {
      return [.fail(name, "phase 1: \(error)")]
    }
  }

  // MARK: generation

  static func restore(_ ctx: SelfTestContext) async -> [SelfTestRow] {
    let name = "N6 restore simulation"
    let live: LiveAtlas
    switch isolatedAtlas(ctx, name) { case .success(let a): live = a; case .failure(let row): return [row] }
    let fm = FileManager.default
    var roots: [URL] = []
    defer { for r in roots { try? fm.removeItem(at: r) } }
    do {
      // the base: the run's atlas and journal as they are now
      let acted = try await privateRoot(from: live, name: "n6-restore-acted")
      roots.append(rootURL(acted))
      let base = acted.atlasDir.appendingPathComponent("base.sqlite")
      try fm.copyItem(at: acted.atlasDir.appendingPathComponent("atlas.sqlite"), to: base)
      if fm.fileExists(atPath: acted.atlasDir.appendingPathComponent("atlas.sqlite-wal").path) {
        try fm.copyItem(at: acted.atlasDir.appendingPathComponent("atlas.sqlite-wal"), to: acted.atlasDir.appendingPathComponent("base.sqlite-wal"))
      }

      // acts, journaled in the private root
      var atlas = try await open(acted)
      let targets = try await atlas.notebookSelfTestTargets()
      guard let passage = targets.passage else {
        await atlas.close()
        return [.pending(name, "this atlas has no body passage to annotate")]
      }
      let p = try await atlas.passage(passage, context: false)
      let anchor = Anchor(docId: p.anchor.docId, sha256: p.anchor.sha256, field: p.anchor.field, start: p.anchor.start,
                          end: p.anchor.end, quote: p.text)
      let target = AnnotationTargetRef(type: "passage", ref: String(passage.rawValue))
      let note = try await atlas.createAnnotation(AnnotationCreateRequest(target: target, anchor: anchor, kind: "interpretation",
                                                                         bodyMd: "Self-test: a first reading.", tags: ["self-test"]))
      _ = try await atlas.reviseAnnotation(note.id, AnnotationPatchRequest(bodyMd: "Self-test: a revised reading.", reason: "self-test"))
      if let rel = targets.relationship {
        _ = try await atlas.review(rel, ReviewRequest(action: "dispute", note: "Self-test: checked both ends by hand."))
      }
      let saved = try await atlas.saveView(SaveViewRequest(name: "self-test restore \(stamp())", state: viewState(passage)))
      func visible(_ a: LiveAtlas) async throws -> [String] {
        [try canonical(try await a.annotations(AnnotationsRequest(target: "passage:\(passage.rawValue)", include: "all"))),
         try canonical(try await a.annotationRevisions(note.id)),
         try canonical(try await a.view(saved.slug, asSaved: true)),
         try canonical(try await a.views(ViewsRequest(limit: 200)))]
      }
      let before = try await visible(atlas)
      await atlas.close()

      // the atlas is lost; Notebook/ is kept: rebuild from the base and replay the journal
      let restored = try AtlasLocation.selfTest("n6-restore-rebuilt", cloneLive: false)
      roots.append(rootURL(restored))
      try fm.copyItem(at: base, to: restored.atlasDir.appendingPathComponent("atlas.sqlite"))
      if fm.fileExists(atPath: acted.atlasDir.appendingPathComponent("base.sqlite-wal").path) {
        try fm.copyItem(at: acted.atlasDir.appendingPathComponent("base.sqlite-wal"), to: restored.atlasDir.appendingPathComponent("atlas.sqlite-wal"))
      }
      for f in try fm.contentsOfDirectory(atPath: acted.notebookDir.path) where f.hasPrefix("journal-") {
        try fm.copyItem(at: acted.notebookDir.appendingPathComponent(f), to: restored.notebookDir.appendingPathComponent(f))
      }
      atlas = try await LiveAtlas.open(restored, conditions: Unthrottled(), launch: EngineLaunchOptions(selfTest: "generation", startBootstrap: false))
      let report = try await JournalReplayer.catchUp(atlas)
      let after = try await visible(atlas)
      await atlas.close()
      let labels = ["notes", "revisions", "as-saved view", "views list"]
      var rows: [SelfTestRow] = [.info("N6 replay", "replayed seq \(report.fromSeq)–\(report.toSeq): \(report.resolved) resolved, "
        + "\(report.reanchored) re-anchored, \(report.orphaned) orphaned\(report.waiting.map { "; waiting at \($0.seq): \($0.reason)" } ?? "")")]
      for (i, label) in labels.enumerated() {
        rows.append(before[i] == after[i]
          ? .pass("\(name): \(label)", "identical after the rebuild (\(after[i].utf8.count) bytes)")
          : .fail("\(name): \(label)", JSONDiffLine.first(before[i], after[i])))
      }
      return rows
    } catch {
      return [.fail(name, String(describing: error))]
    }
  }
}

/// Where two canonical JSON texts first differ, in a few words.
enum JSONDiffLine {
  static func first(_ a: String, _ b: String) -> String {
    let x = Array(a.utf8), y = Array(b.utf8)
    var i = 0
    while i < min(x.count, y.count), x[i] == y[i] { i += 1 }
    let lo = max(0, i - 40)
    func cut(_ u: [UInt8]) -> String { String(decoding: u[lo..<min(u.count, i + 60)], as: UTF8.self) }
    return "first difference at byte \(i): …\(cut(x))… vs …\(cut(y))…"
  }
}

extension SelfTestCatalog {
  static var n6: (any SelfTestSteps.Type)? { N6Steps.self }
}

/// A step's early-exit row travels as the failure of `isolatedAtlas`'s `Result`.
nonisolated extension SelfTestRow: Error {}
