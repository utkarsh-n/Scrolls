// OWNER: N1 — stub written by N0
// Imports in process (server/routes/imports.mjs): the import wizard's API: stage a file, map it (a validating dry
// run), preview, problems.csv, commit and revert. Commit and revert are jobs and journaled acts
// (`JournalOp.importCommit` / `.importRevert` through `userWrites`).
// The signatures are AtlasService's, frozen at M0 (IOS-SPEC §8.4.6). Until the package ports the area, every
// method answers NOT_IMPLEMENTED (501); the owner replaces the bodies here and nowhere else.

import Foundation
import ScrollsContracts
import ScrollsStore

extension LiveAtlas {
  @concurrent
  public func stageImport(_ r: StageImportRequest) async throws -> ImportStagedResponse {
    throw ScrollsError.notImplemented(area: "Imports (stageImport, package N1)")
  }

  @concurrent
  public func setImportMapping(_ id: ImportBatchID, _ r: ImportMappingRequest) async throws -> ImportMappingResponse {
    throw ScrollsError.notImplemented(area: "Imports (setImportMapping, package N1)")
  }

  @concurrent
  public func importPreview(_ id: ImportBatchID, _ r: ImportPreviewRequest) async throws -> ImportPreviewResponse {
    throw ScrollsError.notImplemented(area: "Imports (importPreview, package N1)")
  }

  @concurrent
  public func importProblems(_ id: ImportBatchID) async throws -> ImportProblemsResponse {
    throw ScrollsError.notImplemented(area: "Imports (importProblems, package N1)")
  }

  @concurrent
  public func commitImport(_ id: ImportBatchID, _ r: ImportMappingRequest) async throws -> ImportCommitResponse {
    throw ScrollsError.notImplemented(area: "Imports (commitImport, package N1)")
  }

  @concurrent
  public func revertImport(_ id: ImportBatchID) async throws -> ImportRevertResponse {
    throw ScrollsError.notImplemented(area: "Imports (revertImport, package N1)")
  }
}
