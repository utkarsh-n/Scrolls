// OWNER: Q (created by the bring-up, B2)
// The two models Scrolls runs (IOS-SPEC-QWEN Q-01, §0.2), with every file's size and sha256 compiled in: the phone
// trusts these, not the pushed MANIFEST.json (which `Tools/models.sh` writes from the same values for convenience).
// Measured on the Mac from ~/Developer/scrolls-models (shasum -a 256, 2026-10-13); README.md files are not pushed.

import Foundation
import OfflineIntelligence

public enum ModelRole: String, Codable, Sendable, CaseIterable {
  case embedder, generator
}

public struct ModelFile: Codable, Sendable, Equatable, Hashable {
  public var name: String
  public var bytes: Int
  public var sha256: String
  public init(_ name: String, _ bytes: Int, _ sha256: String) {
    self.name = name
    self.bytes = bytes
    self.sha256 = sha256
  }
}

public struct ModelSpec: Codable, Sendable, Equatable {
  /// The folder name under the models root, e.g. "Qwen3-Embedding-0.6B-8bit".
  public var name: String
  public var role: ModelRole
  /// The weights' sha256 (`model.safetensors`; MODELS.json "model_sha256"): the model id recorded on every run.
  public var sha256: String
  /// All pushed files together.
  public var bytes: Int
  public var upstream: String
  /// Short display name for badges ("Qwen3-4B", "Qwen3-Embedding-0.6B").
  public var display: String
  public var files: [ModelFile]

  public var sha8: String { String(sha256.prefix(8)) }
  public var weights: ModelFile? { files.first { $0.name == "model.safetensors" } }
}

public enum ModelCatalog {
  public static let embedder = ModelSpec(
    name: "Qwen3-Embedding-0.6B-8bit", role: .embedder,
    sha256: "fe956e8d346b4f08215a3cfc48a874354f900c20a59e965b75df0d9d77c54b28",
    bytes: 649_086_541, upstream: "mlx-community/Qwen3-Embedding-0.6B-8bit", display: "Qwen3-Embedding-0.6B (8-bit)",
    files: [
      ModelFile("added_tokens.json", 707, "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680"),
      ModelFile("chat_template.jinja", 4116, "87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5"),
      ModelFile("config.json", 857, "65fb46306262bac47c6a89e5ad8a766c3d40d559057c1931e9c10976266a4fc7"),
      ModelFile("config_sentence_transformers.json", 215, "10667c72ddb772627bf1780cb7f86af8e2ae0032b8c243c731172064105c6961"),
      ModelFile("generation_config.json", 117, "28396d421a2108acce96383f6a7de78008f7f1b17f807958f3c14c51dbfb65fb"),
      ModelFile("merges.txt", 1_671_853, "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5"),
      ModelFile("model.safetensors", 633_152_041, "fe956e8d346b4f08215a3cfc48a874354f900c20a59e965b75df0d9d77c54b28"),
      ModelFile("model.safetensors.index.json", 49_731, "d387721e7d2dd44152b7dc9fcea8d5647e2692e1c064949c000fabad3292d1d1"),
      ModelFile("modules.json", 349, "84e40c8e006c9b1d6c122e02cba9b02458120b5fb0c87b746c41e0207cf642cf"),
      ModelFile("special_tokens_map.json", 613, "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd"),
      ModelFile("tokenizer.json", 11_423_705, "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a"),
      ModelFile("tokenizer_config.json", 5404, "443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0"),
      ModelFile("vocab.json", 2_776_833, "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
    ])

  public static let legacyGenerator = ModelSpec(
    name: "Qwen3-4B-Instruct-2507-4bit", role: .generator,
    sha256: "2a73c6c248601ab904e035548abd8e6abb65ea27dcb5f342fb0a8910eb44173f",
    bytes: 2_278_969_697, upstream: "mlx-community/Qwen3-4B-Instruct-2507-4bit (revision 50d42775)",
    display: "Qwen3-4B",
    files: [
      ModelFile("added_tokens.json", 707, "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680"),
      ModelFile("chat_template.jinja", 4040, "40c21f34cf67d8c760ef72f8ad3ae5afad514299d4b06e91dd9a8d705af7b541"),
      ModelFile("config.json", 938, "574349e5a343236546fda55e4744a76e181f534182d7dc60ff1bad7e7a502849"),
      ModelFile("generation_config.json", 238, "835fffe355c9438e7a25be099b3fccaa98350b83451f9fd2d99512e74f1ade48"),
      ModelFile("merges.txt", 1_671_853, "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5"),
      ModelFile("model.safetensors", 2_263_022_417, "2a73c6c248601ab904e035548abd8e6abb65ea27dcb5f342fb0a8910eb44173f"),
      ModelFile("model.safetensors.index.json", 63_964, "388d811b8b7c2608dd04cce1bcb04a8bf715d19b42790894e6d3427ff429a777"),
      ModelFile("special_tokens_map.json", 613, "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd"),
      ModelFile("tokenizer.json", 11_422_654, "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4"),
      ModelFile("tokenizer_config.json", 5440, "4397cc477eb6d79715ccd2000accd6b3531928f30029665832fa1b255f24d2b9"),
      ModelFile("vocab.json", 2_776_833, "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910"),
    ])

  public static let generator2B = ModelSpec(
    name: "qwen-2b", role: .generator,
    sha256: "713fe7e5d3c3965f7106b0d0ee17615f7869c23c8d327996df8c1196fbcf07d5", bytes: 1_749_079_691,
    upstream: "mlx-community/Qwen3.5-2B-4bit (revision 674aaa7240b91e8012fcad5d791b7dfe5ba90207)", display: "Qwen3.5 2B",
    files: [
      ModelFile("chat_template.jinja", 7_755, "273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80"),
      ModelFile("config.json", 3_113, "beb7fc5a6e0405fe332821cf1a8ef7b69bb390a8c8933171647de5579debf949"),
      ModelFile("model.safetensors", 1_722_271_785, "713fe7e5d3c3965f7106b0d0ee17615f7869c23c8d327996df8c1196fbcf07d5"),
      ModelFile("model.safetensors.index.json", 81_722, "8294c05cca7d53a6c33e3db2b379539bd296d054e0b689711b16b6ac93c7e49d"),
      ModelFile("preprocessor_config.json", 390, "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516"),
      ModelFile("processor_config.json", 1_300, "14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b"),
      ModelFile("tokenizer.json", 19_989_343, "87a7830d63fcf43bf241c3c5242e96e62dd3fdc29224ca26fed8ea333db72de4"),
      ModelFile("tokenizer_config.json", 1_139, "e98f1901ac6f0adff67b1d540bfa0c36ac1a0cf59eb72ed78146ef89aafa1182"),
      ModelFile("video_preprocessor_config.json", 385, "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13"),
      ModelFile("vocab.json", 6_722_759, "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003"),
    ])

  public static let generator4B = ModelSpec(
    name: "qwen-4b", role: .generator,
    sha256: "5fb9acd0246866381cf8c5c354c6db1019f6498eec4ccb4f5edcc71ffeacb2db", bytes: 3_061_129_077,
    upstream: "mlx-community/Qwen3.5-4B-4bit (revision 0e7ffd5c629ef7719d4cbc04069232580bfa9d9c)", display: "Qwen3.5 4B",
    files: [
      ModelFile("chat_template.jinja", 7_756, "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715"),
      ModelFile("config.json", 3_366, "f3efc81b2ea8d96a45301037d3ccccbcccdef44a961845c87f286aaddbc6eaaa"),
      ModelFile("model.safetensors", 3_034_300_695, "5fb9acd0246866381cf8c5c354c6db1019f6498eec4ccb4f5edcc71ffeacb2db"),
      ModelFile("model.safetensors.index.json", 101_944, "52e534c41f7b97708329c85f762e5882bf48bd5955a422c6ae74eba321e6048a"),
      ModelFile("preprocessor_config.json", 390, "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516"),
      ModelFile("processor_config.json", 1_300, "14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b"),
      ModelFile("tokenizer.json", 19_989_343, "87a7830d63fcf43bf241c3c5242e96e62dd3fdc29224ca26fed8ea333db72de4"),
      ModelFile("tokenizer_config.json", 1_139, "e98f1901ac6f0adff67b1d540bfa0c36ac1a0cf59eb72ed78146ef89aafa1182"),
      ModelFile("video_preprocessor_config.json", 385, "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13"),
      ModelFile("vocab.json", 6_722_759, "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003"),
    ])

  /// Historical generator remains named for archived reports; active generation uses the shared catalog.
  public static var generator: ModelSpec { generator2B }
  public static var all: [ModelSpec] { [embedder, generator2B, generator4B] }
  public static func generation(_ choice: OfflineModelChoice) -> ModelSpec {
    choice == .qwen2B ? generator2B : generator4B
  }
  public static func active(_ choice: OfflineModelChoice) -> [ModelSpec] { [embedder, generation(choice)] }
  public static func spec(_ role: ModelRole) -> ModelSpec { role == .embedder ? embedder : generator }
}
