import SwiftUI

/// A small rounded label: Beta, Discord, Fluxer, 4 open. Always text (and optionally a symbol),
/// never colour alone.
struct SyloPill: View {
    let text: Text
    var systemImage: String?
    var tint: Color = .syloBrand
    var filled = false

    init(_ text: LocalizedStringKey, systemImage: String? = nil, tint: Color = .syloBrand, filled: Bool = false) {
        self.text = Text(text)
        self.systemImage = systemImage
        self.tint = tint
        self.filled = filled
    }

    init(verbatim text: String, systemImage: String? = nil, tint: Color = .syloBrand, filled: Bool = false) {
        self.text = Text(verbatim: text)
        self.systemImage = systemImage
        self.tint = tint
        self.filled = filled
    }

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2.weight(.semibold))
            }
            text
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(filled ? Color.syloOnCyan : tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(filled ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.14)), in: Capsule())
        .overlay { Capsule().strokeBorder(tint.opacity(filled ? 0 : 0.35), lineWidth: 1) }
        .accessibilityElement(children: .combine)
    }
}

/// Which platform a server lives on: Discord (blurple) or Fluxer (violet).
struct PlatformPill: View {
    let platformName: String
    let isFluxer: Bool

    var body: some View {
        SyloPill(verbatim: platformName, systemImage: isFluxer ? "sparkle" : "gamecontroller.fill",
                 tint: isFluxer ? .syloFluxer : .syloDiscord)
    }
}
