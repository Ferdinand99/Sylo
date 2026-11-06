import SwiftUI
import SyloKit

/// Giveaways: the winner ping and winner DMs, plus the running and recently ended giveaways.
/// Mirrors web-v2/src/moduleForms/Giveaways.jsx (with End Now and Reroll).
struct GiveawaysSettingsView: View {
    @State private var model: ModuleSettingsModel<GiveawaysPage>
    @State private var runner: ActionRunner
    @State private var pendingEnd: GiveawaysGiveaway?
    @State private var rerolling: GiveawaysGiveaway?
    private let server: ServerID

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        ModuleSettingsForm("Giveaways", model: model) { $settings, page in
            ModuleIntro("Staff start giveaways with /giveaway start; members join with the Enter button. Winners are drawn automatically at the end time.")

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
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("End Now", systemImage: "flag.checkered", role: .destructive) { pendingEnd = giveaway }
                            }
                            .contextMenu {
                                Button("End Now", systemImage: "flag.checkered", role: .destructive) { pendingEnd = giveaway }
                            }
                            .accessibilityAction(named: Text("End Now")) { pendingEnd = giveaway }
                    }
                }
            } header: {
                Text(verbatim: "Active giveaways (\(page.activeGiveaways.count))")
            }

            if !page.endedGiveaways.isEmpty {
                Section("Recently ended") {
                    ForEach(page.endedGiveaways) { giveaway in
                        GiveawaysRow(giveaway: giveaway)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("Reroll", systemImage: "dice") { rerolling = giveaway }
                                    .tint(Color.syloCyan)
                            }
                            .contextMenu {
                                Button("Reroll", systemImage: "dice") { rerolling = giveaway }
                            }
                            .accessibilityAction(named: Text("Reroll")) { rerolling = giveaway }
                    }
                }
            }
        }
        .sheet(item: $rerolling) { giveaway in
            MemberNumberEditor(
                title: "Reroll Winners", asksForMember: false, valueTitle: "Winners", range: 1...20, initial: giveaway.winners,
                footer: "Draws new winners from the entries of \u{201C}\(giveaway.prize)\u{201D}.", saveTitle: "Reroll",
                save: { _, count in
                    guard await runner.run(Endpoints.RerollGiveaway(server: server, id: giveaway.id, count: count)) != nil else { return false }
                    await model.load()
                    return true
                }, failure: { runner.errorMessage })
        }
        .confirmationDialog(
            "End this giveaway now?", isPresented: isConfirmingEnd, titleVisibility: .visible, presenting: pendingEnd
        ) { giveaway in
            Button("End Giveaway", role: .destructive) {
                Task { if await runner.run(Endpoints.EndGiveaway(server: server, id: giveaway.id)) != nil { await model.load() } }
            }
        } message: { giveaway in
            Text("Winners are drawn for \u{201C}\(giveaway.prize)\u{201D} straight away and announced in the channel.")
        }
        .alert("Couldn't Complete", isPresented: isShowingError, presenting: runner.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: runner.successCount)
    }

    private var isConfirmingEnd: Binding<Bool> {
        Binding(get: { pendingEnd != nil }, set: { if !$0 { pendingEnd = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { runner.errorMessage != nil && rerolling == nil }, set: { if !$0 { runner.errorMessage = nil } })
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
