import SwiftUI
import SyloKit

/// A module with its switch: SF Symbol, name, Beta, and a short summary of its setup.
struct ModuleRow: View {
    let card: OverviewCard
    let isPending: Bool
    let setEnabled: @MainActor (Bool) -> Void

    @ScaledMetric(relativeTo: .body) private var iconWidth = 28

    var body: some View {
        Toggle(isOn: Binding(get: { card.isEnabled ?? false }, set: setEnabled)) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(card.name)
                        if card.isBeta {
                            BetaBadge()
                        }
                    }
                    ForEach(Array(card.lines.prefix(2).enumerated()), id: \.offset) { _, line in
                        Text("\(line.label): \(line.value)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if card.status == .blocked {
                        Label(blockedReason, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .symbolRenderingMode(.multicolor)
                    }
                }
            } icon: {
                Image(systemName: ModuleSymbol.name(forIcon: card.icon))
                    .foregroundStyle(.tint)
                    .frame(width: iconWidth)
            }
        }
        .disabled(isPending)
    }

    /// Why the module can't run, in Discord's own words for the intent.
    private var blockedReason: String {
        let names = card.missingIntents.map { Self.intentNames[$0] ?? $0 }
        guard !names.isEmpty else { return "Can't run on this server right now." }
        let list = ListFormatter.localizedString(byJoining: names)
        return "Needs the \(list) intent. Turn it on for the bot in the Discord Developer Portal."
    }

    private static let intentNames = [
        "GuildMembers": "Server Members",
        "GuildPresences": "Presence",
        "MessageContent": "Message Content",
    ]
}

/// The "Beta" tag for modules that are new and still settling in.
struct BetaBadge: View {
    var body: some View {
        Text("Beta")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(.tint)
            .background(.tint.opacity(0.15), in: Capsule())
    }
}

/// A card without a switch: opens its page in the web dashboard.
struct LinkCardRow: View {
    let card: OverviewCard
    let url: URL?

    @ScaledMetric(relativeTo: .body) private var iconWidth = 28

    var body: some View {
        if let url {
            Link(destination: url) {
                Label {
                    HStack {
                        Text(card.name)
                        Spacer()
                        Image(systemName: "arrow.up.forward")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: ModuleSymbol.name(forIcon: card.icon))
                        .foregroundStyle(.tint)
                        .frame(width: iconWidth)
                }
            }
            .foregroundStyle(.primary)
            .accessibilityHint("Opens in the web dashboard")
        }
    }
}

#Preview {
    List {
        ForEach(PreviewData.overview.groups.flatMap(\.cards)) { card in
            if card.hasToggle {
                ModuleRow(card: card, isPending: false) { _ in }
            } else {
                LinkCardRow(card: card, url: URL(string: "https://app.sylobot.com"))
            }
        }
    }
}
