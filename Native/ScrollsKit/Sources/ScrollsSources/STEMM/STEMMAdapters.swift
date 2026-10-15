// OWNER: N2
// The four STEMM adapters as the registry and the Sources page know them (SPEC §10.2; ids, versions, licences and
// collection specs of `server/adapters/stemm/*.mjs`). On the phone they read the `stemm` source pack (ΔS-6), which
// arrives from the Mac; until it is on the phone they probe as unavailable with the reason in words. Their loaders
// (gutenberg-stemm, OpenAlex, Wiktionary claims, the Ngram attach) are package N2's M2 work; a load before then is
// refused as not built, never faked.

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsJobs
import ScrollsStore

/// A STEMM adapter: its descriptor, and the stemm pack when one is installed.
public struct STEMMAdapter: PackBoundAdapter, CollectionCaveats {
  public static let packNames = ["stemm"]

  public let id: String
  public let version: String
  public let label: String
  public let access = AdapterAccess.localDataset
  public let license: String
  public let attribution: String
  public let collections: [CollectionSpec]
  public let collectionCaveats: [String: [String]]
  /// The fetcher he runs on the Mac (the Sources page shows it; the app never runs it).
  public let command: String
  /// The staged folder inside the stemm pack.
  public let stagedDir: String
  public let files: SourceFiles

  public func bound(to files: SourceFiles) -> STEMMAdapter {
    STEMMAdapter(id: id, version: version, label: label, license: license, attribution: attribution, collections: collections,
                 collectionCaveats: collectionCaveats, command: command, stagedDir: stagedDir, files: files)
  }

  init(id: String, version: String, label: String, license: String, attribution: String, collections: [CollectionSpec],
       collectionCaveats: [String: [String]], command: String, stagedDir: String, files: SourceFiles = .none) {
    self.id = id
    self.version = version
    self.label = label
    self.license = license
    self.attribution = attribution
    self.collections = collections
    self.collectionCaveats = collectionCaveats
    self.command = command
    self.stagedDir = stagedDir
    self.files = files
  }

  public func probe(_ context: AdapterContext) async throws -> AdapterProbeResult {
    guard !files.packs.isEmpty else { return .packMissing(Self.packNames) }
    let manifest = "\(stagedDir)/MANIFEST.json", format = "\(stagedDir)/FORMAT.md"
    guard files.contains(manifest) else { return .memberMissing(manifest) }
    guard files.contains(format) else {
      return AdapterProbeResult(available: false, reason: "\(format) is not in the pack", manifestOK: true, formatOK: false)
    }
    return AdapterProbeResult(available: false, reason: "loading \(label) on the phone is not built yet (package N2, milestone M2)",
                              manifestOK: true, formatOK: true)
  }

  public func plan(_ params: JSONValue, _ context: AdapterContext) async throws -> Int { 0 }

  public func documents(_ params: JSONValue, _ context: AdapterContext,
                        into channel: BoundedChannel<[CanonicalDocument]>) async throws {
    throw ScrollsError.notImplemented(area: "STEMM loading on the phone (\(id), package N2, milestone M2)")
  }

  public static let gutenbergStemm = STEMMAdapter(
    id: "stemm.gutenberg-stemm", version: "1.1.0", label: "Gutenberg STEMM shelf",
    license: "Public domain in the USA (Project Gutenberg); 20 texts copyrighted (no text export)",
    attribution: "Project Gutenberg (www.gutenberg.org); dates and sitelinks from Wikidata (CC0)",
    collections: [
      CollectionSpec(slug: "stemm-gutenberg", name: "Gutenberg STEMM shelf", domain: "stemm", modality: "text", unit: "tokens",
                     sampling: "curated", rateEligible: true, exportTextAllowed: true, coverageGate: nil,
                     selectionNote: "LoCC Q/R/T shelf, balanced by field quotas and period bins; priority-scored by prominence"),
      CollectionSpec(slug: "stemm-gutenberg-restricted", name: "Gutenberg STEMM shelf (copyrighted, no text export)",
                     domain: "stemm", modality: "text", unit: "tokens", sampling: "curated", rateEligible: true,
                     exportTextAllowed: false, coverageGate: nil,
                     selectionNote: "LoCC Q/R/T shelf, balanced by field quotas and period bins; priority-scored by prominence"),
    ],
    collectionCaveats: [
      "stemm-gutenberg": ["Selection favours Wikidata-notable and downloaded works; not a random sample of Gutenberg's STEMM holdings.",
                          "Many dates are estimates from the first author's life dates (striped), not evidence."],
      "stemm-gutenberg-restricted": ["Copyrighted texts: they can be read and searched here, but their text is never exported or shared."],
    ],
    command: "node tools/fetch/gutenberg-stemm.mjs", stagedDir: "gutenberg-stemm")

  public static let openAlex = STEMMAdapter(
    id: "stemm.openalex", version: "1.1.0", label: "OpenAlex (top-cited sample per field × period)",
    license: "CC0 metadata; abstracts publishers' (local research only)", attribution: "OpenAlex (CC0)",
    collections: [
      CollectionSpec(slug: "stemm-openalex", name: "OpenAlex top-cited sample", domain: "stemm", modality: "abstracts",
                     unit: "works", sampling: "top_cited_per_cell", rateEligible: true, exportTextAllowed: false,
                     coverageGate: 20, selectionNote: "top-cited sample: 200 per field × period"),
    ],
    collectionCaveats: ["stemm-openalex": [
      "The 200 most-cited works per field and period: compare shares within a cell, never counts between cells.",
      "Field labels are a modern classifier's; before 1900 they are its guess.",
      "OpenAlex year may be a reprint or digitisation year.",
      "Abstract text belongs to its publishers: it is never exported.",
    ]],
    command: "node tools/fetch/openalex.mjs", stagedDir: "openalex")

  public static let wiktionary = STEMMAdapter(
    id: "stemm.wiktionary", version: "1.1.0", label: "Wiktionary attestation claims", license: "CC BY-SA 4.0 / GFDL",
    attribution: "Wiktionary contributors; extracted with Wiktextract (Ylonen 2022) via kaikki.org",
    collections: [
      CollectionSpec(slug: "stemm-wiktionary", name: "Wiktionary entries (attestation claims)", domain: "etymology",
                     modality: "lexical", unit: "entries", sampling: "curated", rateEligible: false, exportTextAllowed: true,
                     coverageGate: nil,
                     selectionNote: "entries of tracked expressions only; Wiktionary STEMM categories, coinage templates and dated etymologies"),
    ],
    collectionCaveats: ["stemm-wiktionary": [
      "Dates in Wiktionary etymologies are external claims, never occurrences; they do not move a bar.",
      "Entry text is a later description of the word (written 2002 or later), excluded from frequency.",
    ]],
    command: "node tools/fetch/wiktionary-coinage.mjs", stagedDir: "wiktionary-coinage")

  public static let ngram = STEMMAdapter(
    id: "stemm.ngram", version: "1.0.0", label: "Google Books Ngram baseline (English 1-grams)", license: "CC BY 3.0",
    attribution: "Google Books Ngram, English, 2020 edition", collections: [], collectionCaveats: [:],
    command: "node tools/fetch/ngram-baseline.mjs", stagedDir: "ngram-baseline")
}
