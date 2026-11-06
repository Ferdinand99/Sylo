import SwiftUI
import SyloKit

// The actions of the web dashboard's module pages: send a test message, a number or a member to act on,
// and the list screens of suggestions, quotes, temporary roles and events.

// MARK: - Send test message

/// "Send Test Message" for a module that posts to one channel. The server sends from the saved settings,
/// so it stays off while there are unsaved changes.
struct SendTestSection: View {
    let server: ServerID
    let module: ModuleID
    let hasUnsavedChanges: Bool

    @State private var runner: ActionRunner
    @State private var result: ModuleTestResult?

    init(server: ServerID, module: ModuleID, hasUnsavedChanges: Bool, session: AppSession) {
        self.server = server
        self.module = module
        self.hasUnsavedChanges = hasUnsavedChanges
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        Section {
            Button {
                Task { result = await runner.run(Endpoints.SendModuleTest(server: server, module: module), changesModules: false) }
            } label: {
                HStack {
                    Label("Send Test Message", systemImage: "paperplane")
                    if runner.isWorking {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(hasUnsavedChanges || runner.isWorking)
            if let result {
                Label(result.message, systemImage: result.isOK ? "checkmark.circle" : "exclamationmark.triangle")
                    .font(.subheadline)
                    .foregroundStyle(result.isOK ? Color.syloBrand : Color.syloWarn)
            }
            if let message = runner.errorMessage {
                StatusMessage(message, kind: .error)
            }
        } footer: {
            Text(hasUnsavedChanges
                ? "Save your changes first. The test is sent from the saved settings."
                : "Posts a sample message from the saved settings to the channel set above.")
        }
    }
}

// MARK: - A member and a number

/// A sheet for an action on a member with a number (set XP, a bonus) or on the server with only a number (the
/// count). The member is a user id or mention.
struct MemberNumberEditor: View {
    let title: LocalizedStringKey
    let asksForMember: Bool
    let valueTitle: LocalizedStringKey
    let unit: LocalizedStringKey?
    let range: ClosedRange<Int>
    let footer: LocalizedStringKey
    let saveTitle: LocalizedStringKey
    let confirmation: String?
    let save: (String, Int) async -> Bool
    let failure: () -> String?

    @State private var member = ""
    @State private var value: Int

    init(
        title: LocalizedStringKey, asksForMember: Bool = true, valueTitle: LocalizedStringKey, unit: LocalizedStringKey? = nil,
        range: ClosedRange<Int>, initial: Int = 0, footer: LocalizedStringKey, saveTitle: LocalizedStringKey = "Save",
        confirmation: String? = nil, save: @escaping (String, Int) async -> Bool, failure: @escaping () -> String?
    ) {
        self.title = title
        self.asksForMember = asksForMember
        self.valueTitle = valueTitle
        self.unit = unit
        self.range = range
        self.footer = footer
        self.saveTitle = saveTitle
        self.confirmation = confirmation
        self.save = save
        self.failure = failure
        _value = State(initialValue: initial)
    }

    var body: some View {
        RecordEditor(
            title: title, problem: problem, hasChanges: !member.isEmpty || value != 0,
            save: { await save(member, value) }, failure: failure, saveTitle: saveTitle, confirmation: confirmation
        ) {
            if asksForMember {
                Section {
                    TextField("User ID or @mention", text: $member)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("Member")
                } footer: {
                    Text("Paste the member's user ID or an @mention.")
                }
            }
            Section {
                NumberField(title: valueTitle, value: $value, range: range, unit: unit)
            } footer: {
                Text(footer)
            }
        }
    }

    private var problem: String? {
        if asksForMember, !ModerationInput.isUserReference(member) { return String(localized: "Enter a user ID or mention.") }
        return nil
    }
}

/// A sheet that asks only for a member (a counting penalty to release).
struct MemberOnlyEditor: View {
    let title: LocalizedStringKey
    let footer: LocalizedStringKey
    let saveTitle: LocalizedStringKey
    let save: (String) async -> Bool
    let failure: () -> String?

    @State private var member = ""

    var body: some View {
        RecordEditor(
            title: title, problem: ModerationInput.isUserReference(member) ? nil : String(localized: "Enter a user ID or mention."),
            hasChanges: !member.isEmpty, save: { await save(member) }, failure: failure, saveTitle: saveTitle
        ) {
            Section {
                TextField("User ID or @mention", text: $member)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
            } header: {
                Text("Member")
            } footer: {
                Text(footer)
            }
        }
    }
}

// MARK: - Suggestions

/// The suggestions of a server with a status filter; tap one to decide on it. Mirrors the list on
/// web-v2/src/moduleForms/Suggestions.jsx.
struct SuggestionsManageView: View {
    let server: ServerID

    @State private var model: QueryListModel<[SuggestionSummary]>
    @State private var runner: ActionRunner
    @State private var filter = SuggestionFilter.all
    @State private var sortByVotes = false
    @State private var selected: SuggestionSummary?
    @State private var pendingDelete: SuggestionSummary?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: QueryListModel(session: session))
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        Form {
            Group {
                Section {
                    Picker("Status", selection: $filter) {
                        Text("All").tag(SuggestionFilter.all)
                        Text("Open").tag(SuggestionFilter.open)
                        Text("Considering").tag(SuggestionFilter.considering)
                        Text("Approved").tag(SuggestionFilter.approved)
                        Text("Denied").tag(SuggestionFilter.denied)
                        Text("Implemented").tag(SuggestionFilter.implemented)
                    }
                    Picker("Order", selection: $sortByVotes) {
                        Text("Newest first").tag(false)
                        Text("Most votes first").tag(true)
                    }
                }

                if let message = model.errorMessage {
                    Section { StatusMessage(message, kind: .error) }
                }

                Section {
                    if let items = model.value {
                        if items.isEmpty {
                            Text("No suggestions match.").foregroundStyle(Color.syloMuted)
                        }
                        ForEach(items) { item in
                            Button { selected = item } label: { SuggestionRow(item: item) }
                                .buttonStyle(.plain)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = item }
                                }
                                .contextMenu {
                                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = item }
                                }
                                .accessibilityAction(named: Text("Delete")) { pendingDelete = item }
                                .accessibilityHint("Opens it to set a status")
                        }
                    } else if model.errorMessage == nil {
                        ProgressView()
                    }
                } header: {
                    Text("Suggestions")
                } footer: {
                    Text("Shows up to 100.")
                }
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .disabled(runner.isWorking)
        .navigationTitle("Suggestions")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task(id: Query(filter: filter, sortByVotes: sortByVotes)) { await reload() }
        .sensoryFeedback(.success, trigger: runner.successCount)
        .sheet(item: $selected) { item in
            SuggestionDecisionSheet(item: item) { action, reason in
                guard await runner.run(Endpoints.DecideSuggestion(server: server, number: item.number, action: action, reason: reason)) != nil else { return false }
                await reload()
                return true
            } failure: { runner.errorMessage }
        }
        .confirmationDialog(
            "Delete this suggestion?", isPresented: isConfirmingDelete, titleVisibility: .visible, presenting: pendingDelete
        ) { item in
            Button("Delete Suggestion", role: .destructive) {
                Task {
                    if await runner.run(Endpoints.DeleteSuggestion(server: server, number: item.number)) != nil { await reload() }
                }
            }
        } message: { item in
            Text("Suggestion #\(item.number) and its post are removed. This can't be undone.")
        }
        .alert("Couldn't Complete", isPresented: isShowingError, presenting: runner.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    nonisolated private struct Query: Hashable {
        let filter: SuggestionFilter
        let sortByVotes: Bool
    }

    private func reload() async {
        await model.load(Endpoints.SuggestionsList(server: server, status: filter, sortByVotes: sortByVotes)) { $0.suggestions }
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { runner.errorMessage != nil && selected == nil }, set: { if !$0 { runner.errorMessage = nil } })
    }
}

private struct SuggestionRow: View {
    let item: SuggestionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: SyloSpacing.s) {
                Text(verbatim: "#\(item.number)" + (item.title.isEmpty ? "" : " \u{00B7} \(item.title)"))
                    .font(.headline)
                    .foregroundStyle(Color.syloText)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: SyloSpacing.xs)
                SyloPill(verbatim: SuggestionStatusText.label(item.status), tint: item.status == .denied ? .syloMuted : .syloBrand)
            }
            Text(verbatim: item.text)
                .font(.subheadline)
                .foregroundStyle(Color.syloText)
                .lineLimit(3)
                .multilineTextAlignment(.leading)
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(Color.syloMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var details: String {
        var parts = ["\u{1F44D} \(item.up)", "\u{1F44E} \(item.down)"]
        if let date = item.createdDate { parts.append(DateText.relative(date)) }
        if let author = item.author {
            parts.append(String(localized: "by \(author)") + (item.isAnonymous ? String(localized: " (hidden from members)") : ""))
        }
        if !item.reason.isEmpty { parts.append(String(localized: "Reason: \(item.reason)")) }
        return parts.joined(separator: " \u{00B7} ")
    }
}

enum SuggestionStatusText {
    static func label(_ status: SuggestionStatus) -> String {
        switch status {
        case .open: String(localized: "Open")
        case .considering: String(localized: "Considering")
        case .approved: String(localized: "Approved")
        case .denied: String(localized: "Denied")
        case .implemented: String(localized: "Implemented")
        case .other(let raw): raw
        }
    }
}

/// Set a suggestion's status with an optional reason (sent to the author when the module DMs them).
private struct SuggestionDecisionSheet: View {
    let item: SuggestionSummary
    let decide: (SuggestionAction, String) async -> Bool
    let failure: () -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var reason: String
    @State private var isWorking = false
    @State private var error: String?

    init(item: SuggestionSummary, decide: @escaping (SuggestionAction, String) async -> Bool, failure: @escaping () -> String?) {
        self.item = item
        self.decide = decide
        self.failure = failure
        _reason = State(initialValue: item.reason)
    }

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    Section {
                        Text(verbatim: item.text)
                        LabeledContent("Status") { Text(verbatim: SuggestionStatusText.label(item.status)) }
                    } header: {
                        Text(verbatim: "#\(item.number)" + (item.title.isEmpty ? "" : " \u{00B7} \(item.title)"))
                    }

                    Section {
                        TextField("Reason (optional)", text: $reason, axis: .vertical)
                            .lineLimit(2...5)
                    } header: {
                        Text("Reason")
                    } footer: {
                        Text("Shown with the new status. The author gets it by DM when the module is set to.")
                    }

                    Section {
                        ForEach(SuggestionAction.allCases) { action in
                            Button { run(action) } label: { Label(title(action), systemImage: symbol(action)) }
                        }
                    } header: {
                        Text("Set the status")
                    } footer: {
                        if let error { Text(verbatim: error) }
                    }
                }
                .syloSectionCards()
            }
            .syloFormStyle()
            .disabled(isWorking)
            .navigationTitle("Suggestion")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDragIndicator(.visible)
    }

    private func run(_ action: SuggestionAction) {
        isWorking = true
        Task {
            let ok = await decide(action, reason)
            isWorking = false
            if ok { dismiss() } else { error = failure() }
        }
    }

    private func title(_ action: SuggestionAction) -> LocalizedStringKey {
        switch action {
        case .consider: "Considering"
        case .approve: "Approve"
        case .deny: "Deny"
        case .implement: "Mark as Implemented"
        }
    }

    private func symbol(_ action: SuggestionAction) -> String {
        switch action {
        case .consider: "questionmark.bubble"
        case .approve: "checkmark.circle"
        case .deny: "xmark.circle"
        case .implement: "shippingbox"
        }
    }
}

// MARK: - Quotes

/// The saved quotes with a search; swipe one to delete it. Mirrors the list on
/// web-v2/src/moduleForms/QuoteBoard.jsx.
struct QuotesManageView: View {
    let server: ServerID

    @State private var model: QueryListModel<QuoteList>
    @State private var runner: ActionRunner
    @State private var search = ""
    @State private var pendingDelete: QuoteSummary?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: QueryListModel(session: session))
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        Form {
            Group {
                if let message = model.errorMessage {
                    Section { StatusMessage(message, kind: .error) }
                }
                Section {
                    if let list = model.value {
                        if list.quotes.isEmpty {
                            Text(search.isEmpty ? "Nothing here yet." : "No quote matches.").foregroundStyle(Color.syloMuted)
                        }
                        ForEach(list.quotes) { quote in
                            QuoteRow(quote: quote)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = quote }
                                }
                                .contextMenu {
                                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = quote }
                                }
                                .accessibilityAction(named: Text("Delete")) { pendingDelete = quote }
                        }
                    } else if model.errorMessage == nil {
                        ProgressView()
                    }
                } header: {
                    Text("Quotes (\(model.value?.total ?? 0))")
                } footer: {
                    Text("The newest 100, or the ones matching the search.")
                }
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .disabled(runner.isWorking)
        .navigationTitle("Quotes")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Search quotes and authors")
        .refreshable { await reload() }
        .task(id: search) {
            // A short pause, so typing does not send one search per letter.
            if !search.isEmpty { try? await Task.sleep(for: .milliseconds(350)) }
            guard !Task.isCancelled else { return }
            await reload()
        }
        .sensoryFeedback(.success, trigger: runner.successCount)
        .confirmationDialog(
            "Delete this quote?", isPresented: isConfirmingDelete, titleVisibility: .visible, presenting: pendingDelete
        ) { quote in
            Button("Delete Quote", role: .destructive) {
                Task {
                    if await runner.run(Endpoints.DeleteQuote(server: server, number: quote.number)) != nil { await reload() }
                }
            }
        } message: { quote in
            Text("Quote #\(quote.number) is removed for good.")
        }
        .alert("Couldn't Complete", isPresented: isShowingError, presenting: runner.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    private func reload() async {
        await model.load(Endpoints.QuotesList(server: server, search: search.trimmingCharacters(in: .whitespacesAndNewlines))) { $0 }
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { runner.errorMessage != nil }, set: { if !$0 { runner.errorMessage = nil } })
    }
}

private struct QuoteRow: View {
    let quote: QuoteSummary

    var body: some View {
        VStack(alignment: .leading, spacing: SyloSpacing.xs) {
            Text(verbatim: "#\(quote.number) \u{00B7} \(quote.author)")
                .font(.headline)
            Text(verbatim: quote.text)
                .lineLimit(5)
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(Color.syloMuted)
        }
        .accessibilityElement(children: .combine)
    }

    private var details: String {
        var parts: [String] = []
        if let date = quote.messageDate { parts.append(DateText.day(date)) }
        if let channel = quote.channel { parts.append("#\(channel)") }
        if quote.attachments > 0 { parts.append("\u{1F4CE} \(quote.attachments)") }
        if !quote.publicSource { parts.append(String(localized: "not on the public page")) }
        return parts.joined(separator: " \u{00B7} ")
    }
}

// MARK: - Temporary roles

/// The temporary roles: who has which, when it ends, give one, take one back early. Mirrors the list
/// on web-v2/src/moduleForms/TempRoles.jsx.
struct TempRolesManageView: View {
    let server: ServerID
    let roles: [RoleOption]
    let defaultDuration: String

    @Environment(AppSession.self) private var session
    @State private var model: QueryListModel<TempRoleList>
    @State private var runner: ActionRunner
    @State private var search = ""
    @State private var isAdding = false
    @State private var pendingRemove: TempRoleRow?
    @State private var notice: String?

    init(server: ServerID, roles: [RoleOption], defaultDuration: String, session: AppSession) {
        self.server = server
        self.roles = roles
        self.defaultDuration = defaultDuration
        _model = State(initialValue: QueryListModel(session: session))
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        Form {
            Group {
                Section {
                    Button("Give a Temporary Role", systemImage: "plus") { isAdding = true }
                }
                if let message = model.errorMessage {
                    Section { StatusMessage(message, kind: .error) }
                }
                Section {
                    if let list = model.value {
                        if list.rows.isEmpty {
                            Text(search.isEmpty ? "No temporary roles right now." : "Nothing matches.").foregroundStyle(Color.syloMuted)
                        }
                        ForEach(list.rows) { row in
                            ListLine(title: "\(row.member) \u{00B7} \(row.role)", details: details(row))
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button("Take Back", systemImage: "arrow.uturn.backward", role: .destructive) { pendingRemove = row }
                                }
                                .contextMenu {
                                    Button("Take Back", systemImage: "arrow.uturn.backward", role: .destructive) { pendingRemove = row }
                                }
                                .accessibilityAction(named: Text("Take Back")) { pendingRemove = row }
                        }
                    } else if model.errorMessage == nil {
                        ProgressView()
                    }
                } header: {
                    Text("Temporary roles (\(model.value?.total ?? 0))")
                }
            }
            .syloSectionCards()
        }
        .syloFormStyle()
        .disabled(runner.isWorking)
        .navigationTitle("Temporary Roles")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Search members, roles and reasons")
        .refreshable { await reload() }
        .task(id: search) {
            if !search.isEmpty { try? await Task.sleep(for: .milliseconds(350)) }
            guard !Task.isCancelled else { return }
            await reload()
        }
        .sensoryFeedback(.success, trigger: runner.successCount)
        .sheet(isPresented: $isAdding) {
            AddTempRoleEditor(server: server, roles: roles, defaultDuration: defaultDuration, runner: runner, session: session) { notice in
                self.notice = notice
                await reload()
            }
        }
        .confirmationDialog(
            "Take this role back now?", isPresented: isConfirmingRemove, titleVisibility: .visible, presenting: pendingRemove
        ) { row in
            Button("Take Role Back", role: .destructive) {
                Task {
                    if let result = await runner.run(Endpoints.RemoveTempRole(server: server, userId: row.userId, roleId: row.roleId)) {
                        notice = result.warning ?? String(localized: "Role taken back.")
                        await reload()
                    }
                }
            }
        } message: { row in
            Text("\(row.member) loses \(row.role) straight away.")
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

    private func details(_ row: TempRoleRow) -> String {
        var parts = [String(localized: "ends \(DateText.relative(row.expiresDate))")]
        if let by = row.addedByName { parts.append(String(localized: "by \(by)")) }
        if !row.reason.isEmpty { parts.append(row.reason) }
        return parts.joined(separator: " \u{00B7} ")
    }

    private func reload() async {
        await model.load(Endpoints.TempRolesList(server: server, search: search.trimmingCharacters(in: .whitespacesAndNewlines))) { $0.list }
    }

    private var isConfirmingRemove: Binding<Bool> {
        Binding(get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } })
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { runner.errorMessage != nil && !isAdding }, set: { if !$0 { runner.errorMessage = nil } })
    }
}

/// Pick a member (search by name, or paste an id), a role, a duration and a reason.
private struct AddTempRoleEditor: View {
    let server: ServerID
    let roles: [RoleOption]
    let defaultDuration: String
    let runner: ActionRunner
    let done: (String) async -> Void

    @State private var search = ""
    @State private var choices: [MemberChoice] = []
    @State private var member: MemberChoice?
    @State private var roleId = ""
    @State private var duration: String
    @State private var reason = ""
    @State private var searchRunner: QueryListModel<[MemberChoice]>

    init(
        server: ServerID, roles: [RoleOption], defaultDuration: String, runner: ActionRunner, session: AppSession,
        done: @escaping (String) async -> Void
    ) {
        self.server = server
        self.roles = roles
        self.defaultDuration = defaultDuration
        self.runner = runner
        self.done = done
        _duration = State(initialValue: defaultDuration)
        _searchRunner = State(initialValue: QueryListModel(session: session))
    }

    var body: some View {
        RecordEditor(
            title: "Temporary Role", problem: problem, hasChanges: member != nil || !reason.isEmpty,
            save: {
                guard let member else { return false }
                guard let result = await runner.run(
                    Endpoints.AddTempRole(server: server, userId: member.id, roleId: roleId, duration: duration, reason: reason))
                else { return false }
                var notice = result.replaced ? String(localized: "The member's earlier temporary role was replaced.") : String(localized: "Temporary role given.")
                if !result.dm { notice += " " + String(localized: "The member could not be sent a DM.") }
                await done(notice)
                return true
            },
            failure: { runner.errorMessage }
        ) {
            Section {
                if let member {
                    LabeledContent("Member") { Text(verbatim: member.name) }
                    Button("Choose Someone Else") {
                        self.member = nil
                        search = ""
                    }
                } else {
                    TextField("Name or user ID", text: $search)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    ForEach(searchRunner.value ?? []) { choice in
                        Button {
                            member = choice
                        } label: {
                            ListLine(title: choice.name, details: choice.username)
                        }
                        .buttonStyle(.plain)
                    }
                }
            } header: {
                Text("Member")
            }
            Section {
                RolePicker(title: "Role", selection: $roleId, roles: roles, noneTitle: "Choose a role")
                TextField("30m, 12h, 7d, 2w or 1d12h", text: $duration)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Reason (optional)", text: $reason, axis: .vertical)
                    .lineLimit(1...3)
            } footer: {
                Text("From 1 minute to 365 days. Use each unit once, like 1d12h.")
            }
        }
        .task(id: search) {
            guard member == nil else { return }
            let text = search.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await searchRunner.load(Endpoints.TempRoleMembers(server: server, search: text)) { $0.members }
        }
    }

    private var problem: String? {
        if member == nil { return String(localized: "Pick a member.") }
        if roleId.isEmpty { return String(localized: "Pick a role.") }
        if duration.trimmingCharacters(in: .whitespaces).isEmpty { return String(localized: "Give a duration.") }
        return nil
    }
}

// MARK: - Events

/// The events: post one, change one, cancel one. Mirrors the list and form on
/// web-v2/src/moduleForms/Events.jsx.
struct EventsManageView: View {
    let server: ServerID

    @State private var model: RecordListModel<EventsManagePage>
    @State private var editing: EventDraft?
    @State private var pendingCancel: EventRecord?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(events: server, session: session))
    }

    var body: some View {
        RecordScreen("Events", model: model) { page in
            Section {
                Button("New Event", systemImage: "plus") { editing = EventDraft(settings: page.settings) }
            }

            Section {
                if page.upcoming.isEmpty {
                    Text("None scheduled.").foregroundStyle(Color.syloMuted)
                }
                ForEach(page.upcoming) { event in
                    RecordRow(title: "#\(event.id) \u{00B7} \(event.title)", details: details(event), status: "Scheduled") {
                        editing = EventDraft(event: event)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Cancel Event", systemImage: "xmark.circle", role: .destructive) { pendingCancel = event }
                    }
                    .contextMenu {
                        Button("Cancel Event", systemImage: "xmark.circle", role: .destructive) { pendingCancel = event }
                    }
                    .accessibilityAction(named: Text("Cancel Event")) { pendingCancel = event }
                }
            } header: {
                Text("Upcoming events")
            }

            if !page.past.isEmpty {
                Section("Past events") {
                    ForEach(page.past) { event in
                        ListLine(title: "#\(event.id) \u{00B7} \(event.title)", details: details(event))
                    }
                }
            }
        }
        .sheet(item: $editing) { draft in
            if let page = model.page {
                EventEditor(draft: draft, page: page, model: model)
            }
        }
        .confirmationDialog(
            "Cancel this event?", isPresented: isConfirmingCancel, titleVisibility: .visible, presenting: pendingCancel
        ) { event in
            Button("Cancel Event", role: .destructive) {
                Task { _ = await model.cancel(eventID: event.id) }
            }
        } message: { event in
            Text("\u{201C}\(event.title)\u{201D} is marked as cancelled, the participant role is taken back and sign-ups stop.")
        }
    }

    private func details(_ event: EventRecord) -> String {
        var parts: [String] = []
        if let start = event.startAt { parts.append(DateText.dayAndTime(start, timeZone: event.zone)) }
        if !event.channel.isEmpty { parts.append("#\(event.channel)") }
        switch event.state {
        case .cancelled: parts.append(String(localized: "cancelled"))
        case .ended: parts.append(String(localized: "ended"))
        default: break
        }
        var going = String(localized: "\(event.joined) going")
        if let capacity = event.capacity { going = String(localized: "\(event.joined)/\(capacity) going") }
        if event.maybe > 0 { going += " \u{00B7} " + String(localized: "\(event.maybe) maybe") }
        parts.append(going)
        return parts.joined(separator: " \u{00B7} ")
    }

    private var isConfirmingCancel: Binding<Bool> {
        Binding(get: { pendingCancel != nil }, set: { if !$0 { pendingCancel = nil } })
    }
}

/// Posts a new event or changes one that is scheduled.
private struct EventEditor: View {
    @State var draft: EventDraft
    let page: EventsManagePage
    let model: RecordListModel<EventsManagePage>

    @State private var initial: EventDraft?

    var body: some View {
        RecordEditor(
            title: draft.eventID == nil ? "New Event" : "Edit Event", problem: draft.problem(),
            hasChanges: initial.map { $0 != draft } ?? false,
            save: { await model.save(draft) }, failure: { model.takeActionError() },
            saveTitle: draft.eventID == nil ? "Post Event" : "Save Event"
        ) {
            Section {
                TextField("Title", text: $draft.title)
                TextField("Description (optional)", text: $draft.description, axis: .vertical)
                    .lineLimit(2...6)
            }

            Section {
                DatePicker("Starts", selection: $draft.start)
                    .environment(\.timeZone, draft.zone)
                Toggle("Has an end time", isOn: $draft.hasEnd)
                if draft.hasEnd {
                    DatePicker("Ends", selection: $draft.end)
                        .environment(\.timeZone, draft.zone)
                }
                TimeZoneRow(selection: zoneBinding)
            } header: {
                Text("When")
            } footer: {
                Text("The times are read in this time zone. Members see them in their own zone.")
            }

            if draft.eventID == nil {
                Section {
                    ChannelPicker(title: "Post in", selection: $draft.channelId, channels: page.channels, noneTitle: "Choose a channel")
                    RolePicker(title: "Participant role", selection: $draft.roleId, roles: page.roles, noneTitle: "None")
                } footer: {
                    Text("The channel and the role can't be changed once the event is posted.")
                }
            }

            Section {
                TextField("Where (optional)", text: $draft.location)
                Toggle("Limit sign-ups", isOn: $draft.hasCapacity)
                if draft.hasCapacity {
                    NumberField(title: "Capacity", value: $draft.capacity, range: 1...100_000)
                }
                Picker("Reminder", selection: $draft.reminderMinutes) {
                    ForEach(EventsSettings.reminderOptions(including: draft.reminderMinutes), id: \.self) { minutes in
                        Text(verbatim: EventsSettingsView.reminderTitle(minutes)).tag(minutes)
                    }
                }
                TextField("Image link (optional, https)", text: $draft.imageUrl)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
            }
        }
        .onAppear { if initial == nil { initial = draft } }
    }

    /// The zone picker treats an empty name as UTC.
    private var zoneBinding: Binding<String> {
        Binding(
            get: { draft.timeZone == "UTC" ? "" : draft.timeZone },
            set: { draft.timeZone = $0.isEmpty ? "UTC" : $0 })
    }
}
