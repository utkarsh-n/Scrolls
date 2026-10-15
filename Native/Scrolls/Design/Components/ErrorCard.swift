// OWNER: N0
// The engine error card (SPEC §8.8, IOS-SPEC §4.18; `gate-card.mjs` renderErrorCard): an opaque card with the
// engine's message and hint, its code for reference, and Retry. An interrupted read (the 5 s deadline) suggests
// narrowing the range or the lanes. The card never clears the selection; it only reports.

import ScrollsContracts
import SwiftUI

nonisolated enum ErrorCardCopy {
  static let retry = "Retry"
  /// The hint added to a `QUERY_TIMEOUT` (§4.18).
  static let narrow = "Narrow the range or the lanes."
}

/// What an error card shows.
nonisolated struct ErrorCardModel: Sendable, Equatable {
  let what: String?
  let message: String
  let hint: String?
  let code: String?

  init(what: String? = nil, message: String, hint: String?, code: String?) {
    self.what = what
    self.message = message
    let extra = code == "QUERY_TIMEOUT" ? ErrorCardCopy.narrow : nil
    self.hint = [hint, extra].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " ").nilIfEmpty
    self.code = code
  }

  /// The card of an engine error (`ScrollsError`: code, message, hint).
  init(_ error: ScrollsError, what: String? = nil) {
    self.init(what: what, message: error.message, hint: error.hint, code: error.code.rawValue)
  }

  /// The card of any error: a `ScrollsError` keeps its code and hint; anything else shows its description.
  init(any error: any Error, what: String? = nil) {
    if let e = error as? ScrollsError {
      self.init(e, what: what)
    } else {
      self.init(what: what, message: String(describing: error), hint: nil, code: nil)
    }
  }
}

struct ErrorCard: View {
  let model: ErrorCardModel
  var onRetry: (() -> Void)?

  init(_ model: ErrorCardModel, onRetry: (() -> Void)? = nil) {
    self.model = model
    self.onRetry = onRetry
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let what = model.what {
        Text(what).font(Typography.cardTitle).foregroundStyle(Tokens.ink.color)
      }
      Label {
        Text(model.message).font(Typography.cardBody).foregroundStyle(Tokens.ink.color)
          .fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: "exclamationmark.triangle").foregroundStyle(Tokens.danger.color)
      }
      if let hint = model.hint {
        Text(hint).font(Typography.meta).foregroundStyle(Tokens.ink2.color)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let code = model.code {
        Text(verbatim: code).font(Typography.code).foregroundStyle(Tokens.ink3.color)
      }
      if let onRetry {
        Button(ErrorCardCopy.retry, action: onRetry)
          .buttonStyle(.bordered)
          .tint(Tokens.cyan.color)
          .frame(minHeight: Tokens.Geometry.minHit)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .opaquePanel()
    .accessibilityElement(children: .contain)
  }
}

nonisolated extension String {
  /// nil for the empty string.
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
