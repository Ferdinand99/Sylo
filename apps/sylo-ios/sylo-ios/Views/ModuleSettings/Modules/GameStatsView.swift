import SwiftUI
import SyloKit

/// Game stats: nothing to set up beyond the module's switch on the overview. The screen explains the
/// stats command and, for the operators of the Sylo server, lists the lookups the shared cache holds.
/// Mirrors web-v2/src/moduleForms/GameStats.jsx.
struct GameStatsView: View {
    @State private var model: GameStatsModel

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: GameStatsModel(server: server, session: session))
    }

    var body: some View {
        content
            .navigationTitle("Game Stats")
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let info = model.info {
            List {
                if let message = model.errorMessage {
                    Section {
                        StatusMessage(message, kind: .error)
                    }
                }
                ModuleIntro("Members look up a player's stats with the stats command: pick a game, give a player name, and Sylo posts that player's stats. Battlefield numbers come from a public stats service and RuneScape numbers from Jagex's official Hiscores. There is nothing to set up here: turn the module on or off on the overview.")

                Section {
                    Text(verbatim: model.statsCommand + " game:… username:… [platform:…]")
                        .font(.subheadline.monospaced())
                    Text("Battlefield: BF1, BF3, BF4, BFV, Hardline, plus best-effort BF2042 and BF6. The platform is required.")
                    Text("RuneScape: Old School and RS3. The platform optionally picks an Ironman account type.")
                    Text("Results are cached for a while to spare the upstream services.")
                } header: {
                    Text("Command")
                }

                if info.isOperator {
                    recentSection(info.recent)
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load Game Stats", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    private func recentSection(_ recent: [GameLookup]) -> some View {
        Section {
            if recent.isEmpty {
                Text("Nothing cached yet. Run \(model.statsCommand) to fill it.")
                    .foregroundStyle(.secondary)
            }
            ForEach(recent) { lookup in
                ListLine(title: lookup.heading, details: lookup.details)
            }
        } header: {
            Text("Recently queried stats")
        } footer: {
            Text("The lookup cache is shared across every server this bot is in, so only the people who run Sylo see it.")
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadGameStats else { return nil }
        return GameStatsInfo(
            isOperator: true,
            recent: [
                GameLookup(game: "bf4", title: "Battlefield 4", username: "player_one", platform: "pc", ago: "5m ago"),
                GameLookup(game: "osrs", username: "Zezima", platform: "", ago: "1h ago"),
            ])
    }
    NavigationStack {
        GameStatsView(server: "1", session: session)
    }
    .environment(session)
}
