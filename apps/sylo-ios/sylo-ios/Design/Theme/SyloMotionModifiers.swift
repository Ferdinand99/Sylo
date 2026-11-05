import SwiftUI

extension View {
    /// Marks this view as where a zoom transition starts (iOS 18 and later; nothing before).
    @ViewBuilder
    func syloZoomSource<ID: Hashable>(id: ID, in namespace: Namespace.ID) -> some View {
        if #available(iOS 18, *) {
            matchedTransitionSource(id: id, in: namespace)
        } else {
            self
        }
    }

    /// Makes this screen zoom out of the source with the same id (iOS 18 and later; the standard
    /// push before).
    @ViewBuilder
    func syloZoomDestination<ID: Hashable>(id: ID, in namespace: Namespace.ID) -> some View {
        if #available(iOS 18, *) {
            navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            self
        }
    }
}

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
