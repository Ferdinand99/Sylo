import SwiftUI
import SyloKit

/// One server, with a tab bar: Modules, Tickets, Moderation and Settings. A person with Inbox access on a
/// Sylo 5.3 server gets the focused moderator view instead (``ModeratorView``): Tickets, Tools and Moderation,
/// without the modules and the settings, unless they chose "Show everything".
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
    @Environment(\.scenePhase) private var scenePhase
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
    /// The Inbox person's choice to see everything (kept on the device).
    @AppStorage(ModeratorView.showEverythingKey) private var showEverything = false
    /// The read of what this Sylo announces has finished, whether or not it worked.
    @State private var featureCheckDone = false

    enum ServerTab: Hashable {
        case modules, tickets, tools, moderation, settings
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

    // MARK: - The moderator view

    /// Whether this Sylo announces the focused view; nil while that is not known (the read of its features is
    /// on its way), so an Inbox person never sees the full app flash before it narrows.
    private var supportsModeratorView: Bool? {
        if session.has(.moderatorView) { return true }
        if session.featuresKnown || featureCheckDone { return false }
        return nil
    }

    private var mode: ModeratorView.Mode {
        ModeratorView.mode(access: summary.access, supports: supportsModeratorView, showEverything: showEverything)
    }

    /// Where the Inbox person can switch to the other view: nil for everyone else.
    private var moderatorSwitch: Binding<Bool>? {
        ModeratorView.canChoose(access: summary.access, supports: supportsModeratorView) ? $showEverything : nil
    }

    private static func focusedTab(_ tab: ServerTab) -> ModeratorView.Tab? {
        switch tab {
        case .tickets: .tickets
        case .tools: .tools
        case .moderation: .moderation
        case .modules, .settings: nil
        }
    }

    private static func serverTab(_ tab: ModeratorView.Tab) -> ServerTab {
        switch tab {
        case .tickets: .tickets
        case .tools: .tools
        case .moderation: .moderation
        }
    }

    /// The tab that is shown: the chosen one, or where the server opens when that tab is not in this view (the
    /// tab a tapped notification or a new server starts on, or the focused view's own landing).
    private var visibleTab: ServerTab {
        guard mode == .focused else { return tab == .tools ? .modules : tab }
        let current = overview.overview
        if let chosen = Self.focusedTab(tab), ModeratorView.tabs(overview: current).contains(chosen) { return tab }
        return Self.serverTab(ModeratorView.landing(overview: current).tab)
    }

    private var selection: Binding<ServerTab> {
        Binding(get: { visibleTab }, set: { tab = $0 })
    }

    @ViewBuilder
    private var tabs: some View {
        switch mode {
        case .full: fullTabs
        case .focused: focusedTabs
        case .undecided: ProgressView()
        }
    }

    private var fullTabs: some View {
        TabView(selection: selection) {
            OverviewView(
                summary: summary, model: overview, wizard: wizard, openTab: { tab = $0 }, moderatorSwitch: moderatorSwitch
            )
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
    }

    /// The focused moderator view: the inboxes whose module is on, and the moderation tools. No modules, no
    /// settings, no audit log.
    private var focusedTabs: some View {
        let shown = ModeratorView.tabs(overview: overview.overview)
        let landing = ModeratorView.landing(overview: overview.overview)
        return TabView(selection: selection) {
            if shown.contains(.tickets) {
                TicketListView(model: tickets)
                    .tabItem { Label("Tickets", systemImage: "bubble.left.and.bubble.right") }
                    .badge(tickets.unreadCount)
                    .tag(ServerTab.tickets)
            }
            FocusedToolsView(model: overview, showEverything: $showEverything)
                .tabItem { Label("Tools", systemImage: "tray.full") }
                .tag(ServerTab.tools)
            ModerationTabView(
                server: summary.id, session: session,
                showsAppeals: ModeratorView.showsAppeals(overview: overview.overview), showsCommands: false,
                initialPart: landing == .appeals ? .appeals : .infractions
            )
                .tabItem { Label("Moderation", systemImage: "shield") }
                .badge(openAppeals.count ?? 0)
                .tag(ServerTab.moderation)
        }
    }

    var body: some View {
        tabs
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
                summary: summary, session: session, overview: searchOverview, pages: searchPages, wizard: wizard
            ) { target in
                tab = target
            }
            .environment(session)
            .environment(\.dashboardAccess, summary.effectiveAccess)
            .environment(health)
            .environment(\.serverPlatform, summary.platform)
            .environment(openAppeals)
        }
        .navigationDestination(for: ModuleRoute.self) { route in
            scoped(ModuleScreens.screen(for: route.moduleID, server: summary.id, session: session))
        }
        .navigationDestination(for: ServerPageRoute.self) { route in
            scoped(ServerPages.screen(for: route.cardID, server: summary.id, session: session))
        }
        .navigationDestination(for: TicketRoute.self) { route in
            scoped(TicketThreadView(server: summary.id, route: route, session: session))
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
        .environment(\.serverPlatform, summary.platform)
        .environment(\.dashboardAccess, summary.effectiveAccess)
        // A newer overview count replaces an older one.
        .onChange(of: overview.overview?.openAppeals) { _, count in
            if let count { openAppeals.update(count) }
        }
        // The Tickets and Moderation badges are right before either tab is ever opened.
        .task { await tickets.load() }
        .task { await openAppeals.refresh() }
        .task { await health.load() }
        // What this Sylo announces (`setup-wizard`, `config-import`, `duplicate`, ...): views show a control only for it.
        .task {
            _ = await session.serverFeatures()
            featureCheckDone = true
        }
        // The focused view has no Modules tab to load the overview, and its tabs and landing depend on it.
        .task(id: mode) {
            if mode == .focused, overview.overview == nil { await overview.load() }
        }
        // A read of the features that failed (an offline start) is asked again when the app comes back, so the 5.2
        // controls do not stay hidden.
        .onChange(of: scenePhase) {
            guard scenePhase == .active, !session.featuresKnown else { return }
            Task {
                _ = await session.serverFeatures()
                await health.load()
            }
        }
    }

    /// A pushed screen reads the server's models and access from its environment. Values set on this view
    /// after its `navigationDestination` modifiers do not reach a screen the stack pushes (the stack is above
    /// this view), so every destination sets them on the screen itself. Without this, pushed module screens
    /// show no health notes, no role and channel picker notes, and none of the View-only or Inbox-only limits.
    private func scoped<Content: View>(_ content: Content) -> some View {
        content
            .environment(openAppeals)
            .environment(health)
            .environment(\.serverPlatform, summary.platform)
            .environment(\.dashboardAccess, summary.effectiveAccess)
    }

    /// What the search lists for modules: all of them, or in the focused view only the two queues that are modules.
    private var searchOverview: ServerOverview? {
        mode == .focused ? ModeratorView.searchOverview(overview.overview) : overview.overview
    }

    /// The pages the search can open: those of the app, and the wizard and the import where this server has them.
    private var searchPages: [SearchPage] {
        if mode == .focused { return ModeratorView.searchPages(overview: overview.overview) }
        var pages: [SearchPage] = [.tickets, .moderation, .settings, .auditLog, .memberData, .insights, .leaderboard, .appeals]
        if ServerPages.hasScreen("commands") { pages.append(.commands) }
        if ServerPages.hasScreen("messages") { pages.append(.messages) }
        if summary.effectiveAccess.canEdit {
            if session.has(.setupWizard) { pages.append(.setupWizard) }
            if session.has(.configImport) { pages.append(.importConfig) }
        }
        return pages
    }

    private var title: String {
        switch visibleTab {
        case .modules: summary.name
        case .tickets: String(localized: "Tickets")
        case .tools: String(localized: "Tools")
        case .moderation: String(localized: "Moderation")
        case .settings: String(localized: "Server Settings")
        }
    }

    @ToolbarContentBuilder
    private var settingsToolbar: some ToolbarContent {
        if visibleTab == .settings || settings.hasChanges {
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
