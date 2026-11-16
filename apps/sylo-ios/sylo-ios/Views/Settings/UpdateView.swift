import SwiftUI
import SyloKit
import UIKit

/// The operators' update notice (Sylo 5.3): whether a newer Sylo is out, what is in it, the command to update by
/// hand and, when the Sylo runs Wise Wren, "Update now" with its progress. Reached from Settings, for an operator, on
/// a server that announces `update-notice`.
struct UpdateView: View {
    let model: UpdateModel

    @State private var isConfirmingUpdate = false
    @State private var didCopy = false

    var body: some View {
        List {
            if let message = model.errorMessage {
                Section { StatusMessage(message, kind: .error) }
            }
            if let status = model.status {
                noticeSection(status)
                if status.isAvailable {
                    commandSection(status)
                }
                wrenSection(status)
            } else if model.isLoading {
                Section { ProgressView() }
            } else if model.isRefused {
                Section { OperatorRefusedView() }
            }
        }
        .navigationTitle("Updates")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load(refresh: true) }
        // Leaving the screen stops the asking; coming back reads the run again.
        .onDisappear { model.stop() }
        .confirmationDialog(
            "Update Sylo to \(model.status?.latest ?? "the new version")?", isPresented: $isConfirmingUpdate,
            titleVisibility: .visible
        ) {
            Button("Update Now") { Task { await model.approve() } }
        } message: {
            Text("Wise Wren stops Sylo for a short while, takes a snapshot, starts the new version and rolls back if it does not come up healthy. The dashboard, the bot and this app are offline meanwhile.")
        }
    }

    // MARK: - The notice

    private func noticeSection(_ status: UpdateStatus) -> some View {
        Section {
            Label {
                Text(verbatim: status.headline)
            } icon: {
                Image(systemName: status.isAvailable ? "arrow.down.circle.fill" : "checkmark.circle")
                    .foregroundStyle(status.isAvailable ? Color.accentColor : Color.secondary)
            }
            if status.isAvailable, let url = status.releaseURL {
                Link(destination: url) {
                    Label("Release on GitHub", systemImage: "arrow.up.right.square")
                }
            }
            if status.isAvailable {
                if let notes = status.notes, !notes.sections.isEmpty {
                    NavigationLink {
                        UpdateNotesView(release: notes)
                    } label: {
                        Label("What's in This Release", systemImage: "sparkles")
                    }
                } else if let text = status.notesText, !text.isEmpty {
                    Text(verbatim: text)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if status.isEnabled, status.checkFailed, status.latest != nil {
                Text("The last check failed; this is from an earlier one.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if status.isEnabled {
                Button {
                    Task { await model.load(refresh: true) }
                } label: {
                    Label("Check Again", systemImage: "arrow.clockwise")
                }
                .disabled(model.isLoading)
            }
        } footer: {
            if status.isEnabled {
                Text("Sylo asks GitHub for its newest release at most every 6 hours. A server admin can turn this off with UPDATE_CHECK=off.")
            }
        }
    }

    private func commandSection(_ status: UpdateStatus) -> some View {
        Section {
            Text(verbatim: status.command)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
            Button {
                UIPasteboard.general.string = status.command
                didCopy = true
            } label: {
                Label(didCopy ? "Copied" : "Copy Command", systemImage: didCopy ? "checkmark" : "doc.on.doc")
            }
            .sensoryFeedback(.success, trigger: didCopy)
        } header: {
            Text("Update by hand")
        } footer: {
            Text("Run this where Sylo's compose file is.")
        }
    }

    // MARK: - Wise Wren

    @ViewBuilder
    private func wrenSection(_ status: UpdateStatus) -> some View {
        if let wren = status.wren {
            Section {
                if let progress = model.progress {
                    progressRows(progress)
                } else if let problem = wren.error {
                    StatusMessage(problem.message, kind: .error)
                } else {
                    Text(verbatim: wrenLine(wren))
                    if let why = wren.whyNot, status.isAvailable || wren.updateSeen {
                        Text(verbatim: why)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if let message = model.actionError {
                    StatusMessage(message, kind: .error)
                }
                if model.progress == nil, status.offersUpdateNow {
                    Button {
                        isConfirmingUpdate = true
                    } label: {
                        if model.isApproving {
                            HStack {
                                Text("Starting\u{2026}")
                                Spacer()
                                ProgressView()
                            }
                        } else {
                            Label("Update Now", systemImage: "arrow.down.circle")
                        }
                    }
                    .disabled(!wren.canApprove || model.isApproving)
                }
            } header: {
                Text("Wise Wren")
            }
        } else if status.isAvailable {
            Section {
                Link(destination: Self.wiseWrenURL) {
                    Label("About Wise Wren", systemImage: "arrow.up.right.square")
                }
            } header: {
                Text("Update from here")
            } footer: {
                Text("Wise Wren can update Sylo from the app, without a command line. A server admin sets it up with WISE_WREN_URL, WISE_WREN_TOKEN and WISE_WREN_TARGET_ID (see the self-hosting guide).")
            }
        }
    }

    private static let wiseWrenURL = URL(string: "https://github.com/Ferdinand99/Wise-Wren")!

    private func wrenLine(_ wren: WrenStatus) -> String {
        guard let target = wren.target else {
            return String(localized: "Wise Wren is connected. Its token cannot read the target, so the check above decides.")
        }
        return wren.updateSeen
            ? String(localized: "Wise Wren sees an update for \(target.name).")
            : String(localized: "Wise Wren does not see an update for \(target.name) yet.")
    }

    @ViewBuilder
    private func progressRows(_ progress: UpdateProgress) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if progress.isDone {
                Image(systemName: progress.tone == .failure || progress.timedOut ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(progress.tone == .failure || progress.timedOut ? Color.orange : Color.green)
            } else {
                ProgressView()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: progress.text)
                if let step = progress.step {
                    Text(verbatim: step)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
        if let problem = progress.problem {
            StatusMessage(problem, kind: .error)
        }
        if progress.timedOut {
            StatusMessage(
                "Sylo has not come back after 30 minutes. Look at the run in Wise Wren and at Sylo's container.",
                kind: .error)
        }
        if progress.isDone {
            Button("Close") { model.closeProgress() }
        }
    }
}

/// The release notes of the update that is available, as the What's New screen shows a release.
struct UpdateNotesView: View {
    let release: ChangelogRelease

    var body: some View {
        List {
            ForEach(release.sections.indices, id: \.self) { index in
                let section = release.sections[index]
                Section {
                    KindLabel(section: section)
                    ForEach(section.items.indices, id: \.self) { itemIndex in
                        ChangeRow(item: section.items[itemIndex])
                    }
                }
            }
        }
        .navigationTitle("Sylo \(release.version)")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The Updates row of the Operator section: the status in words, with a dot while there is something to do. It owns
/// the model, so the screen it opens shows what the row already read.
struct UpdatesRow: View {
    let account: AccountModel
    let session: AppSession
    @State private var model: UpdateModel

    init(account: AccountModel, session: AppSession) {
        self.account = account
        self.session = session
        _model = State(initialValue: UpdateModel(session: session))
    }

    var body: some View {
        NavigationLink {
            OperatorGate(account: account) { UpdateView(model: model) }
        } label: {
            HStack {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Updates")
                        if let status = model.status {
                            Text(verbatim: status.summary)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    Image(systemName: "arrow.down.circle")
                }
                if model.status?.needsAttention == true {
                    Spacer()
                    Image(systemName: "circle.fill")
                        .font(.caption2)
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Update available")
                }
            }
        }
        .task(id: session.generation) { await model.load() }
    }
}
