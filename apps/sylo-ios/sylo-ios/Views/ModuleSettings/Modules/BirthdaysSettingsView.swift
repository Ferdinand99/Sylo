import SwiftUI
import SyloKit

/// Birthdays: the announcement channel and message, and the role for the day. Mirrors
/// web-v2/src/moduleForms/Birthdays.jsx.
struct BirthdaysSettingsView: View {
    @State private var model: ModuleSettingsModel<BirthdaysPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Birthdays", model: model) { $settings, page in
            Section {
                Text("Members save their own date with /birthday set. Sylo checks once a day and posts the message.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                ChannelPicker(title: "Announcement channel", selection: $settings.channel, channels: page.channels,
                              noneTitle: "None (no message)")
            }

            Section {
                TextArea(title: "Message", text: $settings.message,
                         limit: BirthdaysSettings.maxMessageLength, lines: 2...6)
            } header: {
                Text("Message")
            } footer: {
                Text("Placeholders: {user}, and {age} (blank unless the member gave a year).")
            }

            Section {
                RolePicker(title: "Birthday role", selection: $settings.roleId, roles: page.roles)
            } footer: {
                Text("Optional: granted for the day, removed after. Sylo's highest role must sit above this one, and it needs the Manage Roles permission.")
            }

            Section {
                Toggle("Ping the birthday role", isOn: $settings.pingRole)
            } footer: {
                Text("Mentions the birthday role in the announcement.")
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<BirthdaysPage> else { return nil }
        return BirthdaysPage(
            settings: BirthdaysSettings(channel: "c1", roleId: "r1"),
            channels: [ChannelOption(id: "c1", name: "general"), ChannelOption(id: "c2", name: "birthdays")],
            roles: [RoleOption(id: "r1", name: "Birthday"), RoleOption(id: "r2", name: "Members")])
    }
    NavigationStack {
        BirthdaysSettingsView(server: "1", session: session)
    }
    .environment(session)
}
