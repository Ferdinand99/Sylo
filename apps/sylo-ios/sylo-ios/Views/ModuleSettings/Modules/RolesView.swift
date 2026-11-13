import SwiftUI
import SyloKit

/// Reaction roles and autoroles: messages that let members pick their own roles (with reactions,
/// buttons or a menu), and roles given to every new member. Mirrors web-v2/src/moduleForms/Roles.jsx.
struct RolesView: View {
    @State private var model: RolesModel
    @State private var note: ModulePlatformNoteModel
    @State private var editor: ReactionRoleTarget?
    @State private var deleting: ReactionRoleMessage?
    @State private var isConfirmingDiscard = false

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: RolesModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: "roles", session: session))
    }

    var body: some View {
        Group {
            if model.hasLoaded {
                list
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Reaction Roles", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Reaction Roles")
        .navigationBarTitleDisplayMode(.inline)
        // Like the module settings: no way back while the autoroles have unsaved changes.
        .navigationBarBackButtonHidden(model.autorolesChanged)
        .tracksUnsavedChanges(model.autorolesChanged)
        .toolbar {
            if model.autorolesChanged {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { isConfirmingDiscard = true }
                        .disabled(model.isSavingAutoroles)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isSavingAutoroles {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await model.saveAutoroles() } }
                            .toolbarSaveStyle()
                    }
                }
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { model.discardAutoroles() }
        }
        .confirmationDialog(
            "Delete This Reaction-Role Set?", isPresented: isDeleting, titleVisibility: .visible, presenting: deleting
        ) { set in
            Button("Delete Set", role: .destructive) {
                Task { await model.delete(set.id) }
            }
        } message: { _ in
            Text("Its message is deleted from the channel too. Roles members already picked are kept.")
        }
        .alert("Couldn't Update Roles", isPresented: isShowingError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sheet(item: $editor) { target in
            ReactionRoleEditorView(target: target, model: model)
        }
        .sensoryFeedback(.success, trigger: model.successCount)
        .task {
            await note.load()
            if !model.hasLoaded { await model.load() }
        }
    }

    // MARK: - The list

    private var list: some View {
        @Bindable var model = model
        return List {
            ModuleIntro("Let members give themselves roles from a message, and give roles to every new member.")
            PlatformNoteSection(model: note)

            Section {
                if model.reactionMessages.isEmpty {
                    Text("None yet. Create one to let members pick their own roles.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.reactionMessages) { set in
                    Button {
                        editor = .edit(set)
                    } label: {
                        ReactionRoleRow(set: set, channels: model.channels)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = set }
                    }
                    .contextMenu {
                        Button("Edit", systemImage: "pencil") { editor = .edit(set) }
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = set }
                    }
                }
                Button("New Reaction Role", systemImage: "plus") { editor = .new }
                    .disabled(!model.canAddSet)
            } header: {
                Text("Reaction roles (\(model.reactionMessages.count))")
            } footer: {
                if !model.canAddSet {
                    Text("This server already has the maximum of \(model.maxSets) reaction-role messages.")
                }
            }

            Section {
                MultiPicker(title: "Roles", selection: $model.autoroles, options: model.roles, prefix: "@",
                            limit: model.maxAutoroles)
            } header: {
                Text("Autoroles on join")
            } footer: {
                Text("Given automatically when a member joins. These are the same roles as under “Give roles to new members” in Welcome and leave. Save them with the button above.")
            }
        }
        .disabled(model.isSavingAutoroles || model.isSavingSet)
        .refreshable { await model.load() }
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

/// One reaction-role message in the list: its title, whether it is posted, and where and how.
private struct ReactionRoleRow: View {
    let set: ReactionRoleMessage
    let channels: [ChannelOption]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: title)
                    .lineLimit(2)
                StatusTag(set.isPublished ? "Published" : "Draft", tint: set.isPublished ? .green : .secondary, tintsText: true)
            }
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        if !set.embed.isOpaque, !set.embed.draft.title.isEmpty { return set.embed.draft.title }
        let text = String(set.message.prefix(60))
        return text.isEmpty ? String(localized: "Reaction role") : text
    }

    /// "#roles · 3 roles · Buttons · Default style · Exclusive".
    private var details: String {
        var parts: [String] = []
        let channel = channels.first { $0.id == set.channelId }?.name ?? set.channelId
        parts.append("#\(channel)")
        parts.append(String(localized: "\(set.pairs.count) roles"))
        switch set.style {
        case "reaction": parts.append(String(localized: "Reactions"))
        case "buttons": parts.append(String(localized: "Buttons"))
        case "select": parts.append(String(localized: "Dropdown"))
        default: parts.append(set.style)
        }
        if set.style != "select" {
            parts.append(set.mode == "reverse" ? String(localized: "Reverse style") : String(localized: "Default style"))
        }
        if set.exclusive { parts.append(String(localized: "Exclusive")) }
        return parts.joined(separator: " · ")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        if endpoint is Endpoints.LoadRoles {
            return RolesPage(
                reactionMessages: [
                    ReactionRoleMessage(
                        id: "1", channelId: "c1", messageId: "m1", style: "buttons", message: "Pick your roles!",
                        pairs: [ReactionRolePair(emoji: "🎮", label: "Gamer", roleId: "r1")]),
                    ReactionRoleMessage(id: "2", channelId: "c1", style: "reaction", pairs: []),
                ],
                autoroles: ["r2"],
                channels: [ChannelOption(id: "c1", name: "roles")],
                roles: [RoleOption(id: "r1", name: "Gamer"), RoleOption(id: "r2", name: "Member")])
        }
        return nil
    }
    NavigationStack {
        RolesView(server: "1", session: session)
    }
    .environment(session)
}
