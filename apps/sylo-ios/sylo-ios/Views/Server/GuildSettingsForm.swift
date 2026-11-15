import SwiftUI
import SyloKit

/// The server's general settings (the web dashboard's "Core → Settings"): the mod-log channel,
/// the default embed colour and the bot master roles. Mirrors web-v2/src/pages/Settings.jsx.
///
/// Only the tab's content: the server screen around it adds Save and Discard and shows
/// ``GuildSettingsModel/saveError``.
struct GuildSettingsForm: View {
    let model: GuildSettingsModel
    /// The setup wizard of this server, shared with the overview's offer (Sylo 5.2).
    let wizard: SetupWizardModel

    @Environment(AppSession.self) private var session
    @Environment(\.dashboardAccess) private var access

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
            // Settings are Edit work; a lower level reads them.
            Group {
            Section {
                ChannelPicker(title: "Mod-log channel", selection: settings.modlogChannelId,
                              channels: page.channels, noneTitle: "Off", health: true)
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

            dashboardAccessSection(page, settings)
            }
            .disabled(!access.canEdit)

            serverDataSection
        }
        .tabBarClearance()
        .disabled(model.isSaving)
        .refreshable { await model.load() }
    }

    /// Who may use the dashboard and the app for this server besides the owner and Manage Server: the Edit roles
    /// (the bot master roles), and, on a Sylo with access levels, the Inbox and View roles. The rules are the
    /// server's: only Edit may change them, the Edit roles only with Manage Server, and a role belongs to one list.
    @ViewBuilder
    private func dashboardAccessSection(_ page: GuildSettingsPage, _ settings: Binding<GuildSettings>) -> some View {
        if model.accessDraft == nil {
            // A Sylo without access levels: only the bot master roles, as before.
            Section {
                MultiPicker(title: "Bot master roles", selection: settings.botMasterRoleIds,
                            options: page.roles, prefix: "@")
            } footer: {
                Text("Members with these roles can open the dashboard and change Sylo's settings for the server, like someone with Manage Server. Roles with Administrator already can.")
            }
        } else {
            Section {
                MultiPicker(title: "Edit", selection: settings.botMasterRoleIds, options: page.roles, prefix: "@",
                            limit: Self.maxAccessRoles)
                    .disabled(!model.canChangeEditRoles)
                MultiPicker(title: "Inbox", selection: accessRoles(\.inboxRoleIds), options: page.roles, prefix: "@",
                            limit: Self.maxAccessRoles)
                MultiPicker(title: "View", selection: accessRoles(\.viewRoleIds), options: page.roles, prefix: "@",
                            limit: Self.maxAccessRoles)
            } header: {
                Text("Dashboard access")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Who may use the dashboard and this app for the server, besides its owner and members with Manage Server or Administrator, who can always change everything.")
                    Text("Edit: the bot master roles. They can change all of Sylo's settings. Inbox: can handle tickets, ban appeals, applications and suggestions, and look at everything else. View: can look at every page and setting, but not change anything.")
                    if !model.canChangeEditRoles {
                        Text("Only the server owner or someone with Manage Server can change the Edit roles.")
                    }
                    if let note = model.accessNote {
                        Text(verbatim: note).foregroundStyle(.orange)
                    }
                }
            }
        }
    }

    /// The most roles one list keeps, as the server does for the bot master roles.
    private static let maxAccessRoles = 25

    private func accessRoles(_ keyPath: WritableKeyPath<DashboardAccessRoles, [String]>) -> Binding<[String]> {
        Binding(
            get: { model.accessDraft?[keyPath: keyPath] ?? [] },
            set: { model.accessDraft?[keyPath: keyPath] = $0 })
    }

    /// What Sylo keeps about this server: its change history, its configuration as a file, and what
    /// it stores about a member.
    private var serverDataSection: some View {
        Section {
            // The setup wizard and the import exist when the Sylo announces `setup-wizard` and `config-import`, and
            // change the server: Edit only. The row needs no read of the server: the wizard reads its own proposal.
            if access.canEdit, session.has(.setupWizard) {
                NavigationLink {
                    SetupWizardView(model: wizard)
                } label: {
                    Label("Setup Wizard", systemImage: "wand.and.stars")
                }
            }
            NavigationLink {
                AuditLogView(server: model.server, session: session)
            } label: {
                Label("Audit Log", systemImage: "list.bullet.clipboard")
            }
            NavigationLink {
                MemberDataView(server: model.server, session: session)
            } label: {
                Label("Member Data", systemImage: "person.text.rectangle")
            }
            // The configuration file holds every setting as stored: Edit (Sylo 5.2).
            DownloadFileButton(
                "Export Configuration", systemImage: "square.and.arrow.up",
                endpoint: Endpoints.ExportGuildConfig(server: model.server), session: session)
                .disabled(!access.canEdit)
            if access.canEdit, session.has(.configImport) {
                NavigationLink {
                    ConfigImportView(server: model.server, session: session)
                } label: {
                    Label("Import Configuration", systemImage: "square.and.arrow.down")
                }
            }
        } header: {
            Text("Server data")
        } footer: {
            Text("The audit log shows who changed which settings, and when. Member data shows what Sylo stores about a member and deletes it on request. The export is this server's settings as a JSON file.")
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
        GuildSettingsForm(
            model: GuildSettingsModel(server: "1", session: session),
            wizard: SetupWizardModel(server: "1", session: session))
    }
    .environment(session)
}
