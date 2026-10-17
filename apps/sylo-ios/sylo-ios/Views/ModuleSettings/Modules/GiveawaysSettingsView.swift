import SwiftUI
import SyloKit

/// Giveaways: the winner ping and winner DMs, plus the running and recently ended giveaways.
/// Mirrors web-v2/src/moduleForms/Giveaways.jsx (End Now and Reroll stay on the web for now).
struct GiveawaysSettingsView: View {
    @State private var model: ModuleSettingsModel<GiveawaysPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Giveaways", model: model) { $settings, page in
            Section {
                Text("Staff start giveaways with /giveaway start; members join with the Enter button. Winners are drawn automatically at the end time.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                Picker("Ping", selection: $settings.ping) {
                    Text("No Ping").tag(GiveawaysPing.none)
                    Text(verbatim: "@here").tag(GiveawaysPing.here)
                    Text(verbatim: "@everyone").tag(GiveawaysPing.everyone)
                }
                Toggle("DM Each Winner", isOn: $settings.dmWinners)
            } header: {
                Text("Winner message")
            } footer: {
                Text("Who the winner message pings, and whether each winner also gets a direct message.")
            }

            Section {
                if page.activeGiveaways.isEmpty {
                    Text("None running. Start one with /giveaway start.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(page.activeGiveaways) { giveaway in
                        GiveawaysRow(giveaway: giveaway)
                    }
                }
            } header: {
                Text(verbatim: "Active giveaways (\(page.activeGiveaways.count))")
            }

            if !page.endedGiveaways.isEmpty {
                Section("Recently ended") {
                    ForEach(page.endedGiveaways) { giveaway in
                        GiveawaysRow(giveaway: giveaway)
                    }
                }
            }
        }
    }
}

/// "#12 · Nitro" over "#giveaways · 2 winners · 5 entries · ends in 3 days".
private struct GiveawaysRow: View {
    let giveaway: GiveawaysGiveaway

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "#\(giveaway.id) · \(giveaway.prize)")
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var details: String {
        let entries = giveaway.entries == 1 ? "1 entry" : "\(giveaway.entries) entries"
        let when = giveaway.endsAt.formatted(.relative(presentation: .named))
        switch giveaway.state {
        case .active:
            var parts = ["#\(giveaway.channel)",
                         giveaway.winners == 1 ? "1 winner" : "\(giveaway.winners) winners",
                         entries,
                         "ends \(when)"]
            if giveaway.isRoleGated { parts.append("role-gated") }
            return parts.joined(separator: " · ")
        case .ended:
            let won = giveaway.wonIds.isEmpty
                ? "no winner"
                : "won by " + giveaway.wonIds.map { "@\($0)" }.joined(separator: ", ")
            return [entries, won, "ended \(when)"].joined(separator: " · ")
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<GiveawaysPage> else { return nil }
        return GiveawaysPage(
            settings: GiveawaysSettings(ping: .here, dmWinners: true),
            giveaways: [
                GiveawaysGiveaway(id: 12, prize: "Nitro", winners: 2, endsAt: .now.addingTimeInterval(86_400 * 3),
                                  entries: 5, channel: "giveaways", requiredRoleId: "r1"),
                GiveawaysGiveaway(id: 9, prize: "Sticker pack", state: .ended, endsAt: .now.addingTimeInterval(-7_200),
                                  entries: 1, wonIds: ["222222222222222222"], channel: "giveaways"),
            ])
    }
    NavigationStack {
        GiveawaysSettingsView(server: "1", session: session)
    }
    .environment(session)
}
