import SwiftUI
import SyloKit

/// One embed message: its name and channel, the text, up to ten embeds, link buttons and a live
/// preview. Save keeps a draft; Publish posts it to the channel as Sylo (and, once posted, updates
/// the posted message in place). Mirrors web-v2/src/pages/MessageBuilder.jsx.
struct MessageBuilderView: View {
    @State private var model: ComposedMessageBuilderModel
    @State private var isConfirmingDiscard = false
    @State private var pendingMove: PendingMove?

    /// What was asked when a posted message is about to change channel.
    private enum PendingMove {
        case save, publish
    }

    init(server: ServerID, id: ComposedMessageID, session: AppSession) {
        _model = State(initialValue: ComposedMessageBuilderModel(server: server, id: id, session: session))
    }

    var body: some View {
        Group {
            if model.hasLoaded {
                form
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Message", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Embed Message")
        .navigationBarTitleDisplayMode(.inline)
        // Like the module settings: no way back while there are unsaved changes, so none are lost.
        .navigationBarBackButtonHidden(model.hasChanges)
        .toolbar {
            if model.hasChanges {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { isConfirmingDiscard = true }
                        .disabled(model.isSaving)
                }
            }
            if model.hasLoaded {
                ToolbarItem(placement: .confirmationAction) {
                    if model.isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { save() }
                            .toolbarSaveStyle()
                            .disabled(!model.hasChanges)
                    }
                }
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { model.discardChanges() }
        } message: {
            Text("Everything you changed since the last save is lost.")
        }
        .confirmationDialog(
            "Move the posted message?", isPresented: isConfirmingMove, titleVisibility: .visible,
            presenting: pendingMove
        ) { action in
            Button(action == .publish ? "Move and Publish" : "Move and Save", role: .destructive) {
                Task {
                    switch action {
                    case .save: await model.saveDraft(confirmedMove: true)
                    case .publish: await model.publish(confirmedMove: true)
                    }
                }
            }
        } message: { action in
            Text(moveMessage(for: action))
        }
        .alert(
            alertTitle,
            isPresented: isShowingActionError, presenting: model.actionError
        ) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.successCount)
        .task {
            if !model.hasLoaded { await model.load() }
        }
    }

    // MARK: - The form

    @ViewBuilder
    private var form: some View {
        @Bindable var model = model
        Form {
            Section("Name") {
                LimitedTextField(
                    title: "Untitled embed", text: $model.name, limit: ComposedMessageBuilderModel.maxNameLength)
            }

            Section {
                ChannelPicker(title: "Channel", selection: $model.channelId, channels: model.channels,
                              noneTitle: "Choose a channel")
                Button {
                    publish()
                } label: {
                    Label(publishTitle, systemImage: "paperplane")
                }
                .disabled(!model.canPublish)
            } footer: {
                publishFooter
            }

            Section {
                LimitedTextField(title: "Message text", text: $model.spec.content,
                         limit: ComposedMessageSpec.maxContentLength, lines: 2...8)
            } header: {
                Text("Message Text")
            } footer: {
                Text("To ping a role, write <@&ROLE_ID> in the message text. Mentions inside an embed don't notify anyone.")
            }

            Section("Preview") {
                MessagePreviewCard(content: model.spec.content, embeds: model.spec.embeds, links: model.spec.links)
            }

            EmbedElementSections(items: $model.spec.embeds, limit: ComposedMessageSpec.maxEmbeds) { item in
                EmbedEditorView(draft: item.draft, options: EmbedItem.options)
            }
            Section {
                if model.spec.canAddEmbed {
                    Button("Add Embed", systemImage: "plus") {
                        model.spec.embeds.append(EmbedItem())
                    }
                }
            } footer: {
                Text("Up to \(ComposedMessageSpec.maxEmbeds) embeds.")
            }

            LinkButtonSections(model: model)
        }
        .disabled(model.isSaving)
    }

    @ViewBuilder
    private var publishFooter: some View {
        if let notice = model.notice {
            switch notice {
            case .saved: Text("Draft saved.")
            case .published: Text("Published to the channel.")
            case .updated: Text("Published message updated.")
            }
        } else if model.isPublished {
            Text("Published in #\(channelName(model.channelMove?.from ?? model.channelId)). Update Published Message edits the posted message. If you pick another channel, publishing moves the posted message there, after you confirm.")
        } else {
            Text("Save keeps a draft. Publish posts the message to the channel as Sylo.")
        }
    }

    // MARK: - Moving a posted message to another channel

    private func save() {
        if model.channelMove != nil {
            pendingMove = .save
        } else {
            Task { await model.saveDraft() }
        }
    }

    private func publish() {
        if model.channelMove != nil {
            pendingMove = .publish
        } else {
            Task { await model.publish() }
        }
    }

    private var publishTitle: LocalizedStringKey {
        if model.channelMove != nil { return "Move to the New Channel and Publish" }
        return model.isPublished ? "Update Published Message" : "Publish to Channel"
    }

    private func channelName(_ id: String) -> String {
        model.channels.first { $0.id == id }?.name ?? String(localized: "deleted channel")
    }

    private func moveMessage(for action: PendingMove) -> LocalizedStringKey {
        let move = model.channelMove
        let from = channelName(move?.from ?? "")
        let to = channelName(move?.to ?? "")
        switch action {
        case .publish:
            if model.serverMovesMessages {
                return "The message is posted in #\(to) first, then the old post in #\(from) is deleted. If posting fails, the old post stays."
            }
            return "The posted message is deleted from #\(from) and posted again in #\(to). If posting fails, it stays deleted and your message is kept as a draft."
        case .save:
            return "The posted message is deleted from #\(from). Your changes are saved as a draft for #\(to); publish it to post it there."
        }
    }

    private var isConfirmingMove: Binding<Bool> {
        Binding(get: { pendingMove != nil }, set: { if !$0 { pendingMove = nil } })
    }

    private var alertTitle: LocalizedStringKey {
        switch model.failedAction {
        case .publish: "Couldn't Publish"
        case .move: "Couldn't Move Message"
        default: "Couldn't Save"
        }
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// The link buttons of a message, one section each, and the control to add one.
private struct LinkButtonSections: View {
    @Bindable var model: ComposedMessageBuilderModel

    var body: some View {
        ForEach($model.spec.links) { $link in
            Section("Link Button") {
                LimitedTextField(title: "Label", text: $link.label, limit: ComposedLinkButton.maxLabelLength)
                LimitedTextField(title: "Emoji", text: $link.emoji, limit: ComposedLinkButton.maxEmojiLength)
                LinkTextField(title: "Link", text: $link.url)
                Button("Remove Button", role: .destructive) {
                    model.spec.links.removeAll { $0.id == link.id }
                }
            }
        }
        Section {
            if model.spec.canAddLink {
                Button("Add Link Button", systemImage: "plus") {
                    model.spec.links.append(ComposedLinkButton())
                }
            }
        } header: {
            Text("Link Buttons")
        } footer: {
            if model.spec.linkRowHasNoRoom {
                Text("This message already has five rows of buttons or menus from other places, so there is no room for link buttons.")
            } else if model.spec.hasKeptRows {
                Text("Optional, up to \(ComposedMessageSpec.maxLinks). Role buttons and menus made elsewhere stay as they are.")
            } else {
                Text("Optional, up to \(ComposedMessageSpec.maxLinks). A button needs a link and a label or an emoji.")
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadComposedMessage else { return nil }
        return ComposedMessageDetail(
            message: ComposedMessage(
                id: 1, name: "Server rules", channelId: "c1", messageId: "m1",
                spec: ComposedMessageSpec(
                    content: "Read the **rules**.",
                    embeds: [EmbedItem(EmbedDraft(color: "#ed4245", title: "Rules", description: "Be kind."))],
                    links: [ComposedLinkButton(label: "Website", url: "https://example.com")])),
            channels: [ChannelOption(id: "c1", name: "rules")])
    }
    NavigationStack {
        MessageBuilderView(server: "1", id: .saved(1), session: session)
    }
    .environment(session)
}
