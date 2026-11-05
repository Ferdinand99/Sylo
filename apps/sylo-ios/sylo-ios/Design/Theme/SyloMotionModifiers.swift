import SwiftUI

/// Lets a view settle in when it first appears: a short rise and fade, staggered by `index`, so a
/// screen assembles itself instead of snapping in. Does nothing with Reduce Motion, and only for
/// the first few items, so a long list scrolling in does not replay it.
struct ArrivalModifier: ViewModifier {
    let index: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hasArrived = false

    func body(content: Content) -> some View {
        content
            .opacity(hasArrived || reduceMotion || index >= 8 ? 1 : 0)
            .offset(y: hasArrived || reduceMotion || index >= 8 ? 0 : 14)
            .onAppear {
                guard !hasArrived, !reduceMotion, index < 8 else { return }
                withAnimation(SyloMotion.arrival(index: index)) { hasArrived = true }
            }
    }
}

extension View {
    func syloArrival(index: Int) -> some View {
        modifier(ArrivalModifier(index: index))
    }
}
