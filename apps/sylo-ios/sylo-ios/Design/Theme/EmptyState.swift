import SwiftUI

/// An empty or failed screen: a glowing symbol in a ring, a title, a line of help and, when there
/// is something to do, one action. Replaces the system's unavailable view so the empty screens
/// look like the rest of the app.
struct EmptyState: View {
    let title: LocalizedStringKey
    let systemImage: String
    var message: Text?
    var isError = false
    var actionTitle: LocalizedStringKey?
    var action: (() -> Void)?

    @ScaledMetric(relativeTo: .largeTitle) private var ringSize: CGFloat = 76

    init(
        _ title: LocalizedStringKey, systemImage: String, message: Text? = nil, isError: Bool = false,
        actionTitle: LocalizedStringKey? = nil, action: (() -> Void)? = nil
    ) {
        self.title = title
        self.systemImage = systemImage
        self.message = message
        self.isError = isError
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        VStack(spacing: SyloSpacing.l) {
            ZStack {
                Circle()
                    .fill(RadialGradient(
                        colors: [tint.opacity(0.22), tint.opacity(0.04)],
                        center: .center, startRadius: 0, endRadius: ringSize * 0.6))
                Circle().strokeBorder(tint.opacity(0.45), lineWidth: 1)
                Image(systemName: systemImage)
                    .font(.system(size: ringSize * 0.38, weight: .medium))
                    .foregroundStyle(isError ? Color.syloWarn : Color.syloBrand)
                    .symbolRenderingMode(.hierarchical)
            }
            .frame(width: ringSize, height: ringSize)
            .shadow(color: tint.opacity(0.35), radius: 18)
            .accessibilityHidden(true)

            VStack(spacing: SyloSpacing.xs) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                if let message {
                    message
                        .font(.subheadline)
                        .foregroundStyle(Color.syloMuted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .secondaryActionStyle()
            }
        }
        .padding(SyloSpacing.xl)
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var tint: Color { isError ? .syloWarn : .syloGlow }
}

#Preview {
    EmptyState("No Tickets", systemImage: "bubble.left.and.bubble.right",
               message: Text("New tickets show up here for you to answer."))
        .syloScreen()
}
