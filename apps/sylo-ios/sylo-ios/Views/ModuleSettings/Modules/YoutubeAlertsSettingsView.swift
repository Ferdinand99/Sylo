import SwiftUI
import SyloKit

/// YouTube alerts: the channels to announce (typed as a URL or @handle, resolved by the server on
/// save), where, what for, who to ping, the messages and what happens to a went-live post when the
/// stream ends. Mirrors web-v2/src/moduleForms/YoutubeAlerts.jsx.
struct YoutubeAlertsSettingsView: View {
    @State private var model: ModuleSettingsModel<YoutubeAlertsPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("YouTube Alerts", model: model) { $settings, page in
            Section {
                Text("Add a channel by URL or @handle; Sylo looks it up when you save. New uploads come from YouTube's public feed, and going live is spotted on the channel's live page. Checks run about every 3 minutes. Message placeholders: {name} {title} {url}.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // One section per channel, so each control gets its own row.
            ForEach($settings.alerts) { $alert in
                Section {
                    TextField("YouTube channel", text: $alert.input,
                              prompt: Text("@MrBeast or a channel URL"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    if !alert.ytChannelId.isEmpty {
                        LabeledContent("Resolved") {
                            Text(verbatim: alert.ytChannelId)
                                .font(.footnote.monospaced())
                        }
                    }
                    ChannelPicker(title: "Announce in", selection: $alert.discordChannelId,
                                  channels: page.channels, noneTitle: "Choose a channel")
                    Picker("Notify on", selection: $alert.notify) {
                        ForEach(YoutubeAlertsNotify.allCases, id: \.self) { notify in
                            Text(notify.title).tag(notify)
                        }
                    }
                    RolePicker(title: "Ping role", selection: $alert.roleId, roles: page.roles)
                    TextArea(title: "New-video message", text: $alert.videoMessage,
                             limit: YoutubeAlertsSettings.maxMessageLength, lines: 2...6)
                    TextArea(title: "Went-live message", text: $alert.liveMessage,
                             limit: YoutubeAlertsSettings.maxMessageLength, lines: 2...6)
                    Picker("When a livestream ends", selection: $alert.onEnd) {
                        ForEach(YoutubeAlertsEndAction.allCases, id: \.self) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    Button("Remove Channel", role: .destructive) {
                        settings.alerts.removeAll { $0.id == alert.id }
                    }
                } header: {
                    YoutubeAlertsRowHeader(name: alert.name)
                } footer: {
                    YoutubeAlertsRowFooter(defaultVideoMessage: page.defaultVideoMessage,
                                           defaultLiveMessage: page.defaultLiveMessage)
                }
            }
            Section {
                if settings.alerts.count < YoutubeAlertsSettings.maxAlerts {
                    Button("Add Channel", systemImage: "plus") {
                        settings.alerts.append(YoutubeAlertsSettings.Alert())
                    }
                }
            } footer: {
                Text("A channel Sylo can't find, or one without a channel to announce in, is dropped when you save.")
            }
        }
    }
}

/// The resolved channel's name, or "Channel" before it is known.
private struct YoutubeAlertsRowHeader: View {
    let name: String

    var body: some View {
        if name.isEmpty {
            Text("Channel")
        } else {
            Text(verbatim: name)
        }
    }
}

/// What an empty message falls back to, and which post the end setting applies to.
private struct YoutubeAlertsRowFooter: View {
    let defaultVideoMessage: String
    let defaultLiveMessage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("The end setting applies to the went-live post only.")
            if !defaultVideoMessage.isEmpty {
                Text("An empty new-video message uses: \(defaultVideoMessage)")
            }
            if !defaultLiveMessage.isEmpty {
                Text("An empty went-live message uses: \(defaultLiveMessage)")
            }
        }
    }
}

private extension YoutubeAlertsNotify {
    var title: LocalizedStringKey {
        switch self {
        case .both: "New videos and going live"
        case .video: "New videos only"
        case .live: "Going live only"
        }
    }
}

private extension YoutubeAlertsEndAction {
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
        guard endpoint is Endpoints.LoadModuleSettings<YoutubeAlertsPage> else { return nil }
        return YoutubeAlertsPage(
            settings: YoutubeAlertsSettings(alerts: [
                YoutubeAlertsSettings.Alert(ytChannelId: "UCX6OQ3DkcsbYNE6H8uQQuVA", name: "MrBeast",
                                            discordChannelId: "c1", roleId: "r1", notify: .both),
            ]),
            channels: [ChannelOption(id: "c1", name: "videos"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Uploads")],
            defaultVideoMessage: "📺 **{name}** posted a new video: **{title}**\n{url}",
            defaultLiveMessage: "🔴 **{name}** is live on YouTube: **{title}**\n{url}")
    }
    NavigationStack {
        YoutubeAlertsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
