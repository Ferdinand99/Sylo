import SwiftUI
import SyloKit

/// Giveaways: the winner ping and winner DMs, plus the running and recently ended giveaways, which
/// staff can end now, cancel (when the server offers it) and reroll. Mirrors
/// web-v2/src/moduleForms/Giveaways.jsx.
struct GiveawaysSettingsView: View {
    @State private var model: ModuleSettingsModel<GiveawaysPage>
    @State private var actions: GiveawayActionsModel
    @State private var ending: GiveawaysGiveaway?
    @State private var cancelling: GiveawaysGiveaway?
    @State private var rerolling: GiveawaysGiveaway?
    @State private var rerollCount = "1"

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _actions = State(initialValue: GiveawayActionsModel(server: server, session: session))
    }

    var body: some View {
        alerts
    }

    /// The form with its confirmations and alerts, in layers so each stays quick to type-check.
    private var alerts: some View {
        dialogs
            .alert("Reroll Winners", isPresented: isRerolling, presenting: rerolling) { giveaway in
                TextField("Winners", text: $rerollCount)
                    .keyboardType(.numberPad)
                Button("Reroll") {
                    let count = Int(rerollCount.trimmingCharacters(in: .whitespaces)) ?? 1
                    Task { await actions.reroll(giveaway, count: count) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { giveaway in
                Text("Giveaway #\(giveaway.id): new winners are drawn from the entrants and announced. How many (1 to \(GiveawaysGiveaway.rerollRange.upperBound))?")
            }
            .alert("Couldn't Update Giveaway", isPresented: isShowingError, presenting: actions.errorMessage) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
            .alert(noticeTitle, isPresented: isShowingNotice, presenting: actions.notice) { _ in
                Button("OK") {}
            } message: { notice in
                Text(notice.message)
            }
            .sensoryFeedback(.success, trigger: actions.doneCount)
    }

    private var noticeTitle: LocalizedStringKey {
        actions.notice?.isError == true ? "Some Entry Fees Are Still Open" : "Giveaway Cancelled"
    }

    private var dialogs: some View {
        form
            .confirmationDialog(
                "End This Giveaway Now?", isPresented: isEnding, titleVisibility: .visible, presenting: ending
            ) { giveaway in
                Button("End and Draw Winners") { Task { await actions.end(giveaway) } }
                Button("Keep Running", role: .cancel) {}
            } message: { giveaway in
                Text("Giveaway #\(giveaway.id): the winners are drawn immediately and announced in the giveaway channel.")
            }
            .confirmationDialog(
                "Cancel This Giveaway?", isPresented: isCancelling, titleVisibility: .visible, presenting: cancelling
            ) { giveaway in
                Button("Cancel Giveaway", role: .destructive) { Task { await actions.cancel(giveaway) } }
                Button("Keep Running", role: .cancel) {}
            } message: { giveaway in
                Text(Self.cancelMessage(giveaway))
            }
    }

    private var form: some View {
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

            let giveaways = actions.giveaways ?? page.giveaways
            let active = giveaways.filter { $0.state == .active }
            let ended = giveaways.filter { $0.state == .ended }

            Section {
                if active.isEmpty {
                    Text("None running. Start one with /giveaway start.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(active) { giveaway in
                        row(giveaway)
                    }
                }
            } header: {
                Text(verbatim: "Active giveaways (\(active.count))")
            }

            if !ended.isEmpty {
                Section("Recently ended") {
                    ForEach(ended) { giveaway in
                        row(giveaway)
                    }
                }
            }
        }
        // A fresh page replaces what the last action answered.
        .onChange(of: model.page?.giveaways) { actions.forgetAnswer() }
    }

    /// One giveaway with its menu: End Now and Cancel while it runs, Reroll once it has ended.
    private func row(_ giveaway: GiveawaysGiveaway) -> some View {
        HStack(alignment: .top) {
            GiveawaysRow(giveaway: giveaway)
            Spacer(minLength: 0)
            if actions.busyID == giveaway.id {
                ProgressView()
            } else {
                Menu {
                    menuActions(for: giveaway)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .imageScale(.large)
                        .accessibilityLabel("Actions for giveaway #\(giveaway.id)")
                }
                .disabled(actions.busyID != nil)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            swipeButtons(for: giveaway)
        }
        .contextMenu { menuActions(for: giveaway) }
    }

    @ViewBuilder
    private func menuActions(for giveaway: GiveawaysGiveaway) -> some View {
        switch giveaway.state {
        case .active:
            Button("End Now", systemImage: "flag.checkered") { ending = giveaway }
            if giveaway.canCancel {
                Button("Cancel Giveaway", systemImage: "xmark.circle", role: .destructive) { cancelling = giveaway }
            }
        case .ended:
            Button("Reroll", systemImage: "dice") { askReroll(giveaway) }
        }
    }

    @ViewBuilder
    private func swipeButtons(for giveaway: GiveawaysGiveaway) -> some View {
        switch giveaway.state {
        case .active:
            if giveaway.canCancel {
                Button("Cancel", systemImage: "xmark.circle", role: .destructive) { cancelling = giveaway }
            }
            Button("End Now", systemImage: "flag.checkered") { ending = giveaway }
                .tint(.orange)
        case .ended:
            Button("Reroll", systemImage: "dice") { askReroll(giveaway) }
                .tint(.indigo)
        }
    }

    private func askReroll(_ giveaway: GiveawaysGiveaway) {
        rerollCount = "1"
        rerolling = giveaway
    }

    /// What cancelling does, in the dashboard's words: with an entry fee, everyone gets it back.
    static func cancelMessage(_ giveaway: GiveawaysGiveaway) -> String {
        if giveaway.entryFee > 0 {
            return String(localized: "Giveaway #\(giveaway.id): nobody wins, and everyone who entered gets their entry fee of \(DateText.count(giveaway.entryFee)) back.")
        }
        return String(localized: "Giveaway #\(giveaway.id): nobody wins. The giveaway message is closed.")
    }

    private var isEnding: Binding<Bool> {
        Binding(get: { ending != nil }, set: { if !$0 { ending = nil } })
    }

    private var isCancelling: Binding<Bool> {
        Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })
    }

    private var isRerolling: Binding<Bool> {
        Binding(get: { rerolling != nil }, set: { if !$0 { rerolling = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { actions.errorMessage != nil }, set: { if !$0 { actions.errorMessage = nil } })
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { actions.notice != nil }, set: { if !$0 { actions.notice = nil } })
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
            if giveaway.entryFee > 0 { parts.append("entry fee \(DateText.count(giveaway.entryFee))") }
            if giveaway.prizeAmount > 0 { parts.append("pays \(DateText.count(giveaway.prizeAmount)) each") }
            return parts.joined(separator: " · ")
        case .ended:
            return [entries, outcome, "ended \(when)"].joined(separator: " · ")
        }
    }

    /// "cancelled", "won by Alex, Sam" or "no winner".
    private var outcome: String {
        if giveaway.isCancelled { return "cancelled" }
        if giveaway.wonIds.isEmpty { return "no winner" }
        let names = giveaway.wonIds.indices.map { giveaway.winnerName(at: $0) }
        return "won by " + names.joined(separator: ", ")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<GiveawaysPage> else { return nil }
        return GiveawaysPage(
            settings: GiveawaysSettings(ping: .here, dmWinners: true),
            giveaways: [
                GiveawaysGiveaway(id: 12, prize: "Nitro", winners: 2, endsAt: .now.addingTimeInterval(86_400 * 3),
                                  entries: 5, channel: "giveaways", requiredRoleId: "r1", entryFee: 100, cancelled: false),
                GiveawaysGiveaway(id: 9, prize: "Sticker pack", state: .ended, endsAt: .now.addingTimeInterval(-7_200),
                                  entries: 1, wonIds: ["222222222222222222"], channel: "giveaways",
                                  wonNames: ["Alex"], cancelled: false),
            ])
    }
    NavigationStack {
        GiveawaysSettingsView(server: "1", session: session)
    }
    .environment(session)
}
