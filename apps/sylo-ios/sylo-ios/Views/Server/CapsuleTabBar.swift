import SwiftUI

/// The floating tab bar of a server: a glass capsule near the bottom edge with four places. The
/// current one wears a cyan marker that slides to the next with a spring and shows its name; the
/// others are icons. Liquid Glass on iOS 26 and later, a blurred material with a hairline before.
///
/// Not the system `TabBar`, but still plain buttons: every item is a button with a name and the
/// "selected" trait for VoiceOver, 44 pt high, and it keeps working with the keyboard and Switch
/// Control. The screens pushed from a tab cover it, like the system bar.
struct CapsuleTabBar: View {
    struct Item: Identifiable {
        let tab: ServerView.ServerTab
        let title: LocalizedStringKey
        let systemImage: String
        var badge = 0

        var id: ServerView.ServerTab { tab }
    }

    /// The bar's own measurements, so everything that makes room for it uses the same numbers.
    static let itemHeight: CGFloat = 44
    static let padding: CGFloat = 5
    static let bottomGap: CGFloat = SyloSpacing.xs
    /// The height of the capsule.
    static let height: CGFloat = itemHeight + padding * 2
    /// How far a scroll view's content stops short of the bottom edge: the bar, its gap and some air.
    static let clearance: CGFloat = height + bottomGap + 26
    /// How tall the fade behind the bar is.
    static let fadeHeight: CGFloat = clearance + 20

    let items: [Item]
    @Binding var selection: ServerView.ServerTab

    @Namespace private var marker
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items) { item in
                button(for: item)
            }
        }
        .accessibilityElement(children: .contain)
        .padding(Self.padding)
        .background { barBackground }
        .shadow(color: .black.opacity(0.28), radius: 18, y: 8)
        // The system caps its tab bar's type size; so does this one.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .sensoryFeedback(.selection, trigger: selection)
        .padding(.horizontal, SyloSpacing.l)
        .padding(.bottom, Self.bottomGap)
    }

    @ViewBuilder
    private var barBackground: some View {
        if #available(iOS 26, *) {
            Capsule()
                .fill(Color.clear)
                .glassEffect(.regular, in: .capsule)
                .overlay { Capsule().strokeBorder(Color.syloLine, lineWidth: 1) }
        } else {
            Capsule()
                .fill(.ultraThinMaterial)
                .overlay {
                    Capsule().strokeBorder(contrast == .increased ? Color.syloLineStrong : Color.syloLine, lineWidth: 1)
                }
        }
    }

    private func button(for item: Item) -> some View {
        let isSelected = item.tab == selection
        return Button {
            withAnimation(reduceMotion ? nil : SyloMotion.settle) { selection = item.tab }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: item.systemImage)
                    .font(.system(size: 17, weight: .semibold))
                    .symbolVariant(isSelected ? .fill : .none)
                    .overlay(alignment: .topLeading) {
                        if item.badge > 0 { badge(item.badge) }
                    }
                if isSelected {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: .leading)))
                }
            }
            .foregroundStyle(isSelected ? Color.syloOnCyan : Color.syloText.opacity(0.78))
            .padding(.horizontal, isSelected ? 14 : 12)
            .frame(minWidth: Self.itemHeight, minHeight: Self.itemHeight)
            .background {
                if isSelected {
                    Capsule()
                        .fill(Color.syloCyan)
                        .shadow(color: Color.syloGlow.opacity(0.5), radius: 10)
                        .matchedGeometryEffect(id: "marker", in: marker)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(item.title))
        // The bar stops growing with text size, so a press and hold shows the item large, like the system bar.
        .accessibilityShowsLargeContentViewer {
            Label(item.title, systemImage: item.systemImage)
        }
        .accessibilityValue(item.badge > 0 ? Text("\(item.badge) unread") : Text(verbatim: ""))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func badge(_ count: Int) -> some View {
        Text(verbatim: count > 99 ? "99+" : "\(count)")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(Color.white)
            .padding(.horizontal, 4)
            .frame(minWidth: 16, minHeight: 16)
            .background(Color.syloBad, in: Capsule())
            .overlay { Capsule().strokeBorder(Color.syloBackground, lineWidth: 1.5) }
            .offset(x: -9, y: -8)
            .accessibilityHidden(true)
    }
}
