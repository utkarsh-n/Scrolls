// OWNER: N2
// The words of Sources and storage (IOS-SPEC §4.16, §3.5, §3.6, §3.9): what is on this phone, what is missing and how to
// send it, what is being built and how far it got, and where the space goes. Numbers are formatted by the engine's
// Format (en-US grouping); nothing here invents a count.

import Foundation
import ScrollsCore

nonisolated enum SourcesCopy {
  static let title = "Sources and storage"
  static let done = "Done"
  static let refresh = "Refresh"

  // 01 · Cipher on this phone
  static let cipher = "Cipher on this phone"
  static let cipherCaption = "Bundled with the app: Cipher's metadata and full text, built on this phone (no Mac needed)."
  static let build = "Build Cipher now"
  static let building = "Building"
  static let keepBuilding = "Keep building when I leave Scrolls"
  static let keepBuildingNote = "iOS keeps the build going in the background while it can; committed chunks are never lost."
  static let keepBuildingRefused = "iOS did not grant background time"
  static let noPacks = "The Cipher packs are not in this build (Tools/packs.sh, then build the app again)."
  static func phase(_ p: String) -> String { "Phase \(p)" }
  static let statuses = ["ready": "ready", "indexing": "indexing — not yet looked", "pending": "pending — indexing has not reached it",
                         "empty": "empty", "partial": "partial", "metadata": "metadata ready", "running": "building",
                         "failed": "failed", "cancelled": "stopped", "not_started": "not started", "interrupted": "paused — resumes"]
  static func status(_ s: String) -> String { statuses[s] ?? s }
  static func collectionLine(docs: Int, unit: String, tokens: Int) -> String {
    unit == "tokens" && tokens > 0 ? "\(Format.int(docs)) documents · \(Format.int(tokens)) tokens" : "\(Format.int(docs)) \(unit == "works" ? "works" : "documents")"
  }

  // 02 · Packs
  static let packs = "Source packs"
  static let packsCaption = "Each pack holds its sources' files byte for byte, with their sha256."
  static let bundled = "bundled"
  static let installed = "installed"
  static let inbox = "in the Inbox"
  static let inImport = "in Import"
  static let verified = "verified"
  static let unverified = "not verified yet"
  static let failed = "damaged"
  static let loaded = "loaded"
  static let notLoaded = "not loaded"
  static let install = "Install"
  static let stemmAbsent = "STEMM sources (236 MB) are not on this phone."
  static let stemmHow = "On your Mac: Tools/atlas.sh push-pack stemm — or put stemm.scrollspack in Scrolls' Import folder (Finder, Files) — or AirDrop it."

  // 03 · Inbox
  static let inboxTitle = "Inbox"
  static let inboxCaption = "Tools/atlas.sh, Finder and Files put files in Scrolls' Import folder (a pack opened in Scrolls from Files is copied there); AirDrop copies arrive in the system's Inbox. Both are listed here, Import first."
  static let importFolder = "Import"
  static let inboxFolder = "Inbox"
  static let inboxEmpty = "Nothing is waiting."

  // 04 · Generations
  static let generations = "Atlas generation"
  static let generationsCaption = "An atlas is replaced only by swapping in a whole generation; your notebook is kept."
  static func builtOn(_ on: String, _ at: String) -> String { "built on \(on == "device" ? "this phone" : "a Mac") · \(at)" }
  static func journal(_ seq: UInt64) -> String { "notebook entries applied: \(Format.int(Int(seq)))" }
  static let previous = "A previous generation is kept for one-step rollback."
  static let swapLater = "Installing, rolling back and rebuilding generations are not in this build yet."

  // 05 · Storage
  static let storage = "Storage"
  static let storageCaption = "Caches are rebuilt when needed; the atlas is rebuilt from the bundled packs and your notebook."
  static let purge = "Purge caches"
  static func free(_ bytes: Int64) -> String { "\(bytesText(bytes)) free on this phone" }
  static let areaNames = ["atlas": "Atlas", "derived": "Derived (spaces, indexes)", "packs": "Installed packs", "caches": "Caches",
                          "notebook": "Notebook", "import": "Import", "inbox": "Inbox", "next": "Next generation", "prev": "Previous generation",
                          "bundled": "Bundled with the app"]
  static let rebuildable: Set<String> = ["derived", "caches", "next", "prev"]
  static let rebuildableTag = "rebuildable"

  static func bytesText(_ b: Int64) -> String {
    let mb = Double(b) / 1_048_576
    if mb >= 1024 { return String(format: "%.2f GB", mb / 1024) }
    if mb >= 10 { return "\(Format.int(Int(mb.rounded()))) MB" }
    return String(format: "%.1f MB", mb)
  }

  static let engineFixtures = "These figures need the live atlas; the app is running on contract fixtures."
  static let unavailable = "Not available"
}
