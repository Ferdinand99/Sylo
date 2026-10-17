import SwiftUI

// The app runs on iOS 17 and later but is built with the iOS 27 SDK. System bars, sidebars,
// sheets and controls pick up Liquid Glass by themselves on iOS 26 and later; only the button
// styles below ask for it explicitly, so they fall back to the classic styles on older systems.

extension View {
    /// The one main action on a screen, such as Sign in: tinted glass on iOS 26 and later,
    /// a filled button before.
    @ViewBuilder
    func primaryActionStyle() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glassProminent)
        } else {
            buttonStyle(.borderedProminent)
        }
    }

    /// Any other action next to the main one: clear glass on iOS 26 and later, a bordered
    /// button before.
    @ViewBuilder
    func secondaryActionStyle() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glass)
        } else {
            buttonStyle(.bordered)
        }
    }
}
