import SwiftUI
import SyloKit

/// Reaction roles & autoroles: messages members pick roles from (reactions, buttons or a menu), and
/// the roles given to every new member. Mirrors web-v2/src/moduleForms/Roles.jsx.
struct RolesSettingsView: View {
    let server: ServerID

    @State private var model: RecordListModel<RolesPage>
    @State private var note: ModulePlatformNoteModel
    @State private var editing: ReactionRoleDraft?
    @State private var pendingDelete: ReactionRoleSet?
    @State private var publishNotice: String?
    /// The autoroles as edited; nil while they are as loaded.
    @State private var autoroleEdit: [String]?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(roles: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: RolesPage.moduleID, session: session))
    }

    var body: some View {
        RecordScreen("Reaction Roles", model: model, note: note) { page in
            ModuleIntro("Let members pick their own roles from a message, with reactions, buttons or a menu. Sylo needs Manage Roles, and its own role above the roles it hands out.")

            Section {
                if page.sets.isEmpty {
                    Text("None yet. Create one to let members pick their roles.")
                        .foregroundStyle(Color.syloMuted)
                }
                ForEach(page.sets) { set in
                    RecordRow(
                        title: set.title, details: details(of: set, page: page),
                        status: set.isPublished ? LocalizedStringKey("Published") : LocalizedStringKey("Draft"),
                        isActive: set.isPublished
                    ) {
                        editing = ReactionRoleDraft(set: set)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = set }
                    }
                    .contextMenu {
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = set }
                    }
                    .accessibilityAction(named: Text("Delete")) { pendingDelete = set }
                }
                Button("New Reaction Role", systemImage: "plus") {
                    editing = ReactionRoleDraft()
                }
                .disabled(page.sets.count >= RolesPage.maxSets)
            } header: {
                Text("Reaction roles (\(page.sets.count))")
            }

            Section {
                MultiPicker(
                    title: "Roles", selection: autoroles(page), options: page.roles, prefix: "@")
                if let edited = autoroleEdit, edited != page.autoroles {
                    Button("Save Autoroles") {
                        Task {
                            if await model.saveAutoroles(edited) { autoroleEdit = nil }
                        }
                    }
                    Button("Discard Autoroles Changes", role: .destructive) { autoroleEdit = nil }
                }
            } header: {
                Text("Autoroles on join")
            } footer: {
                Text("Given automatically when a member joins. They are the same roles as \u{201C}Give roles to new members\u{201D} under Welcome & Leave.")
            }
        }
        .sheet(item: $editing) { draft in
            if let page = model.page {
                ReactionRoleEditor(draft: draft, page: page, save: { await save($0) }, failure: { model.takeActionError() })
            }
        }
        .confirmationDialog(
            "Delete this reaction-role set?", isPresented: isConfirmingDelete, titleVisibility: .visible,
            presenting: pendingDelete
        ) { set in
            Button("Delete Set", role: .destructive) { Task { _ = await model.delete(set) } }
        } message: { _ in
            Text("Its message is deleted from the channel too. Roles members already picked are kept.")
        }
        .alert("Saved, but not posted", isPresented: isShowingNotice, presenting: publishNotice) { _ in
            Button("OK") {}
        } message: { message in
            Text("The set is saved, but its message could not be posted: \(message)")
        }
    }

    private func save(_ draft: ReactionRoleDraft) async -> Bool {
        guard let saved = await model.save(draft) else { return false }
        publishNotice = saved.publishError
        return true
    }

    private func autoroles(_ page: RolesPage) -> Binding<[String]> {
        Binding(get: { autoroleEdit ?? page.autoroles }, set: { autoroleEdit = $0 })
    }

    private func details(of set: ReactionRoleSet, page: RolesPage) -> String {
        let channel = page.channels.first { $0.id == set.channelId }.map { "#\($0.name)" } ?? String(localized: "deleted channel")
        var parts = [channel, String(localized: "\(set.pairs.count) roles"), set.style.title]
        if set.style != .select {
            parts.append(set.mode == .reverse ? String(localized: "Reverse style") : String(localized: "Default style"))
        }
        if set.exclusive { parts.append(String(localized: "Exclusive")) }
        return parts.joined(separator: " · ")
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { publishNotice != nil }, set: { if !$0 { publishNotice = nil } })
    }
}

extension ReactionRoleStyle {
    var title: String {
        switch self {
        case .reaction: String(localized: "Reactions")
        case .buttons: String(localized: "Buttons")
        case .select: String(localized: "Dropdown")
        }
    }

    var explanation: LocalizedStringKey {
        switch self {
        case .reaction: "Members react with an emoji. Needs the Add Reactions permission."
        case .buttons: "Members click a button. Up to 25, and no reaction permission needed."
        case .select: "Members pick from a menu. Best for long lists."
        }
    }
}

/// Edits one reaction-role set in a sheet and publishes it with Save.
private struct ReactionRoleEditor: View {
    @State var draft: ReactionRoleDraft
    let page: RolesPage
    let save: (ReactionRoleDraft) async -> Bool
    let failure: () -> String?

    @State private var initial: ReactionRoleDraft?

    var body: some View {
        RecordEditor(
            title: draft.setID.isEmpty ? "New Reaction Role" : "Edit Reaction Role", problem: draft.problem,
            hasChanges: initial.map { $0 != draft } ?? false,
            save: { await save(draft) }, failure: failure
        ) {
            Section {
                Picker("Style", selection: $draft.style) {
                    ForEach(ReactionRoleStyle.allCases, id: \.self) { style in
                        Text(verbatim: style.title).tag(style)
                    }
                }
                .pickerStyle(.segmented)
                ChannelPicker(
                    title: "Channel", selection: $draft.channelId, channels: page.channels,
                    noneTitle: "Choose a channel")
            } footer: {
                Text(draft.style.explanation)
            }

            Section {
                TextArea(
                    title: "Pick your roles below!", text: $draft.message,
                    limit: ReactionRoleDraft.maxMessageLength, lines: 2...6)
                NavigationLink {
                    EmbedEditorScreen(title: "Embed", embed: $draft.embed)
                } label: {
                    LabeledContent("Embed") {
                        Text(verbatim: draft.embed.title.isEmpty ? String(localized: "Automatic list") : draft.embed.title)
                    }
                }
            } header: {
                Text("Message")
            } footer: {
                Text("Text above the embed is optional. Without an embed, Sylo lists the roles itself.")
            }

            Section {
                Toggle("Only one role from this set", isOn: $draft.exclusive)
                if draft.style == .select {
                    TextField("Menu placeholder", text: $draft.placeholder)
                    NumberField(title: "Fewest picks", value: $draft.selMin, range: ReactionRoleDraft.pickRange)
                    NumberField(title: "Most picks (0 for no limit)", value: $draft.selMax, range: ReactionRoleDraft.pickRange)
                } else {
                    Picker("Reaction mode", selection: $draft.mode) {
                        Text("Default").tag(ReactionRoleMode.standard)
                        Text("Reverse").tag(ReactionRoleMode.reverse)
                    }
                }
            } header: {
                Text("Options")
            } footer: {
                VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                    Text("With one role at a time, picking a role takes away the others.")
                    if draft.style != .select {
                        Text("Default: the interaction adds the role and undoing it takes it away. Reverse: the interaction removes the role, and undoing it gives it back.")
                    }
                }
            }

            ForEach($draft.rows) { $row in
                Section {
                    TextField(draft.style == .reaction ? "Emoji (required)" : "Emoji (optional)", text: $row.emoji)
                    if draft.style != .reaction {
                        TextField("Label (optional)", text: $row.label)
                            .onChange(of: row.label) {
                                if row.label.count > ReactionRoleDraft.Row.maxLabelLength {
                                    row.label = String(row.label.prefix(ReactionRoleDraft.Row.maxLabelLength))
                                }
                            }
                    }
                    RolePicker(title: "Role", selection: $row.roleId, roles: page.roles, noneTitle: "Choose a role")
                    if draft.style == .buttons {
                        Picker("Button colour", selection: $row.buttonStyle) {
                            ForEach(RoleButtonStyle.allCases, id: \.self) { style in
                                Text(verbatim: style.title).tag(style)
                            }
                        }
                    }
                    if draft.rows.count > 1 {
                        Button("Remove", role: .destructive) {
                            draft.rows.removeAll { $0.id == row.id }
                        }
                    }
                } header: {
                    if let number = draft.rows.firstIndex(where: { $0.id == row.id }) {
                        Text("Role \(number + 1)")
                    }
                }
            }
            Section {
                Button("Add Role", systemImage: "plus") {
                    draft.rows.append(ReactionRoleDraft.Row())
                }
                .disabled(draft.rows.count >= draft.style.maxRoles)
            } footer: {
                Text("\(draft.rows.count) of \(draft.style.maxRoles) roles.")
            }
        }
        .onAppear { if initial == nil { initial = draft } }
    }
}

extension RoleButtonStyle {
    var title: String {
        switch self {
        case .secondary: String(localized: "Grey")
        case .primary: String(localized: "Blue")
        case .success: String(localized: "Green")
        case .danger: String(localized: "Red")
        }
    }
}
