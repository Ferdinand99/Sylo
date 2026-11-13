import SwiftUI
import SyloKit

/// The server's XP leaderboard: the top ten for all time, this week or this month, and the settings
/// of its public page (a switch, and a short link to share). Mirrors web-v2/src/pages/Leaderboard.jsx.
struct LeaderboardView: View {
    @Environment(AppSession.self) private var session
    @State private var model: LeaderboardModel
    @State private var slugInput = ""

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: LeaderboardModel(server: server, session: session))
    }

    var body: some View {
        Group {
            if let page = model.page {
                content(page)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Leaderboard", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Leaderboard")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.period) { await model.load() }
        .onChange(of: model.page?.vanitySlug, initial: true) { slugInput = model.page?.vanitySlug ?? "" }
    }

    private func content(_ page: LeaderboardPage) -> some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            if !page.levelingEnabled {
                Section {
                    Label("The Leveling module is off. Turn it on from the Modules tab to start ranking members.",
                          systemImage: "info.circle")
                        .font(.subheadline)
                }
            }

            publicSection(page)

            Section {
                Picker("Period", selection: $model.period) {
                    Text("All time").tag(LeaderboardPeriod.allTime)
                    Text("This week").tag(LeaderboardPeriod.week)
                    Text("This month").tag(LeaderboardPeriod.month)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            Section {
                if page.rows.isEmpty {
                    Text("No ranked members yet for this period.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(page.rows) { row in
                        LeaderboardRowView(row: row)
                    }
                }
            } footer: {
                if page.total > page.rows.count {
                    Text("Showing the top \(page.rows.count) of \(DateText.count(page.total)) ranked members.")
                }
            }
        }
        .refreshable { await model.load() }
    }

    @ViewBuilder
    private func publicSection(_ page: LeaderboardPage) -> some View {
        Section {
            Toggle("Public leaderboard", isOn: Binding(
                get: { page.isPublic },
                set: { isOn in Task { await model.setPublic(isOn) } }))
                .disabled(model.isSaving)
            if let message = model.publicError {
                StatusMessage(message, kind: .error)
            }
        } footer: {
            Text("Anyone with the link can view it, without signing in.")
        }

        if page.isPublic {
            Section {
                if let url = session.server.flatMap({ model.publicURL(on: $0) }) {
                    LabeledContent("Link") {
                        Text(verbatim: url.absoluteString)
                            .font(.footnote)
                            .multilineTextAlignment(.trailing)
                            .textSelection(.enabled)
                    }
                    ShareLink(item: url) {
                        Label("Share Link", systemImage: "square.and.arrow.up")
                    }
                }
                LabeledContent("Short link") {
                    TextField("my-server", text: $slugInput)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { Task { await model.saveVanity(slugInput) } }
                }
                if slugInput.trimmingCharacters(in: .whitespacesAndNewlines) != (page.vanitySlug ?? "") {
                    Button(slugInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Remove Short Link" : "Save Short Link") {
                        Task { await model.saveVanity(slugInput) }
                    }
                    .disabled(model.isSaving)
                }
                if let message = model.vanityError {
                    StatusMessage(message, kind: .error)
                }
            } header: {
                Text("Sharing")
            } footer: {
                Text("A short link such as /lb/my-server. Use 3 to 32 letters, numbers or hyphens.")
            }
        }
    }
}

/// One ranked member: rank, name, and what they earned.
private struct LeaderboardRowView: View {
    let row: LeaderboardRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(verbatim: "#\(row.rank)")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 36, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: row.name)
                    .lineLimit(2)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        var parts: [String] = []
        if let level = row.level { parts.append(String(localized: "Level \(DateText.count(level))")) }
        parts.append(String(localized: "\(DateText.count(row.xp)) XP"))
        parts.append(String(localized: "\(DateText.count(row.messages)) messages"))
        return parts.joined(separator: " \u{00B7} ")
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.Leaderboard else { return nil }
        return LeaderboardPage(
            isPublic: true, vanitySlug: "sylo-test", total: 128,
            rows: [
                LeaderboardRow(rank: 1, name: "Alice", level: 12, xp: 14_200, messages: 3100),
                LeaderboardRow(rank: 2, name: "Bob", level: 9, xp: 8_900, messages: 1900),
            ])
    }
    NavigationStack {
        LeaderboardView(server: "1", session: session)
    }
    .environment(session)
}
