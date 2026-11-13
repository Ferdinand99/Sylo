import SwiftUI
import SyloKit

/// The roadmap admin for the operators of a Sylo server: review what people suggested, post something
/// yourself, move a post to another stage, edit or delete it. Members vote on the same board in the
/// Roadmap screen. Mirrors web-v2/src/pages/RoadmapAdmin.jsx.
struct RoadmapAdminView: View {
    @State private var model: RoadmapAdminModel
    @State private var isPosting = false
    @State private var editing: RoadmapAdminPost?
    @State private var rejecting: RoadmapAdminPost?
    @State private var deleting: RoadmapAdminPost?

    init(session: AppSession) {
        _model = State(initialValue: RoadmapAdminModel(session: session))
    }

    var body: some View {
        Group {
            if model.isRefused {
                OperatorRefusedView()
            } else if let board = model.board {
                content(board)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load the Roadmap Admin", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Roadmap Admin")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.board != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button("New Post", systemImage: "plus") { isPosting = true }
                }
            }
        }
        .task { if model.board == nil { await model.load() } }
        .sheet(isPresented: $isPosting) {
            RoadmapPostSheet(
                heading: "New Post", saveTitle: "Post as Planned", title: "", description: "",
                footer: "New posts start as Planned. Change the stage in the list afterwards.", model: model
            ) { title, description in
                await model.create(title: title, description: description)
            }
        }
        .sheet(item: $editing) { post in
            RoadmapPostSheet(
                heading: "Edit Post", saveTitle: "Save", title: post.title, description: post.description,
                footer: nil, model: model
            ) { title, description in
                await model.edit(post.id, title: title, description: description)
            }
        }
        .confirmationDialog(
            "Reject this suggestion?", isPresented: isShowing($rejecting), titleVisibility: .visible,
            presenting: rejecting
        ) { post in
            Button("Reject and Delete", role: .destructive) { Task { await model.reject(post.id) } }
        } message: { post in
            Text(verbatim: "\(post.title) is deleted and never shows on the board.")
        }
        .confirmationDialog(
            "Delete this post?", isPresented: isShowing($deleting), titleVisibility: .visible, presenting: deleting
        ) { post in
            Button("Delete Post", role: .destructive) { Task { await model.delete(post.id) } }
        } message: { post in
            Text(verbatim: "\(post.title) is removed from the public board for good.")
        }
        .alert("Couldn't Do That", isPresented: isShowingError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    private func content(_ board: RoadmapAdminBoard) -> some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                Text("Review suggestions, manage stages, or post something yourself. Members see the board in the Roadmap screen.")
                    .font(.subheadline)
            }
            Section {
                if board.pending.isEmpty {
                    Text("Nothing waiting on review.")
                        .foregroundStyle(.secondary)
                }
                ForEach(board.pending) { post in
                    PendingRow(post: post, isBusy: model.busy.contains(post.id)) {
                        Task { await model.approve(post.id) }
                    } reject: {
                        rejecting = post
                    }
                }
            } header: {
                Text("Pending suggestions (\(board.pending.count))")
            }
            Section {
                if board.posts.isEmpty {
                    Text("Nothing posted yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(board.posts) { post in
                    PublicRow(
                        post: post, statuses: board.statuses, isBusy: model.busy.contains(post.id),
                        setStatus: { status in Task { await model.setStatus(post.id, to: status) } },
                        edit: { editing = post }, delete: { deleting = post })
                }
            } header: {
                Text("Public posts (\(board.posts.count))")
            }
        }
        .refreshable { await model.load() }
    }

    private func isShowing(_ post: Binding<RoadmapAdminPost?>) -> Binding<Bool> {
        Binding(get: { post.wrappedValue != nil }, set: { if !$0 { post.wrappedValue = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.actionError != nil && !isPosting && editing == nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// Markdown as the author wrote it, shown formatted; text that is not valid Markdown is shown as it is.
private func markdown(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
}

private struct PendingRow: View {
    let post: RoadmapAdminPost
    let isBusy: Bool
    let approve: () -> Void
    let reject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: post.title)
                .font(.headline)
            if !post.description.isEmpty {
                Text(markdown(post.description))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if !post.ago.isEmpty {
                Text(verbatim: post.ago)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button("Approve", action: approve)
                    .buttonStyle(.borderedProminent)
                Button("Reject", role: .destructive, action: reject)
                    .buttonStyle(.bordered)
                if isBusy {
                    ProgressView()
                }
            }
            .disabled(isBusy)
        }
        .padding(.vertical, 4)
    }
}

private struct PublicRow: View {
    let post: RoadmapAdminPost
    let statuses: [String]
    let isBusy: Bool
    let setStatus: (String) -> Void
    let edit: () -> Void
    let delete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: post.title)
                    .font(.headline)
                Spacer(minLength: 8)
                if isBusy {
                    ProgressView()
                } else {
                    Menu {
                        Button("Edit", systemImage: "pencil", action: edit)
                        Button("Delete", systemImage: "trash", role: .destructive, action: delete)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel(Text("Actions for \(post.title)"))
                }
            }
            if !post.description.isEmpty {
                Text(markdown(post.description))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text("^[\(post.votes) vote](inflect: true) \u{00B7} posted \(post.ago)")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Picker("Stage", selection: Binding(get: { post.status }, set: { setStatus($0) })) {
                ForEach(stages, id: \.self) { status in
                    Text(verbatim: RoadmapAdminBoard.label(for: status)).tag(status)
                }
            }
            .disabled(isBusy)
        }
        .padding(.vertical, 4)
        .contextMenu {
            Button("Edit", systemImage: "pencil", action: edit)
            Button("Delete", systemImage: "trash", role: .destructive, action: delete)
        }
    }

    /// The stages the server offers, with the post's own added when the list does not have it.
    private var stages: [String] {
        statuses.contains(post.status) || post.status.isEmpty ? statuses : statuses + [post.status]
    }
}

/// A post to write or to edit: a title and a Markdown description.
private struct RoadmapPostSheet: View {
    let heading: LocalizedStringKey
    let saveTitle: LocalizedStringKey
    let footer: LocalizedStringKey?
    let model: RoadmapAdminModel
    let save: (String, String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var details: String
    @State private var isSaving = false

    init(
        heading: LocalizedStringKey, saveTitle: LocalizedStringKey, title: String, description: String,
        footer: LocalizedStringKey?, model: RoadmapAdminModel, save: @escaping (String, String) async -> Bool
    ) {
        self.heading = heading
        self.saveTitle = saveTitle
        self.footer = footer
        self.model = model
        self.save = save
        _title = State(initialValue: title)
        _details = State(initialValue: description)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LimitedTextField(
                        title: "Title", text: $title, limit: RoadmapAdminModel.titleLimit,
                        prompt: Text("What it is, in a few words"), showsCounter: true)
                } footer: {
                    Text("3 to 100 characters.")
                }
                Section {
                    LimitedTextField(
                        title: "Description", text: $details, limit: RoadmapAdminModel.descriptionLimit,
                        prompt: Text("What will change, and why it helps"), lines: 5...12)
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: "Markdown works: **bold**, _italic_, `code`, [links](https://example.com) and - bullet lists.")
                        if let footer { Text(footer) }
                    }
                }
                if let message = model.actionError {
                    Section { StatusMessage(message, kind: .error) }
                }
            }
            .navigationTitle(heading)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button(saveTitle) {
                            Task {
                                isSaving = true
                                let saved = await save(title, details)
                                isSaving = false
                                if saved { dismiss() }
                            }
                        }
                        .disabled(RoadmapAdminModel.problem(title: title, description: details) != nil)
                    }
                }
            }
            .onAppear { model.actionError = nil }
        }
        .interactiveDismissDisabled(isSaving)
    }
}
