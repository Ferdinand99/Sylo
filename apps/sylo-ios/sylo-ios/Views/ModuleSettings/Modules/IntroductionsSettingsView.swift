import SwiftUI
import SyloKit

/// Introductions: where the membership cards are posted, how they look, the questions members are
/// asked and their order, the role groups listed on the card, and the "Introduce yourself" message
/// (published and removed here). Mirrors web-v2/src/moduleForms/Introductions.jsx.
struct IntroductionsSettingsView: View {
    @State private var model: ModuleSettingsModel<IntroductionsPage>
    @State private var note: ModulePlatformNoteModel
    @State private var prompt: IntroPromptModel
    @State private var isConfirmingRemove = false
    /// Owned here so the Edit button in the questions header can switch the list to reordering.
    @State private var editMode = EditMode.inactive

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: IntroductionsPage.moduleID, session: session))
        _prompt = State(initialValue: IntroPromptModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Introductions", model: model, problem: model.draft?.problem) { $settings, page in
            ModuleIntro("A member answers a few questions in a direct message and Sylo posts a membership card for them in the introductions channel. Running the command again edits their card.")
            PlatformNoteSection(model: note)

            Section {
                ChannelPicker(title: "Introductions channel", selection: $settings.channelId, channels: page.channels,
                              noneTitle: "Choose a channel")
            } footer: {
                Text(page.introductions == 1 ? "1 card posted so far." : "\(page.introductions) cards posted so far.")
            }

            if let problem = settings.problem {
                Section { StatusMessage(problem, kind: .notice) }
            }

            questionsSection(settings: $settings)
            roleGroupsSection(settings: $settings, page: page)

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
                Text("The top role colour is the colour of the member's highest role that has one. Role groups are always listed on the card.")
            }

            Section {
                TextArea(title: "Description", text: $settings.description,
                         limit: IntroductionsSettings.maxDescriptionLength, lines: 2...8)
            } header: {
                Text("Description")
            } footer: {
                Text(Self.placeholderFooter(page.placeholders, groups: settings.roleGroupPlaceholders))
            }

            Section {
                TextArea(title: "Footer", text: $settings.footer,
                         limit: IntroductionsSettings.maxFooterLength, lines: 1...3)
            } header: {
                Text("Footer")
            } footer: {
                Text("Plain text at the bottom of the card. Placeholders work here too.")
            }

            promptSection(settings: $settings, page: page)
        }
        .environment(\.editMode, $editMode)
        .task { await note.load() }
        .confirmationDialog("Remove the prompt message?", isPresented: $isConfirmingRemove, titleVisibility: .visible) {
            Button("Remove Message", role: .destructive) { remove() }
        } message: {
            Text("The message is deleted from the channel. Members can still use the command.")
        }
        .sensoryFeedback(.success, trigger: prompt.successCount)
    }

    // MARK: - Questions and role groups

    private func questionsSection(settings: Binding<IntroductionsSettings>) -> some View {
        let questions = Binding<[IntroductionsQuestion]>(
            get: { settings.wrappedValue.questions ?? [] },
            set: { settings.wrappedValue.questions = $0 })
        let count = questions.wrappedValue.count
        return Section {
            ForEach(questions) { $question in
                NavigationLink {
                    IntroQuestionEditorView(question: $question)
                } label: {
                    ListLine(title: question.label.isEmpty ? String(localized: "New question") : question.label,
                             details: Self.details(of: question))
                }
            }
            .onMove { source, destination in
                settings.wrappedValue.moveQuestions(fromOffsets: source, toOffset: destination)
            }
            .onDelete { offsets in
                var remaining = settings.wrappedValue.questions ?? []
                remaining.remove(atOffsets: offsets)
                settings.wrappedValue.questions = remaining
            }
            if count == 0 {
                Text("None").foregroundStyle(.secondary)
            }
            Button("Add Question", systemImage: "plus") {
                settings.wrappedValue.addQuestion()
            }
            .disabled(count >= IntroductionsSettings.maxQuestions)
        } header: {
            HStack {
                Text("Questions")
                Spacer()
                if count > 1 {
                    EditButton().textCase(nil)
                }
            }
        } footer: {
            if settings.wrappedValue.questions == nil {
                Text("This server did not send its questions, so it keeps its own until you add one here.")
            } else {
                Text("Members answer these in order, up to \(IntroductionsSettings.maxQuestions) of them. Tap Edit to reorder or swipe one to remove it. A question without a label is not kept.")
            }
        }
    }

    private func roleGroupsSection(settings: Binding<IntroductionsSettings>, page: IntroductionsPage) -> some View {
        Section {
            ForEach(settings.roleGroups) { $group in
                NavigationLink {
                    IntroRoleGroupEditorView(group: $group, roles: page.roles)
                } label: {
                    ListLine(title: group.cleanName.isEmpty ? String(localized: "New group") : group.cleanName,
                             details: Self.details(of: group, roles: page.roles))
                }
            }
            .onDelete { offsets in
                settings.wrappedValue.roleGroups.remove(atOffsets: offsets)
            }
            if settings.wrappedValue.roleGroups.isEmpty {
                Text("None").foregroundStyle(.secondary)
            }
            Button("Add Role Group", systemImage: "plus") {
                settings.wrappedValue.addRoleGroup()
            }
            .disabled(settings.wrappedValue.roleGroups.count >= IntroductionsSettings.maxRoleGroups)
        } header: {
            Text("Role groups")
        } footer: {
            Text("A group lists the member's roles from a set, for example Country or Age, as one field on the card. Swipe a group to remove it.")
        }
    }

    // MARK: - Prompt message

    private func promptSection(settings: Binding<IntroductionsSettings>, page: IntroductionsPage) -> some View {
        Section {
            TextArea(title: "Prompt text", text: settings.promptText,
                     limit: IntroductionsSettings.maxPromptTextLength, lines: 2...6)
            LabeledContent("Message") {
                Text(page.settings.isPromptPublished ? "Published" : "Not published")
            }
            Button(page.settings.isPromptPublished ? "Update Prompt Message" : "Publish Prompt Message",
                   systemImage: "paperplane") {
                publish(channelId: settings.wrappedValue.channelId, text: settings.wrappedValue.promptText)
            }
            .disabled(settings.wrappedValue.channelId.isEmpty || prompt.isBusy)
            if page.settings.isPromptPublished {
                Button("Remove Prompt Message", systemImage: "trash", role: .destructive) {
                    isConfirmingRemove = true
                }
                .disabled(prompt.isBusy)
            }
            if let message = prompt.errorMessage {
                StatusMessage(message, kind: .error)
            }
            if let notice = prompt.notice {
                StatusMessage(notice, kind: .notice)
            }
        } header: {
            Text("Prompt message")
        } footer: {
            Text("A pinned message with a Create my intro button, posted in the introductions channel above. Leave the text empty for Sylo's own. On Fluxer the button is a reaction.")
        }
    }

    /// Posts the prompt with the channel and text as they are in the form (the server saves those two with
    /// it) and loads the page again, so the status is the server's.
    private func publish(channelId: String, text: String) {
        Task {
            if await prompt.publish(channelId: channelId, text: text) != nil {
                await model.load()
            }
        }
    }

    private func remove() {
        Task {
            if await prompt.unpublish() != nil {
                await model.load()
            }
        }
    }

    // MARK: - Words

    private static func placeholderFooter(_ placeholders: [String], groups: [String]) -> LocalizedStringKey {
        let all = placeholders + groups
        guard !all.isEmpty else {
            return "Shown under the member's name. Markdown works."
        }
        return "Shown under the member's name. Markdown works. Placeholders: \(all.joined(separator: ", "))"
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
