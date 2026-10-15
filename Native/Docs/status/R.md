<!-- OWNER: R — progress, evidence, pending device rows, contract requests, rebase notes -->
# Status: R

The reference steward (IOS-SPEC §8.3). Every change, with its test, is in [REFERENCE-CHANGES.md](../REFERENCE-CHANGES.md).

## Progress

| Item | State | Evidence |
|---|---|---|
| RF-1 'und' gating (cube v5, SQL slice, Compare, clustering) | done | `tests/langgate.test.mjs`; RF-1 tests in `aggregate.invariants`; `aggregate.binning` and `aggregate.cube` on the `und` corpus. They fail on `7ce5521` and pass now. |
| RF-2 as-saved Compare and inspector | done | `tests/views.as-saved.test.mjs` "RF-2" (5 tests) |
| RF-3 journey requests + JSONL | done | `tests/acceptance.verify.test.mjs` (journey over HTTP, 23 rows, JSONL record checked) |
| `npm test` green, `ref-freeze-1` tagged | done | `ref-freeze-1` = `839c3f1a6ac659f8f16a5417b1ca968e59252c37` (annotated tag). `npm test` on a `git archive` export of that commit: 1,143 tests, 1,141 pass, 0 fail, 2 skipped (76 s wall, load ≈ 13). |
| RF-4 `m1r`, `m5r` | done | built from the `ref-freeze-1` export in 5 and 15 min; `npm run verify` PASS on both (npm test 1,143/1,141/0/2, journey 26/26, 0 shape errors); `~/Developer/scrolls-snapshots/{m1r,m5r}/SNAPSHOT.json`; `Native/Reports/R-ref-freeze-1.json`; journey records `~/Developer/scrolls-snapshots/tools/verify/*-journey.jsonl` |

## Baseline before any change (clean export of `7ce5521`)

`node --test tests/*.test.mjs`: 1,133 tests, 1,131 pass, 0 fail, 2 skipped (76 s wall).

## Pending device rows

None: R works on the web reference only.

## Contract requests (to N0)

Additive fields that N0 must mirror for C0 and G3:
- `CompareRequest.runs` and `CompareRequest.cutoffs` (optional);
- `Compare.as_saved` (optional);
- the `KwicRequest` query parameters `runs`, `import_batch`, `at` (optional).

The contract version stays 1.3.0, and no fixture changed.

## Notes for the other packages

- **Goldens (N0):** G2 slices, G3, G4 and G7 may now be generated from `ref-freeze-1` (`839c3f1`) on clones of `m1r`/`m5r`.
- **G7 (N6):** two recorded runs of the RF-3 journey are in `~/Developer/scrolls-snapshots/tools/verify/m1r-journey.jsonl` and `m5r-journey.jsonl`. The format is at the head of `scripts/verify-journey.mjs`. `gen-journey.mjs` should record its own run on its clones with `npm run verify -- --record`.
- **Tooling:** `npm` cannot start the broken Homebrew node through `/usr/bin/env` (SIP strips `DYLD_*`). A shim on PATH that sets the DYLD path and execs `/opt/homebrew/Cellar/node/26.10.0_1/bin/node` makes `npm test` and `npm run verify` work (used here).
- **Pending for the next freeze:** P-1 in REFERENCE-CHANGES.md (web UI only).
