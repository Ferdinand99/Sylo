import SwiftUI

/// The surface every card and tile shares: the card colour with a hairline border. A live surface
/// (new ticket, module on) lights its border and glows faintly.
struct SyloSurface: ViewModifier {
    var radius: CGFloat = SyloRadius.tile
    var isLive = false
    var isSelected = false

    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                shape.fill(
                    LinearGradient(
                        colors: [Color.syloCard2, Color.syloCard],
                        startPoint: .top, endPoint: .bottom))
            }
            .overlay {
                shape.strokeBorder(border, lineWidth: isLive || isSelected ? 1.25 : 1)
            }
            .shadow(
                color: isLive ? Color.syloGlow.opacity(colorScheme == .dark ? 0.22 : 0.18) : .clear,
                radius: 16, y: 2)
            .contentShape(shape)
    }

    private var border: Color {
        if isLive { return Color.syloCyan.opacity(0.55) }
        if isSelected { return Color.syloCyan.opacity(0.85) }
        return contrast == .increased ? Color.syloLineStrong : Color.syloLine
    }
}

extension View {
    /// Draws this view on a Sylo card: card colour, hairline border, optional live glow.
    func syloCard(radius: CGFloat = SyloRadius.tile, isLive: Bool = false, isSelected: Bool = false) -> some View {
        modifier(SyloSurface(radius: radius, isLive: isLive, isSelected: isSelected))
    }
}

/// A padded container drawn as a card.
struct SyloCard<Content: View>: View {
    var isLive = false
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(SyloSpacing.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .syloCard(isLive: isLive)
    }
}

/// A card for a group of settings: a small icon and title, then the content. For screens that are
/// not a `Form` (in a `Form` the sections are drawn as cards already, see ``syloFormStyle()``).
struct SectionCard<Content: View>: View {
    let title: LocalizedStringKey
    var systemImage: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.m) {
            Label {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.syloMuted)
            } icon: {
                if let systemImage {
                    Image(systemName: systemImage)
                        .foregroundStyle(Color.syloBrand)
                }
            }
            .accessibilityAddTraits(.isHeader)
            content
        }
        .padding(SyloSpacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .syloCard(radius: SyloRadius.row + 4)
    }
}

/// A bento tile: a small label with an icon on top, then the tile's content, filling a minimum
/// height so neighbours line up. Press feedback is the caller's (``syloPressable``).
struct BentoTile<Content: View>: View {
    let title: LocalizedStringKey
    var systemImage: String?
    var isLive = false
    var minHeight: CGFloat = 0
    @ViewBuilder var content: Content

    @ScaledMetric(relativeTo: .body) private var scaledMinHeight: CGFloat = 1

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.s) {
            Label {
                Text(title)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.syloMuted)
                    .lineLimit(2)
            } icon: {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.syloBrand)
                }
            }
            content
        }
        .padding(SyloSpacing.l)
        .frame(maxWidth: .infinity, minHeight: minHeight * scaledMinHeight, alignment: .topLeading)
        .syloCard(isLive: isLive)
    }
}
