import SwiftUI
import SyloKit

/// Embed messages: the drafts the dashboard keeps for posting rich messages as Sylo. Open one to
/// edit it, post it or update the posted message; a swipe unpublishes or deletes. Mirrors
/// web-v2/src/pages/Messages.jsx.
struct MessagesView: View {
    let server: ServerID
    let session: AppSession

    @State private var model: ComposedMessagesModel
    @State private var toUnpublish: ComposedMessageSummary?
    @State private var toDelete: ComposedMessageSummary?

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: ComposedMessagesModel(server: server, session: session))
    }

    var body: some View {
        content
            .navigationTitle("Embed Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink {
                        MessageBuilderView(server: server, id: .new, session: session)
                    } label: {
                        Label("New Message", systemImage: "plus")
                    }
                    .disabled(!model.hasLoaded || model.isFull)
                }
            }
            // Runs again when a message is closed and the list is back: it may have changed.
            .task { await model.load() }
            .confirmationDialog(
                "Unpublish this message?", isPresented: isUnpublishing, titleVisibility: .visible,
                presenting: toUnpublish
            ) { item in
                Button("Unpublish") { Task { await model.unpublish(item.id) } }
            } message: { _ in
                Text("The posted message is deleted from the channel. The draft stays here, so you can publish it again.")
            }
            .confirmationDialog(
                "Delete this embed message?", isPresented: isDeleting, titleVisibility: .visible,
                presenting: toDelete
            ) { item in
                Button("Delete", role: .destructive) { Task { await model.delete(item.id) } }
            } message: { _ in
                Text("The draft is deleted, and so is the posted message if it's published. This can't be undone.")
            }
            .alert("Couldn't Change Message", isPresented: isShowingActionError, presenting: model.actionError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
            .sensoryFeedback(.success, trigger: model.successCount)
    }

    @ViewBuilder
    private var content: some View {
        if model.hasLoaded {
            List {
                if let message = model.errorMessage {
                    Section {
                        StatusMessage(message, kind: .error)
                    }
                }
                ModuleIntro("Build rich embed messages, then publish them to a channel as Sylo. Publish again to edit the posted message in place.")
                Section {
                    ForEach(model.items) { item in
                        NavigationLink {
                            MessageBuilderView(server: server, id: .saved(item.id), session: session)
                        } label: {
                            MessageRow(item: item)
                        }
                        .disabled(model.busy.contains(item.id))
                        .swipeActions(edge: .trailing) {
                            Button("Delete", systemImage: "trash", role: .destructive) { toDelete = item }
                            if item.published {
                                Button("Unpublish", systemImage: "eye.slash") { toUnpublish = item }
                                    .tint(.orange)
                            }
                        }
                        .contextMenu {
                            if item.published {
                                Button("Unpublish", systemImage: "eye.slash") { toUnpublish = item }
                            }
                            Button("Delete", systemImage: "trash", role: .destructive) { toDelete = item }
                        }
                    }
                } header: {
                    Text("Your Embed Messages (\(model.items.count) of \(ComposedMessagesModel.maxMessages))")
                } footer: {
                    if model.items.isEmpty {
                        Text("None yet. Create one to post an embed to a channel.")
                    }
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load Messages", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    private var isUnpublishing: Binding<Bool> {
        Binding(get: { toUnpublish != nil }, set: { if !$0 { toUnpublish = nil } })
    }

    private var isDeleting: Binding<Bool> {
        Binding(get: { toDelete != nil }, set: { if !$0 { toDelete = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// Name and a Published or Draft tag over the channel and when it was last edited.
private struct MessageRow: View {
    let item: ComposedMessageSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: item.name)
                    .lineLimit(2)
                if item.published {
                    StatusTag("Published", tint: .green)
                } else {
                    StatusTag("Draft")
                }
            }
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    /// "#rules, edited 5m ago".
    private var details: String {
        var parts: [String] = []
        if !item.channel.isEmpty { parts.append("#\(item.channel)") }
        if !item.when.isEmpty { parts.append(String(localized: "edited \(item.when)")) }
        return parts.joined(separator: " \u{00B7} ")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.ListComposedMessages else { return nil }
        return ComposedMessageList(items: [
            ComposedMessageSummary(id: 1, name: "Server rules", channel: "rules", published: true, when: "5m ago"),
            ComposedMessageSummary(id: 2, name: "Giveaway", channel: "announcements", published: false, when: "2d ago"),
        ])
    }
    NavigationStack {
        MessagesView(server: "1", session: session)
    }
    .environment(session)
}
