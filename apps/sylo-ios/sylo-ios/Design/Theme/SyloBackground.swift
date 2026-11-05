import SwiftUI

/// The screen background: the near-black blue (a pale blue-grey in light) with a faint cyan light
/// at the top edge, like the hero of the website. Put it behind a screen with `.syloScreen()`.
struct SyloBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack(alignment: .top) {
            Color.syloBackground
            RadialGradient(
                colors: [Color.syloGlow.opacity(colorScheme == .dark ? 0.16 : 0.12), .clear],
                center: .top, startRadius: 0, endRadius: 460)
                .frame(height: 520)
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// The Sylo background behind a screen, with a scrolling list or form's own background hidden.
    func syloScreen() -> some View {
        scrollContentBackground(.hidden)
            .background { SyloBackground() }
    }
}
