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
                BackupsSection(report: report, model: model, runner: runner) { await model.load() }
                if !report.botAudit.isEmpty {
                    Section("Bot-wide audit log") {
                        // By position: two entries can be identical (the same action twice in a row).
                        ForEach(Array(report.botAudit.enumerated()), id: \.offset) { _, entry in
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
        // After a restore Sylo restarts: ask until it answers again, then the page reloads itself.
        .task(id: model.restoringFrom) {
            if model.restoringFrom != nil { await model.waitForRestart() }
        }
        .navigationBarBackButtonHidden(model.restoringFrom != nil)
        .overlay {
            if let name = model.restoringFrom {
                RestoringView(name: name)
            }
        }
    }
}

/// Covers the page while Sylo restarts after a restore, so nothing else can be started, like the
/// dashboard's "Restoring from ..." page.
private struct RestoringView: View {
    let name: String

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Restoring from \(name)")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("Sylo is restarting. This page refreshes itself when Sylo answers again.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
        .accessibilityElement(children: .combine)
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
    @State private var isLoggingTestError = false

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
                    isLoggingTestError = true
                    Task {
                        let runner = ActionRunner(session: session)
                        if await runner.run(Endpoints.SendDevLogErrorTest(), changesModules: false) != nil {
                            errorTestResult = String(localized: "Logged. The test error should show up in the dev-log channel and below.")
                            await model.loadLog()
                        } else {
                            errorTestResult = runner.errorMessage
                        }
                        isLoggingTestError = false
                    }
                } label: {
                    HStack {
                        Label("Log a Test Error", systemImage: "exclamationmark.bubble")
                        if isLoggingTestError {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(isLoggingTestError)
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
    /// What is running, so its own row shows the progress and nothing else can start.
    private enum Work: Equatable {
        case backUp
        case importFile
        case download(String)
        case delete(String)
    }

    let report: HealthReport
    let model: HealthModel
    let runner: ActionRunner
    let reload: () async -> Void

    @State private var isImporting = false
    @State private var pendingRestore: HealthReport.Backup?
    @State private var pendingDelete: HealthReport.Backup?
    @State private var shared: URL?
    @State private var notice: String?
    @State private var work: Work?

    private var isBusy: Bool { work != nil || runner.isWorking || model.restoringFrom != nil }

    var body: some View {
        Section {
            Button {
                Task {
                    work = .backUp
                    defer { work = nil }
                    if let result = await runner.run(Endpoints.CreateBackup(), changesModules: false) {
                        notice = String(localized: "Backup \(result.name) made.")
                        await reload()
                    }
                }
            } label: {
                HStack {
                    Label("Back Up Now", systemImage: "externaldrive.badge.plus")
                    if work == .backUp {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isBusy)
            Button { isImporting = true } label: {
                HStack {
                    Label("Import a Backup File", systemImage: "square.and.arrow.down")
                    if work == .importFile {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isBusy)
            if let message = runner.errorMessage {
                StatusMessage(message, kind: .error)
            }
            ForEach(report.backups) { backup in
                LabeledContent {
                    HStack(spacing: 8) {
                        Text("\(backup.size) \u{00B7} \(backup.age)")
                        if work == .download(backup.name) || work == .delete(backup.name) {
                            ProgressView()
                        }
                    }
                } label: {
                    Text(verbatim: backup.name)
                        .font(.footnote.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = backup }
                        .disabled(isBusy)
                    Button("Restore", systemImage: "arrow.counterclockwise") { pendingRestore = backup }
                        .tint(Color.syloWarn)
                        .disabled(isBusy)
                    Button("Download", systemImage: "square.and.arrow.up") { download(backup) }
                        .tint(Color.syloCyan)
                        .disabled(isBusy)
                }
                .contextMenu {
                    Button("Download", systemImage: "square.and.arrow.up") { download(backup) }
                        .disabled(isBusy)
                    Button("Restore", systemImage: "arrow.counterclockwise") { pendingRestore = backup }
                        .disabled(isBusy)
                    Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = backup }
                        .disabled(isBusy)
                }
                .accessibilityAction(named: Text("Download")) { if !isBusy { download(backup) } }
                .accessibilityAction(named: Text("Restore")) { if !isBusy { pendingRestore = backup } }
                .accessibilityAction(named: Text("Delete")) { if !isBusy { pendingDelete = backup } }
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
        .sheet(item: $pendingRestore) { backup in
            RestoreBackupSheet(backup: backup, model: model)
        }
        .confirmationDialog(
            "Delete this backup?", isPresented: isConfirmingDelete, titleVisibility: .visible, presenting: pendingDelete
        ) { backup in
            Button("Delete Backup", role: .destructive) {
                Task {
                    work = .delete(backup.name)
                    defer { work = nil }
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
        guard !isBusy else { return }
        Task {
            work = .download(backup.name)
            defer { work = nil }
            guard let bytes = await runner.run(Endpoints.DownloadBackup(name: backup.name), changesModules: false) else { return }
            do {
                shared = try BackupFiles.write(bytes, name: backup.name)
            } catch {
                runner.errorMessage = String(localized: "Couldn't save the file on this device.")
            }
        }
    }

    /// Reads the file off the main actor (a backup can be 100 MB), after checking its size, then
    /// sends it.
    private func importFile(_ url: URL) async {
        guard !isBusy else { return }
        work = .importFile
        defer { work = nil }
        runner.errorMessage = nil
        let granted = url.startAccessingSecurityScopedResource()
        defer { if granted { url.stopAccessingSecurityScopedResource() } }
        let read = await Task.detached { Result { try BackupFiles.read(from: url) } }.value
        let data: Data
        switch read {
        case .success(let bytes):
            data = bytes
        case .failure(let error):
            runner.errorMessage = (error as? BackupFiles.ReadError) == .tooLarge
                ? String(localized: "That file is bigger than 128 MB, the most Sylo accepts.")
                : String(localized: "Couldn't read that file.")
            return
        }
        if let result = await runner.run(Endpoints.ImportBackup(data: data), changesModules: false) {
            notice = String(localized: "Imported as \(result.name).")
            await reload()
        }
    }

    /// Closing the share sheet deletes the file: it holds the server's data.
    private var isSharing: Binding<Bool> {
        Binding(
            get: { shared != nil },
            set: {
                if !$0 {
                    SharedFiles.remove(shared)
                    shared = nil
                }
            })
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var isShowingNotice: Binding<Bool> {
        Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
    }
}

/// Restoring replaces the whole database, so the operator types the backup's name first, as on the
/// dashboard (`onRestoreBackup` in web-v2/src/pages/Health.jsx).
private struct RestoreBackupSheet: View {
    let backup: HealthReport.Backup
    let model: HealthModel

    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var isRestoring = false

    private var matches: Bool { typed.trimmingCharacters(in: .whitespacesAndNewlines) == backup.name }

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    Section {
                        Text("All current data is replaced with \(backup.name) and Sylo restarts. A prerestore snapshot is taken first. If this device was signed in after \(backup.name), you'll need to sign in again.")
                    }
                    Section {
                        TextField("Backup name", text: $typed)
                            .font(.footnote.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } header: {
                        Text("Type the backup name")
                    } footer: {
                        Text(verbatim: backup.name)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    }
                    if let message = model.restoreError {
                        Section { StatusMessage(message, kind: .error) }
                    }
                    Section {
                        Button(role: .destructive) {
                            isRestoring = true
                            Task {
                                if await model.beginRestore(backup: backup.name) { dismiss() }
                                isRestoring = false
                            }
                        } label: {
                            HStack {
                                Text("Restore and Restart")
                                if isRestoring {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(!matches || isRestoring)
                    }
                }
                .syloSectionCards()
            }
            .syloFormStyle()
            .navigationTitle("Restore the Database")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isRestoring)
                }
            }
        }
        .interactiveDismissDisabled(isRestoring)
        .presentationDragIndicator(.visible)
        .onAppear { model.restoreError = nil }
    }
}
