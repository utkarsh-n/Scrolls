// OWNER: N3
// Snapshots in process (server/routes/exports.mjs, POST /api/snapshots and GET /api/snapshots/:file): the PNG and SVG of
// a view written by the app's renderer, stored under Documents/Exports/snapshots/ (visible in Files, IOS-SPEC §3.9) and,
// for a saved view, its SVG in `saved_view.snapshot_svg`. A synthetic view's SVG must carry the SYNTHETIC stamp.

import Foundation
import ScrollsContracts
import ScrollsQuery
import ScrollsStore

extension LiveAtlas {
  /// Documents/Exports/snapshots of this atlas root.
  var snapshotsDir: URL {
    location.inboxDir.deletingLastPathComponent().appendingPathComponent("Exports").appendingPathComponent("snapshots")
  }

  @concurrent
  public func createSnapshot(_ r: SnapshotCreateRequest) async throws -> SnapshotCreateResponse {
    let (plan, dv) = try await read { c in (try Snapshots.plan(c, r), try Meta.dataVersion(c)) }
    let out = try Snapshots.write(plan, dir: snapshotsDir, dataVersion: dv)
    if let slug = plan.viewSlug, let svg = plan.svg {
      try await writer.write("snapshot svg") { tx in try Snapshots.saveSVG(tx, slug: slug, svg: svg) }
    }
    return out.response
  }

  @concurrent
  public func snapshot(_ file: String) async throws -> SnapshotResponse {
    try Snapshots.read(dir: snapshotsDir, file: file)
  }
}
