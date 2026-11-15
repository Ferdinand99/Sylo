import SwiftUI
import SyloKit

/// Search across a server, the app's version of the dashboard's command palette: modules and pages by name,
/// members by name, and an inbox item by its number ("ticket 12", "suggestion #5", "#12"). It opens from the
/// magnifying glass on the server screen, and on an iPad with a hardware keyboard from the Command-K shortcut.
struct ServerSearchView: View {
    let summary: ServerSummary
    let session: AppSession
    let overview: ServerOverview?
    /// The pages of the app this server offers (the setup wizard and import only where the server has them).
    let pages: [SearchPage]
    let wizard: SetupWizardModel
    /// Moves the server screen to a tab, then the search closes.
    let showTab: (ServerView.ServerTab) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var model: ServerSearchModel

    init(summary: ServerSummary, session: AppSession, overview: ServerOverview?, pages: [SearchPage],
         wizard: SetupWizardModel, showTab: @escaping (ServerView.ServerTab) -> Void) {
        self.summary = summary
        self.session = session
        self.overview = overview
        self.pages = pages
        self.wizard = wizard
        self.showTab = showTab
        _model = State(initialValue: ServerSearchModel(server: summary.id, session: session))
    }

    private var results: [SearchItem] {
        SearchIndex.ranked(SearchIndex.items(overview: overview, pages: pages), query: model.query, found: model.foundItems)
    }

    private var typed: Bool { !model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            List {
                if let message = model.errorMessage, typed {
                    Section { StatusMessage(message, kind: .error) }
                }
                let shown = results
                ForEach(groups, id: \.self) { group in
                    let items = shown.filter { $0.group == group }
                    if !items.isEmpty {
                        Section(LocalizedStringKey(group.title)) {
                            ForEach(items) { item in row(item) }
                        }
                    }
                }
                if model.isSearching, typed {
                    Section { ProgressView().frame(maxWidth: .infinity) }
                }
            }
            .overlay {
                if typed, !model.isSearching, results.isEmpty {
                    ContentUnavailableView.search(text: model.query)
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $model.query, placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Modules, pages, members, #12"
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            // After a short pause in typing, so members and numbers are not asked for on every key.
            .task(id: model.query) {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                await model.search()
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .keyboardShortcut(.escape, modifiers: [])
                }
            }
            .navigationDestination(for: SearchTarget.self) { target in
                destination(target)
            }
        }
    }

    private var groups: [SearchGroup] { [.inboxItems, .members, .pages, .modules] }

    @ViewBuilder
    private func row(_ item: SearchItem) -> some View {
        if case .page(let page) = item.target, let tab = tab(of: page) {
            // The tabs of the server screen: switch to the tab and close the search.
            Button {
                showTab(tab)
                dismiss()
            } label: {
                label(item)
            }
            .foregroundStyle(.primary)
        } else {
            NavigationLink(value: item.target) { label(item) }
        }
    }

    private func label(_ item: SearchItem) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.title)
                if !item.hint.isEmpty {
                    Text(verbatim: item.hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: item.symbol)
                .foregroundStyle(.tint)
        }
        .accessibilityElement(children: .combine)
    }

    private func tab(of page: SearchPage) -> ServerView.ServerTab? {
        switch page {
        case .tickets: .tickets
        case .moderation: .moderation
        case .settings: .settings
        default: nil
        }
    }

    @ViewBuilder
    private func destination(_ target: SearchTarget) -> some View {
        let server = summary.id
        switch target {
        case .module(let id):
            if ModuleScreens.hasScreen(id) {
                ModuleScreens.screen(for: id, server: server, session: session)
            } else {
                ServerPages.screen(for: id, server: server, session: session)
            }
        case .page(let page):
            pageScreen(page)
        case .member(let id, let name):
            MemberDataView(server: server, session: session, member: MemberChoice(id: id, name: name))
        case .inbox(let kind, let number):
            switch kind {
            case .ticket:
                TicketThreadView(server: server, route: TicketRoute(id: number, user: ""), session: session)
            case .suggestion:
                ModuleScreens.screen(for: "suggestions", server: server, session: session)
            case .appeal:
                AppealsReviewView(server: server, session: session)
            case .application:
                ApplicationSubmissionView(
                    server: server, session: session, submissionID: number, applicant: "Application #\(number)")
            case .other:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private func pageScreen(_ page: SearchPage) -> some View {
        let server = summary.id
        switch page {
        case .auditLog: AuditLogView(server: server, session: session)
        case .memberData: MemberDataView(server: server, session: session)
        case .insights: InsightsView(server: server, session: session)
        case .leaderboard: LeaderboardView(server: server, session: session)
        case .commands: ServerPages.screen(for: "commands", server: server, session: session)
        case .messages: ServerPages.screen(for: "messages", server: server, session: session)
        case .appeals: AppealsReviewView(server: server, session: session)
        case .setupWizard: SetupWizardView(model: wizard)
        case .importConfig: ConfigImportView(server: server, session: session)
        case .tickets, .moderation, .settings: EmptyView()
        }
    }
}
