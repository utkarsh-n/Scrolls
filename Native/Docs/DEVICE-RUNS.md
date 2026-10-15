<!-- OWNER: I — every device session: date, build, suites, results, thermal and memory notes -->
# Device runs

## 2026-10-13 23:34 — first install on his iPhone 15 Pro Max (lead)
- Build: `SCROLLS_BUILD_DIR=~/Developer/scrolls-build/device Native/Tools/build.sh install` at commit a27c498 (Release, automatic signing, team YOUR_TEAM_ID; `extended-virtual-addressing` removed — a personal team cannot sign it). ** BUILD SUCCEEDED **; installed as com.utkarsh.scrolls (UDID YOUR_DEVICE_ID).
- Bundled: starter.atlas (demo world) + cipher-meta.scrollspack from ~/Developer/scrolls-packs/current.
- Launch with console: ran 45 s with no crash (ended by closing the console session, signal 15). Relaunched without console: process 17291 running. No Qwen yet (B2 in progress).

## 2026-10-14 08:35–09:35 — "it doesn't work" / "The Scroll has no engine" (lead)
- His report: the app said "The Scroll has no engine to ask." Crash logs pulled from the phone
  (`~/Developer/scrolls-build/crashes/`): three SIGKILL 0x8BADF00D watchdog kills (scene-create 19.97 s at 08:35,
  scene-update 10 s in the background at 07:54 and 23:35), main thread inside one layout transaction each time.
- Cause 1, the freeze: with the inspector restored at its large detent, ScrollStateLine padded itself by the inspector
  height, grew the canvas, which grew the inspector's container and the inspector: +46.3 pt per layout pass without end
  (logged on Scrolls SimDevice: the inspector reached ~100 000 pt). Fixed in 1d65b59 (overlays on clear views; the
  Scroll slot pinned to the screen).
- Cause 2, "no engine": `AtlasLocation.prepare()` created `Documents/Inbox`, which iOS reserves (the system creates it
  for AirDrop / "Open in"; apps may not): NSCocoaErrorDomain 513, so `LiveAtlas.open` failed before cloning the starter
  and `Application Support/Atlas/` stayed empty. The simulator allows the folder, so only the phone showed it. Found
  with the new launch trail (`Documents/Diagnostics/launch.jsonl`, 5d5a596). Fix: the Inbox is created best effort.
- Also: the Scroll asked the engine before it opened and never asked again (fixed in 1d65b59); the Qwen 4B weights on
  the phone are truncated (`model.safetensors` 1.63 of 2.26 GB; re-push pending).
- devicectl launches: 09:15 SIGKILLed ~7 s in with no crash report (the 09:15:33 jetsam report does not name Scrolls);
  09:22 the trail build stayed running (40 s), phase ready, engine "No engine: … Inbox … 513".
- From 09:25 the SIMULATOR HOLD is in force (status/I.md): device-only work from here.
- 09:43 build with the review fixes (engine re-ask on launch settle, peek fill height): installed, launched, stayed
  frontmost; trail: atlas exists → "Live atlas" in 0.7 s → phase ready. Cipher bootstrap running (atlas 20.5 MB).
  `Scrolls.diskwrites_resource` report (action: none): 1.07 GB dirtied over 35 717 s since 23:48, heaviest stack
  BootstrapCipher phase A → SourceLoader.loadCollection → DocumentWriter.drain → Writer.checkpoint. Follow-up (N2):
  bootstrap write amplification. The same minutes show an `OfflineIntelligenceBench` crash and a JetsamEvent on his
  phone from another session's app.
