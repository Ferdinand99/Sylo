import SwiftUI
import SyloKit

// The bot-wide pages of the web dashboard, in the Settings sheet: the command list, the roadmap
// (and its admin for the operators), the Bot Personalizer and the stats cache.

// MARK: - Command list

/// Every slash command Sylo has, with a search. Mirrors web-v2/src/pages/CommandList.jsx.
struct CommandListView: View {
    @State private var model: QueryListModel<CommandListPage>
    @State private var query = ""

    init(session: AppSession) {
        _model = State(initialValue: QueryListModel(session: session))
    }

    var body: some View {
        Group {
            if let page = model.value {
                let shown = page.commands(matching: query)
                List {
                    Group {
                        Section {
                            ForEach(shown) { command in
                                CommandReferenceRow(command: command)
                            }
                        } header: {
                            Text("Commands (\(shown.count))")
                        } footer: {
                            Text("Type them in any server Sylo is in. Search by name or by what they do.")
                        }
                    }
                    .syloSectionCards()
                }
                .syloScreen()
                .overlay {
                    if shown.isEmpty {
                        EmptyState(
                            "No Commands Match", systemImage: "magnifyingglass",
                            message: Text("Nothing matches \u{201C}\(query)\u{201D}."))
                            .allowsHitTesting(false)
                    }
                }
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Commands", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") { Task { await reload() } }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Command List")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search commands")
        .refreshable { await reload() }
        .task { if model.value == nil { await reload() } }
    }

    private func reload() async {
        await model.load(Endpoints.CommandList()) { $0 }
    }
}

private struct CommandReferenceRow: View {
    let command: CommandReference

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.xs) {
            Text(verbatim: command.signature)
                .font(.syloNumber(.subheadline, weight: .semibold))
                .foregroundStyle(Color.syloText)
            if !command.description.isEmpty {
                Text(verbatim: command.description).font(.subheadline)
            }
            if let permissions = command.permissions {
                Text("Requires: \(permissions.joined(separator: ", "))")
                    .font(.footnote)
                    .foregroundStyle(Color.syloMuted)
            }
            ForEach(command.options, id: \.name) { option in
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: option.name + " \u{00B7} " + (option.isRequired ? String(localized: "required") : String(localized: "optional")))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.syloBrand)
                    Text(verbatim: option.description + (option.choices.isEmpty ? "" : " " + String(localized: "Choices: \(option.choices.joined(separator: ", "))")))
                        .font(.footnote)
                        .foregroundStyle(Color.syloMuted)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Stats cache

/// The game stats lookups cached for the whole Sylo (operators only). Mirrors web-v2/src/pages/Stats.jsx.
struct StatsCacheView: View {
    @State private var model: QueryListModel<StatsPage>

    init(session: AppSession) {
        _model = State(initialValue: QueryListModel(session: session))
    }

    var body: some View {
        Group {
            if let page = model.value {
                List {
                    Group {
                        Section {
                            if page.rows.isEmpty {
                                Text("Nothing cached yet. Run /stats in a server.").foregroundStyle(Color.syloMuted)
                            }
                            ForEach(page.rows) { row in
                                HStack(alignment: .firstTextBaseline) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(verbatim: "\(row.title) \u{2014} \(row.username)").font(.headline)
                                        Text(verbatim: ([row.platform, row.facts].filter { !$0.isEmpty }).joined(separator: " \u{00B7} "))
                                            .font(.footnote)
                                            .foregroundStyle(Color.syloMuted)
                                    }
                                    Spacer(minLength: SyloSpacing.xs)
                                    SyloPill(row.isFresh ? "Fresh" : "Stale", tint: row.isFresh ? .syloBrand : .syloMuted)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        } footer: {
                            Text("Lookups made with /stats, from every server. Results are cached for \(page.ttlMinutes) minutes; stale rows are refreshed on the next lookup.")
                        }
                    }
                    .syloSectionCards()
                }
                .syloScreen()
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Stats", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") { Task { await reload() } }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Stats Cache")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { if model.value == nil { await reload() } }
    }

    private func reload() async {
        await model.load(Endpoints.Stats()) { $0 }
    }
}

// MARK: - Bot Personalizer

/// The bot's name and pictures, its status, and the announcement everyone sees. Operators only. Mirrors
/// web-v2/src/pages/Personalizer.jsx.
struct PersonalizerView: View {
    @State private var model: PersonalizerModel
    @State private var isConfirmingClear = false

    init(session: AppSession) {
        _model = State(initialValue: PersonalizerModel(session: session))
    }

    var body: some View {
        Group {
            if model.presencePage != nil {
                form
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load the Personalizer", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") { Task { await model.load() } }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Bot Personalizer")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: model.successCount)
        .alert("Done", isPresented: isShowingNotice, presenting: model.notice) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .alert("Couldn't Save", isPresented: isShowingError, presenting: model.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .task { if model.presencePage == nil { await model.load() } }
    }

    private var form: some View {
        Form {
            Group {
                if let bot = model.bot {
                    Section {
                        HStack(spacing: SyloSpacing.m) {
                            AsyncImage(url: bot.avatarURL) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                Image(systemName: "person.crop.circle.fill").resizable().foregroundStyle(Color.syloMuted)
                            }
                            .frame(width: 48, height: 48)
                            .clipShape(Circle())
                            .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: bot.username).font(.headline)
                                Text(verbatim: bot.tag).font(.footnote).foregroundStyle(Color.syloMuted)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    } header: {
                        Text("The bot now")
                    }
                } else {
                    Section {
                        Label("The bot is not connected yet. Try again in a moment.", systemImage: "info.circle")
                            .font(.subheadline)
                            .foregroundStyle(Color.syloMuted)
                    }
                }

                identitySection
                presenceSection
                announcementSection
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .scrollDismissesKeyboard(.interactively)
        .disabled(model.isWorking)
        .refreshable { await model.load() }
        .confirmationDialog("Clear the announcement?", isPresented: $isConfirmingClear, titleVisibility: .visible) {
            Button("Clear Announcement", role: .destructive) { Task { await model.clearAnnouncement() } }
        } message: {
            Text("It disappears from the dashboard for everyone straight away.")
        }
    }

    private var identitySection: some View {
        Section {
            TextField("New name (2 to 32 characters)", text: $model.identity.username)
            TextField("Picture link (https)", text: $model.identity.avatarUrl)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            TextField("Banner link (https)", text: $model.identity.bannerUrl)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            Toggle("Reset the picture to the default", isOn: $model.identity.resetAvatar)
            Button("Save Name and Pictures", systemImage: "person.crop.circle.badge.checkmark") {
                Task { await model.saveIdentity() }
            }
            .disabled(model.identity.isEmpty)
        } header: {
            Text("Name and pictures")
        } footer: {
            Text("Leave a field empty to keep it. Discord limits name changes to about two an hour.")
        }
    }

    private var presenceSection: some View {
        Section {
            Picker("Status", selection: $model.presence.status) {
                ForEach(model.presencePage?.statuses ?? [], id: \.self) { status in
                    Text(verbatim: status.capitalized).tag(status)
                }
            }
            Picker("Activity", selection: $model.presence.type) {
                ForEach(model.presencePage?.types ?? [], id: \.self) { type in
                    Text(verbatim: type).tag(type)
                }
            }
            TextField("Activity text", text: $model.presence.text)
                .onChange(of: model.presence.text) {
                    if model.presence.text.count > PresenceConfig.maxTextLength {
                        model.presence.text = String(model.presence.text.prefix(PresenceConfig.maxTextLength))
                    }
                }
            Button("Save Status", systemImage: "circle.dotted") { Task { await model.savePresence() } }
                .disabled(!model.presenceHasChanges)
        } header: {
            Text("Status")
        } footer: {
            Text("What shows under the bot's name: for example Listening to /stats battlefield.")
        }
    }

    private var announcementSection: some View {
        Section {
            Picker("Severity", selection: $model.announcement.severity) {
                ForEach(model.presencePage?.severities ?? [], id: \.self) { severity in
                    Text(verbatim: severity.capitalized).tag(severity)
                }
            }
            TextField("Title", text: $model.announcement.title)
                .onChange(of: model.announcement.title) {
                    if model.announcement.title.count > AnnouncementDraft.maxTitleLength {
                        model.announcement.title = String(model.announcement.title.prefix(AnnouncementDraft.maxTitleLength))
                    }
                }
            TextField("Details (optional)", text: $model.announcement.body, axis: .vertical)
                .lineLimit(2...8)
                .onChange(of: model.announcement.body) {
                    if model.announcement.body.count > AnnouncementDraft.maxBodyLength {
                        model.announcement.body = String(model.announcement.body.prefix(AnnouncementDraft.maxBodyLength))
                    }
                }
            Button(model.hasAnnouncement ? "Update the Announcement" : "Publish the Announcement", systemImage: "megaphone") {
                Task { await model.saveAnnouncement() }
            }
            .disabled(!model.announcementHasChanges)
            if model.hasAnnouncement {
                Button("Clear the Announcement", systemImage: "xmark.circle", role: .destructive) { isConfirmingClear = true }
            }
        } header: {
            Text("Announcement")
        } footer: {
            Text("One notice for everyone who is signed in, for example an incident. A blank title clears it. A critical notice can't be dismissed.")
        }
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

// MARK: - Roadmap

/// The roadmap: what is planned, started and done; vote for an idea or suggest one. Mirrors
/// web-v2/src/pages/Roadmap.jsx.
struct RoadmapView: View {
    @Environment(AppSession.self) private var session
    @State private var model: QueryListModel<RoadmapBoard>
    @State private var runner: ActionRunner
    @State private var isSuggesting = false
    @State private var notice: String?

    init(session: AppSession) {
        _model = State(initialValue: QueryListModel(session: session))
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        Group {
            if let board = model.value {
                List {
                    Group {
                        Section {
                            Button("Suggest an Idea", systemImage: "lightbulb") { isSuggesting = true }
                            if board.isOwner {
                                NavigationLink {
                                    RoadmapAdminView(session: session)
                                } label: {
                                    Label("Manage the Board", systemImage: "slider.horizontal.3")
                                }
                            }
                        }
                        if !board.mine.isEmpty {
                            Section {
                                ForEach(board.mine) { post in RoadmapPostRow(post: post, vote: nil) }
                            } header: {
                                Text("Your suggestions")
                            } footer: {
                                Text("Waiting for the Sylo team to review them.")
                            }
                        }
                        group("In progress", board.started, board)
                        group("Planned", board.planned, board)
                        group("Done", board.completed, board)
                    }
                    .syloSectionCards()
                }
                .syloScreen()
                .overlay {
                    if board.isEmpty, board.mine.isEmpty {
                        EmptyState("Nothing Here Yet", systemImage: "map", message: Text("Ideas and plans show up here."))
                            .allowsHitTesting(false)
                    }
                }
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load the Roadmap", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") { Task { await reload() } }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Roadmap")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { if model.value == nil { await reload() } }
        .sensoryFeedback(.selection, trigger: runner.successCount)
        .sheet(isPresented: $isSuggesting) {
            RoadmapTextEditor(
                title: "Suggest an Idea", initialTitle: "", initialDescription: "", saveTitle: "Send",
                save: { title, description in
                    guard await runner.run(Endpoints.SuggestRoadmapPost(title: title, description: description), changesModules: false) != nil
                    else { return false }
                    notice = String(localized: "Thanks. The Sylo team will review it.")
                    await reload()
                    return true
                }, failure: { runner.errorMessage })
        }
        .alert("Done", isPresented: isShowingNotice, presenting: notice) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .alert("Couldn't Complete", isPresented: isShowingError, presenting: runner.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    @ViewBuilder
    private func group(_ title: LocalizedStringKey, _ posts: [RoadmapPost], _ board: RoadmapBoard) -> some View {
        if !posts.isEmpty {
            Section(title) {
                ForEach(posts) { post in
                    RoadmapPostRow(post: post) {
                        Task {
                            if await runner.run(Endpoints.VoteRoadmapPost(id: post.id), changesModules: false) != nil {
                                await reload()
                            }
                        }
                    }
                }
            }
        }
    }

    private func reload() async {
        await model.load(Endpoints.Roadmap()) { $0 }
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { runner.errorMessage != nil && !isSuggesting }, set: { if !$0 { runner.errorMessage = nil } })
    }
}

private struct RoadmapPostRow: View {
    let post: RoadmapPost
    let vote: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: SyloSpacing.m) {
            VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                Text(verbatim: post.title).font(.headline)
                Text(RoadmapPostRow.markdown(post.description))
                    .font(.subheadline)
                    .foregroundStyle(Color.syloMuted)
            }
            Spacer(minLength: SyloSpacing.xs)
            if let vote {
                Button(action: vote) {
                    VStack(spacing: 2) {
                        Image(systemName: post.hasVoted ? "hand.thumbsup.fill" : "hand.thumbsup")
                        Text(verbatim: "\(post.votes)").font(.syloNumber(.footnote, weight: .semibold))
                    }
                    .foregroundStyle(post.hasVoted ? Color.syloBrand : Color.syloMuted)
                    .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(post.hasVoted ? Text("Remove your vote") : Text("Vote"))
                .accessibilityValue(Text("\(post.votes) votes"))
            }
        }
    }

    /// The description's markdown as styled text; plain text when it is not valid markdown.
    static func markdown(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
    }
}

/// A title and a description in a sheet (a suggestion, a new post, an edit).
private struct RoadmapTextEditor: View {
    let title: LocalizedStringKey
    let saveTitle: LocalizedStringKey
    let save: (String, String) async -> Bool
    let failure: () -> String?

    @State private var postTitle: String
    @State private var description: String
    private let initial: (String, String)

    init(
        title: LocalizedStringKey, initialTitle: String, initialDescription: String, saveTitle: LocalizedStringKey = "Save",
        save: @escaping (String, String) async -> Bool, failure: @escaping () -> String?
    ) {
        self.title = title
        self.saveTitle = saveTitle
        self.save = save
        self.failure = failure
        initial = (initialTitle, initialDescription)
        _postTitle = State(initialValue: initialTitle)
        _description = State(initialValue: initialDescription)
    }

    var body: some View {
        RecordEditor(
            title: title, problem: RoadmapLimits.problem(title: postTitle, description: description),
            hasChanges: postTitle != initial.0 || description != initial.1,
            save: { await save(postTitle.trimmingCharacters(in: .whitespacesAndNewlines), description.trimmingCharacters(in: .whitespacesAndNewlines)) },
            failure: failure, saveTitle: saveTitle
        ) {
            Section {
                TextField("Title", text: $postTitle)
                    .onChange(of: postTitle) {
                        if postTitle.count > RoadmapLimits.titleRange.upperBound {
                            postTitle = String(postTitle.prefix(RoadmapLimits.titleRange.upperBound))
                        }
                    }
                TextField("Description", text: $description, axis: .vertical)
                    .lineLimit(3...10)
                    .onChange(of: description) {
                        if description.count > RoadmapLimits.maxDescription {
                            description = String(description.prefix(RoadmapLimits.maxDescription))
                        }
                    }
            } footer: {
                Text("Title 3 to 100 characters. The description can use **bold**, _italic_ and `code`.")
            }
        }
    }
}

/// Manage the roadmap board: review suggestions, set a status, edit, delete or add a post. Operators only.
/// Mirrors web-v2/src/pages/RoadmapAdmin.jsx.
struct RoadmapAdminView: View {
    @State private var model: QueryListModel<RoadmapAdminPage>
    @State private var runner: ActionRunner
    @State private var editing: RoadmapPost?
    @State private var isCreating = false
    @State private var pendingDelete: RoadmapPost?

    init(session: AppSession) {
        _model = State(initialValue: QueryListModel(session: session))
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        Group {
            if let page = model.value {
                List {
                    Group {
                        Section {
                            Button("New Post", systemImage: "plus") { isCreating = true }
                        }
                        Section {
                            if page.pending.isEmpty {
                                Text("No suggestions waiting.").foregroundStyle(Color.syloMuted)
                            }
                            ForEach(page.pending) { post in
                                VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                                    Text(verbatim: post.title).font(.headline)
                                    Text(verbatim: post.description).font(.subheadline).foregroundStyle(Color.syloMuted)
                                    HStack {
                                        Button("Approve", systemImage: "checkmark") { act(Endpoints.ApproveRoadmapPost(id: post.id)) }
                                            .buttonStyle(.borderless)
                                        Button("Reject", systemImage: "xmark", role: .destructive) { pendingDelete = post }
                                            .buttonStyle(.borderless)
                                    }
                                }
                                .accessibilityElement(children: .contain)
                            }
                        } header: {
                            Text("Waiting for review (\(page.pending.count))")
                        }
                        Section {
                            ForEach(page.posts) { post in
                                HStack(alignment: .top) {
                                    Button { editing = post } label: {
                                        VStack(alignment: .leading, spacing: SyloSpacing.xs) {
                                            Text(verbatim: post.title).font(.headline).foregroundStyle(Color.syloText)
                                            Text(verbatim: "\(post.status.capitalized) \u{00B7} \(post.votes) votes")
                                                .font(.footnote)
                                                .foregroundStyle(Color.syloMuted)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityHint("Edits the post")
                                    Menu {
                                        ForEach(RoadmapStatus.allCases) { status in
                                            Button(status.rawValue.capitalized) { act(Endpoints.SetRoadmapStatus(id: post.id, status: status)) }
                                        }
                                    } label: {
                                        Label("Status", systemImage: "arrow.triangle.2.circlepath")
                                            .labelStyle(.iconOnly)
                                            .frame(minWidth: 44, minHeight: 44)
                                    }
                                }
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = post }
                                }
                                .contextMenu {
                                    Button("Edit", systemImage: "pencil") { editing = post }
                                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = post }
                                }
                            }
                        } header: {
                            Text("Public posts (\(page.posts.count))")
                        }
                    }
                    .syloSectionCards()
                }
                .syloScreen()
                .disabled(runner.isWorking)
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load the Board", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") { Task { await reload() } }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Manage the Roadmap")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { if model.value == nil { await reload() } }
        .sensoryFeedback(.success, trigger: runner.successCount)
        .sheet(isPresented: $isCreating) {
            RoadmapTextEditor(
                title: "New Post", initialTitle: "", initialDescription: "", saveTitle: "Publish",
                save: { title, description in
                    guard await runner.run(Endpoints.CreateRoadmapPost(title: title, description: description), changesModules: false) != nil
                    else { return false }
                    await reload()
                    return true
                }, failure: { runner.errorMessage })
        }
        .sheet(item: $editing) { post in
            RoadmapTextEditor(
                title: "Edit Post", initialTitle: post.title, initialDescription: post.description,
                save: { title, description in
                    guard await runner.run(Endpoints.EditRoadmapPost(id: post.id, title: title, description: description), changesModules: false) != nil
                    else { return false }
                    await reload()
                    return true
                }, failure: { runner.errorMessage })
        }
        .confirmationDialog(
            "Delete this post?", isPresented: isConfirmingDelete, titleVisibility: .visible, presenting: pendingDelete
        ) { post in
            Button("Delete Post", role: .destructive) {
                if post.status == "pending" { act(Endpoints.RejectRoadmapPost(id: post.id)) } else { act(Endpoints.DeleteRoadmapPost(id: post.id)) }
            }
        } message: { post in
            Text("\u{201C}\(post.title)\u{201D} and its votes are removed for good.")
        }
        .alert("Couldn't Complete", isPresented: isShowingError, presenting: runner.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    private func act<E: APIEndpoint>(_ endpoint: E) {
        Task {
            if await runner.run(endpoint, changesModules: false) != nil { await reload() }
        }
    }

    private func reload() async {
        await model.load(Endpoints.RoadmapAdmin()) { $0 }
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(
            get: { runner.errorMessage != nil && !isCreating && editing == nil },
            set: { if !$0 { runner.errorMessage = nil } })
    }
}
