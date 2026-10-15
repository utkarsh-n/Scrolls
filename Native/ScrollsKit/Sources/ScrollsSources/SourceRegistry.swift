// OWNER: N2
// The adapters this engine has (`server/adapters/registry.mjs`): a new source is one adapter plus one line here.
// The registry holds unbound values (no packs): enough to list them, register their `source_adapter` rows and say
// which packs each needs. A load binds the adapter to the packs it reads (`bound(to:)`).

import Foundation
import ScrollsContracts
import ScrollsCore
import ScrollsStore

/// A file importer's `source_adapter` row (WP1's formats have no adapter module, but every import_batch and
/// collection references one).
public struct FileAdapterRow: Sendable, Equatable {
  public var id: String
  public var version: String
  public var label: String
  public var access: String
  public var license: String
  public var attribution: String
}

/// Every registered source adapter.
public enum SourceRegistry {
  /// The adapters, in the reference's registry order.
  public static let adapters: [any SourceAdapter] = [
    CipherBooksAdapter(), CipherWikisourceAdapter(), CipherWorksAdapter(), CipherRelationsAdapter(), CipherRootsAdapter(),
    CipherThemesAdapter(), STEMMAdapter.gutenbergStemm, STEMMAdapter.openAlex, STEMMAdapter.wiktionary, STEMMAdapter.ngram,
    DemoAdapter(),
  ]

  /// The adapter with `id`, if this build has it.
  public static func adapter(id: String) -> (any SourceAdapter)? { adapters.first { $0.id == id } }

  /// `FILE_ADAPTERS`: the file importers' rows.
  public static let fileAdapters: [FileAdapterRow] = [("txt", "TXT"), ("md", "MD"), ("csv", "CSV"), ("tsv", "TSV"),
                                                       ("json", "JSON"), ("jsonl", "JSONL")].map {
    FileAdapterRow(id: "file.\($0.0)", version: "1.0.0", label: "\($0.1) file import", access: "local-file",
                   license: "as declared by the importer", attribution: "")
  }

  /// The corpus an adapter's collections belong to (`corpusFor`).
  public static func corpus(for adapterID: String) -> String {
    if adapterID == "demo" { return "demo" }
    if adapterID.hasPrefix("cipher.") { return "cipher" }
    if adapterID.hasPrefix("stemm.") { return "stemm" }
    return "user"
  }

  /// The packs an adapter reads, by name (empty for an adapter that reads none).
  public static func packNames(for adapter: any SourceAdapter) -> [String] {
    (type(of: adapter) as? any PackBoundAdapter.Type)?.packNames ?? []
  }

  /// The adapter bound to `files` (unchanged when it reads no packs).
  public static func bind(_ adapter: any SourceAdapter, to files: SourceFiles) -> any SourceAdapter {
    guard let b = adapter as? any PackBoundAdapter else { return adapter }
    return b.bound(to: files)
  }

  /// The source slot of each adapter's rows (IOS-SPEC §3.3).
  public static func slot(for adapterID: String) -> SourceSlot {
    switch adapterID {
    case "demo": .base
    case "cipher.works", "cipher.themes", "cipher.roots": .cipherMeta
    case "cipher.relations": .cipherRelations
    case "cipher.books", "cipher.wikisource": .cipherText
    case "stemm.gutenberg-stemm": .stemmGutenberg
    case "stemm.openalex": .stemmOpenAlex
    case "stemm.wiktionary": .stemmWiktionary
    default: .base
    }
  }
}
