import SwiftUI
import SyloKit

/// Kick alerts: the streamers to announce, where, who to ping, the message and what happens to
/// it when the stream ends. Mirrors web-v2/src/moduleForms/KickAlerts.jsx.
struct KickAlertsSettingsView: View {
    @State private var model: ModuleSettingsModel<KickAlertsPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Kick Alerts", model: model) { $settings, page in
            Section {
                Text("Sylo checks each streamer about once a minute and posts to the chosen channel when they go live. Message placeholders: {name} {title} {game} {url} {viewers}.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if !page.kickEnabled {
                    Label("The bot has no Kick app set up (KICK_CLIENT_ID and KICK_CLIENT_SECRET), so alerts won't fire yet. You can still set them up here.", systemImage: "exclamationmark.triangle")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                }
            }

            // One section per streamer, so each control gets its own row.
            ForEach($settings.alerts) { $alert in
                Section {
                    TextField("Kick username", text: $alert.slug, prompt: Text(verbatim: "xqc"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    ChannelPicker(title: "Announce in", selection: $alert.channelId, channels: page.channels,
                                  noneTitle: "Choose a channel")
                    RolePicker(title: "Ping role", selection: $alert.roleId, roles: page.roles)
                    TextArea(title: "Message", text: $alert.message,
                             limit: KickAlertsSettings.maxMessageLength, lines: 2...6)
                    Picker("Post as", selection: $alert.plainText) {
                        Text("Embed").tag(false)
                        Text("Plain text (no embed)").tag(true)
                    }
                    Picker("When the stream ends", selection: $alert.onEnd) {
                        ForEach(KickAlertsEndAction.allCases, id: \.self) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    Button("Remove Streamer", role: .destructive) {
                        settings.alerts.removeAll { $0.id == alert.id }
                    }
                } header: {
                    KickAlertsRowHeader(slug: alert.slug)
                } footer: {
                    if !page.defaultMessage.isEmpty {
                        Text("An empty message uses the default: \(page.defaultMessage)")
                    }
                }
            }
            Section {
                if settings.alerts.count < KickAlertsSettings.maxAlerts {
                    Button("Add Streamer", systemImage: "plus") {
                        settings.alerts.append(KickAlertsSettings.Alert())
                    }
                }
            } footer: {
                Text("A streamer without a username or a channel is dropped when you save.")
            }
        }
    }
}

/// The streamer's username, or "Streamer" while it is empty.
private struct KickAlertsRowHeader: View {
    let slug: String

    var body: some View {
        if slug.isEmpty {
            Text("Streamer")
        } else {
            Text(verbatim: slug)
        }
    }
}

private extension KickAlertsEndAction {
    var title: LocalizedStringKey {
        switch self {
        case .delete: "Delete the message"
        case .edit: "Mark it as ended"
        case .keep: "Leave it"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<KickAlertsPage> else { return nil }
        return KickAlertsPage(
            settings: KickAlertsSettings(alerts: [
                KickAlertsSettings.Alert(slug: "xqc", channelId: "c1", roleId: "r1", onEnd: .edit),
            ]),
            channels: [ChannelOption(id: "c1", name: "streams"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Live pings")],
            kickEnabled: false,
            defaultMessage: "🟢 **{name}** is live on Kick!")
    }
    NavigationStack {
        KickAlertsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
