import SwiftUI
import SyloKit

/// One server, with a tab bar: Modules, Tickets and Settings.
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

    enum ServerTab: Hashable {
        case modules, tickets, settings
    }

    init(summary: ServerSummary, session: AppSession, tab: Binding<ServerTab>) {
        self.summary = summary
        _tab = tab
        _overview = State(initialValue: OverviewModel(server: summary.id, session: session))
        _tickets = State(initialValue: TicketsModel(server: summary.id, session: session))
        _settings = State(initialValue: GuildSettingsModel(server: summary.id, session: session))
    }

    var body: some View {
        TabView(selection: $tab) {
            OverviewView(summary: summary, model: overview)
                .tabItem { Label("Modules", systemImage: "square.grid.2x2") }
                .tag(ServerTab.modules)
            TicketListView(model: tickets)
                .tabItem { Label("Tickets", systemImage: "bubble.left.and.bubble.right") }
                .badge(tickets.unreadCount)
                .tag(ServerTab.tickets)
            GuildSettingsForm(model: settings)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(ServerTab.settings)
        }
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

    private var title: String {
        switch tab {
        case .modules: summary.name
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
                        .disabled(!settings.hasChanges)
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
