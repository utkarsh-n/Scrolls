// OWNER: N2
// Sources and storage (IOS-SPEC §4.16; More → Sources and storage, or the status chip): Cipher on this phone with each
// collection's load status and the bootstrap's progress, Build Cipher now and Keep building when I leave Scrolls; the
// source packs (bundled, installed, waiting in Import or the Inbox) with their verification and how to send an absent
// one; the Inbox (what waits in Documents/Import, then the system's Documents/Inbox, each with its folder); the
// atlas generation; and the storage by area with Purge caches. On contract fixtures (no live atlas) it says so instead
// of showing figures.

import LabKitUI
import ScrollsContracts
import ScrollsService
import SwiftUI

extension RootSlots {
  func sources() -> some View { SourcesScreen(model: model) }
}

struct SourcesScreen: View {
  let model: AppModel
  @State private var sources: SourcesModel?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if let s = sources {
            if !s.live {
              Text(SourcesCopy.engineFixtures).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
            }
            if let e = s.error {
              Text(e).font(Typography.meta).foregroundStyle(Tokens.danger.color).accessibilityIdentifier("sources.error")
            }
            CipherPanel(sources: s)
            PacksPanel(sources: s)
            InboxPanel(sources: s)
            GenerationPanel(sources: s)
            StoragePanel(sources: s)
          } else {
            ProgressView()
          }
        }
        .padding(16)
      }
      .background(Tokens.bg0.color)
      .navigationTitle(SourcesCopy.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button(SourcesCopy.done) { dismiss() } }
        ToolbarItem(placement: .topBarLeading) {
          Button(SourcesCopy.refresh, systemImage: "arrow.clockwise") { Task { await sources?.refresh() } }
        }
      }
    }
    .accessibilityIdentifier("sourcesSheet")
    .task {
      let s = SourcesModel(atlas: model.atlas, platform: model.platform)
      sources = s
      await s.start()
    }
    .onDisappear { sources?.stop() }
  }
}

// MARK: 01 · Cipher on this phone

private struct CipherPanel: View {
  let sources: SourcesModel

  var body: some View {
    InstrumentPanel("01", SourcesCopy.cipher, caption: SourcesCopy.cipherCaption) {
      VStack(alignment: .leading, spacing: 10) {
        if let b = sources.bootstrap {
          HStack(alignment: .firstTextBaseline) {
            Text(SourcesCopy.status(b.status)).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
            if let phase = b.phase { Text(phase).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
          }
          if let p = b.progress, b.status == "running" || b.status == "metadata" {
            ProgressView(value: min(1, max(0, p))).tint(Tokens.cyan.color).accessibilityLabel(b.message ?? SourcesCopy.building)
          }
          if let m = b.message { Text(m).font(Typography.meta).foregroundStyle(Tokens.ink2.color) }
        }
        ForEach(sources.cipher) { row in
          HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
              Text(row.name).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
              Text(row.line).font(Typography.count).foregroundStyle(Tokens.ink3.color)
            }
            Spacer()
            Text(SourcesCopy.status(row.status)).font(Typography.meta)
              .foregroundStyle(row.status == "ready" ? Tokens.ok.color : Tokens.ink2.color)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("sources.collection.\(row.slug)")
        }
        if sources.live {
          if sources.cipherPacksPresent {
            Button(SourcesCopy.build) { Task { await sources.buildCipher() } }
              .disabled(sources.busy || sources.bootstrap?.status == "ready")
              .frame(minHeight: Tokens.Geometry.minHit)
              .accessibilityIdentifier("sources.build")
            Toggle(SourcesCopy.keepBuilding, isOn: Binding(get: { sources.keepBuilding },
                                                           set: { on in Task { await sources.setKeepBuilding(on) } }))
              .accessibilityIdentifier("sources.keepBuilding")
            Text(SourcesCopy.keepBuildingNote).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          } else {
            Text(SourcesCopy.noPacks).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          }
        }
      }
    }
  }
}

// MARK: 02 · Packs

private struct PacksPanel: View {
  let sources: SourcesModel

  var body: some View {
    InstrumentPanel("02", SourcesCopy.packs, caption: SourcesCopy.packsCaption) {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(Array(sources.packs.enumerated()), id: \.offset) { _, p in
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(p.name).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
              Text(p.version).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
              Spacer()
              Text(SourcesCopy.bytesText(p.bytes)).font(Typography.count).foregroundStyle(Tokens.ink2.color)
            }
            Text(detail(p)).font(Typography.meta).foregroundStyle(p.verification == .failed ? Tokens.danger.color : Tokens.ink3.color)
            if let problem = p.problem { Text(problem).font(Typography.meta).foregroundStyle(Tokens.danger.color) }
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("sources.pack.\(p.name)")
        }
        if sources.live && !sources.stemmPresent {
          Text(SourcesCopy.stemmAbsent).font(Typography.cardBody).foregroundStyle(Tokens.ink2.color)
          Text(SourcesCopy.stemmHow).font(Typography.code).foregroundStyle(Tokens.ink3.color).textSelection(.enabled)
        }
      }
    }
  }

  private func detail(_ p: PackStatus) -> String {
    let place = switch p.location {
    case .bundled: SourcesCopy.bundled
    case .installed: SourcesCopy.installed
    case .inbox: p.folder == .import ? SourcesCopy.inImport : SourcesCopy.inbox
    }
    let check = switch p.verification {
    case .verified: SourcesCopy.verified + (p.sha256.map { " · sha \($0.prefix(8))…" } ?? "")
    case .verifying, .unverified: SourcesCopy.unverified
    case .failed: SourcesCopy.failed
    }
    return "\(place) · \(check) · \(p.loaded ? SourcesCopy.loaded : SourcesCopy.notLoaded)"
  }
}

// MARK: 03 · Inbox

private struct InboxPanel: View {
  let sources: SourcesModel

  var body: some View {
    InstrumentPanel("03", SourcesCopy.inboxTitle, caption: SourcesCopy.inboxCaption) {
      VStack(alignment: .leading, spacing: 10) {
        if sources.inbox.isEmpty {
          Text(SourcesCopy.inboxEmpty).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
        ForEach(Array(sources.inbox.enumerated()), id: \.offset) { _, item in
          HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
              Text(item.url.lastPathComponent).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
              Text(item.folder == .import ? SourcesCopy.importFolder : SourcesCopy.inboxFolder)
                .font(Typography.badge).foregroundStyle(Tokens.ink3.color)
              if let note = item.note { Text(note).font(Typography.meta).foregroundStyle(Tokens.ink3.color) }
            }
            Spacer()
            if item.kind == .pack && item.compatible {
              Button(SourcesCopy.install) { Task { await sources.install(item) } }.disabled(sources.busy)
            }
          }
        }
      }
    }
  }
}

// MARK: 04 · Generation

private struct GenerationPanel: View {
  let sources: SourcesModel

  var body: some View {
    InstrumentPanel("04", SourcesCopy.generations, caption: SourcesCopy.generationsCaption) {
      VStack(alignment: .leading, spacing: 6) {
        if let g = sources.generation?.current {
          Text(verbatim: String(g.generation.prefix(8)) + "…").font(Typography.code).foregroundStyle(Tokens.ink.color)
          Text(SourcesCopy.builtOn(g.builtOn, g.builtAt)).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          Text(SourcesCopy.journal(g.journalSeq)).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        } else {
          Text(SourcesCopy.unavailable).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
        if sources.generation?.previous != nil {
          Text(SourcesCopy.previous).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
        }
        Text(SourcesCopy.swapLater).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
      }
    }
  }
}

// MARK: 05 · Storage

private struct StoragePanel: View {
  let sources: SourcesModel

  private static let order = ["atlas", "bundled", "packs", "derived", "caches", "notebook", "import", "inbox", "next", "prev"]
  private static let colors: [String: TokenColor] = ["atlas": Tokens.cyan, "bundled": Tokens.ink3, "packs": Tokens.amber,
                                                      "derived": Tokens.violet, "caches": Tokens.ink2]

  var body: some View {
    InstrumentPanel("05", SourcesCopy.storage, caption: SourcesCopy.storageCaption) {
      VStack(alignment: .leading, spacing: 8) {
        if let s = sources.storage {
          let areas: [(String, Int64)] = Self.order.compactMap { k in s.areas[k].flatMap { $0 > 0 ? (k, $0) : nil } }
          let total = max(1, areas.reduce(Int64(0)) { $0 + $1.1 })
          GeometryReader { geo in
            HStack(spacing: 1) {
              ForEach(areas, id: \.0) { area in
                Rectangle().fill((Self.colors[area.0] ?? Tokens.rule).color)
                  .frame(width: max(2, geo.size.width * CGFloat(area.1) / CGFloat(total)))
              }
            }
          }
          .frame(height: 10)
          .accessibilityHidden(true)
          ForEach(areas, id: \.0) { area in
            HStack {
              Text(SourcesCopy.areaNames[area.0] ?? area.0).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
              if SourcesCopy.rebuildable.contains(area.0) {
                Text(SourcesCopy.rebuildableTag).font(Typography.badge).foregroundStyle(Tokens.ink3.color)
              }
              Spacer()
              Text(SourcesCopy.bytesText(area.1)).font(Typography.count).foregroundStyle(Tokens.ink2.color)
            }
            .accessibilityElement(children: .combine)
          }
          Text(SourcesCopy.free(s.availableBytes)).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
          Button(SourcesCopy.purge) { Task { await sources.purgeCaches() } }
            .frame(minHeight: Tokens.Geometry.minHit)
            .accessibilityIdentifier("sources.purge")
        } else {
          Text(SourcesCopy.unavailable).font(Typography.meta).foregroundStyle(Tokens.ink3.color)
        }
      }
    }
  }
}
