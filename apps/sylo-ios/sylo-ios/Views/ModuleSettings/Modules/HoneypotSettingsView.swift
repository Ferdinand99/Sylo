import SwiftUI
import SyloKit

/// Honeypot: trap channels and bait messages, the action each one takes, exempt roles, and the
/// last catches. Mirrors web-v2/src/moduleForms/Honeypot.jsx.
struct HoneypotSettingsView: View {
    @State private var model: ModuleSettingsModel<HoneypotPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Honeypot", model: model) { $settings, page in
            Section {
                Text("Any real member who posts in a trap channel, or reacts to a trap message, is punished at once, with no warning. Administrators and exempt roles are never acted on. Every catch goes to the mod-log channel.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // One section per trap, so each control gets its own row.
            ForEach($settings.channels) { $trap in
                Section {
                    ChannelPicker(title: "Channel", selection: $trap.channelId, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    ActionRows(action: $trap.action, timeoutMinutes: $trap.timeoutMinutes)
                    Toggle("Delete the message", isOn: $trap.deleteMessage)
                    Button("Remove Channel Honeypot", role: .destructive) {
                        settings.channels.removeAll { $0.id == trap.id }
                    }
                } header: {
                    TrapHeader(title: "Channel honeypot", triggerCount: trap.triggerCount)
                }
            }
            Section {
                if settings.channels.count < HoneypotSettings.maxTraps {
                    Button("Add Channel Honeypot", systemImage: "plus") {
                        settings.channels.append(HoneypotSettings.ChannelTrap())
                    }
                }
            } footer: {
                Text("Any message posted in a channel honeypot triggers its action.")
            }

            ForEach($settings.messages) { $trap in
                Section {
                    ChannelPicker(title: "Channel", selection: $trap.channelId, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    TextArea(title: "Bait text", text: $trap.bait,
                             limit: HoneypotSettings.MessageTrap.maxBaitLength, lines: 2...6)
                    ActionRows(action: $trap.action, timeoutMinutes: $trap.timeoutMinutes)
                    Button("Remove Message Honeypot", role: .destructive) {
                        settings.messages.removeAll { $0.id == trap.id }
                    }
                } header: {
                    TrapHeader(title: "Message honeypot", triggerCount: trap.triggerCount)
                }
            }
            Section {
                if settings.messages.count < HoneypotSettings.maxTraps {
                    Button("Add Message Honeypot", systemImage: "plus") {
                        settings.messages.append(HoneypotSettings.MessageTrap())
                    }
                }
            } footer: {
                Text("Sylo posts a trap message in the channel. Any reaction to it triggers its action.")
            }

            Section {
                MultiPicker(title: "Exempt roles", selection: $settings.exemptRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("Members with one of these roles are never acted on.")
            }

            if !page.catches.isEmpty {
                Section("Recent catches") {
                    ForEach(Array(page.catches.enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: item.userTag)
                            Text(verbatim: "\(HoneypotAction(rawValue: item.action)?.title ?? item.action) · #\(item.channelName) · \(item.ago)")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }
}

/// "Channel honeypot · caught 4 times".
private struct TrapHeader: View {
    let title: String
    let triggerCount: Int

    var body: some View {
        Text(verbatim: triggerCount > 0 ? "\(title) · caught \(triggerCount) times" : title)
    }
}

/// Kick, timeout (with its length) or ban.
private struct ActionRows: View {
    @Binding var action: HoneypotAction
    @Binding var timeoutMinutes: Int

    var body: some View {
        Picker("Action", selection: $action) {
            ForEach(HoneypotAction.allCases, id: \.self) { action in
                Text(verbatim: action.title).tag(action)
            }
        }
        if action == .timeout {
            NumberField(title: "Timeout", value: $timeoutMinutes, range: HoneypotSettings.timeoutRange, unit: "min")
        }
    }
}

extension HoneypotAction {
    var title: String {
        switch self {
        case .kick: "Kick"
        case .timeout: "Timeout"
        case .ban: "Ban"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<HoneypotPage> else { return nil }
        return HoneypotPage(
            settings: HoneypotSettings(
                exemptRoles: ["r1"],
                channels: [HoneypotSettings.ChannelTrap(channelId: "c1", action: .timeout, triggerCount: 3)],
                messages: [HoneypotSettings.MessageTrap(channelId: "c2", bait: "Free nitro, react here")]),
            channels: [ChannelOption(id: "c1", name: "trap"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Moderators")])
    }
    NavigationStack {
        HoneypotSettingsView(server: "1", session: session)
    }
    .environment(session)
}
