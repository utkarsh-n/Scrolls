// OWNER: N0
// The app (IOS-SPEC §8.4.9): one scene, the dark observatory palette (`LabPalette.scrolls`, cyan signature), LabKit
// haptics, and the launch sequence started from the root view's task. Background-task handlers are registered in
// `init`, before the app finishes launching, as BackgroundTasks requires.

import LabKitUI
import SwiftUI

@main
struct ScrollsApp: App {
  @State private var model = AppModel(launch: LaunchArgs.parse(ProcessInfo.processInfo.arguments))
  @Environment(\.scenePhase) private var phase

  init() {
    BackgroundTasks.registerMaintenance()
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .labPalette(.scrolls)
        .labHaptics(model.hapticEngine)
        .preferredColorScheme(.dark)
        .qwenLaunchCover(model.launch)
        .modifier(QwenScenePhase())
        .task { await model.start() }
    }
    .onChange(of: phase) { _, p in model.lifecycle.scenePhase(p) }
  }
}
