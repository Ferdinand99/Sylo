import SwiftUI
import SyloKit

/// One server, with a tab bar: Modules, Tickets, Moderation and Settings.
///
/// The tab view sits inside the detail column's navigation stack (one stack, never nested), so
/// screens pushed from any tab (a module's settings, a ticket) cover the tab bar the way a
/// conversation does in Messages. Titles, toolbars and destinations therefore live here, keyed by
/// the selected tab, rather than inside the tabs.
struct ServerView: View {
    let summary: ServerSummary
    /// The selected tab, kept by ``MainView`` so a tapped notification can open Tickets.
    @Binding var tab: ServerTab

    @Environment(AppSession.self) private var session
    @State private var overview: OverviewModel
    @State private var tickets: TicketsModel
    @State private var settings: GuildSettingsModel
    @State private var isConfirmingDiscard = false
    /// The open appeals for the Moderation tab's badge: the newest of what the server screen, the
    /// overview and the appeals screen (wherever it was opened from) have seen.
    @State private var openAppeals: OpenAppealsModel
    /// The permission and role-hierarchy check (Sylo 5.2); module screens and role and channel pickers read it.
    @State private var health: ServerHealthModel
    /// The setup wizard, shared by the overview's offer, Server settings and the search.
    @State private var wizard: SetupWizardModel
    @State private var isSearching = false
    /// Whether this server has the import routes (Sylo 5.2), for the search.
    @State private var hasImport = false

    enum ServerTab: Hashable {
        case modules, tickets, moderation, settings
    }

    init(summary: ServerSummary, session: AppSession, tab: Binding<ServerTab>) {
        self.summary = summary
        _tab = tab
        _overview = State(initialValue: OverviewModel(server: summary.id, session: session))
        _tickets = State(initialValue: TicketsModel(server: summary.id, session: session))
        // A server that sent a dashboard level has the access route (Sylo 5.2).
        _settings = State(initialValue: GuildSettingsModel(
            server: summary.id, session: session, hasAccessLevels: summary.access != nil))
        _openAppeals = State(initialValue: OpenAppealsModel(server: summary.id, session: session))
        _health = State(initialValue: ServerHealthModel(server: summary.id, session: session))
        _wizard = State(initialValue: SetupWizardModel(server: summary.id, session: session))
    }

    var body: some View {
        TabView(selection: $tab) {
            OverviewView(summary: summary, model: overview, wizard: wizard, openTab: { tab = $0 })
                .tabItem { Label("Modules", systemImage: "square.grid.2x2") }
                .tag(ServerTab.modules)
            TicketListView(model: tickets)
                .tabItem { Label("Tickets", systemImage: "bubble.left.and.bubble.right") }
                .badge(tickets.unreadCount)
                .tag(ServerTab.tickets)
            ModerationTabView(server: summary.id, session: session)
                .tabItem { Label("Moderation", systemImage: "shield") }
                .badge(openAppeals.count ?? 0)
                .tag(ServerTab.moderation)
            GuildSettingsForm(model: settings, wizard: wizard)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(ServerTab.settings)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        // Unsaved server settings can't be lost by going back to the server list.
        .navigationBarBackButtonHidden(settings.hasChanges)
        .tracksUnsavedChanges(settings.hasChanges, scope: .server)
        .toolbar { settingsToolbar }
        .toolbar {
            // "View only" or "Inbox only" next to the search; Command-K opens the search on an iPad with a keyboard.
            if summary.effectiveAccess.badgeTitle != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    AccessBadge(access: summary.effectiveAccess)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    isSearching = true
                } label: {
                    Label("Search", systemImage: "magnifyingglass")
                }
                .keyboardShortcut("k", modifiers: .command)
            }
        }
        .sheet(isPresented: $isSearching) {
            ServerSearchView(
                summary: summary, session: session, overview: overview.overview, pages: searchPages, wizard: wizard
            ) { target in
                tab = target
            }
            .environment(session)
            .environment(\.dashboardAccess, summary.effectiveAccess)
            .environment(health)
            .environment(openAppeals)
        }
        .navigationDestination(for: ModuleRoute.self) { route in
            ModuleScreens.screen(for: route.moduleID, server: summary.id, session: session)
        }
        .navigationDestination(for: ServerPageRoute.self) { route in
            ServerPages.screen(for: route.cardID, server: summary.id, session: session)
        }
        .navigationDestination(for: TicketRoute.self) { route in
            TicketThreadView(server: summary.id, route: route, session: session)
        }
        .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { settings.discardChanges() }
        }
        .alert("Couldn't Save", isPresented: isShowingSaveError, presenting: settings.saveError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: settings.saveCount)
        .environment(openAppeals)
        .environment(health)
        .environment(\.dashboardAccess, summary.effectiveAccess)
        // A newer overview count replaces an older one.
        .onChange(of: overview.overview?.openAppeals) { _, count in
            if let count { openAppeals.update(count) }
        }
        // The Tickets and Moderation badges are right before either tab is ever opened.
        .task { await tickets.load() }
        .task { await openAppeals.refresh() }
        .task { await health.load() }
        .task { if summary.effectiveAccess.canEdit { hasImport = await session.hasImportRoutes(server: summary.id) } }
    }

    /// The pages the search can open: those of the app, and the wizard and the import where this server has them.
    private var searchPages: [SearchPage] {
        var pages: [SearchPage] = [.tickets, .moderation, .settings, .auditLog, .memberData, .insights, .leaderboard, .appeals]
        if ServerPages.hasScreen("commands") { pages.append(.commands) }
        if ServerPages.hasScreen("messages") { pages.append(.messages) }
        if summary.effectiveAccess.canEdit {
            if wizard.isAvailable, wizard.draft != nil { pages.append(.setupWizard) }
            if hasImport { pages.append(.importConfig) }
        }
        return pages
    }

    private var title: String {
        switch tab {
        case .modules: summary.name
        case .tickets: String(localized: "Tickets")
        case .moderation: String(localized: "Moderation")
        case .settings: String(localized: "Server Settings")
        }
    }

    @ToolbarContentBuilder
    private var settingsToolbar: some ToolbarContent {
        if tab == .settings || settings.hasChanges {
            if settings.hasChanges {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard") { isConfirmingDiscard = true }
                        .disabled(settings.isSaving)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if settings.isSaving {
                    ProgressView()
                } else {
                    Button("Save") { Task { await settings.save() } }
                        .toolbarSaveStyle()
                        .disabled(!settings.hasChanges || settings.draftProblem != nil)
                }
            }
        }
    }

    private var isShowingSaveError: Binding<Bool> {
        Binding(get: { settings.saveError != nil }, set: { if !$0 { settings.saveError = nil } })
    }
}

/// A ticket conversation to push from the Tickets tab.
struct TicketRoute: Hashable {
    let id: Int
    /// The member's name, for the title before the ticket has loaded.
    let user: String
}

#Preview {
    @Previewable @State var tab = ServerView.ServerTab.modules
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        ServerView(summary: PreviewData.servers[0], session: session, tab: $tab)
    }
    .environment(session)
    .environment(PushCoordinator(session: session))
}
