import SwiftUI
import SyloKit
import UserNotifications

/// Signed in: the servers in the sidebar, the chosen server's overview in the detail. On iPhone
/// the split view collapses to a stack that starts at the server list.
///
/// The detail's navigation (server, tab, pushed screens) lives here, so a tapped notification can
/// open a ticket conversation from anywhere.
struct MainView: View {
    let server: ServerURL

    @Environment(AppSession.self) private var session
    @Environment(PushCoordinator.self) private var push
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var servers: ServersModel
    @State private var selection: ServerID?
    @State private var serverTab = ServerView.ServerTab.overview
    @State private var detailPath = NavigationPath()
    @State private var column = NavigationSplitViewColumn.sidebar
    @State private var isShowingSettings = false

    init(server: ServerURL, session: AppSession) {
        self.server = server
        _servers = State(initialValue: ServersModel(session: session))
        #if DEBUG
        // Screenshot builds: start on the screen named by the demo launch arguments.
        if let start = DemoLaunch.start {
            _selection = State(initialValue: start.server)
            _serverTab = State(initialValue: start.tab)
            _detailPath = State(initialValue: start.path)
            _column = State(initialValue: start.server == nil ? .sidebar : .detail)
        }
        #endif
    }

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            ServerListView(servers: servers, selection: selection, open: openServer)
                .navigationTitle("Servers")
                .toolbar {
                    // iPad: a hardware keyboard and room in the bar; iPhone pulls to refresh.
                    if horizontalSizeClass == .regular {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                Task { await servers.load() }
                            } label: {
                                Label("Refresh", systemImage: "arrow.clockwise")
                            }
                            .keyboardShortcut("r")
                            .disabled(servers.isLoading)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            isShowingSettings = true
                        } label: {
                            Label("Settings", systemImage: "gearshape")
                        }
                    }
                }
        } detail: {
            NavigationStack(path: $detailPath) {
                if let summary = servers.server(selection) {
                    ServerView(
                        summary: summary, session: session, tab: $serverTab, path: $detailPath,
                        refreshServers: { Task { await loadServers() } })
                        .id(summary.id)
                } else {
                    EmptyState(
                        "Choose a Server", systemImage: "server.rack",
                        message: Text("Pick a server to see and switch its modules."))
                        .syloScreen()
                }
            }
        }
        .sheet(isPresented: $isShowingSettings) {
            SettingsView(server: server, session: session, servers: servers)
        }
        .task { await loadServers() }
        .task { await push.didSignIn() }
        // Ticket counts in the sidebar: fresh after a notification, coming back to the app, or
        // leaving a conversation (opening one marks it seen).
        .onChange(of: push.ticketActivity) { Task { await loadServers() } }
        .onChange(of: scenePhase) { if scenePhase == .active { Task { await loadServers() } } }
        .onChange(of: detailPath) { Task { await loadServers() } }
        .onChange(of: push.pendingTicket, initial: true) { openPendingTicket() }
        // A tapped dev-log notification: Settings opens Health (SettingsView clears the flag).
        .onChange(of: push.pendingDevLog, initial: true) {
            if push.pendingDevLog { isShowingSettings = true }
        }
        .onChange(of: servers.hasLoaded) { openPendingTicket() }
    }

    /// A tapped server card: another server starts on its first tab, at the top, and the detail
    /// column comes forward (on iPhone, the push from the list).
    private func openServer(_ id: ServerID) {
        if id != selection {
            serverTab = .overview
            detailPath = NavigationPath()
        }
        selection = id
        column = .detail
    }

    /// Opens a tapped ticket notification: its server, the Tickets tab, the conversation. Waits
    /// for the server list; a server no longer in it is ignored.
    /// Reloads the server list and sets the app icon's badge to the unread tickets across them.
    private func loadServers() async {
        await servers.load()
        guard servers.hasLoaded else { return }
        let unread = servers.servers.reduce(0) { $0 + $1.unreadTickets }
        try? await UNUserNotificationCenter.current().setBadgeCount(unread)
    }

    private func openPendingTicket() {
        guard let ticket = push.pendingTicket, servers.hasLoaded else { return }
        push.pendingTicket = nil
        guard servers.server(ticket.guildID) != nil else { return }
        isShowingSettings = false
        selection = ticket.guildID
        serverTab = .tickets
        var path = NavigationPath()
        // The member's name is unknown here; the conversation shows it once loaded.
        path.append(TicketRoute(id: ticket.ticketID, user: ""))
        detailPath = path
        column = .detail
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    MainView(server: .hosted, session: session)
        .environment(session)
        .environment(PushCoordinator(session: session))
}

