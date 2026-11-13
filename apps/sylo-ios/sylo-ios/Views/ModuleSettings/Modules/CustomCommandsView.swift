import SwiftUI
import SyloKit

/// Custom commands: commands members run in chat, each built from an ordered list of actions (reply,
/// post to a channel, add or remove a role). Mirrors web-v2/src/moduleForms/CustomCommands.jsx.
struct CustomCommandsView: View {
    @State private var model: CustomCommandsModel
    @State private var note: ModulePlatformNoteModel
    @State private var editor: CustomCommandTarget?
    @State private var deleting: CustomCommand?

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: CustomCommandsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: "custom-commands", session: session))
    }

    var body: some View {
        Group {
            if model.hasLoaded {
                list
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Custom Commands", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Custom Commands")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Delete This Command?", isPresented: isDeleting, titleVisibility: .visible, presenting: deleting
        ) { command in
            Button("Delete Command", role: .destructive) {
                Task { await model.delete(command.id) }
            }
        } message: { _ in
            Text("Members can no longer run it. This can’t be undone.")
        }
        .alert("Couldn't Update Commands", isPresented: isShowingError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sheet(item: $editor) { target in
            CustomCommandEditorView(target: target, model: model)
        }
        .sensoryFeedback(.success, trigger: model.successCount)
        .task {
            await note.load()
            if !model.hasLoaded { await model.load() }
        }
    }

    private var list: some View {
        List {
            ModuleIntro(intro)
            PlatformNoteSection(model: note)

            Section {
                if model.commands.isEmpty {
                    Text("None yet. Create one below.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.commands) { command in
                    Button {
                        editor = .edit(command)
                    } label: {
                        CustomCommandRow(command: command, name: model.displayName(command.name))
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = command }
                    }
                    .contextMenu {
                        Button("Edit", systemImage: "pencil") { editor = .edit(command) }
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = command }
                    }
                }
                Button("New Command", systemImage: "plus") { editor = .new }
                    .disabled(!model.canAddCommand)
            } header: {
                Text("Your commands (\(model.commands.count))")
            } footer: {
                if !model.canAddCommand {
                    Text("This server already has the maximum of \(model.maxCommands) commands.")
                }
            }
        }
        .disabled(model.isSaving)
        .refreshable { await model.load() }
    }

    private var intro: LocalizedStringKey {
        if model.platform == .fluxer {
            "Build chat commands from an ordered list of actions: reply, post to a channel, add or remove a role."
        } else {
            "Build slash commands from an ordered list of actions: reply, post to a channel, add or remove a role."
        }
    }

    private var isDeleting: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    /// The editor shows its own errors while it is open.
    private var isShowingError: Binding<Bool> {
        Binding(
            get: { model.actionError != nil && editor == nil },
            set: { if !$0 { model.actionError = nil } })
    }
}

/// One command in the list: its name, what it does and who may use it.
private struct CustomCommandRow: View {
    let command: CustomCommand
    /// The name as members type it, with the prefix.
    let name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: name)
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if command.reserved {
                Text("Rename needed: \(name) is now a built-in command, so this command is switched off until you give it another name.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// "Says hello · 2 actions · limited to certain roles or channels · 10s cooldown".
    private var details: String {
        var parts: [String] = []
        parts.append(command.description.isEmpty ? String(localized: "No description") : command.description)
        parts.append(String(localized: "\(command.actions.count) actions"))
        if !command.allowedRoles.isEmpty || !command.allowedChannels.isEmpty {
            parts.append(String(localized: "limited to certain roles or channels"))
        }
        if command.cooldownSeconds > 0 { parts.append(String(localized: "\(command.cooldownSeconds)s cooldown")) }
        return parts.joined(separator: " · ")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        if endpoint is Endpoints.LoadCustomCommands {
            return CustomCommandsPage(
                commands: [
                    CustomCommand(
                        id: "1", name: "hello", description: "Says hello",
                        actions: [CommandAction(kind: .reply, messages: [CommandMessage(content: "Hi {user}!")])],
                        cooldownSeconds: 10),
                    CustomCommand(id: "2", name: "ban", actions: [CommandAction(kind: .addRole, roleId: "r1")],
                                  reserved: true),
                ],
                channels: [ChannelOption(id: "c1", name: "general")],
                roles: [RoleOption(id: "r1", name: "Member")])
        }
        return nil
    }
    NavigationStack {
        CustomCommandsView(server: "1", session: session)
    }
    .environment(session)
}
