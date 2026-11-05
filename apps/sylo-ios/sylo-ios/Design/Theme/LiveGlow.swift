import SwiftUI

/// A small dot for something alive: the bot is online, a ticket is new, a module is on. Lit, with
/// a halo, and a ring that breathes outward. With Reduce Motion the ring stays still.
struct LiveDot: View {
    var color: Color = .syloGlow
    var size: CGFloat = 10
    var isLive = true
    var pulses = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false

    var body: some View {
        ZStack {
            if isLive {
                Circle()
                    .stroke(color, lineWidth: 1.5)
                    .frame(width: size, height: size)
                    .scaleEffect(expanded ? 2.6 : 1)
                    .opacity(expanded ? 0 : (pulses && !reduceMotion ? 0.7 : 0))
            }
            Circle()
                .fill(isLive ? color : Color.syloMuted.opacity(0.45))
                .frame(width: size, height: size)
                .shadow(color: isLive ? color.opacity(0.8) : .clear, radius: size * 0.6)
        }
        .frame(width: size, height: size)
        .onAppear {
            guard isLive, pulses, !reduceMotion else { return }
            withAnimation(SyloMotion.pulse) { expanded = true }
        }
        .accessibilityHidden(true)
    }
}

extension View {
    /// A cyan halo behind this view while `isLive`, for the one thing on a screen that is alive.
    func syloGlow(isLive: Bool = true, radius: CGFloat = 14) -> some View {
        shadow(color: isLive ? Color.syloGlow.opacity(0.45) : .clear, radius: radius)
    }
}

/// A quiet breathing of scale while `isActive`: the "new ticket" badge. Still with Reduce Motion.
struct PulseModifier: ViewModifier {
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isLarge = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(isActive && isLarge && !reduceMotion ? 1.08 : 1)
            .onAppear {
                guard isActive, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { isLarge = true }
            }
    }
}

extension View {
    func syloPulse(_ isActive: Bool = true) -> some View {
        modifier(PulseModifier(isActive: isActive))
    }
}
