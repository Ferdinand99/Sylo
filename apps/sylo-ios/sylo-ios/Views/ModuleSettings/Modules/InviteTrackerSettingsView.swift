import SwiftUI
import SyloKit

/// Invite tracker: the join/leave log channel, the fake-invite grace window, and the invite
/// leaderboard. Mirrors web-v2/src/moduleForms/InviteTracker.jsx (without its bonus form).
struct InviteTrackerSettingsView: View {
    @State private var model: ModuleSettingsModel<InviteTrackerPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Invite Tracker", model: model) { $settings, page in
            Section {
                Text("Members get a personal invite link with /invites. When someone joins through it, that member's invite count goes up. /inviter and /invites-leaderboard read the same data.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if !page.board.canReadInvites {
                    Label("Sylo needs the Manage Server permission to read this server's invites. Without it, joins can't be credited to an inviter.", systemImage: "exclamationmark.triangle")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                }
            }

            Section {
                ChannelPicker(title: "Join and leave log", selection: $settings.joinLogChannelId,
                              channels: page.channels)
            } footer: {
                Text("Sylo posts a line here each time someone joins or leaves.")
            }

            Section {
                NumberField(title: "Grace window", value: $settings.graceHours,
                            range: InviteTrackerSettings.graceHoursRange, unit: "h")
            } footer: {
                Text("A join that leaves inside this window isn't counted. 0 turns the guard off.")
            }

            Section {
                if page.board.rows.isEmpty {
                    Text("No invites tracked yet.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(page.board.rows, id: \.userId) { row in
                        InviteTrackerInviterRow(row: row)
                    }
                }
            } header: {
                Text("Leaderboard")
            } footer: {
                if page.board.total > 0 {
                    Text("^[\(page.board.total) member](inflect: true) invited someone.")
                }
            }
        }
    }
}

/// "#1 · ada" over "7 invites · 9 joined · 3 left · 1 bonus".
private struct InviteTrackerInviterRow: View {
    let row: InviteTrackerInviter

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "#\(row.rank) · \(row.name)")
            Text("^[\(row.net) invite](inflect: true) ·\(row.regular) joined · \(row.leaves) left · \(row.bonus) bonus")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<InviteTrackerPage> else { return nil }
        return InviteTrackerPage(
            settings: InviteTrackerSettings(joinLogChannelId: "c1", graceHours: 48),
            channels: [ChannelOption(id: "c1", name: "joins"), ChannelOption(id: "c2", name: "general")],
            board: InviteTrackerBoard(total: 2, rows: [
                InviteTrackerInviter(rank: 1, userId: "u1", name: "ada", net: 7, regular: 9, leaves: 3, bonus: 1),
                InviteTrackerInviter(rank: 2, userId: "u2", name: "grace", net: 1, regular: 1),
            ]))
    }
    NavigationStack {
        InviteTrackerSettingsView(server: "1", session: session)
    }
    .environment(session)
}
