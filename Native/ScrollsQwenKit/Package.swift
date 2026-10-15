// swift-tools-version: 6.4
// OWNER: Q (created by the bring-up, B2)
// The MLX side of Scrolls' Qwen layer (IOS-SPEC-QWEN §2.1, ΔQ-2): the only third-party code in the app, pinned
// exactVersion as AttentionMachine (proven on his iPhone). Built only by xcodebuild: SwiftPM on the command line cannot
// compile MLX's Metal shaders. Every decision lives in ScrollsKit's pure `ScrollsQwen`; this package moves tensors.
//   ScrollsQwenRuntime  MLXQwenRuntime · ModelManager · Embedder · Generator · GuidedRun · ModelStore · QwenMemoryGuard ·
//                       QwenDemoRunner · QwenSelfTest · TransformersTokenizerLoader · Footprint
//   scrolls-qwen        macOS CLI: R1 windows, embeddings for the S6 parity check against Python MLX, the demo on a Mac
// Not linked: MLXHuggingFace (downloads), MLXFoundationModels, MLXVLM, MLXRerankers.
import PackageDescription

let package = Package(
  name: "ScrollsQwenKit",
  platforms: [.iOS(.v27), .macOS(.v27)],
  products: [
    .library(name: "ScrollsQwenRuntime", targets: ["ScrollsQwenRuntime"]),
    .executable(name: "scrolls-qwen", targets: ["scrolls-qwen"]),
  ],
  dependencies: [
    .package(path: "../ScrollsKit"),
    .package(path: "../../../OfflineIntelligenceKit"),
    .package(path: "../../../OfflineIntelligenceKit/MLX"),
    .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.32.3"),
    .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "3.32.3", traits: []),
    .package(url: "https://github.com/huggingface/swift-transformers", exact: "1.3.0"),
    .package(url: "https://github.com/apple/swift-collections", exact: "1.5.0"),
  ],
  targets: [
    .target(
      name: "ScrollsQwenRuntime",
      dependencies: [
        .product(name: "ScrollsQwen", package: "ScrollsKit"),
        .product(name: "OfflineIntelligence", package: "OfflineIntelligenceKit"),
        .product(name: "OfflineIntelligenceMLX", package: "MLX"),
        .product(name: "MLX", package: "mlx-swift"),
        .product(name: "MLXNN", package: "mlx-swift"),
        .product(name: "MLXLLM", package: "mlx-swift-lm"),
        .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
        .product(name: "MLXEmbedders", package: "mlx-swift-lm"),
        .product(name: "Tokenizers", package: "swift-transformers"),
      ],
      swiftSettings: [.unsafeFlags(["-O"], .when(configuration: .debug))]),
    .executableTarget(
      name: "scrolls-qwen",
      dependencies: ["ScrollsQwenRuntime", .product(name: "ScrollsQwen", package: "ScrollsKit")]),
  ],
  swiftLanguageModes: [.v6]
)
