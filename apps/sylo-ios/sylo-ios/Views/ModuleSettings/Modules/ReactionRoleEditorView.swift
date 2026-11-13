import SwiftUI
import SyloKit

/// What the reaction-role sheet is for: a new set, or one that exists.
enum ReactionRoleTarget: Identifiable {
    case new
    case edit(ReactionRoleMessage)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let message): "edit-\(message.id)"
        }
    }
}

/// The form for one reaction-role message: how members pick (reactions, buttons or a menu), the
/// channel, the text and embed above, and the emoji and role of every row. Publish saves the set
/// and posts it, as the dashboard's form does. Mirrors `ReactionRoleForm` in
/// web-v2/src/moduleForms/Roles.jsx.
struct ReactionRoleEditorView: View {
    let target: ReactionRoleTarget
    let model: RolesModel

    @State private var draft: ReactionRoleMessage
    @State private var original: ReactionRoleMessage
    @State private var isConfirmingMove = false
    @State private var isConfirmingDiscard = false
    @State private var failure: EditorFailure?
    @Environment(\.dismiss) private var dismiss

    /// A message for the person, and whether closing it also closes the form.
    private struct EditorFailure {
        let title: LocalizedStringKey
        let message: String
        var closesEditor = false
    }

    init(target: ReactionRoleTarget, model: RolesModel) {
        self.target = target
        self.model = model
        var start: ReactionRoleMessage
        switch target {
        case .new: start = ReactionRoleMessage()
        case .edit(let message): start = message
        }
        if start.pairs.isEmpty { start.pairs = [ReactionRolePair()] }
        _draft = State(initialValue: start)
        _original = State(initialValue: start)
    }

    private var isDirty: Bool { draft != original }

    private var problems: [String] {
        draft.problems(
            customEmojis: model.customEmojis, pairsLimit: model.pairsLimit, emojiListKnown: model.hasEmojiList)
    }

    private var maxRows: Int {
        ReactionRoleMessage.maxRows(style: draft.style, pairsLimit: model.pairsLimit)
    }

    var body: some View {
        NavigationStack {
            Form {
                styleSection
                Section {
                    ChannelPicker(title: "Channel", selection: $draft.channelId, channels: model.channels,
                                  noneTitle: "Choose a channel")
                } footer: {
                    channelFooter
                }
                Section {
                    UTF16TextArea(title: "Pick your roles below!", text: $draft.message,
                                  limit: model.messageLimit, lines: 2...6)
                } header: {
                    Text("Message Text")
                } footer: {
                    Text("Optional, above the embed.")
                }
                embedSection
                Section {
                    Toggle("Only one role from this set at a time", isOn: $draft.exclusive)
                } footer: {
                    Text("Picking one removes the others.")
                }
                if draft.style == "select" { menuSection }
                rowSections
                if draft.hasMode { modeSection }
                if draft.hasUncheckedShortcode(listKnown: model.hasEmojiList) {
                    Section {
                        Text("The server's emoji list could not be loaded, so a :shortcode: is sent as typed and the server looks it up.")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                if !problems.isEmpty {
                    Section {
                        ForEach(problems, id: \.self) { problem in
                            Text(verbatim: problem)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                }
            }
            .disabled(model.isSavingSet)
            // Whatever the first load could not get (emoji list, limits, the server's move feature) is asked again.
            .task { await model.prepare() }
            .navigationTitle(draft.isNew ? "New Reaction Role" : "Edit Reaction Role")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if isDirty { isConfirmingDiscard = true } else { dismiss() }
                    }
                    .disabled(model.isSavingSet)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isSavingSet {
                        ProgressView()
                    } else {
                        Button("Publish") { publish() }
                            .toolbarSaveStyle()
                            .disabled(!problems.isEmpty)
                    }
                }
            }
            .interactiveDismissDisabled(isDirty || model.isSavingSet)
            .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
            }
            .confirmationDialog(
                "Move the posted message?", isPresented: $isConfirmingMove, titleVisibility: .visible
            ) {
                Button("Move and Publish", role: .destructive) { publish(confirmedMove: true) }
            } message: {
                Text(moveMessage)
            }
            .alert(
                failure?.title ?? "", isPresented: isShowingFailure, presenting: failure
            ) { failure in
                Button("OK") { if failure.closesEditor { dismiss() } }
            } message: { failure in
                Text(failure.message)
            }
            .sensoryFeedback(.success, trigger: model.successCount)
        }
    }

    // MARK: - Sections

    private struct StyleOption: Identifiable {
        let id: String
        let title: LocalizedStringKey
        let hint: LocalizedStringKey
    }

    private static let styleOptions = [
        StyleOption(id: "reaction", title: "Reactions", hint: "Members react with an emoji. Needs Add Reactions permission."),
        StyleOption(id: "buttons", title: "Buttons", hint: "Members click a button. Up to 25, no reaction permission needed."),
        StyleOption(id: "select", title: "Dropdown", hint: "Members pick from a select menu. Best for long lists."),
    ]

    private var styleSection: some View {
        Section {
            Picker("Style", selection: $draft.style) {
                ForEach(Self.styleOptions) { entry in
                    Text(entry.title).tag(entry.id)
                }
                // A style a newer server has: kept as it is until the person picks another.
                if !ReactionRoleMessage.styles.contains(draft.style) {
                    Text(verbatim: draft.style).tag(draft.style)
                }
            }
            .pickerStyle(.segmented)
        } footer: {
            if let hint = Self.styleOptions.first(where: { $0.id == draft.style })?.hint {
                Text(hint)
            }
        }
    }

    @ViewBuilder
    private var channelFooter: some View {
        if model.channelMove(for: draft) != nil {
            if model.serverMovesMessages {
                Text("The message is posted in the new channel, and the old one is deleted after that.")
            } else {
                Text("The set is posted again in the new channel and the old message is deleted after that, once you confirm.")
            }
        } else if draft.isPublished {
            Text("Publish edits the posted message.")
        } else {
            Text("Publish posts the message in this channel.")
        }
    }

    private var embedSection: some View {
        Section {
            if draft.embed.isOpaque {
                EmbedItemSummary(item: draft.embed)
            } else {
                NavigationLink {
                    EmbedEditorView(draft: $draft.embed.draft, options: EmbedOptions())
                } label: {
                    LabeledContent("Embed") {
                        Text(verbatim: draft.embed.draft.title)
                    }
                }
            }
        } footer: {
            Text("Leave the embed empty and Sylo lists the roles for you.")
        }
    }

    private var menuSection: some View {
        Section {
            LimitedTextField(title: "Pick your roles", text: $draft.placeholder, limit: model.placeholderLimit)
            NumberField(title: "Min picks", value: $draft.selMin, range: 0...ReactionRoleMessage.Limits.picks)
            NumberField(title: "Max picks", value: $draft.selMax, range: 0...ReactionRoleMessage.Limits.picks)
        } header: {
            Text("Menu")
        } footer: {
            Text("The text in the closed menu. Max picks 0 means no limit.")
        }
    }

    @ViewBuilder
    private var rowSections: some View {
        ForEach($draft.pairs) { $pair in
            Section {
                EmojiField(title: draft.style == "reaction" ? "👋 (required)" : "👋 (optional)",
                           text: $pair.emoji, customEmojis: model.customEmojis)
                if draft.style != "reaction" {
                    LimitedTextField(title: "Button label (optional)", text: $pair.label, limit: model.labelLimit)
                }
                RolePicker(title: "Role", selection: $pair.roleId, roles: model.roles, noneTitle: "Select a role")
                if draft.style == "buttons" {
                    Picker("Button colour", selection: $pair.buttonStyle) {
                        ForEach(ReactionRolePair.buttonStyles, id: \.self) { style in
                            Text(Self.buttonStyleTitle(style)).tag(style)
                        }
                        if !ReactionRolePair.buttonStyles.contains(pair.buttonStyle) {
                            Text(verbatim: pair.buttonStyle).tag(pair.buttonStyle)
                        }
                    }
                }
                Button("Remove", role: .destructive) { remove(pair.id) }
            } header: {
                Text(verbatim: "\(rowTitle) \(rowNumber(of: pair.id))")
            }
        }
        Section {
            Button(addTitle, systemImage: "plus") {
                if draft.pairs.count < maxRows { draft.pairs.append(ReactionRolePair()) }
            }
            .disabled(draft.pairs.count >= maxRows)
        } footer: {
            Text("\(draft.pairs.count) of \(maxRows).")
        }
    }

    private var modeSection: some View {
        Section {
            Picker("Reaction mode", selection: $draft.mode) {
                Text("Default").tag("default")
                Text("Reverse").tag("reverse")
            }
            .pickerStyle(.segmented)
        } footer: {
            if draft.mode == "reverse" {
                Text("Reverse: the interaction removes the role (opt-out); undoing it gives it back.")
            } else {
                Text("Default: the interaction adds the role; undoing it takes it away.")
            }
        }
    }

    private var rowTitle: String {
        switch draft.style {
        case "buttons": String(localized: "Button")
        case "select": String(localized: "Option")
        default: String(localized: "Reaction")
        }
    }

    private func rowNumber(of id: UUID) -> Int {
        (draft.pairs.firstIndex { $0.id == id } ?? 0) + 1
    }

    private var addTitle: LocalizedStringKey {
        switch draft.style {
        case "buttons": "Add Button"
        case "select": "Add Option"
        default: "Add Reaction"
        }
    }

    private static func buttonStyleTitle(_ style: String) -> LocalizedStringKey {
        switch style {
        case "primary": "Blue"
        case "success": "Green"
        case "danger": "Red"
        default: "Grey"
        }
    }

    private func remove(_ id: UUID) {
        draft.pairs.removeAll { $0.id == id }
        if draft.pairs.isEmpty { draft.pairs = [ReactionRolePair()] }
    }

    // MARK: - Publishing

    private func channelName(_ id: String) -> String {
        model.channels.first { $0.id == id }?.name ?? String(localized: "deleted channel")
    }

    private var moveMessage: LocalizedStringKey {
        let move = model.channelMove(for: draft)
        let from = channelName(move?.from ?? "")
        let to = channelName(move?.to ?? "")
        return "The set is posted again in #\(to), and the old message in #\(from) is deleted after that. Its buttons and reactions stop working. If posting in the new channel fails, nothing changes and the old message stays."
    }

    private func publish(confirmedMove: Bool = false) {
        Task {
            let outcome = await model.save(draft, confirmedMove: confirmedMove)
            switch outcome {
            case .saved:
                dismiss()
            case .savedNotPosted(let text):
                failure = EditorFailure(
                    title: "Saved, but Not Posted",
                    message: text + " The set is saved as a draft; publish it again once that is fixed.",
                    closesEditor: true)
            case .stillPosted(let text, let moved):
                let message = moved
                    ? String(localized: "The message was not moved: it is still posted in the old channel. The set is saved with your changes, but the new channel only applies once posting there works. ")
                    : String(localized: "The set is saved, but the posted message was not updated. ")
                failure = EditorFailure(
                    title: moved ? "Not Moved" : "Saved, but Not Updated", message: message + text,
                    closesEditor: true)
            case .movedOldRemains(let text):
                failure = EditorFailure(title: "Moved, Old Set Remains", message: text, closesEditor: true)
            case .failed(let text):
                failure = EditorFailure(title: "Couldn't Publish", message: text)
            case .failedAfterRemoval(let text):
                // The set is gone from the server: the next publish puts it back under the same id.
                draft.messageId = ""
                failure = EditorFailure(title: "Old Message Deleted", message: text)
            case .needsConfirmation:
                isConfirmingMove = true
            case .ignored:
                break
            }
        }
    }

    private var isShowingFailure: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadRoles {
            return RolesPage(
                channels: [ChannelOption(id: "c1", name: "roles")],
                roles: [RoleOption(id: "r1", name: "Gamer"), RoleOption(id: "r2", name: "Artist")])
        }
        return nil
    }
    let model = RolesModel(server: "1", session: session)
    ReactionRoleEditorView(
        target: .edit(ReactionRoleMessage(
            id: "1", channelId: "c1", messageId: "m1", style: "buttons", message: "Pick your roles!",
            pairs: [ReactionRolePair(emoji: "🎮", label: "Gamer", roleId: "r1", buttonStyle: "primary")])),
        model: model)
    .environment(session)
}
