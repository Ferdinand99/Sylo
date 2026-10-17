import SwiftUI
import SyloKit

/// Counting: the counting channel, its rules, the penalty role, and (read only) the current game
/// and who is benched. Mirrors web-v2/src/moduleForms/Counting.jsx.
struct CountingSettingsView: View {
    @State private var model: ModuleSettingsModel<CountingPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Counting", model: model) { $settings, page in
            Section {
                ChannelPicker(title: "Counting channel", selection: $settings.channelId, channels: page.channels)
            } footer: {
                if settings.resetOnFail {
                    Text("Members count upward in this channel, one number per message. A wrong number breaks the streak and it starts over from 1.")
                } else {
                    Text("Members count upward in this channel, one number per message. A wrong number is rejected and deleted.")
                }
            }

            Section {
                Toggle("React on a correct count", isOn: $settings.react)
                Toggle("Let one person count twice in a row", isOn: $settings.allowSameUser)
                Toggle("Reset when someone posts the wrong number", isOn: $settings.resetOnFail)
            } footer: {
                Text("Reactions are ✅ on a correct count and 🎉 on a new record. With repeats off, counters must take turns.")
            }

            Section {
                RolePicker(title: "Penalty role", selection: $settings.penaltyRoleId, roles: page.roles,
                           noneTitle: "None (no penalty)")
                if !settings.penaltyRoleId.isEmpty {
                    NumberField(title: "Bench for", value: $settings.penaltyMinutes,
                                range: CountingSettings.penaltyRange, unit: "min")
                }
            } header: {
                Text("Penalty")
            } footer: {
                Text("When someone breaks the streak, Sylo takes this role away and gives it back later. Point it at the role that lets people type in the counting channel; Sylo's top role must be above it. This is not a ban or a timeout.")
            }

            if !page.penalties.isEmpty {
                Section("Currently benched") {
                    ForEach(page.penalties) { penalty in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: penalty.label)
                            Text(verbatim: "@\(penalty.roleName)")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            if let restoreAt = penalty.restoreAt {
                                Text("Back \(restoreAt, format: .relative(presentation: .named))")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }

            Section {
                LabeledContent("Count") {
                    Text(page.state.current, format: .number)
                }
                LabeledContent("Best streak") {
                    Text(page.state.record, format: .number)
                }
            } header: {
                Text("Current game")
            } footer: {
                Text("Set or reset the count in the web dashboard.")
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<CountingPage> else { return nil }
        return CountingPage(
            settings: CountingSettings(channelId: "c1", penaltyRoleId: "r1", penaltyMinutes: 30),
            channels: [ChannelOption(id: "c1", name: "counting"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Counter")],
            state: CountingState(current: 41, record: 120, lastUserId: "u1"),
            penalties: [CountingPenalty(userId: "u2", label: "oops", roleName: "Counter",
                                        restoreAt: Date().addingTimeInterval(600))])
    }
    NavigationStack {
        CountingSettingsView(server: "1", session: session)
    }
    .environment(session)
}
