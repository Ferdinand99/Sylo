import SwiftUI
import SyloKit

/// Free games: the announcement channel and an optional ping role. Mirrors
/// web-v2/src/moduleForms/FreeGames.jsx.
struct FreeGamesSettingsView: View {
    @State private var model: ModuleSettingsModel<FreeGamesPage>

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Free Games", model: model) { $settings, page in
            Section {
                Text("Sylo checks every hour and posts when a game becomes free to claim, from the Epic Games Store and, when the bot has an IsThereAnyDeal key, Steam, GOG, Fanatical, Humble and more. DLC is left out of announcements; /freegames dlc:true shows free DLC on demand.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section {
                ChannelPicker(title: "Announcement channel", selection: $settings.channelId, channels: page.channels,
                              noneTitle: "Choose a channel")
            } footer: {
                if settings.channelId.isEmpty {
                    Text("Nothing is posted until you choose a channel.")
                } else {
                    Text("Sylo needs View Channel, Send Messages and Embed Links in this channel.")
                }
            }

            Section {
                RolePicker(title: "Ping role", selection: $settings.roleId, roles: page.roles)
            } footer: {
                Text("Optional: mentioned with each announcement.")
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadModuleSettings<FreeGamesPage> else { return nil }
        return FreeGamesPage(
            settings: FreeGamesSettings(channelId: "c1"),
            channels: [ChannelOption(id: "c1", name: "free-games"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Gamers")])
    }
    NavigationStack {
        FreeGamesSettingsView(server: "1", session: session)
    }
    .environment(session)
}
