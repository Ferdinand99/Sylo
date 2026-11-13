import SwiftUI
import SyloKit

/// Suggestions: where they are posted and logged, anonymous posts, DMs to the author, turning
/// messages into suggestions, the cooldown and the staff roles, and the suggestions themselves:
/// filter and sort them, set a status with an optional reason, move them back to the suggestions
/// channel or delete them. Mirrors web-v2/src/moduleForms/Suggestions.jsx.
struct SuggestionsSettingsView: View {
    @State private var model: ModuleSettingsModel<SuggestionsPage>
    @State private var note: ModulePlatformNoteModel
    @State private var list: SuggestionListModel
    /// The status change the reason alert is asking about.
    @State private var deciding: PendingDecision?
    @State private var reason = ""
    @State private var deleting: SuggestionSummary?
    @State private var isConfirmingMoveAll = false

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: SuggestionsPage.moduleID, session: session))
        _list = State(initialValue: SuggestionListModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Suggestions", model: model) { $settings, page in
            ModuleIntro("Members post ideas and everyone votes with thumbs up and down. Staff approve, deny or mark a suggestion as implemented, in chat or right here.")
            PlatformNoteSection(model: note)

            Section {
                ChannelPicker(title: "Suggestions channel", selection: $settings.channel, channels: page.channels,
                              noneTitle: "Where the command is used")
            }

            Section {
                ChannelPicker(title: "Log channel", selection: $settings.logChannel, channels: page.channels,
                              noneTitle: "Decided ones stay")
                Picker("When decided", selection: $settings.logMode) {
                    Text("Copy, keep the original").tag(SuggestionsLogMode.copy)
                    Text("Move, delete the original").tag(SuggestionsLogMode.move)
                }
                .disabled(settings.logChannel.isEmpty)
            } footer: {
                Text(Self.logModeFooter(settings))
            }

            Section {
                Toggle("Anonymous suggestions", isOn: $settings.anonymous)
            } footer: {
                Text("New posts do not show who wrote them. Staff still see the author in the list below.")
            }

            Section {
                Toggle("DM the author when staff decide", isOn: $settings.dmAuthor)
            } footer: {
                Text("Members with DMs closed are skipped quietly.")
            }

            Section {
                Toggle("Turn messages into suggestions", isOn: $settings.messagesToSuggestions)
            } footer: {
                Text("Sylo deletes a message in the suggestions channel and posts it as a suggestion. Needs the suggestions channel above and the Manage Messages permission. It also has to be allowed to read message text, which only the bot owner can switch on. Messages with attachments are left alone.")
            }

            Section {
                NumberField(title: "Cooldown", value: $settings.cooldownSeconds,
                            range: SuggestionsSettings.cooldownRange, unit: "seconds")
            } footer: {
                Text("Per member between two suggestions. 0 turns it off.")
            }

            Section {
                MultiPicker(title: "Staff roles", selection: $settings.staffRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("May decide on suggestions without Manage Server.")
            }

            suggestionsSection(page)
        }
        .task { await note.load() }
        // The page comes with the unfiltered list; take it over whenever the page is loaded.
        .onChange(of: model.page?.suggestions, initial: true) {
            if let page = model.page { Task { await list.adopt(page) } }
        }
        // A new suggestions channel changes which suggestions can be moved back.
        .onChange(of: model.saveCount) { Task { await list.load() } }
        .onChange(of: list.filter) { Task { await list.load() } }
        .onChange(of: list.sort) { Task { await list.load() } }
        .alert(
            "Set the Status?", isPresented: isAskingReason, presenting: deciding
        ) { pending in
            TextField("Reason (optional)", text: $reason)
            Button(pending.action.title) {
                let text = reason
                Task { await list.decide(pending.suggestion, pending.action, reason: text) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { pending in
            Text("Suggestion #\(pending.suggestion.number) becomes \(pending.action.title). The reason is shown on the post and sent to the author.")
        }
        .confirmationDialog(
            "Delete This Suggestion?", isPresented: isConfirmingDelete, titleVisibility: .visible, presenting: deleting
        ) { suggestion in
            Button("Delete", role: .destructive) { Task { await list.delete(suggestion) } }
            Button("Cancel", role: .cancel) {}
        } message: { suggestion in
            Text("Suggestion #\(suggestion.number), its votes and its post are removed. This can't be undone.")
        }
        .confirmationDialog("Move All Back?", isPresented: $isConfirmingMoveAll, titleVisibility: .visible) {
            Button("Move All Back") { Task { await list.moveAllBack() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Sylo posts each one again in the suggestions channel, oldest first, and removes the old post. With a log channel in copy mode, a decided suggestion keeps the old post as its log copy. A suggestion whose old post Sylo cannot reach is skipped and listed afterwards. This can take a while.")
        }
        .alert("Couldn't Update Suggestion", isPresented: isShowingActionError, presenting: list.actionError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .alert(
            list.notice?.isError == true ? "Not Everything Moved" : "Moved Back",
            isPresented: isShowingNotice, presenting: list.notice
        ) { _ in
            Button("OK") {}
        } message: { notice in
            Text(notice.message)
        }
        .sensoryFeedback(.success, trigger: list.doneCount)
    }

    /// The filter and order, the move-all-back banner and the suggestions.
    @ViewBuilder
    private func suggestionsSection(_ page: SuggestionsPage) -> some View {
        let suggestions = list.hasLoaded ? list.suggestions : page.suggestions
        let outside = list.hasLoaded ? list.outside : page.outside
        if outside > 0 {
            Section {
                Text("\(outside) suggestions are not in the suggestions channel, for example after an earlier move to the log channel.")
                    .font(.subheadline)
                Button("Move All Back", systemImage: "arrow.uturn.backward") { isConfirmingMoveAll = true }
                    .disabled(list.isWorking)
            }
        }

        Section {
            Picker("Show", selection: $list.filter) {
                Text("All").tag(SuggestionFilter.all)
                Text("Open and Considering").tag(SuggestionFilter.open)
                Text("Approved").tag(SuggestionFilter.approved)
                Text("Denied").tag(SuggestionFilter.denied)
                Text("Implemented").tag(SuggestionFilter.implemented)
            }
            Picker("Order", selection: $list.sort) {
                Text("Newest First").tag(SuggestionSort.new)
                Text("Most Votes First").tag(SuggestionSort.top)
            }
        }

        Section {
            if suggestions.isEmpty {
                Text(list.isLoading ? "Loading…" : "Nothing here yet.").foregroundStyle(.secondary)
            }
            ForEach(suggestions) { item in
                HStack(alignment: .top) {
                    SuggestionLine(item: item)
                    Spacer(minLength: 0)
                    Menu {
                        actions(for: item)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .imageScale(.large)
                            .accessibilityLabel("Actions for suggestion #\(item.number)")
                    }
                    .disabled(list.isWorking)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button("Delete", systemImage: "trash", role: .destructive) { deleting = item }
                }
                .contextMenu { actions(for: item) }
            }
        } header: {
            Text("Suggestions (\(suggestions.count))")
        } footer: {
            if let message = list.errorMessage {
                StatusMessage(message, kind: .error)
            }
        }
    }

    /// Set a status, move back, delete: the same list from the menu and from a long press.
    @ViewBuilder
    private func actions(for item: SuggestionSummary) -> some View {
        ForEach(SuggestionAction.available(for: item.status), id: \.self) { action in
            Button(action.title, systemImage: action.symbol) { ask(action, for: item) }
        }
        if item.canMoveBack {
            Button("Move Back", systemImage: "arrow.uturn.backward") {
                Task { await list.moveBack(item) }
            }
        }
        Button("Delete", systemImage: "trash", role: .destructive) { deleting = item }
    }

    private func ask(_ action: SuggestionAction, for suggestion: SuggestionSummary) {
        reason = ""
        deciding = PendingDecision(suggestion: suggestion, action: action)
    }

    private var isAskingReason: Binding<Bool> {
        Binding(get: { deciding != nil }, set: { if !$0 { deciding = nil } })
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { list.actionError != nil }, set: { if !$0 { list.actionError = nil } })
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { list.notice != nil }, set: { if !$0 { list.notice = nil } })
    }

    /// What the log channel does with a decided suggestion, in the dashboard's words.
    private static func logModeFooter(_ settings: SuggestionsSettings) -> LocalizedStringKey {
        if settings.logChannel.isEmpty {
            return "Pick a log channel to have decided suggestions posted there too."
        }
        switch settings.logMode {
        case .copy:
            return "The original stays in the suggestions channel and shows its status. The copy in the log channel is updated if the status changes again and removed if the suggestion is reopened."
        case .move:
            return "The original is deleted and the suggestion lives in the log channel from then on."
        }
    }
}

/// A status change waiting for the person to confirm it, with the reason they type.
private struct PendingDecision: Identifiable {
    let suggestion: SuggestionSummary
    let action: SuggestionAction

    var id: String { "\(suggestion.number)-\(action.rawValue)" }
}

extension SuggestionAction {
    /// The status the action sets, as the dashboard words the "Set status" choices.
    var title: String {
        switch self {
        case .approve: String(localized: "Approved")
        case .deny: String(localized: "Denied")
        case .implement: String(localized: "Implemented")
        case .consider: String(localized: "Considering")
        }
    }

    var symbol: String {
        switch self {
        case .approve: "checkmark.circle"
        case .deny: "xmark.circle"
        case .implement: "shippingbox"
        case .consider: "questionmark.circle"
        }
    }
}

private struct SuggestionLine: View {
    let item: SuggestionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "#\(item.number)" + (item.title.isEmpty ? "" : " · \(item.title)"))
                .font(.headline)
            Text(verbatim: Self.statusLabel(item.status))
                .font(.footnote.weight(.semibold))
            Text(verbatim: item.text)
                .lineLimit(3)
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if !item.reason.isEmpty {
                Text(verbatim: "Reason: \(item.reason)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// "👍 12 · 👎 1 · 3 min. ago · by Alex (hidden from members)".
    private var details: String {
        var parts = ["👍 \(item.up)", "👎 \(item.down)"]
        if let date = item.createdDate { parts.append(DateText.relative(date)) }
        if let author = item.author {
            parts.append("by \(author)" + (item.isAnonymous ? " (hidden from members)" : ""))
        } else {
            parts.append("author removed")
        }
        return parts.joined(separator: " · ")
    }

    static func statusLabel(_ status: SuggestionStatus) -> String {
        switch status {
        case .open: "⏳ Open"
        case .considering: "🤔 Considering"
        case .approved: "✅ Approved"
        case .denied: "❌ Denied"
        case .implemented: "🚀 Implemented"
        case .other(let raw): raw
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        guard endpoint is Endpoints.LoadModuleSettings<SuggestionsPage> else { return nil }
        return SuggestionsPage(
            settings: SuggestionsSettings(channel: "c1", cooldownSeconds: 60, staffRoles: ["r1"]),
            channels: [ChannelOption(id: "c1", name: "suggestions")],
            roles: [RoleOption(id: "r1", name: "Moderators")],
            suggestions: [SuggestionSummary(id: 1, number: 12, text: "Add a movie night", status: .approved,
                                            reason: "Starting next week", up: 8, down: 1, author: "Alex")])
    }
    NavigationStack {
        SuggestionsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
