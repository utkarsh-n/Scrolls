// OWNER: N2
// The state of Sources and storage (IOS-SPEC §4.16): Cipher's collections and their load status (corpora), the
// bootstrap's phase and progress (health.cipher), the packs, the Inbox, the generation and the storage, read through
// AtlasService and AtlasPlatform only. Actions: Build Cipher now (AtlasService.loadAdapter of a Cipher adapter resumes the
// bootstrap), Keep building when I leave Scrolls (submits the BGContinuedProcessingTask of the running bootstrap job,
// from this foreground action only, §3.7), Install a pack waiting in Import or the Inbox, Purge caches.

import Foundation
import Observation
import ScrollsContracts
import ScrollsService
import ScrollsStore

@MainActor @Observable
final class SourcesModel {
  struct CollectionRow: Identifiable, Equatable {
    var id: String { slug }
    var slug: String
    var name: String
    var line: String
    var status: String
  }

  private(set) var cipher: [CollectionRow] = []
  private(set) var bootstrap: BootstrapStatus?
  private(set) var packs: [PackStatus] = []
  private(set) var inbox: [InboxItem] = []
  private(set) var generation: GenerationsStatus?
  private(set) var storage: StorageReport?
  private(set) var error: String?
  private(set) var busy = false
  private(set) var continuedJob: JobID?
  var keepBuilding = false

  @ObservationIgnored private let atlas: (any AtlasService)?
  @ObservationIgnored private let platform: (any AtlasPlatform)?
  @ObservationIgnored private var jobStates: [JobID: (status: String, progress: Double, message: String?)] = [:]
  @ObservationIgnored private var listener: Task<Void, Never>?

  init(atlas: (any AtlasService)?, platform: (any AtlasPlatform)?) {
    self.atlas = atlas
    self.platform = platform
  }

  var live: Bool { platform != nil }
  var cipherPacksPresent: Bool { packs.contains { $0.name == "cipher-meta" } }
  var stemmPresent: Bool { packs.contains { $0.name == "stemm" } }

  /// Reads everything once, then follows job events until `stop()`.
  func start() async {
    await refresh()
    guard listener == nil, let atlas else { return }
    let events = atlas.events
    listener = Task { [weak self] in
      for await e in events {
        guard let self else { return }
        if case .job(let j) = e { self.note(j) }
        if case .bootstrap(let b) = e { self.bootstrap = b }
        if case .dataChanged = e { await self.refreshCorpora() }
      }
    }
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  func refresh() async {
    await refreshCorpora()
    guard let platform else { return }
    do {
      packs = try await platform.packs()
      inbox = try await platform.inbox()
      generation = try await platform.generations()
      storage = try await platform.storage()
      error = nil
    } catch let e as ScrollsError {
      error = e.message
    } catch {
      self.error = String(describing: error)
    }
  }

  private func refreshCorpora() async {
    guard let atlas else { return }
    do {
      let corpora = try await atlas.corpora()
      let health = try? await atlas.health()
      bootstrap = health?.cipher ?? bootstrap
      cipher = (corpora.first { $0.slug == "cipher" }?.collections ?? []).map {
        CollectionRow(slug: $0.slug, name: $0.name, line: SourcesCopy.collectionLine(docs: $0.docs, unit: $0.unit, tokens: $0.tokens),
                      status: $0.status)
      }
    } catch let e as ScrollsError {
      error = e.message
    } catch {
      self.error = String(describing: error)
    }
  }

  private func note(_ e: JobEventPayload) {
    let id = JobID(rawValue: Int64(e.job))
    switch e {
    case .progress(let p): jobStates[id] = (p.status ?? "running", p.fraction, p.message)
    case .done(let d): jobStates[id] = (d.status, 1, nil)
    }
  }

  /// Build Cipher now: resumes the bootstrap; with Keep building on, its job gets a continued-processing task.
  func buildCipher() async {
    guard let atlas else { return }
    busy = true
    defer { busy = false }
    do {
      let ref = try await atlas.loadAdapter("cipher.works", AdapterLoadRequest())
      let job = JobID(rawValue: Int64(ref.job.id))
      if keepBuilding { await submitContinued(job) }
      await refresh()
    } catch let e as ScrollsError {
      error = e.message
    } catch {
      self.error = String(describing: error)
    }
  }

  /// The toggle: submits a continued-processing task for the running bootstrap job (a foreground action, §3.7).
  func setKeepBuilding(_ on: Bool) async {
    keepBuilding = on
    guard on, let atlas else { return }
    if let running = try? await atlas.jobs(JobsRequest(status: "running")).items.first(where: { $0.type == "bootstrap-cipher" }) {
      await submitContinued(JobID(rawValue: Int64(running.id)))
    }
  }

  private func submitContinued(_ job: JobID) async {
    installBindings()
    do {
      try await BackgroundTasks.submitContinued(job: job, title: "Indexing Cipher books", subtitle: bootstrap?.message ?? "")
      continuedJob = job
    } catch {
      self.error = "\(SourcesCopy.keepBuildingRefused): \(error.localizedDescription)"
      keepBuilding = false
    }
  }

  /// The continued-processing binding (BackgroundTasks' hooks): the job's progress from its events, and cancel on expiry.
  private func installBindings() {
    BackgroundTasks.jobProgress = { [weak self] id in
      guard let s = self?.jobStates[id] else { return nil }
      switch s.status {
      case "succeeded": return .finished(success: true)
      case "failed", "cancelled": return .finished(success: false)
      default: return .running(fraction: s.progress, subtitle: s.message ?? "")
      }
    }
    BackgroundTasks.cancelJob = { [weak self] id in
      guard let atlas = self?.atlas else { return }
      Task { _ = try? await atlas.cancelJob(id) }
    }
  }

  func install(_ item: InboxItem) async {
    guard let platform else { return }
    busy = true
    defer { busy = false }
    do {
      _ = try await platform.installPack(item.url)
      await refresh()
    } catch let e as ScrollsError {
      error = e.message
    } catch {
      self.error = String(describing: error)
    }
  }

  func purgeCaches() async {
    guard let platform else { return }
    do {
      try await platform.purgeCaches()
      storage = try await platform.storage()
    } catch {
      self.error = String(describing: error)
    }
  }
}
