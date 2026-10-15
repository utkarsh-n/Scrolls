// OWNER: WP4
// tools/nl-adapter/main.swift — the optional on-device NL adapter (SPEC §4.10, data-inventory §8), built by
// build.sh into $SCROLLS_DATA/bin/scrolls-nl. One JSON object per line on stdin, one per line on stdout:
//   {"op":"probe"}                                   → {"ok":true,"languages":{"sentiment":[…],"word_embedding":[…]},"macos":"…",…}
//   {"op":"sentiment","lang":"en","text":"…"}        → {"score":-0.4}            (Apple NLTagger .sentimentScore, −1…1)
//   {"op":"neighbors","lang":"en","word":"virus","k":10} → {"neighbors":[{"word":"infect","distance":0.83},…]}
// An "id" in a request is echoed in its response. Errors answer {"error":"…"} and the adapter keeps reading.
// Everything runs on this Mac (Apple's NaturalLanguage framework); nothing is sent anywhere. The models are
// static and modern: Scrolls labels every result "modern reader model, fallible, anachronistic for
// historical text" and never uses it as period meaning.

import Foundation
import NaturalLanguage

let candidates: [NLLanguage] = [.english, .french, .spanish, .german, .italian, .portuguese, .hindi, .gujarati]

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
        FileHandle.standardOutput.write("{\"error\":\"could not encode the response\"}\n".data(using: .utf8)!)
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func reply(_ request: [String: Any], _ body: [String: Any]) {
    var out = body
    if let id = request["id"] { out["id"] = id }
    emit(out)
}

func sentimentLanguages() -> [String] {
    candidates.filter { NLTagger.availableTagSchemes(for: .paragraph, language: $0).contains(.sentimentScore) }.map { $0.rawValue }
}

func embeddingLanguages() -> [String] {
    candidates.filter { NLEmbedding.wordEmbedding(for: $0) != nil }.map { $0.rawValue }
}

func probe() -> [String: Any] {
    let os = ProcessInfo.processInfo.operatingSystemVersion
    var info: [String: Any] = [
        "ok": true,
        "adapter": "scrolls-nl",
        "version": "1.0.0",
        "macos": ProcessInfo.processInfo.operatingSystemVersionString,
        "macos_version": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
        "languages": ["sentiment": sentimentLanguages(), "word_embedding": embeddingLanguages()],
        "sentiment_method": "NLTagger .sentimentScore (paragraph)",
    ]
    if let e = NLEmbedding.wordEmbedding(for: .english) {
        info["word_embedding_en"] = ["dimension": e.dimension, "revision": e.revision, "vocabulary_size": e.vocabularySize]
    }
    return info
}

func sentiment(_ text: String, _ lang: String) -> [String: Any] {
    let language = NLLanguage(rawValue: lang)
    guard NLTagger.availableTagSchemes(for: .paragraph, language: language).contains(.sentimentScore) else {
        return ["error": "sentiment is not available for \(lang)"]
    }
    // one passage = one paragraph: line breaks inside it (verse) would make NLTagger score only the first line
    let flat = text.components(separatedBy: .newlines).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    if flat.isEmpty { return ["error": "empty text"] }
    let tagger = NLTagger(tagSchemes: [.sentimentScore])
    tagger.string = flat
    tagger.setLanguage(language, range: flat.startIndex..<flat.endIndex)
    let (tag, _) = tagger.tag(at: flat.startIndex, unit: .paragraph, scheme: .sentimentScore)
    guard let raw = tag?.rawValue, let score = Double(raw) else { return ["error": "no sentiment score for this text"] }
    return ["score": score]
}

func neighbors(_ word: String, _ lang: String, _ k: Int) -> [String: Any] {
    guard let embedding = NLEmbedding.wordEmbedding(for: NLLanguage(rawValue: lang)) else {
        return ["error": "no word embedding for \(lang)"]
    }
    let list = embedding.neighbors(for: word.lowercased(), maximumCount: max(1, min(k, 100)))
    return ["neighbors": list.map { ["word": $0.0, "distance": $0.1] }, "revision": embedding.revision, "dimension": embedding.dimension]
}

while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else {
        emit(["error": "each line must be one JSON object"])
        continue
    }
    switch request["op"] as? String {
    case "probe":
        reply(request, probe())
    case "sentiment":
        guard let text = request["text"] as? String else { reply(request, ["error": "sentiment needs text"]); continue }
        reply(request, sentiment(text, (request["lang"] as? String) ?? "en"))
    case "neighbors":
        guard let word = request["word"] as? String else { reply(request, ["error": "neighbors needs word"]); continue }
        reply(request, neighbors(word, (request["lang"] as? String) ?? "en", (request["k"] as? Int) ?? 10))
    default:
        reply(request, ["error": "unknown op; use probe, sentiment or neighbors"])
    }
}
