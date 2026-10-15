// OWNER: Q (created by the bring-up, B2)
// Launch arguments for the bring-up: `-qwen-demo` opens "Qwen on this iPhone" over the app and runs the demonstration;
// `-selftest qwen` opens it and runs S4–S7 (Documents/qwen-selftest.json). Both keep the Cipher bootstrap from
// starting, so the models do not share the phone's memory with it. `-qwen-device gpu` asks the simulator to try MLX
// on its GPU (MLXSetup); the phone always uses its GPU.

import SwiftUI

struct QwenLaunchCover: ViewModifier {
  let launch: LaunchArgs
  @State private var shown: Bool

  init(launch: LaunchArgs) {
    self.launch = launch
    _shown = State(initialValue: launch.qwenDemo || launch.qwenSelfTest)
  }

  func body(content: Content) -> some View {
    content.fullScreenCover(isPresented: $shown) {
      NavigationStack {
        QwenScreen(autorun: launch.qwenSelfTest ? .selfTest : .demo)
          .toolbar {
            ToolbarItem(placement: .topBarTrailing) { Button("Close") { shown = false } }
          }
      }
      .preferredColorScheme(.dark)
    }
  }
}

extension View {
  func qwenLaunchCover(_ launch: LaunchArgs) -> some View { modifier(QwenLaunchCover(launch: launch)) }
}

/// Unloads Qwen when the scene leaves the foreground (§2.6), inside a background task.
struct QwenScenePhase: ViewModifier {
  @Environment(\.scenePhase) private var phase

  func body(content: Content) -> some View {
    content.onChange(of: phase) { _, p in
      if p == .background { QwenHost.ifCreated?.enteredBackground() }
    }
  }
}
