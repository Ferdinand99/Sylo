import SwiftUI
import SyloKit

/// One action of a custom command: the role or channel it works on, and for a reply or a send, its
/// messages (text and an optional embed each; with several, the bot picks one at random). Changes go
/// straight into the command being edited, which the screen before saves.
struct CommandActionEditorView: View {
    @Binding var action: CommandAction
    let model: CustomCommandsModel

    var body: some View {
        Form {
            switch action.kind {
            case .addRole, .removeRole:
                Section {
                    RolePicker(title: "Role", selection: $action.roleId, roles: model.roles,
                               noneTitle: "Choose a role")
                } footer: {
                    Text("Applied to whoever ran the command.")
                }
            case .send:
                Section {
                    ChannelPicker(title: "Channel", selection: $action.channelId, channels: model.channels,
                                  noneTitle: "Choose a channel")
                }
                messageSections
            case .reply:
                Section {
                    Toggle("Private", isOn: $action.isPrivate)
                } footer: {
                    Text("Only the person who ran it sees the reply.")
                }
                messageSections
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var title: LocalizedStringKey {
        switch action.kind {
        case .reply: "Reply"
        case .send: "Send to a Channel"
        case .addRole: "Add a Role"
        case .removeRole: "Remove a Role"
        }
    }

    // MARK: - Messages

    @ViewBuilder
    private var messageSections: some View {
        ForEach($action.messages) { $message in
            Section {
                LimitedTextField(
                    title: "Write your message here… (leave blank for embed-only)", text: $message.content,
                    limit: model.contentLimit, lines: 2...8)
                PlaceholderInsertRow(tokens: model.placeholders, text: $message.content, limit: model.contentLimit)
                if let warning = unknownTokenWarning(message.content) {
                    Text(verbatim: warning)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                embedRows($message)
                if action.messages.count > 1 {
                    Button("Remove Message", role: .destructive) {
                        action.messages.removeAll { $0.id == message.id }
                    }
                }
            } header: {
                Text(verbatim: "\(String(localized: "Message")) \(messageNumber(of: message.id))")
            }
        }
        Section {
            Button("Add a Message", systemImage: "plus") {
                action.messages.append(CommandMessage())
            }
            .disabled(action.messages.count >= model.maxMessages)
        } footer: {
            Text("With more than one message, the bot picks one at random. Up to \(model.maxMessages).")
        }
    }

    @ViewBuilder
    private func embedRows(_ message: Binding<CommandMessage>) -> some View {
        if let embed = message.wrappedValue.embed {
            if embed.isOpaque {
                EmbedItemSummary(item: embed)
            } else {
                NavigationLink {
                    // The preview shows the {tokens} as typed, so it is left out here.
                    EmbedEditorView(
                        draft: embedDraft(message), options: EmbedItem.options,
                        variables: model.placeholders.map { token in
                            EmbedVariable(token: token, label: token.filter { $0 != "{" && $0 != "}" })
                        }, showsPreview: false)
                } label: {
                    LabeledContent("Embed") {
                        Text(verbatim: embed.draft.title)
                    }
                }
            }
            Button("Remove Embed", role: .destructive) { message.wrappedValue.embed = nil }
        } else {
            Button("Add Embed", systemImage: "plus") { message.wrappedValue.embed = EmbedItem() }
        }
    }

    private func embedDraft(_ message: Binding<CommandMessage>) -> Binding<EmbedDraft> {
        Binding(
            get: { message.wrappedValue.embed?.draft ?? EmbedDraft() },
            set: { message.wrappedValue.embed?.draft = $0 })
    }

    private func messageNumber(of id: UUID) -> Int {
        (action.messages.firstIndex { $0.id == id } ?? 0) + 1
    }

    private func unknownTokenWarning(_ text: String) -> String? {
        let unknown = CommandPlaceholders.unknownTokens(in: text, known: model.placeholders)
        guard !unknown.isEmpty else { return nil }
        let shown = unknown.prefix(3).joined(separator: ", ")
        return String(localized: "\(shown) is not filled in by custom commands. It is sent as typed.")
    }
}

/// The "Insert: {user} {server} …" row under a message field: each token goes at the end of the text,
/// when it fits.
struct PlaceholderInsertRow: View {
    let tokens: [String]
    @Binding var text: String
    /// The text's limit in UTF-16 units.
    let limit: Int

    var body: some View {
        if !tokens.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("Insert a variable")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(tokens, id: \.self) { token in
                            Button {
                                insert(token)
                            } label: {
                                Text(verbatim: token)
                            }
                            .buttonStyle(.bordered)
                            .accessibilityHint(Text(verbatim: CommandPlaceholders.hint(for: token)))
                        }
                    }
                }
            }
        }
    }

    private func insert(_ token: String) {
        let joined = text.isEmpty || text.hasSuffix(" ") ? text + token : text + " " + token
        if joined.utf16.count <= limit { text = joined }
    }
}
