import SwiftUI
import SyloKit

/// The editor of one embed message: its name and channel, a live preview, the message text, the
/// embeds and the link buttons, with Save Draft and Publish. Mirrors web-v2/src/pages/MessageBuilder.jsx.
/// Publishing a message that is already posted edits the posted message.
struct EmbedMessageEditorView: View {
    let server: ServerID
    @State private var model: ComposedMessageEditorModel

    /// - Parameter id: The saved message to edit; nil starts a new one.
    init(server: ServerID, session: AppSession, id: Int?) {
        self.server = server
        _model = State(initialValue: ComposedMessageEditorModel(server: server, session: session, id: id))
    }

    var body: some View {
        Group {
            if model.isLoaded {
                EmbedMessageForm(model: model, isFluxer: server.rawValue.hasPrefix("fluxer:"))
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Message", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") {
                        Task { await model.load() }
                    }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Embed Message")
        .navigationBarTitleDisplayMode(.inline)
        .task { if !model.isLoaded { await model.load() } }
    }
}

/// The loaded editor.
private struct EmbedMessageForm: View {
    @Bindable var model: ComposedMessageEditorModel
    let isFluxer: Bool

    @State private var isConfirmingDiscard = false

    var body: some View {
        Form {
            Group {
                nameSection
                previewSection
                textSection
                embedsSection
                linksSection
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .disabled(model.isBusy)
        .navigationBarBackButtonHidden(model.hasChanges)
        .toolbar {
            if model.hasChanges {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { isConfirmingDiscard = true }
                        .disabled(model.isBusy)
                }
            }
            ToolbarItemGroup(placement: .confirmationAction) {
                if model.isBusy {
                    ProgressView()
                } else {
                    Button(model.isPublished ? "Update" : "Publish") { Task { await model.publish() } }
                        .toolbarSaveStyle()
                        .disabled(model.publishProblem != nil)
                }
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { model.discardChanges() }
        }
        .alert("Couldn't Save", isPresented: isShowingError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.saveCount)
    }

    // MARK: Sections

    private var nameSection: some View {
        Section {
            TextField("Untitled embed", text: $model.name)
                .onChange(of: model.name) {
                    if model.name.count > ComposedMessageDraft.maxNameLength {
                        model.name = String(model.name.prefix(ComposedMessageDraft.maxNameLength))
                    }
                }
                .accessibilityLabel(Text("Name"))
            ChannelPicker(
                title: "Channel", selection: $model.channelId, channels: model.channels, noneTitle: "Choose a channel")
            Button("Save Draft", systemImage: "square.and.arrow.down") { Task { await model.saveDraft() } }
                .disabled(!model.hasChanges)
        } header: {
            Text("Message")
        } footer: {
            VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                if model.isPublished {
                    Text("Published. Update edits the posted message; changing the channel posts a fresh one. Save Draft keeps your changes without touching the posted message.")
                }
                if !model.hasChanges {
                    statusLine
                }
                if let problem = model.publishProblem, model.hasChanges || model.isNew {
                    Text(problem)
                }
            }
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        switch model.lastStatus {
        case .saved:
            Label("Draft saved.", systemImage: "checkmark.circle.fill").foregroundStyle(Color.syloBrand)
        case .sent:
            Label("Published to the channel.", systemImage: "checkmark.circle.fill").foregroundStyle(Color.syloBrand)
        case .updated:
            Label("Published message updated.", systemImage: "checkmark.circle.fill").foregroundStyle(Color.syloBrand)
        case nil:
            EmptyView()
        }
    }

    private var previewSection: some View {
        Section {
            MessagePreview(
                content: model.draft.content, embeds: model.draft.embeds, links: model.draft.links,
                isFluxer: isFluxer)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
        } header: {
            Text("Preview")
        }
    }

    private var textSection: some View {
        Section {
            TextArea(
                title: "Write your message here", text: $model.draft.content,
                limit: ComposedMessageDraft.maxContentLength, lines: 2...8)
        } header: {
            Text("Message text")
        } footer: {
            Text("To ping a role, type <@&ROLE_ID> in the text. Mentions inside an embed don't notify anyone.")
        }
    }

    private var embedsSection: some View {
        Section {
            ForEach(Array(model.draft.embeds.enumerated()), id: \.element.id) { index, embed in
                NavigationLink {
                    EmbedEditorScreen(
                        title: "Embed \(index + 1)", embed: embedBinding(embed.id), isFluxer: isFluxer)
                } label: {
                    EmbedRowLabel(embed: embed, number: index + 1)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button("Remove", systemImage: "trash", role: .destructive) { remove(embed.id) }
                }
                .contextMenu {
                    Button("Move Up", systemImage: "arrow.up") { move(embed.id, by: -1) }
                        .disabled(index == 0)
                    Button("Move Down", systemImage: "arrow.down") { move(embed.id, by: 1) }
                        .disabled(index == model.draft.embeds.count - 1)
                    Button("Duplicate", systemImage: "plus.square.on.square") { duplicate(embed.id) }
                        .disabled(model.draft.embeds.count >= ComposedMessageDraft.maxEmbeds)
                    Button("Remove", systemImage: "trash", role: .destructive) { remove(embed.id) }
                }
                .accessibilityAction(named: Text("Move up")) { move(embed.id, by: -1) }
                .accessibilityAction(named: Text("Move down")) { move(embed.id, by: 1) }
                .accessibilityAction(named: Text("Duplicate")) { duplicate(embed.id) }
                .accessibilityAction(named: Text("Remove")) { remove(embed.id) }
            }
            Button("Add Embed", systemImage: "plus") {
                model.draft.embeds.append(EmbedSpec())
            }
            .disabled(model.draft.embeds.count >= ComposedMessageDraft.maxEmbeds)
        } header: {
            Text("Embeds (\(model.draft.embeds.count) / \(ComposedMessageDraft.maxEmbeds))")
        } footer: {
            Text("Touch and hold an embed to move, copy or remove it.")
        }
    }

    @ViewBuilder
    private var linksSection: some View {
        ForEach($model.draft.links) { $link in
            Section("Link button") {
                TextField("Label", text: $link.label)
                    .onChange(of: link.label) {
                        if link.label.count > LinkButton.maxLabelLength {
                            link.label = String(link.label.prefix(LinkButton.maxLabelLength))
                        }
                    }
                TextField("Emoji (optional)", text: $link.emoji)
                WebLinkField(title: "https://…", text: $link.url)
                Button("Remove Link Button", role: .destructive) {
                    model.draft.links.removeAll { $0.id == link.id }
                }
            }
        }
        Section {
            Button("Add Link Button", systemImage: "link.badge.plus") {
                model.draft.links.append(LinkButton())
            }
            .disabled(model.draft.links.count >= ComposedMessageDraft.maxLinks)
        } footer: {
            Text("Optional buttons under the message that open a link. Up to \(ComposedMessageDraft.maxLinks).")
        }
    }

    // MARK: Editing embeds

    /// A binding to the embed with this id, so a screen pushed for it never writes to the wrong
    /// embed after the list changed.
    private func embedBinding(_ id: UUID) -> Binding<EmbedSpec> {
        Binding(
            get: { model.draft.embeds.first { $0.id == id } ?? EmbedSpec() },
            set: { newValue in
                if let index = model.draft.embeds.firstIndex(where: { $0.id == id }) {
                    model.draft.embeds[index] = newValue
                }
            })
    }

    private func remove(_ id: UUID) {
        model.draft.embeds.removeAll { $0.id == id }
    }

    private func move(_ id: UUID, by offset: Int) {
        guard let index = model.draft.embeds.firstIndex(where: { $0.id == id }) else { return }
        let target = index + offset
        guard model.draft.embeds.indices.contains(target) else { return }
        let embed = model.draft.embeds.remove(at: index)
        model.draft.embeds.insert(embed, at: target)
    }

    private func duplicate(_ id: UUID) {
        guard model.draft.embeds.count < ComposedMessageDraft.maxEmbeds,
              let index = model.draft.embeds.firstIndex(where: { $0.id == id }) else { return }
        model.draft.embeds.insert(model.draft.embeds[index].duplicated(), at: index + 1)
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// An embed in the editor's list: a swatch of its colour, its title and the start of its text.
private struct EmbedRowLabel: View {
    let embed: EmbedSpec
    let number: Int

    var body: some View {
        HStack(spacing: SyloSpacing.m) {
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(EmbedColorRow.swiftUIColor(embed.withDefaultColor().color))
                .frame(width: 6)
                .frame(minHeight: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: embed.title.isEmpty ? String(localized: "Embed \(number)") : embed.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.syloText)
                    .lineLimit(1)
                if !embed.description.isEmpty {
                    Text(verbatim: embed.description)
                        .font(.footnote)
                        .foregroundStyle(Color.syloMuted)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}
