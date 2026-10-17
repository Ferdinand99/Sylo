import SwiftUI
import SyloKit

/// AFK: the nickname prefix, mention replies and ignored channels. Mirrors
/// web-v2/src/moduleForms/Afk.jsx.
struct AfkSettingsView: View {
    @State private var model: ModuleSettingsModel<AfkPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("AFK", model: model) { $settings, page in
            Section {
                Text("Members run /afk [reason]. Sylo replies to anyone who mentions them, and clears the status automatically when they next send a message.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                Toggle("Add [AFK] to their nickname", isOn: $settings.setNickname)
            } footer: {
                Text("Needs the Manage Nicknames permission.")
            }

            Section {
                Toggle("Reply when they're mentioned", isOn: $settings.mentionReply)
            } footer: {
                Text("Sylo replies in the channel when someone mentions an AFK member.")
            }

            Section {
                MultiPicker(title: "Ignore channels", selection: $settings.ignoreChannels,
                            options: page.channels, prefix: "#")
            } footer: {
                Text("AFK isn't cleared or announced in these channels.")
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<AfkPage> else { return nil }
        return AfkPage(
            settings: AfkSettings(ignoreChannels: ["c2"]),
            channels: [ChannelOption(id: "c1", name: "general"), ChannelOption(id: "c2", name: "bot-commands")])
    }
    NavigationStack {
        AfkSettingsView(server: "1", session: session)
    }
    .environment(session)
}
