import SwiftUI
import SyloKit

/// A module row in select mode: a checkmark in front of its name and whether it is on now. Tapping
/// anywhere on the row picks or unpicks it.
struct ModuleSelectionRow: View {
    let card: OverviewCard
    let isSelected: Bool
    let toggle: () -> Void

    @ScaledMetric(relativeTo: .body) private var iconWidth = 28

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 12) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .accessibilityHidden(true)
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(card.name)
                            if card.isBeta {
                                BetaBadge()
                            }
                        }
                        Text(card.isEnabled == true ? "On" : "Off")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: ModuleSymbol.name(forIcon: card.icon))
                        .foregroundStyle(.tint)
                        .frame(width: iconWidth)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// The bar above the tab bar in select mode: how many modules are picked, Cancel, and the two
/// switches. Nothing is sent until one of them is pressed.
struct ModuleSelectionBar: View {
    let count: Int
    let isBusy: Bool
    let cancel: () -> Void
    let turnOn: () -> Void
    let turnOff: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Text("^[\(count) module](inflect: true) selected")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Button("Cancel", role: .cancel, action: cancel)
                    .buttonStyle(.bordered)
                Spacer(minLength: 8)
                Button("Turn Off", action: turnOff)
                    .buttonStyle(.bordered)
                    .disabled(count == 0 || isBusy)
                Button("Turn On", action: turnOn)
                    .buttonStyle(.borderedProminent)
                    .disabled(count == 0 || isBusy)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

#Preview {
    VStack(spacing: 0) {
        List {
            ModuleSelectionRow(card: PreviewData.overview.groups[0].cards[1], isSelected: true) {}
            ModuleSelectionRow(card: PreviewData.overview.groups[0].cards[2], isSelected: false) {}
        }
        ModuleSelectionBar(count: 1, isBusy: false, cancel: {}, turnOn: {}, turnOff: {})
    }
}
