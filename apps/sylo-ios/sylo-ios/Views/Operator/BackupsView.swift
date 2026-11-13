import SwiftUI
import SyloKit
import UniformTypeIdentifiers

/// The database backups of a Sylo server, for its operators: list, create, import a file, and (on each
/// backup's own screen) download, restore and delete. A backup holds the personal data of every server on
/// this Sylo, so a downloaded file only opens in Quick Look and the share sheet, and restoring or
/// importing asks for a typed word. Mirrors the "Database & backups" part of web-v2/src/pages/Health.jsx.
struct BackupsView: View {
    let session: AppSession
    @State private var model: BackupsModel
    @State private var importer: BackupImportModel
    @State private var isChoosingFile = false
    @State private var isConfirmingImport = false
    /// The file the person chose, kept open (it is outside the app) until the import is over.
    @State private var picked: PickedBackupFile?
    @State private var pickError: String?
    /// Keeps the upload going for a little while if the app is sent to the background.
    @State private var background = BackgroundActivity()

    init(session: AppSession) {
        self.session = session
        _model = State(initialValue: BackupsModel(session: session))
        _importer = State(initialValue: BackupImportModel(session: session))
    }

    var body: some View {
        Group {
            if model.isRefused {
                OperatorRefusedView()
            } else if let restoring = model.restoring {
                RestoringView(name: restoring)
            } else if model.report != nil {
                content
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load the Backups", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Backups")
        .navigationBarTitleDisplayMode(.inline)
        .task { if model.report == nil { await model.load() } }
        .fileImporter(isPresented: $isChoosingFile, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
            choose(result)
        }
        .typedConfirmation(importConfirmation, isPresented: $isConfirmingImport) { typed in
            guard let picked else { return }
            importer.start(fileURL: picked.url, typed: typed)
        }
        .onChange(of: importer.phase) { _, phase in
            if case .imported = phase {
                picked = nil
                Task { await model.load() }
            }
        }
        .onChange(of: importer.isUploading) { _, isUploading in
            if isUploading {
                background.begin("Backup import") { importer.cancel() }
            } else {
                background.end()
            }
        }
        // Another account signed in: the chosen file was for the earlier one.
        .onChange(of: session.generation) { picked = nil }
        .onDisappear {
            // Leaving the screen stops an upload in flight; nothing is kept on the server.
            importer.cancel()
            background.end()
        }
    }

    private var content: some View {
        List {
            if let notice = model.notice {
                Section { StatusMessage(notice, kind: .notice) }
            }
            if let message = model.actionError {
                Section { StatusMessage(message, kind: .error) }
            }
            if let database = model.report?.database {
                Section("Database") {
                    LabeledContent("Kind", value: database.isPostgres ? "Postgres" : "SQLite")
                    if let size = database.size { LabeledContent("Size", value: size) }
                    if let hours = database.backupIntervalHours {
                        LabeledContent("Automatic backups", value: hours > 0 ? "Every \(hours.formatted()) h" : "Off")
                    }
                    if let kept = database.backupsKept { LabeledContent("Kept", value: kept.formatted()) }
                    LabeledContent("Off-site copies", value: database.offsite ?? "None")
                }
            }
            Section {
                Button {
                    Task { await model.create() }
                } label: {
                    HStack {
                        Label("Create Backup Now", systemImage: "externaldrive.badge.plus")
                        Spacer()
                        if model.isWorking { ProgressView() }
                    }
                }
                .disabled(model.isWorking || importer.isUploading)
            }
            importSection
            Section {
                if model.backups.isEmpty {
                    Text("No snapshots yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.backups) { backup in
                    NavigationLink {
                        BackupDetailView(backup: backup, model: model, session: session)
                    } label: {
                        BackupRow(backup: backup)
                    }
                    .disabled(importer.isUploading)
                }
            } header: {
                Text("Snapshots")
            } footer: {
                Text("Snapshots are written to the backups folder on the server. Open one to download, restore or delete it.")
            }
        }
        .refreshable { await model.load() }
    }

    // MARK: - Import

    @ViewBuilder
    private var importSection: some View {
        Section {
            switch importer.phase {
            case .uploading:
                VStack(alignment: .leading, spacing: 8) {
                    if let fraction = importer.fraction {
                        ProgressView(value: fraction) {
                            Text("Uploading \(picked?.url.lastPathComponent ?? "")")
                        } currentValueLabel: {
                            Text(verbatim: Self.sizes(importer.bytesSent, of: importer.bytesTotal))
                        }
                    } else {
                        ProgressView("Starting the upload")
                    }
                    Button("Cancel Import", role: .destructive) { importer.cancel() }
                }
            case .idle, .imported, .failed:
                if let picked {
                    LabeledContent("File") {
                        Text(verbatim: picked.url.lastPathComponent)
                            .font(.footnote.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    LabeledContent("Size", value: Self.size(picked.byteCount))
                    Button("Import\u{2026}") { isConfirmingImport = true }
                        .disabled(model.isWorking)
                    Button("Choose Another File\u{2026}") { isChoosingFile = true }
                } else {
                    Button {
                        pickError = nil
                        importer.reset()
                        isChoosingFile = true
                    } label: {
                        Label("Choose Backup File\u{2026}", systemImage: "doc.badge.plus")
                    }
                    .disabled(model.isWorking)
                }
                if let pickError {
                    StatusMessage(pickError, kind: .error)
                }
                switch importer.phase {
                case .imported(let name):
                    StatusMessage("Imported \(name). Open it in the list and use Restore to load it.", kind: .notice)
                case .failed(let message):
                    StatusMessage(message, kind: .error)
                default:
                    EmptyView()
                }
            }
        } header: {
            Text("Import")
        } footer: {
            Text("Importing stores the file as a snapshot (up to 128 MB); you then restore it. Restoring replaces the live database and restarts the bot, with a prerestore snapshot taken first.")
        }
    }

    private var importConfirmation: OperatorConfirmation {
        .importFile(name: picked?.url.lastPathComponent ?? "")
    }

    private func choose(_ result: Result<[URL], any Error>) {
        pickError = nil
        importer.reset()
        guard case .success(let urls) = result, let url = urls.first else { return }
        guard let file = PickedBackupFile(url) else {
            pickError = "That file can't be read."
            return
        }
        if file.byteCount > BackupLimits.maxImportBytes {
            pickError = "That file is \(Self.size(file.byteCount)). The server takes backup files of up to 128 MB."
            return
        }
        picked = file
    }

    private static func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private static func sizes(_ sent: Int64, of total: Int64) -> String {
        "\(size(sent)) of \(size(total))"
    }
}

/// A file chosen with the Files picker. It lives outside the app, so the app must ask for access and
/// keep it while the file is read (the upload reads it from the disk as it goes); the access ends when
/// this goes away.
private final class PickedBackupFile {
    let url: URL
    let byteCount: Int64
    private let isScoped: Bool

    init?(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize else {
            if scoped { url.stopAccessingSecurityScopedResource() }
            return nil
        }
        self.url = url
        self.byteCount = Int64(size)
        self.isScoped = scoped
    }

    deinit {
        if isScoped { url.stopAccessingSecurityScopedResource() }
    }
}

private struct BackupRow: View {
    let backup: HealthReport.Backup

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: backup.name)
                .font(.footnote.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
            Text(verbatim: [backup.size, backup.age].filter { !$0.isEmpty }.joined(separator: " \u{00B7} "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// What the screen shows from the moment the server takes a restore until Sylo answers again.
private struct RestoringView: View {
    let name: String

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Restoring")
                .font(.headline)
            Text("Sylo is restoring from \(name) and restarting. This screen refreshes when it answers again.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// One backup: what it is, and download, restore and delete.
private struct BackupDetailView: View {
    let backup: HealthReport.Backup
    let model: BackupsModel

    @Environment(\.dismiss) private var dismiss
    @State private var download: FileDownloadModel
    /// The downloaded file while Quick Look shows it.
    @State private var previewed: DownloadedFile?
    @State private var isConfirmingRestore = false
    @State private var isConfirmingDelete = false

    init(backup: HealthReport.Backup, model: BackupsModel, session: AppSession) {
        self.backup = backup
        self.model = model
        _download = State(initialValue: FileDownloadModel(session: session))
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Name") {
                    Text(verbatim: backup.name)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                }
                LabeledContent("Size", value: backup.size)
                LabeledContent("Taken", value: backup.age)
            }
            if let message = model.actionError {
                Section { StatusMessage(message, kind: .error) }
            }
            downloadSection
            Section {
                Button("Restore\u{2026}", role: .destructive) { isConfirmingRestore = true }
                    .disabled(model.isWorking)
            } footer: {
                Text("Restoring replaces the live database with this backup and restarts the bot. It changes the data of every server at once.")
            }
            Section {
                Button("Delete Backup\u{2026}", role: .destructive) { isConfirmingDelete = true }
                    .disabled(model.isWorking)
            }
        }
        .navigationTitle("Backup")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { model.actionError = nil }
        .typedConfirmation(.restore(backup: backup.name), isPresented: $isConfirmingRestore) { typed in
            Task { await model.restore(backup.name, typed: typed) }
        }
        .typedConfirmation(.deleteBackup(name: backup.name), isPresented: $isConfirmingDelete) { typed in
            Task {
                if await model.delete(backup.name, typed: typed) { dismiss() }
            }
        }
        .onDisappear { download.cancel() }
        // The list shows the restore from here on.
        .onChange(of: model.restoring) { _, restoring in
            if restoring != nil { dismiss() }
        }
    }

    /// Download with progress and Cancel, then Quick Look (which has Share). Leaving the screen stops it.
    private var downloadSection: some View {
        Section {
            if download.isDownloading {
                VStack(alignment: .leading, spacing: 8) {
                    if let fraction = download.fraction {
                        ProgressView(value: fraction) {
                            Text("Downloading")
                        } currentValueLabel: {
                            Text(verbatim: "\(Self.size(download.bytesReceived)) of \(Self.size(download.bytesExpected))")
                        }
                    } else {
                        ProgressView {
                            Text(verbatim: "Downloading \(Self.size(download.bytesReceived))")
                        }
                    }
                    Button("Cancel Download", role: .destructive) { download.cancel() }
                }
            } else {
                Button {
                    Task {
                        if await download.download(Endpoints.DownloadBackup(name: backup.name)) { previewed = download.file }
                    }
                } label: {
                    Label("Download Backup", systemImage: "square.and.arrow.down")
                }
                .fileQuickLook($previewed) { download.clear() }
            }
            if let message = download.errorMessage {
                StatusMessage(message, kind: .error)
            }
        } footer: {
            Text("A backup holds the personal data of every server on this Sylo. It opens in Quick Look, where you can read or share it. The temporary copy is deleted when you close it, when you sign out and when the app starts.")
        }
    }

    private static func size(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
