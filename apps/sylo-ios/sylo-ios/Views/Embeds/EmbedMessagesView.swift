import SwiftUI
import SyloKit

/// An embed message editor to push from the list: a saved message, or nil for a new one.
///
/// `nonisolated` so SwiftUI can hash and compare it as a navigation value on any thread; a
/// main-actor `Hashable` conformance (this app's default) would trap off the main thread.
nonisolated struct EmbedMessageRoute: Hashable {
    let id: Int?
}

/// Embed messages: the messages built here and posted to a channel as Sylo, each a draft or
/// published. Mirrors web-v2/src/pages/Messages.jsx; opens from the "Embed messages" card.
struct EmbedMessagesView: View {
    let server: ServerID
    let session: AppSession

    @State private var model: ComposedMessagesModel
    @State private var pendingUnpublish: ComposedMessageSummary?
    @State private var pendingDelete: ComposedMessageSummary?

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        _model = State(initialValue: ComposedMessagesModel(server: server, session: session))
    }

    var body: some View {
        Group {
            if let items = model.items {
                Form {
                    Group {
                        Section {
                            NavigationLink(value: EmbedMessageRoute(id: nil)) {
                                Label("New Embed Message", systemImage: "plus")
                            }
                            .disabled(items.count >= ComposedMessagesModel.limit)
                        } footer: {
                            Text("Build a message with a live preview, then publish it to a channel as Sylo. Publish again to edit the posted message in place.")
                        }

                        Section {
                            if items.isEmpty {
                                Text("None yet. Create one to post an embed to a channel.")
                                    .foregroundStyle(Color.syloMuted)
                            }
                            ForEach(items) { item in
                                NavigationLink(value: EmbedMessageRoute(id: item.id)) {
                                    EmbedMessageRow(item: item, isBusy: model.busy.contains(item.id))
                                }
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button("Delete", systemImage: "trash", role: .destructive) {
                                        pendingDelete = item
                                    }
                                    if item.isPublished {
                                        Button("Unpublish", systemImage: "eye.slash") {
                                            pendingUnpublish = item
                                        }
                                        .tint(Color.syloWarn)
                                    }
                                }
                                .contextMenu {
                                    if item.isPublished {
                                        Button("Unpublish", systemImage: "eye.slash") { pendingUnpublish = item }
                                    }
                                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = item }
                                }
                                .accessibilityAction(named: Text("Delete")) { pendingDelete = item }
                                .accessibilityActions {
                                    if item.isPublished {
                                        Button("Unpublish") { pendingUnpublish = item }
                                    }
                                }
                            }
                        } header: {
                            Text("Your embed messages (\(items.count) / \(ComposedMessagesModel.limit))")
                        }
                    }
                    .syloSectionCards()
                }
                .syloFormStyle()
                .refreshable { await model.load() }
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Messages", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") {
                        Task { await model.load() }
                    }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Embed Messages")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Unpublish this message?", isPresented: isConfirmingUnpublish, titleVisibility: .visible,
            presenting: pendingUnpublish
        ) { item in
            Button("Unpublish", role: .destructive) { Task { await model.unpublish(item.id) } }
        } message: { _ in
            Text("The posted message is deleted from the channel. The draft stays here, so you can publish it again.")
        }
        .confirmationDialog(
            "Delete this embed message?", isPresented: isConfirmingDelete, titleVisibility: .visible,
            presenting: pendingDelete
        ) { item in
            Button("Delete", role: .destructive) { Task { await model.delete(item.id) } }
        } message: { _ in
            Text("The draft is deleted, and so is the posted message if it is published. This can't be undone.")
        }
        .alert("Couldn't Complete", isPresented: isShowingActionError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: model.changeCount)
        .task { await model.load() }
    }

    private var isConfirmingUnpublish: Binding<Bool> {
        Binding(get: { pendingUnpublish != nil }, set: { if !$0 { pendingUnpublish = nil } })
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// One message in the list: its name, whether it is posted, and where and when.
private struct EmbedMessageRow: View {
    let item: ComposedMessageSummary
    let isBusy: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: SyloSpacing.s) {
                Text(verbatim: item.name)
                    .font(.headline)
                    .foregroundStyle(Color.syloText)
                Spacer(minLength: SyloSpacing.xs)
                if isBusy {
                    ProgressView()
                } else {
                    SyloPill(item.isPublished ? "Published" : "Draft", tint: item.isPublished ? .syloBrand : .syloMuted)
                }
            }
            Text(verbatim: "#\(item.channel) · \(String(localized: "edited")) \(item.edited)")
                .font(.footnote)
                .foregroundStyle(Color.syloMuted)
        }
        .accessibilityElement(children: .combine)
    }
}
