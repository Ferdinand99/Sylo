import SwiftUI
import SyloKit

/// The server pages that are not modules: Insights and the Leaderboard, and a way into select mode
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
