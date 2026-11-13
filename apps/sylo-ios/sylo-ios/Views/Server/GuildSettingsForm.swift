import SwiftUI
import SyloKit

/// The server's general settings (the web dashboard's "Core → Settings"): the mod-log channel,
/// the default embed colour and the bot master roles. Mirrors web-v2/src/pages/Settings.jsx.
///
/// Only the tab's content: the server screen around it adds Save and Discard and shows
/// ``GuildSettingsModel/saveError``.
struct GuildSettingsForm: View {
    let model: GuildSettingsModel

    @Environment(AppSession.self) private var session

    var body: some View {
        Group {
            if let page = model.page {
                form(page)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Settings", systemImage: "exclamationmark.triangle")
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

            if page.hasCommandPrefix {
                commandPrefixSection(page, settings)
            }

            Section {
                ColorPicker("Default embed colour", selection: colour(settings), supportsOpacity: false)
                // Only while a colour of its own is set; otherwise there is nothing to reset.
                if !settings.wrappedValue.usesDefaultColor {
                    Button("Reset to Sylo's Colour", systemImage: "arrow.counterclockwise") {
                        settings.wrappedValue.useDefaultColor()
                    }
                }
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
                Text("Members with these roles can open the dashboard and change Sylo's settings for the server, like someone with Manage Server. Roles with Administrator already can.")
            }

            serverDataSection
        }
        .tabBarClearance()
        .disabled(model.isSaving)
        .refreshable { await model.load() }
    }

    /// What Sylo keeps about this server: its change history. Export and member data join it later.
    private var serverDataSection: some View {
        Section {
            NavigationLink {
                AuditLogView(server: model.server, session: session)
            } label: {
                Label("Audit Log", systemImage: "list.bullet.clipboard")
            }
        } header: {
            Text("Server data")
        } footer: {
            Text("Who changed which settings of this server, and when.")
        }
    }

    /// Fluxer only: the prefix members type before a command. Same rules as the server; the
    /// message under the field says what is wrong, and Save stays off until it is fixed.
    private func commandPrefixSection(_ page: GuildSettingsPage, _ settings: Binding<GuildSettings>) -> some View {
        let text = Binding(
            get: { settings.wrappedValue.commandPrefix ?? "" },
            set: { settings.wrappedValue.commandPrefix = $0 })
        let typed = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = typed.isEmpty ? page.defaultCommandPrefix : typed
        return Section {
            LabeledContent("Command prefix") {
                TextField("Command prefix", text: text, prompt: Text(verbatim: page.defaultCommandPrefix))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if let problem = settings.wrappedValue.commandPrefixProblem(max: page.commandPrefixMaxLength) {
                    Text(verbatim: problem)
                        .foregroundStyle(.red)
                }
                Text("Fluxer has no slash commands, so members start a command with this, for example \(shown)help. Leave it empty to use the default, \(page.defaultCommandPrefix). Mentioning Sylo (@Sylo help) always works.")
            }
        }
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
