import SwiftUI
import SyloKit

/// One server, with a floating tab bar: Overview, Modules, Tickets and Settings.
///
/// The screens sit inside the detail column's navigation stack (one stack, never nested), so
/// screens pushed from any tab (a module's settings, a ticket) cover the tab bar the way a
/// conversation does in Messages. Titles, toolbars and destinations therefore live here, keyed by
/// the selected tab, rather than inside the tabs. The tab bar is ``CapsuleTabBar``; the models stay
/// here, so switching tabs never loses a loaded list.
struct ServerView: View {
    let summary: ServerSummary
    /// The selected tab, kept by ``MainView`` so a tapped notification can open Tickets.
    @Binding var tab: ServerTab
    /// The detail column's pushed screens, so a tile can open a module.
    @Binding var path: NavigationPath

    @Environment(AppSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var overview: OverviewModel
    @State private var tickets: TicketsModel
    @State private var settings: GuildSettingsModel
    @State private var searchText = ""
    @State private var isConfirmingDiscard = false

    enum ServerTab: Hashable {
        case overview, modules, tickets, settings
    }

    init(summary: ServerSummary, session: AppSession, tab: Binding<ServerTab>, path: Binding<NavigationPath>) {
        self.summary = summary
        _tab = tab
        _path = path
        _overview = State(initialValue: OverviewModel(server: summary.id, session: session))
        _tickets = State(initialValue: TicketsModel(server: summary.id, session: session))
        _settings = State(initialValue: GuildSettingsModel(server: summary.id, session: session))
    }

    var body: some View {
        screen
            .animation(reduceMotion ? nil : SyloMotion.quick, value: tab)
            .overlay(alignment: .bottom) {
                ZStack(alignment: .bottom) {
                    // Content fades out behind the bar instead of showing through the glass.
                    LinearGradient(
                        colors: [Color.syloBackground.opacity(0), Color.syloBackground.opacity(0.94)],
                        startPoint: .top, endPoint: .bottom)
                        .frame(height: 104)
                        .ignoresSafeArea(edges: .bottom)
                        .allowsHitTesting(false)
                    CapsuleTabBar(items: tabItems, selection: $tab)
                }
            }
            .syloScreen()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            // Unsaved server settings can't be lost by going back to the server list.
            .navigationBarBackButtonHidden(settings.hasChanges)
            .toolbar { settingsToolbar }
            .navigationDestination(for: ModuleRoute.self) { route in
                ModuleScreens.screen(for: route.moduleID, server: summary.id, session: session)
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
            // The Tickets badge is right before the tab is ever opened.
            .task { await tickets.load() }
    }

    @ViewBuilder
    private var screen: some View {
        switch tab {
        case .overview:
            BentoOverviewView(
                summary: summary, model: overview, unreadTickets: tickets.unreadCount,
                openTab: { tab = $0 }, openModule: openModule)
                .transition(.opacity)
        case .modules:
            ModuleBoardView(
                summary: summary, model: overview, searchText: $searchText, openModule: openModule)
                .transition(.opacity)
        case .tickets:
            TicketListView(model: tickets, open: { path.append($0) })
                .transition(.opacity)
        case .settings:
            GuildSettingsForm(model: settings)
                .transition(.opacity)
        }
    }

    private var tabItems: [CapsuleTabBar.Item] {
        [
            CapsuleTabBar.Item(tab: .overview, title: "Overview", systemImage: "square.grid.2x2"),
            CapsuleTabBar.Item(tab: .modules, title: "Modules", systemImage: "switch.2"),
            CapsuleTabBar.Item(
                tab: .tickets, title: "Tickets", systemImage: "bubble.left.and.bubble.right",
                badge: tickets.unreadCount),
            CapsuleTabBar.Item(tab: .settings, title: "Settings", systemImage: "gearshape"),
        ]
    }

    private func openModule(_ id: String) {
        path.append(ModuleRoute(moduleID: id))
    }

    private var title: String {
        switch tab {
        case .overview: summary.name
        case .modules: String(localized: "Modules")
        case .tickets: String(localized: "Tickets")
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
