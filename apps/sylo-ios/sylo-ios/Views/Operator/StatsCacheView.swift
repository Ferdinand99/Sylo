import SwiftUI
import SyloKit

/// The game-stats lookups every server on this Sylo shares, newest first, for its operators. Read
/// only: it never calls a game service. Mirrors web-v2/src/pages/Stats.jsx.
struct StatsCacheView: View {
    @State private var model: StatsCacheModel

    init(session: AppSession) {
        _model = State(initialValue: StatsCacheModel(session: session))
    }

    var body: some View {
        Group {
            if model.isRefused {
                OperatorRefusedView()
            } else if let cache = model.cache {
                list(cache)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load the Stats Cache", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Stats Cache")
        .navigationBarTitleDisplayMode(.inline)
        .task { if model.cache == nil { await model.load() } }
    }

    private func list(_ cache: StatsCache) -> some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            Section {
                Text("Lookups made with the stats command, from every server. Results are kept for \(cache.ttlMinutes) minutes; the next lookup refreshes a stale one.")
                    .font(.subheadline)
            }
            Section {
                if cache.rows.isEmpty {
                    Text("Nothing cached yet. Run the stats command in Discord.")
                        .foregroundStyle(.secondary)
                }
                ForEach(cache.rows) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: row.heading)
                                .font(.headline)
                            Text(verbatim: row.facts.joined(separator: " \u{00B7} "))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        StatusTag(row.isFresh ? "Fresh" : "Stale", tint: row.isFresh ? .green : .secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Newest 50")
            }
        }
        .refreshable { await model.load() }
    }
}
