import SwiftUI

/// A small capsule tag after a name: "Published", "Draft", "Active", "Paused", "Beta". The tint is the
/// capsule's background; the text is plain, or in the tint with `tintsText`. The meaning is always in
/// the words, never in the colour alone.
struct StatusTag: View {
    let text: LocalizedStringKey
    var tint: Color = .secondary
    var tintsText = false

    init(_ text: LocalizedStringKey, tint: Color = .secondary, tintsText: Bool = false) {
        self.text = text
        self.tint = tint
        self.tintsText = tintsText
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(tintsText ? AnyShapeStyle(tint) : AnyShapeStyle(.primary))
            .background(tint.opacity(0.2), in: Capsule())
    }
}

/// "Active" or "Paused" next to the name of a schedule, a reminder or a watch.
struct ActiveBadge: View {
    let isActive: Bool

    var body: some View {
        if isActive {
            StatusTag("Active", tint: .green)
        } else {
            StatusTag("Paused")
        }
    }
}

#Preview {
    HStack {
        StatusTag("Published", tint: .green)
        StatusTag("Draft")
        StatusTag("Beta", tint: .accentColor, tintsText: true)
        ActiveBadge(isActive: false)
    }
}
