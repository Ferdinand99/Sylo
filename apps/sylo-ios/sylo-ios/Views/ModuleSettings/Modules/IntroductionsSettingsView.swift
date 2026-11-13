import SwiftUI
import SyloKit

/// Introductions: where the membership cards are posted, how they look, and the text of the
/// "Introduce yourself" message. The questions and the role groups are shown read only; adding,
/// changing and ordering them, and publishing the prompt message, stay in the web dashboard. They
/// go back untouched with every save. Mirrors web-v2/src/moduleForms/Introductions.jsx.
struct IntroductionsSettingsView: View {
    @State private var model: ModuleSettingsModel<IntroductionsPage>
    @State private var note: ModulePlatformNoteModel
    private let server: ServerID

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: IntroductionsPage.moduleID, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Introductions", model: model) { $settings, page in
            ModuleIntro("A member answers a few questions in a direct message and Sylo posts a membership card for them in the introductions channel. Running the command again edits their card.")
            PlatformNoteSection(model: note)

            Section {
                ChannelPicker(title: "Introductions channel", selection: $settings.channelId, channels: page.channels,
                              noneTitle: "Choose a channel")
            } footer: {
                Text(page.introductions == 1 ? "1 card posted so far." : "\(page.introductions) cards posted so far.")
            }

            Section {
                Picker("Colour", selection: $settings.colorChoice) {
                    Text("Server colour").tag(IntroductionsColorChoice.serverDefault)
                    Text("Custom colour").tag(IntroductionsColorChoice.custom)
                    Text("Member's top role colour").tag(IntroductionsColorChoice.memberRole)
                }
                if settings.colorChoice == .custom {
                    IntroColorRow(settings: $settings)
                }
                Toggle("List the member's other roles", isOn: $settings.showRoles)
                Toggle("Remove the card when a member leaves", isOn: $settings.deleteOnLeave)
            } header: {
                Text("Card")
            } footer: {
                Text("The top role colour is the colour of the member's highest role that has one. Role groups below are always listed on the card.")
            }

            Section {
                TextArea(title: "Description", text: $settings.description,
                         limit: IntroductionsSettings.maxDescriptionLength, lines: 2...8)
            } header: {
                Text("Description")
            } footer: {
                Text(Self.placeholderFooter(page.placeholders))
            }

            Section {
                TextArea(title: "Footer", text: $settings.footer,
                         limit: IntroductionsSettings.maxFooterLength, lines: 1...3)
            } header: {
                Text("Footer")
            } footer: {
                Text("Plain text at the bottom of the card. Placeholders work here too.")
            }

            Section {
                TextArea(title: "Prompt text", text: $settings.promptText,
                         limit: IntroductionsSettings.maxPromptTextLength, lines: 2...6)
                LabeledContent("Message") {
                    Text(settings.isPromptPublished ? "Published" : "Not published")
                }
            } header: {
                Text("Prompt message")
            } footer: {
                Text("A pinned message with a Create my intro button. Leave the text empty for Sylo's own. Publish or remove the message in the web dashboard.")
            }

            Section {
                if let questions = settings.questions, !questions.isEmpty {
                    ForEach(questions) { question in
                        ListLine(title: question.label, details: Self.details(of: question))
                    }
                } else {
                    Text("None").foregroundStyle(.secondary)
                }
            } header: {
                Text("Questions")
            } footer: {
                Text("Add, change or reorder the questions in the web dashboard.")
            }

            Section {
                if settings.roleGroups.isEmpty {
                    Text("None").foregroundStyle(.secondary)
                }
                ForEach(settings.roleGroups) { group in
                    ListLine(title: group.name, details: Self.details(of: group, roles: page.roles))
                }
            } header: {
                Text("Role groups")
            } footer: {
                Text("A group lists the member's roles from a set, for example Country or Age. Edit them in the web dashboard.")
            }

            DashboardLinkSection(
                server: server, module: IntroductionsPage.moduleID,
                footer: "Edit the questions and role groups, and publish the prompt message, in the web dashboard.")
        }
        .task { await note.load() }
    }

    private static func placeholderFooter(_ placeholders: [String]) -> LocalizedStringKey {
        guard !placeholders.isEmpty else {
            return "Shown under the member's name. Markdown works."
        }
        return "Shown under the member's name. Markdown works. Placeholders: \(placeholders.joined(separator: ", "))"
    }

    private static func details(of question: IntroductionsQuestion) -> String {
        var parts = [question.required ? String(localized: "Required") : String(localized: "Optional")]
        parts.append(String(localized: "up to \(question.maxLength) characters"))
        if question.inline { parts.append(String(localized: "side by side")) }
        return parts.joined(separator: " · ")
    }

    private static func details(of group: IntroductionsRoleGroup, roles: [RoleOption]) -> String {
        let names = group.roleIds.map { id in roles.first { $0.id == id }.map { "@" + $0.name } ?? String(localized: "deleted role") }
        var parts = [String(localized: "\(group.roleIds.count) roles")]
        if !names.isEmpty { parts = [ListFormatter.localizedString(byJoining: names)] }
        if group.hideWhenEmpty { parts.append(String(localized: "hidden when empty")) }
        return parts.joined(separator: " · ")
    }
}

/// The colour picker for a custom card colour.
private struct IntroColorRow: View {
    @Binding var settings: IntroductionsSettings

    var body: some View {
        ColorPicker("Card colour", selection: colour, supportsOpacity: false)
    }

    private var colour: Binding<Color> {
        Binding(
            get: {
                let rgb = settings.rgb
                return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
            },
            set: { newValue in
                let resolved = newValue.resolve(in: EnvironmentValues())
                settings.setRGB(red: Double(resolved.red), green: Double(resolved.green), blue: Double(resolved.blue))
            })
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        guard endpoint is Endpoints.LoadModuleSettings<IntroductionsPage> else { return nil }
        return IntroductionsPage(
            settings: IntroductionsSettings(
                channelId: "c1",
                questions: [
                    IntroductionsQuestion(id: "about", label: "About me", prompt: "Tell us about you.", required: true),
                    IntroductionsQuestion(id: "pronouns", label: "Pronouns", maxLength: 40, inline: true),
                ],
                roleGroups: [IntroductionsRoleGroup(name: "Country", roleIds: ["r1"], hideWhenEmpty: true)],
                color: "#7aa2f7", description: "Welcome {user}", promptMessageId: "m1"),
            channels: [ChannelOption(id: "c1", name: "introductions")],
            roles: [RoleOption(id: "r1", name: "Norway")],
            placeholders: ["{user}", "{server}"], introductions: 12)
    }
    NavigationStack {
        IntroductionsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
