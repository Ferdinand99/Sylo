import SwiftUI
import SyloKit

/// Custom commands: commands built from an ordered list of actions (reply, post to a channel, give
/// or take a role). Mirrors web-v2/src/moduleForms/CustomCommands.jsx.
struct CustomCommandsSettingsView: View {
    let server: ServerID

    @State private var model: RecordListModel<CustomCommandsPage>
    @State private var note: ModulePlatformNoteModel
    @State private var editing: CustomCommand?
    @State private var pendingDelete: CustomCommand?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(customCommands: server, session: session))
        _note = State(
            initialValue: ModulePlatformNoteModel(server: server, module: CustomCommandsPage.moduleID, session: session))
    }

    private var isFluxer: Bool { server.rawValue.hasPrefix("fluxer:") }

    var body: some View {
        RecordScreen("Custom Commands", model: model, note: note) { page in
            ModuleIntro("Build your own commands from a list of actions that run in order: reply, post to a channel, or give or take a role. Members run them like any other command.")

            Section {
                if page.commands.isEmpty {
                    Text("None yet. Create one below.")
                        .foregroundStyle(Color.syloMuted)
                }
                ForEach(page.commands) { command in
                    RecordRow(
                        title: page.trigger(for: command.name, isFluxer: isFluxer), details: details(of: command),
                        warning: command.isReserved
                            ? String(localized: "Rename needed: \(page.trigger(for: command.name, isFluxer: isFluxer)) is now a built-in command, so this command is off until you give it another name.")
                            : nil
                    ) {
                        editing = command
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = command }
                    }
                    .contextMenu {
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = command }
                    }
                    .accessibilityAction(named: Text("Delete")) { pendingDelete = command }
                }
                Button("New Command", systemImage: "plus") {
                    editing = CustomCommand()
                }
                .disabled(page.commands.count >= CustomCommand.maxCommands)
            } header: {
                Text("Your commands (\(page.commands.count))")
            }
        }
        .sheet(item: $editing) { command in
            if let page = model.page {
                CommandEditor(
                    command: command, page: page, isFluxer: server.rawValue.hasPrefix("fluxer:"),
                    save: { await model.save($0) }, failure: { model.takeActionError() })
            }
        }
        .confirmationDialog(
            "Delete this command?", isPresented: isConfirmingDelete, titleVisibility: .visible,
            presenting: pendingDelete
        ) { command in
            Button("Delete Command", role: .destructive) { Task { _ = await model.delete(command) } }
        } message: { _ in
            Text("Members can no longer run it. This can't be undone.")
        }
    }

    private func details(of command: CustomCommand) -> String {
        var parts = [command.description.isEmpty ? String(localized: "No description") : command.description]
        parts.append(command.actions.count == 1 ? String(localized: "1 action") : String(localized: "\(command.actions.count) actions"))
        if !command.allowedRoles.isEmpty || !command.allowedChannels.isEmpty {
            parts.append(String(localized: "limited to certain roles or channels"))
        }
        if command.cooldownSeconds > 0 {
            parts.append(String(localized: "\(command.cooldownSeconds)s cooldown"))
        }
        return parts.joined(separator: " · ")
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }
}

extension CommandActionType {
    /// What the action does, for its heading and the picker.
    var title: String {
        switch self {
        case .reply: String(localized: "Reply in the channel")
        case .send: String(localized: "Post to a channel")
        case .addRole: String(localized: "Give the member a role")
        case .removeRole: String(localized: "Take a role from the member")
        }
    }

    var systemImage: String {
        switch self {
        case .reply: "arrowshape.turn.up.left"
        case .send: "paperplane"
        case .addRole: "person.badge.plus"
        case .removeRole: "person.badge.minus"
        }
    }
}

/// Edits one command in a sheet.
private struct CommandEditor: View {
    @State var command: CustomCommand
    let page: CustomCommandsPage
    let isFluxer: Bool
    let save: (CustomCommand) async -> Bool
    let failure: () -> String?

    @State private var initial: CustomCommand?

    var body: some View {
        RecordEditor(
            title: command.commandID.isEmpty ? "New Command" : "Edit Command", problem: command.problem,
            hasChanges: initial.map { $0 != command } ?? false,
            save: { await save(command) }, failure: failure
        ) {
            Section {
                LabeledContent("Name") {
                    HStack(spacing: 2) {
                        Text(verbatim: isFluxer ? (page.commandPrefix ?? "") : "/")
                            .foregroundStyle(Color.syloMuted)
                        TextField("my-command", text: $command.name)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onChange(of: command.name) {
                                let cleaned = String(command.name.lowercased().prefix(CustomCommand.maxNameLength))
                                if cleaned != command.name { command.name = cleaned }
                            }
                    }
                }
                TextField("Description", text: $command.description)
                    .onChange(of: command.description) {
                        if command.description.count > CustomCommand.maxDescriptionLength {
                            command.description = String(command.description.prefix(CustomCommand.maxDescriptionLength))
                        }
                    }
            } footer: {
                if isFluxer {
                    Text("Lowercase letters, numbers, - and _. Members type the prefix and the name to run it, for example \(page.trigger(for: command.name.isEmpty ? "name" : command.name, isFluxer: true)).")
                } else {
                    Text("Lowercase letters, numbers, - and _. The description is shown in the command list.")
                }
            }

            ForEach($command.actions) { $action in
                ActionSections(
                    action: $action, number: number(of: action), count: command.actions.count, page: page,
                    isFluxer: isFluxer,
                    move: { move(action, by: $0) }, remove: { command.actions.removeAll { $0.id == action.id } })
            }

            Section {
                Menu {
                    ForEach(CommandActionType.allCases, id: \.self) { type in
                        Button(type.title, systemImage: type.systemImage) {
                            command.actions.append(CustomCommand.Action(type: type))
                        }
                    }
                } label: {
                    Label("Add Action", systemImage: "plus")
                }
                .disabled(command.actions.count >= CustomCommand.maxActions)
            } footer: {
                Text("Actions run in order, top to bottom. Up to \(CustomCommand.maxActions).")
            }

            Section {
                MultiPicker(title: "Only these roles", selection: $command.allowedRoles, options: page.roles, prefix: "@")
                MultiPicker(
                    title: "Only in these channels", selection: $command.allowedChannels, options: page.channels,
                    prefix: "#")
                NumberField(
                    title: "Cooldown per member", value: $command.cooldownSeconds, range: CustomCommand.cooldownRange,
                    unit: "s")
            } header: {
                Text("Who can use it")
            } footer: {
                Text("With no roles or channels chosen, everyone can use it anywhere.")
            }
        }
        .onAppear { if initial == nil { initial = command } }
    }

    private func number(of action: CustomCommand.Action) -> Int {
        (command.actions.firstIndex { $0.id == action.id } ?? 0) + 1
    }

    private func move(_ action: CustomCommand.Action, by offset: Int) {
        guard let index = command.actions.firstIndex(where: { $0.id == action.id }) else { return }
        let target = index + offset
        guard command.actions.indices.contains(target) else { return }
        let item = command.actions.remove(at: index)
        command.actions.insert(item, at: target)
    }
}

/// The sections of one action: what it does, then its messages or its role.
private struct ActionSections: View {
    @Binding var action: CustomCommand.Action
    let number: Int
    let count: Int
    let page: CustomCommandsPage
    let isFluxer: Bool
    let move: (Int) -> Void
    let remove: () -> Void

    var body: some View {
        Section {
            switch action.type {
            case .addRole, .removeRole:
                RolePicker(title: "Role", selection: $action.roleId, roles: page.roles, noneTitle: "Choose a role")
            case .send:
                ChannelPicker(
                    title: "Channel", selection: $action.channelId, channels: page.channels,
                    noneTitle: "Choose a channel")
            case .reply:
                Toggle("Only the member sees the reply", isOn: $action.isPrivate)
            }
            Menu {
                Button("Move Up", systemImage: "arrow.up") { move(-1) }
                    .disabled(number == 1)
                Button("Move Down", systemImage: "arrow.down") { move(1) }
                    .disabled(number == count)
                Button("Remove Action", systemImage: "trash", role: .destructive, action: remove)
            } label: {
                Label("Order and remove", systemImage: "ellipsis.circle")
            }
        } header: {
            Label {
                Text(verbatim: "\(number). \(action.type.title)")
            } icon: {
                Image(systemName: action.type.systemImage)
            }
        } footer: {
            if action.type == .addRole || action.type == .removeRole {
                Text("Applied to whoever ran the command.")
            }
        }

        if action.type.postsMessages {
            ForEach($action.messages) { $message in
                Section {
                    TextArea(
                        title: "Write your message here (or leave blank for an embed only)", text: $message.content,
                        limit: CustomCommand.Action.Message.maxContentLength, lines: 2...8)
                    if !page.placeholders.isEmpty {
                        PlaceholderChips(tokens: page.placeholders, text: $message.content)
                    }
                    if message.embed != nil {
                        NavigationLink {
                            EmbedEditorScreen(
                                title: "Embed", embed: embedBinding($message), showsTimestamp: true,
                                placeholders: page.placeholders, isFluxer: isFluxer)
                        } label: {
                            LabeledContent("Embed") {
                                Text(verbatim: message.embed?.title ?? "")
                            }
                        }
                        Button("Remove Embed", role: .destructive) { message.embed = nil }
                    } else {
                        Button("Add Embed", systemImage: "plus") { message.embed = EmbedSpec() }
                    }
                    if action.messages.count > 1 {
                        Button("Remove Message", role: .destructive) {
                            action.messages.removeAll { $0.id == message.id }
                        }
                    }
                } header: {
                    if let index = action.messages.firstIndex(where: { $0.id == message.id }) {
                        Text("Action \(number), message \(index + 1)")
                    }
                }
            }
            Section {
                Button("Add Message", systemImage: "plus") {
                    action.messages.append(CustomCommand.Action.Message())
                }
                .disabled(action.messages.count >= CustomCommand.Action.maxMessages)
            } footer: {
                Text("With more than one message, the bot picks one at random.")
            }
        }
    }

    private func embedBinding(_ message: Binding<CustomCommand.Action.Message>) -> Binding<EmbedSpec> {
        Binding(
            get: { message.wrappedValue.embed ?? EmbedSpec() },
            set: { message.wrappedValue.embed = $0 })
    }
}
