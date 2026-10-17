import SwiftUI
import SyloKit

/// The server's general settings (the web dashboard's "Core → Settings"): the mod-log channel,
/// the default embed colour and the bot master roles. Mirrors web-v2/src/pages/Settings.jsx.
///
/// Only the tab's content: the server screen around it adds Save and Discard and shows
/// ``GuildSettingsModel/saveError``.
struct GuildSettingsForm: View {
    let model: GuildSettingsModel

    var body: some View {
        Group {
            if let page = model.page {
                form(page)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Can't Load Settings", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .task {
            if model.page == nil { await model.load() }
        }
    }

    private func form(_ page: GuildSettingsPage) -> some View {
        let settings = Binding(get: { model.draft ?? page.settings }, set: { model.draft = $0 })
        return Form {
            Section {
                ChannelPicker(title: "Mod-log channel", selection: settings.modlogChannelId,
                              channels: page.channels, noneTitle: "Off")
            } footer: {
                Text("Every moderation action posts an embed here.")
            }

            Section {
                ColorPicker("Default embed colour", selection: colour(settings), supportsOpacity: false)
                Button("Use Sylo's Colour") { settings.wrappedValue.useDefaultColor() }
                    .disabled(settings.wrappedValue.usesDefaultColor)
            } footer: {
                if settings.wrappedValue.usesDefaultColor {
                    Text("Sylo's embeds in this server use Sylo's own colour.")
                } else {
                    Text("Sylo's embeds in this server use this colour.")
                }
            }

            Section {
                MultiPicker(title: "Bot master roles", selection: settings.botMasterRoleIds,
                            options: page.roles, prefix: "@")
            } footer: {
                Text("Roles with Administrator already have dashboard access and don't need to be added here.")
            }
        }
        .disabled(model.isSaving)
        .refreshable { await model.load() }
    }

    private func colour(_ settings: Binding<GuildSettings>) -> Binding<Color> {
        Binding(
            get: {
                let rgb = settings.wrappedValue.rgb
                return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
            },
            set: { newValue in
                let resolved = newValue.resolve(in: EnvironmentValues())
                settings.wrappedValue.setRGB(
                    red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue))
            })
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadGuildSettings else { return nil }
        return GuildSettingsPage(
            settings: GuildSettings(modlogChannelId: "c1", botMasterRoleIds: ["r2"], embedColorHex: "#ff8000"),
            channels: [ChannelOption(id: "c1", name: "mod-log"), ChannelOption(id: "c2", name: "general")],
            roles: [RoleOption(id: "r1", name: "Admins"), RoleOption(id: "r2", name: "Moderators")])
    }
    NavigationStack {
        GuildSettingsForm(model: GuildSettingsModel(server: "1", session: session))
    }
    .environment(session)
}
