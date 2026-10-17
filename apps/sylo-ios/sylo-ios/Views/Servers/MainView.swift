import SwiftUI
import SyloKit

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
    @State private var servers: ServersModel
    @State private var selection: ServerID?
    @State private var serverTab = ServerView.ServerTab.modules
    @State private var detailPath = NavigationPath()
    @State private var column = NavigationSplitViewColumn.sidebar
    @State private var isShowingSettings = false

    init(server: ServerURL, session: AppSession) {
        self.server = server
        _servers = State(initialValue: ServersModel(session: session))
    }

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            ServerSidebar(servers: servers, selection: sidebarSelection)
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
                    ServerView(summary: summary, session: session, tab: $serverTab)
                        .id(summary.id)
                } else {
                    ContentUnavailableView(
                        "Choose a Server", systemImage: "server.rack",
                        description: Text("Pick a server to see and switch its modules."))
                }
            }
        }
        .sheet(isPresented: $isShowingSettings) {
            SettingsView(server: server, session: session, servers: servers)
        }
        .task { await servers.load() }
        .task { await push.didSignIn() }
        .onChange(of: push.pendingTicket, initial: true) { openPendingTicket() }
        .onChange(of: servers.hasLoaded) { openPendingTicket() }
    }

    /// The sidebar's selection: another server starts on its Modules tab, at the top.
    private var sidebarSelection: Binding<ServerID?> {
        Binding {
            selection
        } set: { newValue in
            if newValue != selection {
                serverTab = .modules
                detailPath = NavigationPath()
            }
            selection = newValue
        }
    }

    /// Opens a tapped ticket notification: its server, the Tickets tab, the conversation. Waits
    /// for the server list; a server no longer in it is ignored.
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

/// The sidebar: servers grouped by platform, pull to refresh.
private struct ServerSidebar: View {
    let servers: ServersModel
    @Binding var selection: ServerID?

    var body: some View {
        List(selection: $selection) {
            if servers.hasLoaded, let message = servers.errorMessage {
                Section {
                    StatusMessage(message, kind: .error)
                }
            }
            ForEach(servers.sections) { section in
                Section(section.platform.displayName) {
                    ForEach(section.servers) { server in
                        Label {
                            Text(server.name)
                        } icon: {
                            ServerIcon(url: server.iconURL, name: server.name)
                        }
                        .tag(server.id)
                    }
                }
            }
        }
        .overlay { placeholder }
        .refreshable { await servers.load() }
    }

    @ViewBuilder
    private var placeholder: some View {
        if servers.hasLoaded, servers.servers.isEmpty {
            ContentUnavailableView(
                "No Servers", systemImage: "server.rack",
                description: Text("You don't manage a server with Sylo on it yet. Add Sylo to a server, then pull to refresh."))
                // Let the pull to refresh reach the list underneath.
                .allowsHitTesting(false)
        } else if !servers.hasLoaded {
            if let message = servers.errorMessage {
                ContentUnavailableView {
                    Label("Can't Load Servers", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await servers.load() } }
                }
            } else {
                ProgressView()
            }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    MainView(server: .hosted, session: session)
        .environment(session)
        .environment(PushCoordinator(session: session))
}
