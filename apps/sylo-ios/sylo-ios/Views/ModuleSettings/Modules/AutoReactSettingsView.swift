import SwiftUI
import SyloKit

/// Auto-react: a per-user cooldown, a log channel, and rules that react (and optionally change a
/// role) when a message comes from chosen users or a chosen role. Mirrors
/// web-v2/src/moduleForms/AutoReact.jsx.
struct AutoReactSettingsView: View {
    @State private var model: ModuleSettingsModel<AutoReactPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Auto-react", model: model) { $settings, page in
            Section {
                Text("Reacts automatically to messages from chosen users or roles. Each rule is independent, and the first rule that matches a message wins.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                NumberField(title: "Per-user cooldown", value: $settings.cooldownSeconds,
                            range: AutoReactSettings.cooldownRange, unit: "sec")
            } footer: {
                Text("How long to wait before reacting to the same person again.")
            }

            Section {
                ChannelPicker(title: "Log channel", selection: $settings.logChannelId, channels: page.channels)
            } footer: {
                Text("Posts one line here every time a rule triggers: who it reacted to and what changed.")
            }

            // One section per rule, so each control gets its own row.
            ForEach($settings.rules) { $rule in
                Section {
                    TextField("Target users", text: $rule.targetUsersText,
                              prompt: Text(verbatim: "123456789012345678 @SomeUser"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    RolePicker(title: "Target role", selection: $rule.targetRoleId, roles: page.roles,
                               noneTitle: "No role")
                    ChannelPicker(title: "Channel", selection: $rule.channelId, channels: page.channels,
                                  noneTitle: "All channels")
                    TextField("Emoji to react with", text: $rule.emojisText, prompt: Text(verbatim: "🧟 🔥"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("When to react", selection: $rule.mode) {
                        ForEach(AutoReactMode.allCases, id: \.self) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    if rule.mode == .random {
                        NumberField(title: "Chance", value: $rule.chance, range: AutoReactSettings.chanceRange,
                                    unit: "%")
                    }
                    RolePicker(title: "Also change a role", selection: $rule.roleId, roles: page.roles,
                               noneTitle: "No role change")
                    if !rule.roleId.isEmpty {
                        Picker("Role change", selection: $rule.roleAction) {
                            ForEach(AutoReactRoleAction.allCases, id: \.self) { action in
                                Text(action.title).tag(action)
                            }
                        }
                    }
                    Button("Remove Rule", role: .destructive) {
                        settings.rules.removeAll { $0.id == rule.id }
                    }
                } header: {
                    Text("Rule")
                } footer: {
                    Text("Matches if either the users or the role match. Users are IDs or @mentions, emoji are separated by spaces or commas.")
                }
            }
            Section {
                if settings.rules.count < AutoReactSettings.maxRules {
                    Button("Add Rule", systemImage: "plus") {
                        settings.rules.append(AutoReactSettings.Rule())
                    }
                }
            } footer: {
                Text("A rule without target users or a role, or without emoji, is dropped when you save.")
            }
        }
    }
}

extension AutoReactMode {
    var title: LocalizedStringKey {
        switch self {
        case .always: "React to every message"
        case .random: "React at a random chance"
        }
    }
}

extension AutoReactRoleAction {
    var title: LocalizedStringKey {
        switch self {
        case .add: "Give them the role"
        case .remove: "Take the role away"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<AutoReactPage> else { return nil }
        return AutoReactPage(
            settings: AutoReactSettings(
                cooldownSeconds: 10, logChannelId: "c1",
                rules: [AutoReactSettings.Rule(targetRoleId: "r1", emojisText: "🧟", mode: .random, chance: 30,
                                               roleId: "r1")]),
            channels: [ChannelOption(id: "c1", name: "game-log"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Infected")])
    }
    NavigationStack {
        AutoReactSettingsView(server: "1", session: session)
    }
    .environment(session)
}
