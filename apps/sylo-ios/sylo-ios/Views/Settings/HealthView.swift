import SwiftUI
import SyloKit
import UniformTypeIdentifiers

/// The Health page for Sylo's operators, read only: whether the bot is up, its size, the database
/// and backups, and the stored dev log (Sylo's own errors and warnings). Reached from Settings,
/// and from a dev-log notification.
struct HealthView: View {
    @State private var model: HealthModel
    @State private var runner: ActionRunner

    init(session: AppSession) {
        _model = State(initialValue: HealthModel(session: session))
        _runner = State(initialValue: ActionRunner(session: session))
    }

    var body: some View {
        List {
            Group {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            if let report = model.report {
                StatusSection(report: report)
                if report.hasEphemeralSessionSecret {
                    Section {
                        Label("The session secret is generated at every start, so sign-ins and signed links stop working whenever Sylo restarts. Set SESSION_SECRET.", systemImage: "exclamationmark.triangle")
                            .font(.subheadline)
                            .foregroundStyle(Color.syloWarn)
                    }
                }
                DatabaseSection(report: report)
                BackupsSection(report: report, runner: runner) { await model.load() }
                if !report.botAudit.isEmpty {
                    Section("Bot-wide audit log") {
                        ForEach(report.botAudit, id: \.self) { entry in
                            ListLine(
                                title: entry.action,
                                details: [entry.actor, entry.detail, entry.ago].filter { !$0.isEmpty }.joined(separator: " \u{00B7} "))
                        }
                    }
                }
            } else if model.isLoading {
                Section { ProgressView() }
            }
            DevLogSection(model: model)
            }
            .syloSectionCards()
        }
        .syloScreen()
        .navigationTitle("Health")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onChange(of: model.errorsOnly) {
            Task { await model.loadLog() }
        }
    }
}

private struct StatusSection: View {
    let report: HealthReport

    var body: some View {
        Section("Status") {
            LabeledContent("Bot") {
                Label(report.isReady ? "Online" : "Connecting", systemImage: report.isReady ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundStyle(report.isReady ? .green : .orange)
            }
            if let tag = report.botTag { LabeledContent("Signed in as", value: tag) }
            if let version = report.version { LabeledContent("Version", value: version) }
            if let uptime = report.uptime { LabeledContent("Uptime", value: uptime) }
            if let ping = report.gatewayPing { LabeledContent("Gateway ping", value: "\(ping) ms") }
            LabeledContent("Servers", value: report.serverCount.formatted())
            LabeledContent("Members reached", value: report.memberReach.formatted())
            LabeledContent("Open tickets", value: report.openTickets.formatted())
            LabeledContent("Warnings this week", value: report.warningsThisWeek.formatted())
        }
    }
}

private struct DatabaseSection: View {
    let report: HealthReport

    var body: some View {
        Section {
            if let db = report.database {
                LabeledContent("Database", value: db.isPostgres ? "Postgres" : "SQLite")
                if let size = db.size { LabeledContent("Size", value: size) }
                if let hours = db.backupIntervalHours {
                    LabeledContent("Backups", value: hours > 0 ? "Every \(hours.formatted()) h" : "Off")
                }
                LabeledContent("Off-site copies", value: db.offsite ?? "None")
            }
        } header: {
            Text("Database")
        } footer: {
            Text("Make, download, restore, import and delete backups below.")
        }
    }
}

private struct DevLogSection: View {
    @Bindable var model: HealthModel
    @Environment(AppSession.self) private var session
    @State private var errorTestResult: String?

    var body: some View {
        Section {
            Picker("Show", selection: $model.errorsOnly) {
                Text("Errors and Warnings").tag(false)
                Text("Errors").tag(true)
            }
            .pickerStyle(.segmented)
            if model.entries.isEmpty, model.report != nil {
                Label("Nothing logged", systemImage: "checkmark.seal")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.entries) { entry in
                DevLogRow(entry: entry)
            }
        } header: {
            Text("Dev Log")
        } footer: {
            channelFooter
        }
        if model.report?.isDevLogChannelSet == true {
            Section {
                Button {
                    Task { await model.sendTest() }
                } label: {
                    Label("Send Test to Dev-Log Channel", systemImage: "paperplane")
                }
                .disabled(model.isSendingTest)
                switch model.testResult {
                case .sent: Label("Sent. Check the dev-log channel.", systemImage: "checkmark.circle")
                case .failed(let reason): StatusMessage(reason, kind: .error)
                case nil: EmptyView()
                }
                Button {
                    Task {
                        let runner = ActionRunner(session: session)
                        if await runner.run(Endpoints.SendDevLogErrorTest(), changesModules: false) != nil {
                            errorTestResult = String(localized: "Logged. The test error should show up in the dev-log channel and below.")
                            await model.loadLog()
                        } else {
                            errorTestResult = runner.errorMessage
                        }
                    }
                } label: {
                    Label("Log a Test Error", systemImage: "exclamationmark.bubble")
                }
                if let errorTestResult {
                    Text(verbatim: errorTestResult).font(.footnote).foregroundStyle(.secondary)
                }
            } footer: {
                Text("A test error checks the whole error path, not only the channel.")
            }
        }
    }

    @ViewBuilder
    private var channelFooter: some View {
        if model.report?.isDevLogChannelSet == false {
            Text("No dev-log channel is set. Errors and warnings are still kept here, and sent to this app if you turn on dev-log notifications.")
        } else {
            Text("Sylo's own errors and warnings from the last 30 days.")
        }
    }
}

private struct DevLogRow: View {
    let entry: DevLogEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(entry.scope.isEmpty ? "Sylo" : entry.scope, systemImage: symbol)
                    .labelStyle(.titleAndIcon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(entry.level == .error ? .red : .orange)
                Spacer()
                Text(entry.date, format: .relative(presentation: .named))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(verbatim: entry.message)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.level == .error ? "Error" : "Warning"), \(entry.scope): \(entry.message)")
    }

    private var symbol: String {
        entry.level == .error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill"
    }
}

/// The backups: make one, download or delete or restore one, import one from the Files app. Mirrors the
/// "Database & backups" part of web-v2/src/pages/Health.jsx.
private struct BackupsSection: View {
    let report: HealthReport
    let runner: ActionRunner
    let reload: () async -> Void

    @State private var isImporting = false
    @State private var pendingRestore: HealthReport.Backup?
    @State private var pendingDelete: HealthReport.Backup?
    @State private var shared: URL?
    @State private var notice: String?

    var body: some View {
        Section {
            Button {
                Task {
                    if let result = await runner.run(Endpoints.CreateBackup(), changesModules: false) {
                        notice = String(localized: "Backup \(result.name) made.")
                        await reload()
                    }
                }
            } label: {
                HStack {
                    Label("Back Up Now", systemImage: "externaldrive.badge.plus")
                    if runner.isWorking {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(runner.isWorking)
            Button("Import a Backup File", systemImage: "square.and.arrow.down") { isImporting = true }
                .disabled(runner.isWorking)
            if let message = runner.errorMessage {
                StatusMessage(message, kind: .error)
            }
            ForEach(report.backups) { backup in
                LabeledContent {
                    Text("\(backup.size) \u{00B7} \(backup.age)")
                } label: {
                    Text(verbatim: backup.name)
                        .font(.footnote.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = backup }
                    Button("Restore", systemImage: "arrow.counterclockwise") { pendingRestore = backup }
                        .tint(Color.syloWarn)
                    Button("Download", systemImage: "square.and.arrow.up") { download(backup) }
                        .tint(Color.syloCyan)
                }
                .contextMenu {
                    Button("Download", systemImage: "square.and.arrow.up") { download(backup) }
                    Button("Restore", systemImage: "arrow.counterclockwise") { pendingRestore = backup }
                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = backup }
                }
                .accessibilityAction(named: Text("Download")) { download(backup) }
                .accessibilityAction(named: Text("Restore")) { pendingRestore = backup }
                .accessibilityAction(named: Text("Delete")) { pendingDelete = backup }
            }
        } header: {
            Text("Backups")
        } footer: {
            Text("Swipe a backup to download, restore or delete it. Restoring replaces the database with the backup and restarts Sylo.")
        }
        .fileImporter(isPresented: $isImporting, allowedContentTypes: [.data]) { result in
            guard case .success(let url) = result else { return }
            Task { await importFile(url) }
        }
        .sheet(isPresented: isSharing) {
            if let shared { ShareSheet(url: shared) }
        }
        .confirmationDialog(
            "Restore this backup?", isPresented: isConfirmingRestore, titleVisibility: .visible, presenting: pendingRestore
        ) { backup in
            Button("Restore and Restart", role: .destructive) {
                Task {
                    if await runner.run(Endpoints.RestoreBackup(name: backup.name), changesModules: false) != nil {
                        notice = String(localized: "Restoring. Sylo restarts in a moment and is back with the data of the backup.")
                    }
                }
            }
        } message: { backup in
            Text("Everything since \(backup.name) is lost: the database is replaced with it, and Sylo restarts. This can't be undone.")
        }
        .confirmationDialog(
            "Delete this backup?", isPresented: isConfirmingDelete, titleVisibility: .visible, presenting: pendingDelete
        ) { backup in
            Button("Delete Backup", role: .destructive) {
                Task {
                    if await runner.run(Endpoints.DeleteBackup(name: backup.name), changesModules: false) != nil { await reload() }
                }
            }
        } message: { backup in
            Text("\(backup.name) is removed from the server for good.")
        }
        .alert("Done", isPresented: isShowingNotice, presenting: notice) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
    }

    private func download(_ backup: HealthReport.Backup) {
        Task {
            guard let bytes = await runner.run(Endpoints.DownloadBackup(name: backup.name), changesModules: false) else { return }
            do {
                shared = try BackupFiles.write(bytes, name: backup.name)
            } catch {
                runner.errorMessage = String(localized: "Couldn't save the file on this device.")
            }
        }
    }

    private func importFile(_ url: URL) async {
        let granted = url.startAccessingSecurityScopedResource()
        defer { if granted { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            runner.errorMessage = String(localized: "Couldn't read that file.")
            return
        }
        if let result = await runner.run(Endpoints.ImportBackup(data: data), changesModules: false) {
            notice = String(localized: "Imported as \(result.name).")
            await reload()
        }
    }

    private var isSharing: Binding<Bool> {
        Binding(get: { shared != nil }, set: { if !$0 { shared = nil } })
    }

    private var isConfirmingRestore: Binding<Bool> {
        Binding(get: { pendingRestore != nil }, set: { if !$0 { pendingRestore = nil } })
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
    }
}
