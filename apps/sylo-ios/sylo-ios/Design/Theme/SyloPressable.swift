import SwiftUI

/// Press feedback for a tappable card: it sinks a little while a finger is down. Not drawn with
/// Reduce Motion on; the tap still works.
struct SyloPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .animation(SyloMotion.quick, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == SyloPressStyle {
    static var syloPress: SyloPressStyle { SyloPressStyle() }
}

/// A view that reacts to a tap and to a press-and-hold, with the card press feedback. A plain tap
/// gesture rather than a button, so a hold does not also count as a tap.
struct SyloPressable: ViewModifier {
    let tap: () -> Void
    var hold: (() -> Void)?
    var holdDuration: Double = 0.45

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPressed = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(isPressed ? 0.92 : 1)
            .animation(SyloMotion.quick, value: isPressed)
            .onTapGesture(perform: tap)
            .onLongPressGesture(minimumDuration: holdDuration, maximumDistance: 12) {
                hold?()
            } onPressingChanged: { pressing in
                isPressed = pressing
            }
    }
}

extension View {
    func syloPressable(tap: @escaping () -> Void, hold: (() -> Void)? = nil) -> some View {
        modifier(SyloPressable(tap: tap, hold: hold))
    }
}
