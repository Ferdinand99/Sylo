import SwiftUI
import SyloKit

/// The Health page for Sylo's operators: whether the bot is up, its size, the database and its
/// backups (managed on their own screen), and the stored dev log (Sylo's own errors and warnings)
/// with its two tests. Reached from Settings, and from a dev-log notification.
struct HealthView: View {
    let session: AppSession
    @State private var model: HealthModel

    init(session: AppSession) {
        self.session = session
        _model = State(initialValue: HealthModel(session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            if let report = model.report {
                StatusSection(report: report)
                DatabaseSection(report: report, session: session)
            } else if model.isLoading {
                Section { ProgressView() }
            }
            DevLogSection(model: model)
        }
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
    let session: AppSession

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
            ForEach(report.backups.prefix(5)) { backup in
                LabeledContent {
                    Text("\(backup.size) · \(backup.age)")
                } label: {
                    Text(verbatim: backup.name)
                        .font(.footnote.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            NavigationLink {
                BackupsView(session: session)
            } label: {
                Label("Manage Backups", systemImage: "externaldrive")
            }
        } header: {
            Text("Database")
        } footer: {
            Text("Create, download, import, restore and delete backups. A backup holds the personal data of every server.")
        }
    }
}

private struct DevLogSection: View {
    @Bindable var model: HealthModel
    @State private var isConfirmingErrorTest = false

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
            }
            Section {
                Button {
                    isConfirmingErrorTest = true
                } label: {
                    Label("Trigger a Real Error", systemImage: "exclamationmark.octagon")
                }
                .disabled(model.isSendingErrorTest)
                .confirmationDialog(
                    "Trigger a real error?", isPresented: $isConfirmingErrorTest, titleVisibility: .visible
                ) {
                    Button("Trigger Error") { Task { await model.sendErrorTest() } }
                } message: {
                    Text("Sylo logs an error on purpose. It goes to the dev-log channel and to every operator who gets dev-log notifications. An identical test is not posted again within 5 minutes.")
                }
                switch model.errorTestResult {
                case .sent: Label("Logged. Check the dev-log channel in a moment.", systemImage: "checkmark.circle")
                case .failed(let reason): StatusMessage(reason, kind: .error)
                case nil: EmptyView()
                }
            } footer: {
                Text("Logs a real error on the server to test the whole error pipeline. Every operator who gets dev-log notifications is notified.")
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
