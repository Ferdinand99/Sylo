import SwiftUI
import SyloKit

/// Game stats: the /stats command and, for whoever runs this Sylo, the latest player lookups. The
/// module has nothing to set beyond its switch. Mirrors web-v2/src/moduleForms/GameStats.jsx.
struct GameStatsSettingsView: View {
    @State private var model: RecordListModel<GameStatsPage>
    @State private var note: ModulePlatformNoteModel

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: RecordListModel(gameStats: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: GameStatsPage.moduleID, session: session))
    }

    var body: some View {
        Group {
            if let page = model.page {
                ScrollView {
                    VStack(alignment: .leading, spacing: SyloSpacing.l) {
                        if let text = note.note {
                            Label(text, systemImage: "info.circle")
                                .font(.subheadline)
                                .foregroundStyle(Color.syloMuted)
                                .padding(SyloSpacing.m)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .syloCard(radius: SyloRadius.row)
                        }
                        SectionCard(title: "Command", systemImage: "terminal") {
                            Text("Adds /stats: pick a game, give a player name, and Sylo posts that player's stats. Battlefield numbers come from a public stats service and RuneScape numbers from Jagex's official Hiscores.")
                                .font(.subheadline)
                                .foregroundStyle(Color.syloText)
                            Text(verbatim: "/stats game:… username:… [platform:…]")
                                .font(.footnote.monospaced())
                                .foregroundStyle(Color.syloBrand)
                                .padding(SyloSpacing.m)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.syloBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: SyloRadius.chip, style: .continuous))
                                .textSelection(.enabled)
                        }
                        SectionCard(title: "Games", systemImage: "gamecontroller") {
                            VStack(alignment: .leading, spacing: SyloSpacing.s) {
                                Label("Battlefield: BF1, BF3, BF4, BFV and Hardline, plus BF2042 and BF6 as far as they work. The platform is required.", systemImage: "scope")
                                Label("RuneScape: Old School and RS3. The platform can pick an Ironman account type.", systemImage: "shield")
                                Label("Results are kept for a while to spare the services they come from.", systemImage: "clock")
                            }
                            .font(.subheadline)
                            .foregroundStyle(Color.syloText)
                        }
                        if page.isOperator {
                            SectionCard(title: "Recently looked up", systemImage: "clock.arrow.circlepath") {
                                if page.recent.isEmpty {
                                    Text("Nothing is cached yet. Run /stats to fill it.")
                                        .font(.subheadline)
                                        .foregroundStyle(Color.syloMuted)
                                } else {
                                    VStack(alignment: .leading, spacing: SyloSpacing.m) {
                                        ForEach(page.recent) { lookup in
                                            LookupRow(lookup: lookup)
                                        }
                                    }
                                }
                                Text("The lookup cache is shared by every server this bot is in.")
                                    .font(.footnote)
                                    .foregroundStyle(Color.syloMuted)
                            }
                        }
                    }
                    .padding(.horizontal, SyloSpacing.screen)
                    .padding(.vertical, SyloSpacing.s)
                }
                .refreshable { await model.load() }
            } else if let message = model.errorMessage {
                EmptyState(
                    "Couldn't Load Game Stats", systemImage: "exclamationmark.triangle", message: Text(message),
                    isError: true, actionTitle: "Try Again") {
                        Task { await model.load() }
                    }
            } else {
                SyloLoadingView()
            }
        }
        .background { SyloBackground() }
        .navigationTitle("Game Stats")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model.page == nil { await model.load() }
            await note.load()
        }
    }
}

/// One cached lookup: what it was, for whom, on which platform and when.
private struct LookupRow: View {
    let lookup: GameStatsLookup

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: lookup.heading)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.syloText)
            Text(verbatim: [lookup.username, lookup.platformName, lookup.ago].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.footnote)
                .foregroundStyle(Color.syloMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
