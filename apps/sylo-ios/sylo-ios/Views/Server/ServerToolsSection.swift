import SwiftUI
import SyloKit

/// The server pages that are not modules: Insights, the Leaderboard and Mirror to Fluxer, and a way into select mode
/// to switch several modules at once. A section for the Modules tab's list, right below the
/// server header.
struct ServerToolsSection: View {
    let server: ServerID
    /// Starts select mode in the module list; nil hides the row.
    var selectModules: (() -> Void)?

    @Environment(AppSession.self) private var session
    @ScaledMetric(relativeTo: .body) private var iconWidth = 28

    var body: some View {
        Section("Server tools") {
            NavigationLink {
                InsightsView(server: server, session: session)
            } label: {
                row("Insights", symbol: "chart.bar.xaxis", detail: "Activity, members and voice")
            }
            NavigationLink {
                LeaderboardView(server: server, session: session)
            } label: {
                row("Leaderboard", symbol: "trophy", detail: "XP ranking and its public page")
            }
            // Sylo 5.3: copy a Discord server to a Fluxer server and keep it in step. The same screen serves the
            // Fluxer server of a pair (agreeing with the code, pausing, stopping).
            if session.has(.mirror) {
                NavigationLink {
                    MirrorView(server: server, session: session)
                } label: {
                    row("Mirror to Fluxer", symbol: "square.on.square", detail: "Copy this server to Fluxer and keep it in step")
                }
            }
            if let selectModules {
                Button(action: selectModules) {
                    row("Switch Several Modules", symbol: "checklist", detail: "Pick modules, then turn them on or off")
                }
                .foregroundStyle(.primary)
            }
        }
    }

    private func row(_ title: LocalizedStringKey, symbol: String, detail: LocalizedStringKey) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(.tint)
                .frame(width: iconWidth)
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn)
    NavigationStack {
        List { ServerToolsSection(server: "1") {} }
    }
    .environment(session)
}
