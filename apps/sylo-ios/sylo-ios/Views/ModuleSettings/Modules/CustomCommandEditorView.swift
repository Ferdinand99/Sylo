import SwiftUI
import SyloKit

/// What the command sheet is for: a new command, or one that exists.
enum CustomCommandTarget: Identifiable {
    case new
    case edit(CustomCommand)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let command): "edit-\(command.id)"
        }
    }
}

/// The form for one custom command: its name, description, the ordered list of actions, and who may
/// use it. Each action opens on its own screen; Edit in the actions section reorders and removes
/// them. Mirrors `CommandForm` in web-v2/src/moduleForms/CustomCommands.jsx.
struct CustomCommandEditorView: View {
    let target: CustomCommandTarget
    let model: CustomCommandsModel

    @State private var draft: CustomCommand
    @State private var original: CustomCommand
    @State private var isConfirmingDiscard = false
    @State private var saveError: String?
    @Environment(\.dismiss) private var dismiss

    init(target: CustomCommandTarget, model: CustomCommandsModel) {
        self.target = target
        self.model = model
        let start: CustomCommand
        switch target {
        case .new: start = CustomCommand()
        case .edit(let command): start = command
        }
        _draft = State(initialValue: start)
        _original = State(initialValue: start)
    }

    private var isDirty: Bool { draft != original }
    private var problems: [String] { model.problems(for: draft) }
    private var isFluxer: Bool { model.platform == .fluxer }

    var body: some View {
        NavigationStack {
            Form {
                nameSection
                descriptionSection
                actionsSection
                permissionsSection
                if !problems.isEmpty, hasSomethingTyped {
                    Section {
                        ForEach(problems, id: \.self) { problem in
                            Text(verbatim: problem)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                }
            }
            .disabled(model.isSaving)
            .navigationTitle(draft.isNew ? "New Command" : "Edit Command")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if isDirty { isConfirmingDiscard = true } else { dismiss() }
                    }
                    .disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { save() }
                            .toolbarSaveStyle()
                            .disabled(!problems.isEmpty || (!draft.isNew && !isDirty))
                    }
                }
            }
            .interactiveDismissDisabled(isDirty || model.isSaving)
            .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
            }
            .alert("Couldn't Save Command", isPresented: isShowingError, presenting: saveError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
            .sensoryFeedback(.success, trigger: model.successCount)
        }
    }

    /// Problems wait until there is a name or an action filled in, so a fresh form is not red.
    private var hasSomethingTyped: Bool {
        !draft.name.isEmpty || draft.actions.contains { $0.hasEffect } || isDirty
    }

    // MARK: - Sections

    private var nameSection: some View {
        Section {
            HStack(spacing: 4) {
                Text(verbatim: model.commandPrefix)
                    .foregroundStyle(.secondary)
                TextField("my-command", text: $draft.name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: draft.name) {
                        let cleaned = String(draft.name.lowercased().prefix(model.maxNameLength))
                        if cleaned != draft.name { draft.name = cleaned }
                    }
            }
        } header: {
            Text("Name")
        } footer: {
            Text(isFluxer
                 ? "\(CustomCommandName.rule) Members run it as \(model.commandPrefix)name in chat."
                 : "\(CustomCommandName.rule) This is the slash command.")
        }
    }

    private var descriptionSection: some View {
        Section {
            LimitedTextField(title: "What this command does", text: $draft.description, limit: model.descriptionLimit)
        } header: {
            Text("Description")
        } footer: {
            Text(isFluxer
                 ? "A note for you; Fluxer has no command list to show it in."
                 : "Shown in Discord's command list.")
        }
    }

    private var actionsSection: some View {
        Section {
            ForEach($draft.actions) { $action in
                if action.isUnknown {
                    CommandActionSummary(action: action, roles: model.roles, channels: model.channels)
                } else {
                    NavigationLink {
                        CommandActionEditorView(action: $action, model: model)
                    } label: {
                        CommandActionSummary(action: action, roles: model.roles, channels: model.channels)
                    }
                }
            }
            .onMove { draft.actions.move(fromOffsets: $0, toOffset: $1) }
            .onDelete { draft.actions.remove(atOffsets: $0) }
            Menu {
                ForEach(CommandAction.Kind.allCases, id: \.self) { kind in
                    Button(Self.kindTitle(kind)) { draft.actions.append(.blank(kind)) }
                }
            } label: {
                Label("Add Another Action", systemImage: "plus")
            }
            .disabled(draft.actions.count >= model.maxActions)
        } header: {
            HStack {
                Text("Actions")
                Spacer()
                EditButton()
                    .font(.footnote)
                    .textCase(nil)
            }
        } footer: {
            Text("Actions run in order. Tap Edit to reorder or remove them. Up to \(model.maxActions).")
        }
    }

    private var permissionsSection: some View {
        Section {
            MultiPicker(title: "Only these roles", selection: $draft.allowedRoles, options: model.roles,
                        prefix: "@", limit: model.maxAllowedRoles)
            MultiPicker(title: "Only in these channels", selection: $draft.allowedChannels,
                        options: model.channels, prefix: "#", limit: model.maxAllowedChannels)
            NumberField(title: "Cooldown per person", value: $draft.cooldownSeconds, range: model.cooldownRange,
                        unit: "seconds")
        } header: {
            Text("Advanced options and permissions")
        } footer: {
            Text("No roles means everyone may use it, and no channels means anywhere. The cooldown is per person.")
        }
    }

    static func kindTitle(_ kind: CommandAction.Kind) -> LocalizedStringKey {
        switch kind {
        case .reply: "Bot responds with a message in the current channel"
        case .send: "Bot sends a message to a chosen channel"
        case .addRole: "Bot gives the member a role"
        case .removeRole: "Bot removes a role from the member"
        }
    }

    // MARK: - Saving

    private func save() {
        Task {
            if await model.save(draft) {
                dismiss()
            } else {
                saveError = model.actionError ?? String(localized: "The command could not be saved.")
            }
        }
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })
    }
}

/// One action in the command's list: its number, what it does and where or to whom.
struct CommandActionSummary: View {
    let action: CommandAction
    let roles: [RoleOption]
    let channels: [ChannelOption]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            if let detail {
                Text(verbatim: detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var title: LocalizedStringKey {
        if action.isUnknown { return "Unsupported action (kept as is)" }
        switch action.kind {
        case .reply: return "Reply"
        case .send: return "Send to a channel"
        case .addRole: return "Add a role"
        case .removeRole: return "Remove a role"
        }
    }

    private var detail: String? {
        if action.isUnknown {
            if let type = action.unknownType { return String(localized: "Kind “\(type)”. The app cannot edit it. It is sent back unchanged.") }
            return String(localized: "The app cannot edit it. It is sent back unchanged.")
        }
        switch action.kind {
        case .reply, .send:
            var parts: [String] = []
            if action.kind == .send {
                let channel = channels.first { $0.id == action.channelId }?.name
                parts.append(channel.map { "#\($0)" } ?? String(localized: "No channel yet"))
            } else if action.isPrivate {
                parts.append(String(localized: "Private"))
            }
            let first = action.messages.first { $0.hasContent }
            if let first {
                let text = first.content.trimmingCharacters(in: .whitespacesAndNewlines)
                parts.append(text.isEmpty ? String(localized: "Embed") : text)
            } else {
                parts.append(String(localized: "Empty"))
            }
            if action.messages.count > 1 { parts.append(String(localized: "\(action.messages.count) messages")) }
            return parts.joined(separator: " · ")
        case .addRole, .removeRole:
            let role = roles.first { $0.id == action.roleId }?.name
            return role.map { "@\($0)" } ?? String(localized: "No role yet")
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadCustomCommands {
            return CustomCommandsPage(
                channels: [ChannelOption(id: "c1", name: "general")],
                roles: [RoleOption(id: "r1", name: "Member")])
        }
        return nil
    }
    let model = CustomCommandsModel(server: "1", session: session)
    CustomCommandEditorView(
        target: .edit(CustomCommand(
            id: "1", name: "hello", description: "Says hello",
            actions: [
                CommandAction(kind: .reply, messages: [CommandMessage(content: "Hi {user}!")]),
                CommandAction(kind: .addRole, roleId: "r1"),
            ])),
        model: model)
    .environment(session)
}
