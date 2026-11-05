import SwiftUI

/// The Sylo mark, drawn as a swept feather: a pointed blade rising from bottom left to top right,
/// with its quill. Drawn from paths so it is sharp at any size and takes any colour.
nonisolated struct SyloMarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y)
        }
        var path = Path()
        let tail = point(0.10, 0.92)
        let tip = point(0.92, 0.08)
        path.move(to: tail)
        // The upper edge bows out to the left of the diagonal, the lower edge to the right.
        path.addCurve(to: tip, control1: point(0.02, 0.38), control2: point(0.50, 0.04))
        path.addCurve(to: tail, control1: point(0.98, 0.52), control2: point(0.52, 0.98))
        path.closeSubpath()
        return path
    }
}

/// The quill: a thin line along the blade, cut out of it.
private nonisolated struct SyloQuillShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.20, y: rect.minY + rect.height * 0.80))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + rect.width * 0.78, y: rect.minY + rect.height * 0.22),
            control: CGPoint(x: rect.minX + rect.width * 0.44, y: rect.minY + rect.height * 0.56))
        return path
    }
}

/// The mark as a view, in the brand cyan, with the quill cut out.
struct SyloMark: View {
    var size: CGFloat = 28
    var color: Color = .syloCyan

    var body: some View {
        SyloMarkShape()
            .fill(color)
            .overlay {
                SyloQuillShape()
                    .stroke(Color.syloBackground, style: StrokeStyle(lineWidth: max(size * 0.045, 1), lineCap: .round))
                    .blendMode(.destinationOut)
            }
            .compositingGroup()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The loading indicator: the Sylo mark, breathing in its own glow. With Reduce Motion it is
/// still. Announces "Loading" to VoiceOver.
struct SyloLoader: View {
    var size: CGFloat = 44

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isBright = false

    var body: some View {
        SyloMark(size: size)
            .scaleEffect(isBright && !reduceMotion ? 1.06 : 0.94)
            .opacity(isBright || reduceMotion ? 1 : 0.65)
            .shadow(color: Color.syloGlow.opacity(isBright || reduceMotion ? 0.6 : 0.15), radius: size * 0.4)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) { isBright = true }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Loading"))
    }
}

/// A full-screen loading state.
struct SyloLoadingView: View {
    var body: some View {
        SyloLoader()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
