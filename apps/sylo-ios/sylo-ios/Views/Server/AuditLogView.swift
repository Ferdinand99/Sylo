import SwiftUI
import SyloKit

/// The server's configuration history: who changed what, newest first, grouped by day. Mirrors
/// web-v2/src/pages/AuditLog.jsx.
struct AuditLogView: View {
    @State private var model: AuditLogModel

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: AuditLogModel(server: server, session: session))
    }

    var body: some View {
        Group {
            if let page = model.page {
                list(page)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load Audit Log", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Audit Log")
        .navigationBarTitleDisplayMode(.inline)
        .task { if model.page == nil { await model.load() } }
    }

    private func list(_ page: AuditLogPage) -> some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            if page.entries.isEmpty {
                Section {
                    Text("Nothing recorded yet.")
                        .foregroundStyle(.secondary)
                } footer: {
                    footer(page)
                }
            } else {
                ForEach(model.days) { day in
                    Section(DateText.day(day.day)) {
                        ForEach(day.entries) { entry in
                            AuditEntryRow(title: model.title(for: entry), entry: entry)
                        }
                    }
                }
                Section {} footer: { footer(page) }
            }
        }
        .refreshable { await model.load() }
    }

    private func footer(_ page: AuditLogPage) -> some View {
        Text("Configuration changes made from the dashboard or the app. Sylo keeps the most recent \(DateText.count(page.kept)) for each server.")
    }
}

/// One change: what, who and when.
private struct AuditEntryRow: View {
    let title: String
    let entry: AuditEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: title)
                .font(.headline)
            Text(verbatim: summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(entry.date, format: .dateTime.hour().minute())
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var summary: String {
        guard let detail = entry.detail else { return entry.actor }
        return entry.actor.isEmpty ? detail : "\(entry.actor) \u{2014} \(detail)"
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        switch endpoint {
        case is Endpoints.AuditLog:
            return AuditLogPage(entries: [
                AuditEntry(id: "2", actor: "Ferdi (dashboard)", action: "module:starboard", detail: "enabled", date: .now),
                AuditEntry(id: "1", actor: "Ferdi (dashboard)", action: "settings:server", detail: nil,
                           date: .now.addingTimeInterval(-90_000)),
            ])
        default:
            return nil
        }
    }
    NavigationStack {
        AuditLogView(server: "1", session: session)
    }
    .environment(session)
}
