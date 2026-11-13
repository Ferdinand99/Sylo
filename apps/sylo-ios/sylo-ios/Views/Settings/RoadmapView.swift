import SwiftUI
import SyloKit

/// What Sylo has planned, is working on and has shipped. Vote on what matters, or suggest
/// something new. Mirrors web-v2/src/pages/Roadmap.jsx.
struct RoadmapView: View {
    @State private var model: RoadmapModel
    @State private var isSuggesting = false

    init(session: AppSession) {
        _model = State(initialValue: RoadmapModel(session: session))
    }

    var body: some View {
        Group {
            if let board = model.board {
                content(board)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Roadmap", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Roadmap")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.board?.canParticipate == true {
                ToolbarItem(placement: .primaryAction) {
                    Button("Suggest a Feature", systemImage: "plus") { isSuggesting = true }
                }
            }
        }
        .task { if model.board == nil { await model.load() } }
        .sheet(isPresented: $isSuggesting) {
            SuggestionSheet(model: model)
        }
        .alert("Couldn't Do That", isPresented: isShowingActionError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .alert("Thanks", isPresented: $model.suggestionSent) {
            Button("OK") {}
        } message: {
            Text("Your suggestion is waiting for review.")
        }
    }

    private func content(_ board: RoadmapBoard) -> some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                Text("What's planned, in progress and shipped. Vote on what matters to you, or suggest something new.")
                    .font(.subheadline)
                if !board.canParticipate {
                    StatusMessage("Voting and suggesting need a login, and this Sylo has none set up.", kind: .notice)
                }
            }
            ForEach(RoadmapStatus.allCases) { status in
                Section {
                    let posts = board.groups[status] ?? []
                    if posts.isEmpty {
                        Text("Nothing here yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(posts) { post in
                            PostRow(
                                post: post, canVote: board.canParticipate, isVoting: model.isVoting(post.id)
                            ) {
                                _ = model.toggleVote(post.id)
                            }
                        }
                    }
                } header: {
                    Text(Self.title(status))
                }
            }
            if !board.pending.isEmpty {
                Section("Your suggestions awaiting review") {
                    ForEach(board.pending) { suggestion in
                        HStack {
                            Text(verbatim: suggestion.title)
                            Spacer(minLength: 8)
                            Text(verbatim: suggestion.ago)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .refreshable { await model.load() }
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil && !isSuggesting }, set: { if !$0 { model.actionError = nil } })
    }

    private static func title(_ status: RoadmapStatus) -> LocalizedStringKey {
        switch status {
        case .planned: "Planned"
        case .started: "In progress"
        case .completed: "Recently shipped"
        }
    }
}

/// A post, with its vote button.
private struct PostRow: View {
    let post: RoadmapPost
    let canVote: Bool
    let isVoting: Bool
    let vote: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: post.title)
                    .font(.headline)
                if !post.description.isEmpty {
                    Text(Self.markdown(post.description))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if canVote {
                Button(action: vote) {
                    VStack(spacing: 0) {
                        Image(systemName: post.hasVoted ? "arrow.up.circle.fill" : "arrow.up.circle")
                        Text(verbatim: DateText.count(post.votes))
                            .font(.footnote.weight(.semibold))
                            .monospacedDigit()
                    }
                    .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .disabled(isVoting)
                .accessibilityLabel(Text("Vote for \(post.title)"))
                .accessibilityValue(Text("^[\(post.votes) vote](inflect: true)"))
                .accessibilityAddTraits(post.hasVoted ? .isSelected : [])
            } else {
                VStack(spacing: 0) {
                    Text(verbatim: DateText.count(post.votes))
                        .font(.headline)
                        .monospacedDigit()
                    Text("^[\(post.votes) vote](inflect: true)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// The post's markdown as text; plain text when it does not parse.
    private static func markdown(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
    }
}

/// The form for a new suggestion.
private struct SuggestionSheet: View {
    let model: RoadmapModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var details = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                        .submitLabel(.next)
                } footer: {
                    Text("\(title.trimmingCharacters(in: .whitespacesAndNewlines).count) of 100 characters. At least 3.")
                }
                Section {
                    TextEditor(text: $details)
                        .frame(minHeight: 140)
                } header: {
                    Text("Description")
                } footer: {
                    Text(verbatim: "Markdown works: **bold**, _italic_, `code`, and [links](https://example.com).")
                }
                if let message = model.actionError {
                    Section { StatusMessage(message, kind: .error) }
                }
            }
            .navigationTitle("Suggest a Feature")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isSuggesting {
                        ProgressView()
                    } else {
                        Button("Submit") {
                            Task {
                                if await model.suggest(title: title, description: details) { dismiss() }
                            }
                        }
                        .disabled(RoadmapModel.suggestionProblem(title: title, description: details) != nil)
                    }
                }
            }
            .onAppear { model.actionError = nil }
        }
        .interactiveDismissDisabled(model.isSuggesting)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.Roadmap else { return nil }
        return RoadmapBoard(
            groups: [
                .planned: [RoadmapPost(id: 1, title: "Dark mode for the web", description: "A **dark** theme.", votes: 12)],
                .started: [RoadmapPost(id: 2, title: "Native app", description: "Everything, on iOS.", votes: 40, hasVoted: true)],
                .completed: [],
            ],
            pending: [RoadmapSuggestion(id: 9, title: "Shop themes", ago: "2d ago")])
    }
    NavigationStack {
        RoadmapView(session: session)
    }
    .environment(session)
}
