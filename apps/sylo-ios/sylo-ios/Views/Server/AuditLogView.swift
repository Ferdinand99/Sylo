import SwiftUI
import SyloKit

/// The server's configuration history: who changed what, newest first, grouped by day. With Sylo 5.2 an entry
/// that kept what it changed has "Show changes" (a native diff) and, for settings, "Undo this change". Mirrors
/// web-v2/src/pages/AuditLog.jsx.
struct AuditLogView: View {
    @State private var model: AuditLogModel
    private let server: ServerID
    private let session: AppSession

    init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
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
            if model.filterChoices.count > 1 || !model.filter.isEmpty {
                Section {
                    Picker("Show", selection: $model.filter) {
                        Text("All Changes").tag("")
                        ForEach(model.filterChoices) { choice in
                            Text(verbatim: choiceTitle(choice)).tag(choice.action)
                        }
                    }
                }
            }
            if page.entries.isEmpty {
                Section {
                    Text(model.filter.isEmpty ? "Nothing recorded yet." : "Nothing recorded for this kind of change.")
                        .foregroundStyle(.secondary)
                } footer: {
                    footer(page)
                }
            } else {
                ForEach(model.days) { day in
                    Section(DateText.day(day.day)) {
                        ForEach(day.entries) { entry in
                            AuditEntryRow(title: model.title(for: entry), entry: entry, server: server, session: session) {
                                await model.load()
                            }
                        }
                    }
                }
                if page.hasMore {
                    Section {
                        Button {
                            Task { await model.loadMore() }
                        } label: {
                            if model.isLoadingMore {
                                HStack(spacing: 8) {
                                    ProgressView()
                                    Text("Loading\u{2026}")
                                }
                            } else {
                                Text("Show More")
                            }
                        }
                        .disabled(model.isLoadingMore)
                        if let message = model.moreError {
                            StatusMessage(message, kind: .error)
                        }
                    }
                }
                Section {} footer: { footer(page) }
            }
        }
        .refreshable { await model.load() }
        .onChange(of: model.filter) { Task { await model.load() } }
    }

    private func choiceTitle(_ choice: AuditActionCount) -> String {
        let name = AuditAction.title(for: choice.action, moduleNames: model.moduleNames)
        return choice.count > 0 ? "\(name) (\(DateText.count(choice.count)))" : name
    }

    private func footer(_ page: AuditLogPage) -> some View {
        Text("Configuration changes made from the dashboard or the app. Sylo keeps the most recent \(DateText.count(page.kept)) for each server. Open an entry to see what it changed and, for settings, undo it.")
    }
}

/// One change: what, who and when, and where it kept the settings, what they were before.
private struct AuditEntryRow: View {
    let title: String
    let entry: AuditEntry
    let server: ServerID
    let session: AppSession
    /// Reads the list again after an undo, so the new entry shows.
    let onUndone: () async -> Void

    @State private var changes: AuditChangeModel?
    @State private var isOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
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
            // Only a Sylo that announces `config-history` keeps and shows what an entry changed.
            if entry.hasChange, session.has(.configHistory) {
                Button(isOpen ? "Hide Changes" : "Show Changes") {
                    isOpen.toggle()
                    if isOpen {
                        let model = changes ?? AuditChangeModel(server: server, entry: entry.id, session: session)
                        changes = model
                        Task { await model.load() }
                    }
                }
                .buttonStyle(.borderless)
                .font(.subheadline.weight(.semibold))
                .accessibilityHint("What this entry changed")
                if isOpen, let changes {
                    AuditChangeDetail(model: changes, onUndone: onUndone)
                }
            }
        }
    }

    private var summary: String {
        guard let detail = entry.detail else { return entry.actor }
        return entry.actor.isEmpty ? detail : "\(entry.actor) \u{2014} \(detail)"
    }
}

/// What an entry changed, as a list of before and after, and the undo.
private struct AuditChangeDetail: View {
    let model: AuditChangeModel
    let onUndone: () async -> Void

    @Environment(\.dashboardAccess) private var access
    @State private var isConfirming = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch model.phase {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                StatusMessage(message, kind: .error)
            case .ready(let change):
                ready(change)
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func ready(_ change: AuditChange) -> some View {
        if change.isTooLarge {
            Text(verbatim: change.undo.reason ?? "This change was too large to keep a copy of.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else {
            let diff = change.diff
            if diff.rows.isEmpty {
                Text("Nothing differs.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(diff.rows) { row in
                DiffRowView(row: row, names: change.names)
            }
            if diff.more > 0 {
                Text("and \(diff.more) more changed.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        if !change.undo.notRestored.isEmpty {
            Text(verbatim: notRestoredText(change))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        if !change.undo.droppedSecrets.isEmpty {
            Text(verbatim: "\(labels(change.undo.droppedSecrets)) holds a secret that is never stored in the history, so an undo keeps the secret that is saved now and leaves out one that is gone.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        if change.undo.needsConfirmation {
            Label {
                Text(verbatim: laterText(change))
                    .font(.footnote)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
        }
        undoControl(change)
        if change.kind == "module", change.undo.isAvailable {
            Text("Undo restores this module's settings. Lists kept on their own (reminders, shop items and the like) are not part of it and are not restored.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        if let message = model.undoError {
            StatusMessage(message, kind: .error)
        }
        if let done = model.doneMessage, model.undoCount > 0 {
            StatusMessage(done, kind: .notice)
        }
    }

    @ViewBuilder
    private func undoControl(_ change: AuditChange) -> some View {
        if change.undo.isAvailable, access.canEdit {
            Button(role: .destructive) {
                isConfirming = true
            } label: {
                if model.isUndoing {
                    HStack(spacing: 6) {
                        ProgressView()
                        Text("Undoing\u{2026}")
                    }
                } else {
                    Label("Undo This Change", systemImage: "arrow.uturn.backward")
                }
            }
            .buttonStyle(.borderless)
            .disabled(model.isUndoing)
            .confirmationDialog(
                change.undo.needsConfirmation ? "Undo and Lose Later Changes?" : "Undo This Change?",
                isPresented: $isConfirming, titleVisibility: .visible
            ) {
                Button(change.undo.needsConfirmation ? "Undo and Lose Later Changes" : "Undo", role: .destructive) {
                    Task {
                        if await model.undo(confirmed: true) { await onUndone() }
                    }
                }
            } message: {
                Text("The earlier settings are put back through the normal save. The undo is written to the audit log, so it can be undone too.")
            }
        } else if let reason = change.undo.reason, !change.isTooLarge {
            Text(verbatim: reason).font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func labels(_ keys: [String]) -> String {
        keys.map { ConfigDiff.label(for: $0) }.joined(separator: ", ")
    }

    private func notRestoredText(_ change: AuditChange) -> String {
        let lead = change.undo.isAvailable ? "An undo leaves these as they are: " : "Not restored: "
        return lead + change.undo.notRestored.map { "\(ConfigDiff.label(for: $0.key)) (\($0.reason))" }.joined(separator: " ")
    }

    private func laterText(_ change: AuditChange) -> String {
        let which = change.undo.laterChanges.isEmpty ? "" : ": " + labels(change.undo.laterChanges)
        return "These settings were changed again after this entry\(which). Undoing it will lose those later changes."
    }
}

/// One changed setting: its name, then the value before and after in words ("Before", "After", "Added", "Removed").
struct DiffRowView: View {
    let row: ConfigDiff.Row
    let names: [String: String]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: row.pathText)
                .font(.footnote.weight(.semibold))
            switch row.kind {
            case .changed(let before, let after):
                value("Before", before)
                value("After", after)
            case .added(let added):
                value("Added", added)
            case .removed(let removed):
                value("Removed", removed)
            case .list(let added, let removed):
                if !removed.isEmpty { value("Removed", .array(removed)) }
                if !added.isEmpty { value("Added", .array(added)) }
            case .hidden:
                Text("Changed (the value is not shown)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func value(_ word: String, _ value: JSONValue) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: word)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 52, alignment: .leading)
            Text(verbatim: ConfigDiff.format(value, names: names))
                .font(.footnote)
                .textSelection(.enabled)
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        switch endpoint {
        case is Endpoints.AuditLog:
            return AuditLogPage(entries: [
                AuditEntry(id: "2", actor: "Ferdi (dashboard)", action: "module:starboard", detail: "enabled", date: .now,
                           hasChange: true),
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
