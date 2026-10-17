import SwiftUI
import SyloKit

/// Tickets (modmail): the greeting and close messages, the staff notification channel, staff
/// roles, and how long closed tickets are kept. Mirrors web-v2/src/moduleForms/Tickets.jsx.
struct TicketsSettingsView: View {
    @State private var model: ModuleSettingsModel<TicketsPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Tickets", model: model) { $settings, page in
            Section {
                Text("Members open a ticket by sending Sylo a direct message. Staff read and reply from the dashboard's Tickets page; replies reach the member as an anonymous \"Staff\" DM.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                TextArea(title: "Thanks for contacting the staff of {server}…", text: $settings.greeting,
                         limit: TicketsSettings.maxMessageLength, lines: 2...8)
            } header: {
                Text("Greeting when a ticket opens")
            } footer: {
                Text("{server} is replaced with the server's name. Leave empty for the default text.")
            }

            Section {
                TextArea(title: "This ticket has been closed…", text: $settings.closeMessage,
                         limit: TicketsSettings.maxMessageLength, lines: 2...8)
            } header: {
                Text("Message when a ticket is closed")
            } footer: {
                Text("Leave empty for the default text. A transcript is attached.")
            }

            Section {
                ChannelPicker(title: "Notification channel", selection: $settings.notifyChannel,
                              channels: page.channels)
                Toggle("Include the opening message", isOn: $settings.showMessageInAlert)
            } header: {
                Text("Staff notifications")
            } footer: {
                Text("Optional. Staff are pinged here on new tickets and replies. Including the ticket's opening message lets staff see what it's about before opening it; it's off by default since the message may be sensitive.")
            }

            Section {
                MultiPicker(title: "Staff roles", selection: $settings.staffRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("Members with these roles may read and reply to tickets even without Manage Server.")
            }

            Section {
                NumberField(title: "Delete closed tickets after", value: $settings.transcriptRetentionDays,
                            range: TicketsSettings.retentionRange, unit: "days")
            } footer: {
                Text("0 keeps them forever. A daily job removes closed tickets and every message in them once they are older than this. Open tickets are never affected.")
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<TicketsPage> else { return nil }
        return TicketsPage(
            settings: TicketsSettings(greeting: "Thanks for contacting the staff of {server}.",
                                      notifyChannel: "c1", staffRoles: ["r1"], transcriptRetentionDays: 30),
            channels: [ChannelOption(id: "c1", name: "staff-alerts")],
            roles: [RoleOption(id: "r1", name: "Support")])
    }
    NavigationStack {
        TicketsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
