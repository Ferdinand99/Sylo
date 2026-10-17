import SwiftUI
import SyloKit

/// Server statistics: voice channels Sylo renames to show a live count, what each one counts, its
/// name template, and how often they refresh. Mirrors web-v2/src/moduleForms/ServerStats.jsx.
struct ServerStatsSettingsView: View {
    @State private var model: ModuleSettingsModel<ServerStatsPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Server Statistics", model: model) { $settings, page in
            Section {
                Text("Pick a voice channel (make one and lock it so nobody can join) and Sylo renames it to show a live count. Put {count} in the name, such as \"Members: {count}\". Sylo needs Manage Channels on each one.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            // One section per stat channel, so each control gets its own row.
            ForEach($settings.channels) { $stat in
                Section("Stat channel") {
                    ServerStatsVoicePicker(selection: $stat.channelId, channels: page.voiceChannels)
                    Picker("Stat", selection: $stat.type) {
                        ForEach(ServerStatsStat.allCases, id: \.self) { type in
                            Text(type.title).tag(type)
                        }
                    }
                    TextField("Channel name", text: $stat.template, prompt: Text(verbatim: "Members: {count}"))
                        .autocorrectionDisabled()
                        .onChange(of: stat.template) {
                            if stat.template.count > ServerStatsSettings.maxTemplateLength {
                                stat.template = String(stat.template.prefix(ServerStatsSettings.maxTemplateLength))
                            }
                        }
                    if !stat.template.contains(ServerStatsSettings.countPlaceholder) {
                        Label("The name must include {count}, or this channel is dropped when you save.",
                              systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    Button("Remove Stat Channel", role: .destructive) {
                        settings.channels.removeAll { $0.id == stat.id }
                    }
                }
            }
            Section {
                if settings.channels.count < ServerStatsSettings.maxChannels {
                    Button("Add Stat Channel", systemImage: "plus") {
                        settings.channels.append(ServerStatsSettings.StatChannel())
                    }
                }
            } footer: {
                if settings.channels.isEmpty {
                    Text("No stat channels yet.")
                }
            }

            Section {
                NumberField(title: "Refresh every", value: $settings.refreshMinutes,
                            range: ServerStatsSettings.refreshRange, unit: "min")
            } footer: {
                Text("5 to 60 minutes. Lower is more current, but closer to Discord's limit on renaming channels.")
            }
        }
    }
}

/// Picks one voice channel, shown with a speaker rather than the `#` the shared channel picker
/// uses. A channel that no longer exists stays selectable so opening the screen changes nothing.
private struct ServerStatsVoicePicker: View {
    @Binding var selection: String
    let channels: [ChannelOption]

    var body: some View {
        Picker("Voice channel", selection: $selection) {
            Text("Choose a voice channel").tag("")
            ForEach(channels) { channel in
                Text(verbatim: "🔊 \(channel.name)").tag(channel.id)
            }
            if !selection.isEmpty, !channels.contains(where: { $0.id == selection }) {
                Text("Deleted channel").tag(selection)
            }
        }
        .pickerStyle(.navigationLink)
    }
}

private extension ServerStatsStat {
    var title: LocalizedStringKey {
        switch self {
        case .members: "Members (total)"
        case .humans: "Humans (non-bots)"
        case .bots: "Bots"
        case .roles: "Roles"
        case .channels: "Channels"
        case .boosts: "Server boosts"
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<ServerStatsPage> else { return nil }
        return ServerStatsPage(
            settings: ServerStatsSettings(refreshMinutes: 15, channels: [
                ServerStatsSettings.StatChannel(channelId: "v1"),
                ServerStatsSettings.StatChannel(channelId: "v2", type: .boosts, template: "Boosts: {count}"),
            ]),
            voiceChannels: [ChannelOption(id: "v1", name: "Members"), ChannelOption(id: "v2", name: "Boosts")])
    }
    NavigationStack {
        ServerStatsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
