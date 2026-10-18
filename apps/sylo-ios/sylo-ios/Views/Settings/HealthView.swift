import SwiftUI
import SyloKit

/// The Health page for Sylo's operators, read only: whether the bot is up, its size, the database
/// and backups, and the stored dev log (Sylo's own errors and warnings). Reached from Settings,
/// and from a dev-log notification.
struct HealthView: View {
    @State private var model: HealthModel

    init(session: AppSession) {
        _model = State(initialValue: HealthModel(session: session))
    }

    var body: some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            if let report = model.report {
                StatusSection(report: report)
                DatabaseSection(report: report)
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
        } header: {
            Text("Database")
        } footer: {
            Text("Backups are made, restored and downloaded from the web dashboard.")
        }
    }
}

private struct DevLogSection: View {
    @Bindable var model: HealthModel

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
