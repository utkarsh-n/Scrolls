// OWNER: N0
// scrolls-cli: the Mac executable of the same engine (IOS-SPEC §1.2, §8.1). It runs the commands that build packs,
// starters and generations, dump and fingerprint atlases, and replay the reference's requests for the differential
// stages. Each command is one file in Commands/, owned by the package named in IOS-SPEC §8.1; N0 wrote every file as
// a stub that answers NOT_IMPLEMENTED, so a package lands its command by replacing `run` in its own file. A new command
// needs one line in `commands` (by N0).

import Foundation
import ScrollsCore

/// One subcommand.
protocol CLICommand: Sendable {
  /// The word after `scrolls-cli`.
  static var name: String { get }
  /// One line for the command list.
  static var summary: String { get }
  /// The full usage text.
  static var usage: String { get }
  /// Runs with the arguments after the command name; returns the exit code (0 ok · 1 failure · 2 usage).
  static func run(_ args: [String]) async throws -> Int32
}

enum CLI {
  /// Every command, in the order `help` lists them (each in Commands/, owned by the package named there).
  static let commands: [any CLICommand.Type] = [
    DumpCommand.self, ProbeCommand.self,                                               // N0
    PackCommand.self, StarterCommand.self, AtlasCommand.self, FingerprintCommand.self,  // N2
    ConvertReferenceCommand.self, BenchCommand.self,                                   // N2
    DiffReadCommand.self,                                                              // N3
    DiffAnalysisCommand.self,                                                          // N4
    ApiCommand.self,                                                                   // N6
  ]

  static func printUsage() {
    var lines = ["usage: scrolls-cli <command> [options]   (engine \(BuildInfo.engineVersion), \(BuildInfo.gitCommit))", ""]
    for c in commands { lines.append("  \(c.name.padding(toLength: 18, withPad: " ", startingAt: 0)) \(c.summary)") }
    lines.append("")
    lines.append("A command whose package has not landed it yet answers NOT_IMPLEMENTED (exit 1).")
    print(lines.joined(separator: "\n"))
  }

  static func standardError(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
  }
}

/// Errors a command reports as a usage problem (exit 2).
struct UsageError: Error, CustomStringConvertible {
  let description: String
  init(_ message: String) { description = message }
}

/// `--name value` and `--flag` arguments.
struct Arguments {
  private var values: [String: String] = [:]
  private var flags: Set<String> = []
  private(set) var positional: [String] = []

  init(_ args: [String], flags known: Set<String> = []) throws {
    var i = 0
    while i < args.count {
      let a = args[i]
      if a.hasPrefix("--") {
        let name = String(a.dropFirst(2))
        if known.contains(name) {
          flags.insert(name)
        } else {
          guard i + 1 < args.count else { throw UsageError("\(a) needs a value") }
          values[name] = args[i + 1]
          i += 1
        }
      } else {
        positional.append(a)
      }
      i += 1
    }
  }

  func value(_ name: String) -> String? { values[name] }
  func flag(_ name: String) -> Bool { flags.contains(name) }
  func required(_ name: String) throws -> String {
    guard let v = values[name] else { throw UsageError("--\(name) is required") }
    return v
  }
}

let argv = Array(CommandLine.arguments.dropFirst())
guard let name = argv.first, name != "help", name != "--help", name != "-h" else {
  CLI.printUsage()
  exit(argv.isEmpty ? 2 : 0)
}
if let command = CLI.commands.first(where: { $0.name == name }) {
  do {
    exit(try await command.run(Array(argv.dropFirst())))
  } catch let e as UsageError {
    CLI.standardError("scrolls-cli \(name): \(e)\n\n\(command.usage)")
    exit(2)
  } catch {
    CLI.standardError("scrolls-cli \(name): \(error)")
    exit(1)
  }
} else {
  CLI.standardError("scrolls-cli: unknown command '\(name)'.")
  CLI.printUsage()
  exit(2)
}
