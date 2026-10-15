// OWNER: N5
// Contract requests → the query strings the reference's routes receive (`req.query`): absent members stay absent,
// numbers are written as JavaScript writes them, names are the reference's snake_case parameters.

import ScrollsContracts
import ScrollsCore

extension LineageRequest {
  /// GET /api/lineage's query.
  public var queryArgs: QueryArgs {
    var a: QueryArgs = ["root": root]
    a["depth"] = depth.map(String.init)
    a["dir"] = dir
    a["max_nodes"] = maxNodes.map(String.init)
    a["types"] = types
    a["status"] = status
    a["rejected"] = rejected
    a["rel_rev_cutoff"] = relRevCutoff.map(String.init)
    a["runs"] = runs
    return a
  }
}

extension LineagePathRequest {
  /// GET /api/lineage/path's query.
  public var queryArgs: QueryArgs {
    var a: QueryArgs = ["from": from, "to": to]
    a["types"] = types
    a["status"] = status
    return a
  }
}

extension GenealogyRequest {
  /// GET /api/genealogy's query.
  public var queryArgs: QueryArgs {
    var a: QueryArgs = [:]
    a["work"] = work
    a["maker"] = maker
    a["dir"] = dir
    a["depth"] = depth.map(String.init)
    a["max"] = max.map(String.init)
    a["types"] = types
    a["status"] = status
    a["cursor"] = cursor
    return a
  }
}
