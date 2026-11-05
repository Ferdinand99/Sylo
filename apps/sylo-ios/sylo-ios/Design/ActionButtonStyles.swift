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
            buttonStyle(.glassProminent).modifier(OnAccentLabel())
        } else {
            buttonStyle(.borderedProminent).modifier(OnAccentLabel())
        }
    }

    /// The Save button in a toolbar. On iOS 26 and later it is drawn as tinted glass with a label
    /// that stays readable on the accent in both appearances; before that it is a plain text
    /// button, which needs nothing. Put `.disabled(...)` after this, so the label can dim.
    @ViewBuilder
    func toolbarSaveStyle() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glassProminent).modifier(OnAccentLabel())
        } else {
            self
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

/// The label colour for text on the accent colour (dark on the light cyan, white on the dark one).
/// Only while the button is enabled: a disabled button keeps the system's dimmed look, which the
/// system keeps readable. Apply it before `.disabled(...)`, so it can see that.
private struct OnAccentLabel: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View {
        if isEnabled {
            content.foregroundStyle(Color.onAccent)
        } else {
            content
        }
    }
}
