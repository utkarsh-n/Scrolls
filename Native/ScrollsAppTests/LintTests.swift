// OWNER: N0
// Source lint (IOS-SPEC §8.4.10 item 3, §1.7, §4.19, ΔS-17), run by xcodebuild on the simulator over the mirrored
// Native/ tree (the simulator reads the Mac's file system; `#filePath` locates the tree):
//   1. no Swift `String` lowercasing in ScrollsKit/Sources (the fold goes through NSString; Final_Sigma);
//   2. no inline SQL outside the statement catalogues (`enum <Area>SQL: SQLCatalog`, files named *SQL.swift);
//   3. no LabKit import anywhere in ScrollsKit (the engine sees `DeviceConditionsSource`, never LabKit);
//   4. no networking API anywhere in Native/ (the app contains no networking code);
//   5. every Swift file starts with its `// OWNER:` line (Package.swift: line 2);
//   6. copy: the app's own strings (every `enum …Copy` and every *Copy.swift) use British spelling (LabKit
//      `CopyLint`) and contain no mental-state verb or forbidden phrase (`Copy.mentalStateVerbs`,
//      `Copy.forbiddenPhrases`). Copy ported from vocab is byte-equal to the reference and is not re-linted here.
// Banned words are assembled from pieces so this file does not trip the shell lint of check.sh.

import Foundation
import LabKitCore
import ScrollsCore
import Testing

/// The mirrored `Native/` directory and its Swift sources.
private enum Tree {
  /// Symlinks resolved, so `/var/…` and `/private/var/…` spellings of the mirror compare equal.
  static let native = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .resolvingSymlinksInPath()

  /// Swift files under `relative` (sorted), skipping build products and iCloud conflict copies.
  static func swiftFiles(under relative: String) -> [URL] {
    let root = native.appending(path: relative, directoryHint: .isDirectory)
    guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
    var out: [URL] = []
    for case let url as URL in walk {
      let path = url.path(percentEncoded: false)
      if path.contains("/.build/") || path.contains("/.swiftpm/") || path.contains("/Scrolls.xcodeproj/") { continue }
      if url.lastPathComponent.contains(" 2.") { continue }
      if url.pathExtension == "swift" { out.append(url) }
    }
    return out.sorted { $0.path < $1.path }
  }

  static func text(_ url: URL) -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }

  /// "ScrollsKit/Sources/ScrollsCore/Text/Fold.swift"
  static func relative(_ url: URL) -> String {
    let root = native.path(percentEncoded: false)
    let path = url.resolvingSymlinksInPath().path(percentEncoded: false)
    return path.hasPrefix(root) ? String(path.dropFirst(root.count)).trimmingPrefix("/").description : path
  }
}

/// A finding: file:line and the offending line.
private struct Finding: CustomStringConvertible {
  let file: String
  let line: Int
  let text: String
  var description: String { "\(file):\(line): \(text.trimmingCharacters(in: .whitespaces))" }
}

/// Lines of `text` without `//` comments (string literals containing "//" are kept whole).
private func codeLines(_ text: String) -> [(Int, String)] {
  var out: [(Int, String)] = []
  var inBlockComment = false
  for (i, raw) in text.components(separatedBy: "\n").enumerated() {
    var line = Substring(raw)
    if inBlockComment {
      guard let end = line.range(of: "*/") else { continue }
      line = line[end.upperBound...]
      inBlockComment = false
    }
    var code = ""
    var inString = false
    var idx = line.startIndex
    while idx < line.endIndex {
      let c = line[idx]
      if c == "\"" { inString.toggle() }
      if !inString, line[idx...].hasPrefix("//") { break }
      if !inString, line[idx...].hasPrefix("/*") {
        inBlockComment = true
        break
      }
      code.append(c)
      idx = line.index(after: idx)
    }
    out.append((i + 1, code))
  }
  return out
}

@Suite("Source lint (§8.4.10 item 3)")
struct LintTests {
  @Test("the mirrored Native tree is readable from the test")
  func treeIsThere() {
    #expect(FileManager.default.fileExists(atPath: Tree.native.appending(path: "project.yml").path(percentEncoded: false)),
            "Native/ not found at \(Tree.native.path)")
    #expect(!Tree.swiftFiles(under: "ScrollsKit/Sources").isEmpty)
  }

  @Test("no Swift String lowercasing in ScrollsKit/Sources (the fold goes through NSString)")
  func noLowercased() {
    let banned = "." + "lower" + "cased()"
    var findings: [Finding] = []
    for url in Tree.swiftFiles(under: "ScrollsKit/Sources") {
      for (n, line) in codeLines(Tree.text(url)) where line.contains(banned) {
        findings.append(Finding(file: Tree.relative(url), line: n, text: line))
      }
    }
    #expect(findings.isEmpty, "\(findings.map(\.description).joined(separator: "\n"))")
  }

  @Test("no inline SQL outside the statement catalogues")
  func noInlineSQL() throws {
    let keywords = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "PRAGMA", "WITH", "REPLACE",
                    "ATTACH", "DETACH", "VACUUM", "ANALYZE", "REINDEX", "SAVEPOINT", "RELEASE", "BEGIN", "COMMIT",
                    "ROLLBACK", "EXPLAIN"]
    // A string literal (or the first line of a multi-line literal) that starts with an upper-case SQL keyword
    // followed by more SQL ("SELECT id", "PRAGMA journal_mode", "BEGIN IMMEDIATE"); prose never starts that way.
    let pattern = try Regex(#"("""|")\s*("# + keywords.joined(separator: "|") + #")\b\s+[A-Za-z(*_'"]"#)
    var findings: [Finding] = []
    for url in Tree.swiftFiles(under: "ScrollsKit/Sources") {
      let text = Tree.text(url)
      if url.lastPathComponent.hasSuffix("SQL.swift") || text.contains(": SQLCatalog") { continue }
      let lines = text.components(separatedBy: "\n")
      let code = codeLines(text)
      for (n, line) in code {
        // An explicit, reasoned exemption on the line itself: `// lint: sql-ok (<why>)`.
        if lines[n - 1].contains("lint: sql-ok") { continue }
        if line.contains(pattern) {
          findings.append(Finding(file: Tree.relative(url), line: n, text: line))
          continue
        }
        // A multi-line literal opened at the end of this line whose first line is SQL.
        let opensBlock = line.trimmingCharacters(in: .whitespaces).hasSuffix("\"\"\"")
          && line.components(separatedBy: "\"\"\"").count % 2 == 0
        if opensBlock, n < lines.count {
          let next = lines[n].trimmingCharacters(in: .whitespaces)
          if keywords.contains(where: { next.hasPrefix($0 + " ") }), !lines[n].contains("lint: sql-ok") {
            findings.append(Finding(file: Tree.relative(url), line: n + 1, text: next))
          }
        }
      }
    }
    #expect(findings.isEmpty, "inline SQL belongs in an `enum <Area>SQL: SQLCatalog`:\n\(findings.map(\.description).joined(separator: "\n"))")
  }

  @Test("no LabKit import in ScrollsKit (the engine sees DeviceConditionsSource)")
  func noLabKitInEngine() {
    let banned = "import " + "LabKit"
    var findings: [Finding] = []
    for url in Tree.swiftFiles(under: "ScrollsKit") {
      for (n, line) in codeLines(Tree.text(url)) where line.trimmingCharacters(in: .whitespaces).hasPrefix(banned) {
        findings.append(Finding(file: Tree.relative(url), line: n, text: line))
      }
    }
    #expect(findings.isEmpty, "\(findings.map(\.description).joined(separator: "\n"))")
  }

  @Test("no networking API anywhere in Native/ (ΔS-17)")
  func noNetworking() {
    let banned = ["URL" + "Session", "URL" + "Request", "NW" + "Connection", "NW" + "Listener", "NW" + "Browser",
                  "import " + "Network", "CF" + "Socket", "CF" + "Stream", "sock" + "et(", "import " + "WebKit",
                  "WK" + "WebView"]
    var findings: [Finding] = []
    for url in Tree.swiftFiles(under: "") {
      for (n, line) in codeLines(Tree.text(url)) where banned.contains(where: { line.contains($0) }) {
        findings.append(Finding(file: Tree.relative(url), line: n, text: line))
      }
    }
    #expect(findings.isEmpty, "\(findings.map(\.description).joined(separator: "\n"))")
  }

  @Test("every Swift file starts with its OWNER line")
  func ownerLines() {
    var missing: [String] = []
    for folder in ["ScrollsKit", "Scrolls", "ScrollsAppTests", "ScrollsUITests"] {
      for url in Tree.swiftFiles(under: folder) {
        let lines = Tree.text(url).components(separatedBy: "\n")
        let ownerLine = url.lastPathComponent == "Package.swift" ? lines.dropFirst().first : lines.first
        if ownerLine?.hasPrefix("// OWNER: ") != true { missing.append(Tree.relative(url)) }
      }
    }
    #expect(missing.isEmpty, "files without a first `// OWNER:` line:\n\(missing.joined(separator: "\n"))")
  }

  // MARK: Copy

  /// The string literals of the app's copy: every `enum …Copy { … }` body in Scrolls/, and every *Copy.swift.
  private static func appCopy() throws -> [(file: String, literal: String)] {
    let header = try Regex(#"enum\s+\w*Copy\b[^{]*\{"#)
    let literal = try Regex(#""((?:[^"\\]|\\.)*)""#)
    var out: [(String, String)] = []
    for url in Tree.swiftFiles(under: "Scrolls") {
      let text = Tree.text(url)
      var bodies: [Substring] = []
      if url.lastPathComponent.hasSuffix("Copy.swift") {
        bodies.append(Substring(text))
      } else {
        for match in text.matches(of: header) {
          var depth = 1
          var i = match.range.upperBound
          while i < text.endIndex, depth > 0 {
            if text[i] == "{" { depth += 1 }
            if text[i] == "}" { depth -= 1 }
            i = text.index(after: i)
          }
          bodies.append(text[match.range.upperBound..<i])
        }
      }
      for body in bodies {
        let code = codeLines(String(body)).map(\.1).joined(separator: "\n")
        for m in code.matches(of: literal) {
          if let s = m.output[1].substring { out.append((Tree.relative(url), String(s))) }
        }
      }
    }
    return out
  }

  @Test("the app's copy is found (the lint is not vacuous)")
  func copyFound() throws {
    let copy = try Self.appCopy()
    #expect(copy.count > 40, "only \(copy.count) copy strings found")
    #expect(copy.contains { $0.literal.contains("SYNTHETIC DEMONSTRATION CORPUS") })
  }

  @Test("the app's copy uses British spelling (LabKit CopyLint)")
  func britishSpelling() throws {
    let findings = try Self.appCopy().compactMap { file, s -> String? in
      let words = CopyLint.americanSpellings(in: s)
      return words.isEmpty ? nil : "\(file): \(words.joined(separator: ", ")) in \"\(s)\""
    }
    #expect(findings.isEmpty, "\(findings.joined(separator: "\n"))")
  }

  @Test("the app's copy has no mental-state verbs or forbidden phrases (SPEC §13 rule 11)")
  func noMentalStates() throws {
    let banned = Copy.mentalStateVerbs + Copy.forbiddenPhrases
    let patterns = try banned.map { try Regex("\\b" + NSRegularExpression.escapedPattern(for: $0) + "\\b").ignoresCase() }
    let findings = try Self.appCopy().compactMap { file, s -> String? in
      let hits = zip(banned, patterns).filter { s.contains($0.1) }.map(\.0)
      return hits.isEmpty ? nil : "\(file): \(hits.joined(separator: ", ")) in \"\(s)\""
    }
    #expect(findings.isEmpty, "\(findings.joined(separator: "\n"))")
  }
}
