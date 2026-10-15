# Public source snapshot

This repository contains a reviewed source snapshot. Original Git history, credentials, personal records, local signing identities, device diagnostics, build outputs, downloaded model weights, firmware, and unreviewed media are excluded. Existing upstream license and attribution files apply to their respective components. Publication does not grant a new license to third-party content.

Configure your own Apple signing team to run native apps on a physical device. Downloaded datasets, binary runtimes, fonts, demo media, and models may need to be obtained separately using the documented upstream sources or fetch/build tools. This publication review does not certify that this snapshot builds or runs.

## Project-specific setup and exclusions

This source uses sibling dependencies: `../LabKit`, `../OfflineIntelligenceKit`, `../OfflineIntelligenceKit/MLX`, `../Cipher (optional runtime data source)`. Clone the corresponding public source repositories beside this project, or update local package paths before generating the Xcode project. Optional Cipher datasets are not bundled.

The synthetic `data/demo` and native demo copy remain. Real corpus exports, bundled/probe passages, model weights, personal/local reports, native Golden snapshots and mini SQLite fixtures are excluded. Differential/native fixture suites require rebuilding reviewed fixtures; this snapshot does not claim those suites pass. Source fetchers use `SCROLLS_CONTACT` for the crawler contact. Files named `label@1.system` and `label@1.user` are versioned prompt resources rather than email addresses. Query keys, annotation keys and manifest checksums are stable content identifiers rather than authentication secrets.
