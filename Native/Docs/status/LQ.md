<!-- OWNER: LQ — the LQ tasks: started / resume / done, with their .jsonl markers -->
# Status: LQ

## Rows (IOS-SPEC-QWEN §7.2)

- 2026-10-14 00:31 · LQ-1 · started · split recorded: **LQ-1a** = `run_pseudo.py scope=cipher-en configs=base gatecal=1` (Qwen vs PPMI-SVD on the base config + the gate calibration, v1 and rule_v2, per-pair done-markers `exp=pseudo_gatecal_item`); **LQ-1b** = the other configs (q4, w64, plain, mark, wp) if time allows · resume: `~/Developer/cipher-llm/venv/bin/python Native/Reports/qwen-lab/senses-scripts/run_pseudo.py scope=cipher-en configs=base gatecal=1` (skips logged `pseudo_words` / `pseudo_gatecal_item` lines; vectors cached in `~/Developer/scrolls-lab-senses/cache`) · progress: Reports/progress/LQ-1.json

- 2026-10-14 00:29 · LQ-3 · started · resume: `cd Native/Reports/qwen-lab/senses-scripts && ~/Developer/cipher-llm/venv/bin/python rule_v2.py window=24w` (done-markers: `senses.jsonl` lines `exp=rule_v2`, `window="24w"`) · progress: Reports/progress/LQ-3.json
- 2026-10-14 00:29 · LQ-6 · started · resume: `~/Developer/cipher-llm/venv/bin/python flux_3class.py` (done-markers: `exp=demo_flux_3class`) · progress: Reports/progress/LQ-6.json
- 2026-10-14 00:29 · LQ-7 · started · resume: `~/Developer/cipher-llm/venv/bin/python rule_v2.py spring:stemm-en` (done-marker: `exp=rule_v2`, word spring, scope stemm-en, window 64) · progress: Reports/progress/LQ-7.json
- 2026-10-14 01:33 · LQ-3 · resumed (2nd session) · **split recorded**: LQ-3a = the ±24-word window on *bank* + the key decision; LQ-3b = rule_v2 on the 13 runs under the decided key + the other 24w runs (information) + QWEN-LAB §6 · LQ-3a result: *bank* w24w silver ARI **0.914 < 0.92** (rule_v2 k 2, ok, margin 0.0701) → **R1 key for English = `…/w32t/d256`** (bar not lowered) · resume: `rule_v2.py window=32t` and `window=24w` (done-markers `exp=rule_v2`, `window`) · no device rows in LQ, nothing to simulate · progress: Reports/progress/LQ-3.json
- 2026-10-14 01:52 · LQ-1 · resumed (new session) · the 00:41/01:12 processes are alive; LQ-1a base gatecal 9/21 items, r1 4/4 analyses + 2/21 items; **LQ-1b** launched (`configs=q4,w64,plain,mark,wp`, log `~/Developer/scrolls-lab-senses/logs/LQ-1b.log`) · resume: as the 00:31 row, plus `run_pseudo.py scope=cipher-en configs=q4,w64,plain,mark,wp` · progress: Reports/progress/LQ-1.json
