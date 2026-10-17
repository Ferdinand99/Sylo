import SwiftUI
import SyloKit

/// Signed in: the servers in the sidebar, the chosen server's overview in the detail. On iPhone
/// the split view collapses to a stack that starts at the server list.
struct MainView: View {
    let server: ServerURL

    @Environment(AppSession.self) private var session
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var servers: ServersModel
    @State private var selection: ServerID?
    @State private var column = NavigationSplitViewColumn.sidebar
    @State private var isShowingSettings = false

    init(server: ServerURL, session: AppSession) {
        self.server = server
        _servers = State(initialValue: ServersModel(session: session))
    }

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            ServerSidebar(servers: servers, selection: $selection)
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
            NavigationStack {
                if let summary = servers.server(selection) {
                    OverviewView(summary: summary, session: session)
                        .id(summary.id)
                } else {
                    ContentUnavailableView(
                        "Choose a Server", systemImage: "server.rack",
                        description: Text("Pick a server to see and switch its modules."))
                }
            }
        }
        .sheet(isPresented: $isShowingSettings) {
            SettingsView(server: server, session: session)
        }
        .task { await servers.load() }
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
}
