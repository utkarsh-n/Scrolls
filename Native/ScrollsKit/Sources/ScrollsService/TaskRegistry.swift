// OWNER: N0
// Every job type the engine can run (IOS-SPEC §1.3 "jobs/tasks/*"): the reference's 19 `vocab.JOB_TYPES` plus the phone
// types, each implemented as a `JobTask` in the module that owns it and listed here, the one place that sees every
// module. A package lands its task and asks N0 to add one line below (§8.2 rule 1); until then the queue answers
// E_JOB_TYPE for that type, and `missing` names it.

import ScrollsAnalysis
import ScrollsCore
import ScrollsIngest
import ScrollsJobs
import ScrollsLineage
import ScrollsQuery

/// The task types handed to `JobQueue`.
public struct TaskRegistry: Sendable {
  /// Every registered task type (`JobQueue.init(registry:)`).
  public static let all: [any JobTask.Type] = [
    // one line per task type, as its package lands it
    ImportTask.self,           // N1 · import (ScrollsIngest/Pipeline/ImportJobs.swift)
    RevertTask.self,           // N1 · revert
    AdapterLoadTask.self,      // N2 · adapter-load (ScrollsService/Pipelines/AdapterLoad.swift)
    DemoLoadTask.self,         // N2 · demo-load
    BootstrapCipherTask.self,  // N2 · bootstrap-cipher (ScrollsService/Pipelines/BootstrapCipher.swift)
    MaterializeTask.self,      // N3 · materialize (ScrollsQuery/Match/Materializer.swift)
    TokStreamTask.self,        // N4 · tokstream (ScrollsAnalysis/Tasks/TokStreamTask.swift)
    BoilerplateTask.self,      // N5 · boilerplate (ScrollsLineage/Tasks/BoilerplateTask.swift)
    TraceTask.self,            // N5 · trace (ScrollsLineage/Tasks/TraceTask.swift)
  ]

  /// The job types the engine must run (`vocab.JOB_TYPES` and the phone types) that no registered task implements yet.
  public static var missing: [String] {
    let have = Set(all.map { $0.type.rawValue })
    let want = Vocab.jobTypes.keys + JobType.phoneTypes.keys.map(\.rawValue).sorted()
    return want.filter { !have.contains($0) }
  }
}
