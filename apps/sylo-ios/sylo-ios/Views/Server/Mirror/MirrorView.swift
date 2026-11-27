import SwiftUI
import SyloKit

/// Mirror to Fluxer (Sylo 5.3): copy a Discord server's structure to a Fluxer server and keep it in step. The same
/// screen serves both servers of a pair. On the Discord server its owner asks for a mirror (picking one of their
/// Fluxer servers, or typing an id), looks at the preview and starts the copy. On the Fluxer server its owner agrees
/// with the code, may allow real deletion, and may pause or stop. Everyone with access reads it; only the owner of
/// the server shown changes anything. Mirrors web-v2/src/pages/Mirror.jsx.
struct MirrorView: View {
    @State private var model: MirrorModel
    @State private var isConfirmingStart = false
    @State private var isConfirmingStop = false
    @State private var isConfirmingAllow = false
    @State private var isCopyingAgain = false

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: MirrorModel(server: server, session: session))
    }

    var body: some View {
        content
            .navigationTitle("Mirror to Fluxer")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await model.load()
                await model.loadFluxerServers()
            }
            // While a copy or a sync runs, the progress is read again every few seconds.
            .task(id: model.state?.isBusy == true) {
                if model.state?.isBusy == true { await model.followProgress() }
            }
            .refreshable { await model.load() }
            .confirmationDialog(
                startTitle, isPresented: $isConfirmingStart, titleVisibility: .visible
            ) {
                Button("Start the Copy") { Task { await model.start() } }
            } message: {
                Text("Sylo creates the channels, roles and emoji you saw in the preview on the Fluxer server. It does not delete anything there. You can pause or stop the mirror at any time.")
            }
            .confirmationDialog("Stop the mirror?", isPresented: $isConfirmingStop, titleVisibility: .visible) {
                Button("Stop", role: .destructive) { Task { await model.stop() } }
            } message: {
                if model.state?.platform == .fluxer {
                    Text("Sylo stops following the Discord server. What it made here stays.")
                } else {
                    Text("Sylo stops copying and following changes. Everything it made on Fluxer stays. Starting again needs both servers to agree again.")
                }
            }
            .confirmationDialog(
                "Allow deleting on this server?", isPresented: $isConfirmingAllow, titleVisibility: .visible
            ) {
                Button("Allow Deleting", role: .destructive) { Task { await model.allowDeletes(true) } }
            } message: {
                Text("From now on, what is deleted on Discord is deleted here too: a channel loses all its messages, including ones that only exist here. Only what Sylo made is ever deleted. Without this, deleted items are only locked and listed for you to look at.")
            }
            .alert("Apply the deletions on Fluxer?", isPresented: isConfirmingDeletions, presenting: model.deletionsToConfirm) { _ in
                Button("Apply the Deletions", role: .destructive) { Task { await model.confirmDeletions() } }
                Button("Cancel", role: .cancel) {}
            } message: { deletions in
                Text(verbatim: String(localized: "These were deleted on Discord and wait to be applied on Fluxer: \(MirrorText.deleteSummary(deletions)). A locked channel or role stays on Fluxer; a deleted channel loses its messages. Stop the mirror instead if this was a mistake."))
            }
            .alert("Couldn't Change the Mirror", isPresented: isShowingError, presenting: model.actionError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
            .sheet(isPresented: $isCopyingAgain) {
                NavigationStack {
                    MirrorCopyAgainView(model: model)
                }
            }
            .sensoryFeedback(.success, trigger: model.successCount)
    }

    @ViewBuilder
    private var content: some View {
        if let state = model.state {
            Form {
                if let message = model.errorMessage {
                    Section { StatusMessage(message, kind: .error) }
                }
                if let notice = model.notice {
                    Section { StatusMessage(notice, kind: .notice) }
                }
                if state.platform == .discord {
                    sourceSections(state)
                } else {
                    targetSections(state)
                }
            }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load the Mirror", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    private var startTitle: String {
        let name = model.preview?.targetName ?? model.pair?.otherName
        return name.map { String(localized: "Copy this server to \($0)?") } ?? String(localized: "Copy this server to the Fluxer server?")
    }

    // MARK: - The Discord server

    @ViewBuilder
    private func sourceSections(_ state: MirrorState) -> some View {
        Section {
            Text("Mirror this server to a Fluxer server: Sylo creates the same categories, channels, roles and emoji there and keeps them in step when you change them here. Only the owner of this server, and the owner of the Fluxer server, can set up and run a mirror.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            MirrorStepper(step: state.step)
        }
        if !state.isOwner {
            Section {
                StatusMessage(String(localized: "Only the server owner can change the mirror. You can look at everything here, but not change it."), kind: .notice)
            }
        }
        switch state.step {
        case .ask: askSections(state)
        case .agree: if let pair = state.pair { agreeSection(pair) }
        case .preview: if let pair = state.pair { previewSections(pair, state: state) }
        case .copy: if let pair = state.pair { runningSections(pair, state: state) }
        }
    }

    @ViewBuilder
    private func askSections(_ state: MirrorState) -> some View {
        if !state.fluxerConnected {
            Section {
                StatusMessage(String(localized: "This Sylo is not connected to Fluxer, so there is nothing to mirror to."), kind: .notice)
            }
        }
        Section("Ask for a Mirror") {
            Label("On Fluxer, create an empty server for the mirror.", systemImage: "1.circle")
            Label("Invite Sylo to it and give Sylo's role the Administrator permission, at the top of the roles.", systemImage: "2.circle")
            Label("Pick that Fluxer server below.", systemImage: "3.circle")
            MirrorFacts(state: state)
        }
        MirrorServerPicker(model: model, state: state)
        Section {
            Button("Ask for the Mirror") { Task { await model.requestMirror() } }
                .disabled(!model.canAsk)
        }
    }

    @ViewBuilder
    private func agreeSection(_ pair: MirrorPair) -> some View {
        Section {
            Text("Nothing is created until the owner of the Fluxer server has agreed. Ask them to open Sylo for that server (in this app or on the web), go to Mirror to Fluxer and enter the code.")
            if let code = model.code {
                Text(verbatim: code)
                    .font(.title3.monospaced().weight(.semibold))
                    .textSelection(.enabled)
                CopyValueButton(title: "Copy Code", value: code)
            } else {
                Text("The code is shown once, when you ask. If you lost it, ask again for a new one.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Waiting for the Fluxer Server")
        } footer: {
            Text(verbatim: codeFooter(pair))
        }
        Section {
            Button("Ask Again with a New Code") { Task { await model.requestMirror(again: pair.otherID) } }
            Button("Cancel the Request", role: .destructive) { Task { await model.remove() } }
        }
        .disabled(!model.isOwner || model.isWorking)
    }

    private func codeFooter(_ pair: MirrorPair) -> String {
        let left = MirrorText.codeLeft(until: pair.codeExpiresAt).map { String(localized: "The code works for another \($0).") }
            ?? String(localized: "The code has expired.")
        return left + " " + String(localized: "Asking again gives a new one. If you own the Fluxer server yourself, add your Fluxer login to your account (Settings, then Account) and ask again: both sides agree at once.")
    }

    @ViewBuilder
    private func previewSections(_ pair: MirrorPair, state: MirrorState) -> some View {
        Section {
            ForEach(MirrorOptionKey.allCases) { key in
                MirrorOptionToggle(key: key, options: pair.options, model: model)
            }
        } header: {
            Text(verbatim: pair.otherName.map { String(localized: "Preview for \($0)") } ?? String(localized: "Preview"))
        } footer: {
            Text("Both servers agreed. The preview shows what the copy would do and what cannot be carried over. It creates nothing.")
        }
        Section {
            Button(model.preview == nil ? "Show the Preview" : "Look Again") { Task { await model.loadPreview() } }
                .disabled(model.isLoadingPreview)
            if model.isLoadingPreview {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Reading both servers…").foregroundStyle(.secondary)
                }
            }
            if let problem = model.previewError {
                StatusMessage(problem, kind: .error)
            }
            Button("Cancel the Mirror", role: .destructive) { Task { await model.remove() } }
                .disabled(!model.isOwner || model.isWorking)
        }
        if let preview = model.preview {
            MirrorPreviewSections(preview: preview)
            Section {
                Button(String(localized: "Copy to \(preview.targetName ?? "Fluxer")")) { isConfirmingStart = true }
                    .disabled(!preview.ok || !model.isOwner || model.isWorking)
            } footer: {
                if !model.isOwner {
                    Text("Only the server owner can do this.")
                }
            }
        }
    }

    @ViewBuilder
    private func runningSections(_ pair: MirrorPair, state: MirrorState) -> some View {
        Section {
            LabeledContent(pair.otherName ?? String(localized: "Fluxer server")) {
                Text(verbatim: pair.status.title).foregroundStyle(pair.status.color)
            }
            if pair.status == .stopped {
                Text("The mirror was stopped. What Sylo made on Fluxer is still there. To mirror again, ask for a new mirror; the same Fluxer server picks up where this one left off.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let progress = state.progress, progress.total > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    ProgressView(value: Double(progress.percent), total: 100)
                        .accessibilityLabel("Copy progress")
                    Text(verbatim: progress.text)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if pair.status == .live {
                Text(verbatim: liveText(pair, progress: state.progress))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        MirrorPauseSection(pair: pair, model: model)
        Section {
            if pair.status.isRunning {
                Button("Pause", systemImage: "pause.circle") { Task { await model.pause() } }
            }
            if pair.canCopyAgain {
                Button("Copy Again", systemImage: "arrow.triangle.2.circlepath") { isCopyingAgain = true }
            }
            if pair.status != .stopped {
                Button("Stop", systemImage: "stop.circle", role: .destructive) { isConfirmingStop = true }
            } else {
                Button("Remove the Mirror", systemImage: "trash", role: .destructive) { Task { await model.remove() } }
            }
        }
        .disabled(!model.isOwner || model.isWorking)
        MirrorRemovedSection(progress: state.progress)
        Section {
            MirrorOptionToggle(key: .continuous, options: pair.options, model: model)
        } header: {
            Text("What Is Mirrored")
        } footer: {
            Text("Changes on Fluxer to mirrored channels and roles are overwritten the next time that item changes on Discord. Sylo never deletes something on Fluxer that it did not create.")
        }
        if pair.copyRun > 0 {
            Section("Report") {
                Button(model.report == nil ? "Show the Report" : "Refresh the Report") { Task { await model.loadReport() } }
                if let report = model.report {
                    MirrorReportRows(report: report)
                }
            }
        }
    }

    private func liveText(_ pair: MirrorPair, progress: MirrorProgress?) -> String {
        var text = String(localized: "Changes to channels, roles, emoji and stickers on this server are applied on Fluxer")
        if let waiting = progress?.waitingChanges, waiting > 0 { text += String(localized: " (\(waiting) waiting)") }
        text += "."
        if let copied = pair.copiedAt {
            text += " " + String(localized: "The first copy finished \(DateText.relative(copied)).")
        }
        return text
    }

    // MARK: - The Fluxer server

    @ViewBuilder
    private func targetSections(_ state: MirrorState) -> some View {
        if let pair = state.pair {
            if pair.status == .pending {
                Section {
                    Text(verbatim: pendingText(pair))
                } header: {
                    HStack {
                        Text(verbatim: String(localized: "Mirror of \(pair.otherName ?? String(localized: "a Discord server"))"))
                        Spacer()
                        Text(verbatim: pair.status.title)
                    }
                }
                if !state.isOwner {
                    Section {
                        StatusMessage(String(localized: "Only the server owner can do this. You can look at everything here, but not change it."), kind: .notice)
                    }
                }
                Section {
                    TextField("Code", text: $model.acceptCode, prompt: Text(verbatim: "XXXX-XXXX"))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    Button("Agree to the Mirror") { Task { await model.agree() } }
                        .disabled(!MirrorText.isCode(model.acceptCode) || model.isWorking)
                    Button("Decline", role: .destructive) { Task { await model.remove() } }
                        .disabled(model.isWorking)
                } footer: {
                    Text("Like K7QW-H2NP. It works once.")
                }
                .disabled(!state.isOwner)
            } else {
                Section {
                    LabeledContent(String(localized: "Mirror of \(pair.otherName ?? String(localized: "a Discord server"))")) {
                        Text(verbatim: pair.status.title).foregroundStyle(pair.status.color)
                    }
                    Text("The Discord server is the source: what changes there is applied here. Changes made here to mirrored channels and roles are overwritten the next time that item changes on Discord. Sylo never deletes something here that it did not create, and by default does not delete here when something is deleted on Discord: the copy is locked and marked as removed. Changing a mirrored category also changes the channels here that are synced with it. Only the server owner can pause or stop the mirror.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if !state.isOwner {
                    Section {
                        StatusMessage(String(localized: "Only the server owner can do this. You can look at everything here, but not change it."), kind: .notice)
                    }
                }
                MirrorPauseSection(pair: pair, model: model)
                MirrorRemovedSection(progress: state.progress)
                deletesSection(pair)
                if pair.status.isRunning || pair.status != .stopped {
                    Section {
                        if pair.status.isRunning {
                            Button("Pause", systemImage: "pause.circle") { Task { await model.pause() } }
                        }
                        if pair.status != .stopped {
                            Button("Stop", systemImage: "stop.circle", role: .destructive) { isConfirmingStop = true }
                        }
                    }
                    .disabled(!state.isOwner || model.isWorking)
                }
            }
        } else {
            Section {
                Text("This Fluxer server is not the mirror of a Discord server. To make it one, open Sylo for the Discord server, go to Mirror to Fluxer and ask for a mirror. You will be given a code to enter here.")
                MirrorFacts(state: state)
            }
        }
    }

    private func pendingText(_ pair: MirrorPair) -> String {
        let who = pair.requestedBy.isEmpty
            ? String(localized: "Someone asked")
            : String(localized: "\(pair.requestedBy) asked")
        let server = pair.otherName ?? String(localized: "above")
        return String(localized: "\(who) to copy the Discord server \(server) to this server. Sylo would create channels, roles and emoji here, and keep them in step with Discord. Nothing is deleted. If you agree, enter the code they gave you.")
    }

    @ViewBuilder
    private func deletesSection(_ pair: MirrorPair) -> some View {
        let asked = pair.options.mirrorDeletesRequested
        let allowed = pair.options.mirrorDeletes
        if asked || allowed {
            Section {
                if allowed {
                    Text("Deleting is allowed: what is deleted on Discord is deleted here, with its messages. Only what Sylo made is deleted.")
                    Button("Stop Deleting Here") { Task { await model.allowDeletes(false) } }
                } else {
                    Text("The Discord server asks to delete here too, when something is deleted on Discord. Until you allow it, those items are locked and listed, and nothing is deleted.")
                    Button("Allow Deleting", role: .destructive) { isConfirmingAllow = true }
                }
            } header: {
                Text("Deleting on This Server")
            }
            .disabled(!model.isOwner || model.isWorking)
        }
    }

    private var isConfirmingDeletions: Binding<Bool> {
        Binding(get: { model.deletionsToConfirm != nil }, set: { if !$0 { model.deletionsToConfirm = nil } })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

extension MirrorPairStatus {
    /// Colour backs up the word, never replaces it.
    var color: Color {
        switch self {
        case .pending, .paused: .orange
        case .copying, .live, .done: .green
        case .ready, .stopped, .other: .secondary
        }
    }
}

/// Ask, Agree, Preview, Copy, with the current one marked.
private struct MirrorStepper: View {
    let step: MirrorStep

    var body: some View {
        HStack(spacing: 6) {
            ForEach(MirrorStep.allCases, id: \.self) { item in
                HStack(spacing: 4) {
                    Image(systemName: item < step ? "checkmark.circle.fill" : "\(item.rawValue + 1).circle\(item == step ? ".fill" : "")")
                        .foregroundStyle(item <= step ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    Text(verbatim: item.title)
                        .font(.footnote.weight(item == step ? .semibold : .regular))
                        .foregroundStyle(item == step ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                if item != MirrorStep.allCases.last {
                    Spacer(minLength: 2)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: String(localized: "Step \(step.rawValue + 1) of \(MirrorStep.allCases.count): \(step.title)")))
    }
}

/// What a copy takes and what it leaves, as the dashboard says it.
private struct MirrorFacts: View {
    let state: MirrorState

    var body: some View {
        DisclosureGroup("What Is Copied") {
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: String(localized: "Copied: categories and channels with their topics, slowmode, age restriction and permission overwrites; roles with their colour, order and permissions; up to \(state.emojiLimit) emoji and \(state.stickerLimit) stickers; the server's name, icon and banner; and Sylo's own settings, with channels and roles pointing at the new ones."))
                Text("Not copied: members (they join Fluxer themselves), roles given to people, message history, threads, overwrites for single members, and anything Fluxer has no counterpart for. The preview lists every such case before anything is created.")
                Text("One way: Discord is the source. Changes you make to mirrored channels on Fluxer are overwritten the next time that item changes on Discord. Sylo never deletes anything on Fluxer that it did not create itself, and by default does not delete there when you delete on Discord: the copy is locked and marked as removed. Changing a mirrored category also changes the channels on Fluxer that are synced with it.")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }
}

/// Which Fluxer server to mirror to: the ones the signed-in person owns on Fluxer with Sylo in them, or, behind
/// "Enter an ID Instead", an id typed in (for a Fluxer server somebody else owns: its owner agrees with a code).
private struct MirrorServerPicker: View {
    let model: MirrorModel
    let state: MirrorState
    @State private var isTyping = false

    private var canList: Bool { state.isOwner && state.fluxerConnected }

    var body: some View {
        let showsField = isTyping || !canList || model.fluxerListState == .failed
        if showsField {
            Section {
                TextField("Fluxer Server ID", text: Bindable(model).targetID, prompt: Text("Server ID"))
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if isTyping, canList, model.fluxerListState == .loaded {
                    Button("Pick from My Fluxer Servers Instead") {
                        isTyping = false
                        model.targetID = ""
                    }
                }
            } header: {
                Text("Fluxer Server")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    if model.fluxerListState == .failed, canList {
                        Text("Your Fluxer servers could not be listed just now.")
                    }
                    Text("Paste the id of the Fluxer server (copy it with Developer Mode on). If you do not own that Fluxer server, its owner agrees with a code you give them.")
                }
            }
            .disabled(!state.isOwner)
        } else {
            Section {
                switch model.fluxerListState {
                case .idle, .loading:
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Looking for your Fluxer servers…").foregroundStyle(.secondary)
                    }
                case .loaded, .failed:
                    if let list = model.fluxerServers {
                        if !list.connected {
                            StatusMessage(
                                String(localized: "Fluxer is not connected to your account. Add your Fluxer login in Settings, then Account, to pick your Fluxer servers."),
                                kind: .notice)
                        } else if list.servers.isEmpty {
                            Text("No Fluxer server was found where Sylo is a member and you are the owner. Invite Sylo to your server first, or enter an id instead.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(list.servers) { choice in
                            MirrorChoiceRow(choice: choice, isSelected: model.targetID == choice.id) {
                                model.targetID = choice.id
                            }
                        }
                    }
                    Button("Enter an ID Instead") {
                        isTyping = true
                        model.targetID = ""
                    }
                }
            } header: {
                Text("Pick the Fluxer Server")
            }
        }
    }
}

/// One Fluxer server in the picker: icon, name, members, and what Sylo still needs there.
private struct MirrorChoiceRow: View {
    let choice: MirrorFluxerChoice
    let isSelected: Bool
    let pick: () -> Void

    var body: some View {
        Button(action: pick) {
            HStack(spacing: 12) {
                ServerIcon(url: choice.iconURL, name: choice.name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: choice.name)
                        .foregroundStyle(.primary)
                    Text(verbatim: choice.memberText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if choice.inUse {
                        Label("This server is already part of a mirror.", systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    ForEach(choice.notes, id: \.self) { note in
                        Label(note.message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(choice.inUse)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// One switch of what is mirrored. Real deletion shows as on once it is asked for, and says when it still waits for
/// the Fluxer owner.
private struct MirrorOptionToggle: View {
    let key: MirrorOptionKey
    let options: MirrorOptions
    let model: MirrorModel

    var body: some View {
        Toggle(isOn: Binding(
            get: { options.shows(key) },
            set: { on in Task { await model.setOption(key, to: on) } })
        ) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: key.title)
                if key == .mirrorDeletes, options.deletesWaitForFluxer {
                    Text("Waiting for the owner of the Fluxer server to allow it there. Until then deleted items are locked, not deleted.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                if let hint = key.hint {
                    Text(verbatim: hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(!model.isOwner || model.isWorking)
    }
}

/// Why a mirror is paused, and the button that resumes it (when this side may).
private struct MirrorPauseSection: View {
    let pair: MirrorPair
    let model: MirrorModel

    var body: some View {
        if pair.status == .paused {
            Section {
                StatusMessage(pair.lastError.isEmpty ? String(localized: "It was paused.") : pair.lastError, kind: .notice)
                Button(pair.resumeTitle, systemImage: "play.circle") { Task { await model.resume() } }
                    .disabled(!model.isOwner || model.isWorking || !pair.canResume)
            } header: {
                Text("The Mirror Is Paused")
            } footer: {
                if let note = pair.resumeNote {
                    Text(verbatim: note)
                }
            }
        }
    }
}

/// Copies left on Fluxer whose Discord original was deleted: locked, not deleted.
private struct MirrorRemovedSection: View {
    let progress: MirrorProgress?

    var body: some View {
        if let removed = progress?.removed, !removed.isEmpty {
            Section {
                ForEach(Array(removed.enumerated()), id: \.offset) { _, item in
                    Text(verbatim: "\(item.kind): \(item.label)")
                }
            } header: {
                Text(verbatim: String(localized: "Removed on Discord (\(removed.count))"))
            } footer: {
                Text("These were deleted on Discord. Their copies on Fluxer were locked, not deleted, so their messages are kept. Delete them on Fluxer if you do not need them.")
            }
        }
    }
}

/// The result of a dry run: what blocks it, what is good to know, what the copy does, what cannot be carried over,
/// and every step.
private struct MirrorPreviewSections: View {
    let preview: MirrorPreview

    var body: some View {
        if !preview.blockers.isEmpty || !preview.warnings.isEmpty {
            Section {
                ForEach(preview.blockers, id: \.self) { blocker in
                    StatusMessage(blocker.message, kind: .error)
                }
                ForEach(preview.warnings, id: \.self) { warning in
                    StatusMessage(warning.message, kind: .notice)
                }
            } header: {
                Text(preview.blockers.isEmpty ? "Good to Know" : "This Cannot Start Yet")
            }
        }
        Section("What the Copy Does") {
            ForEach(preview.summaryLines, id: \.self) { line in
                Text(verbatim: line)
            }
            Text("Last, every copied text channel is linked through the bridge, if the channels allow it (the reasons are in the report).")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        Section {
            let groups = MirrorNoteGroup.groups(preview.notes)
            if groups.isEmpty {
                Text("Nothing.").foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                DisclosureGroup(String(localized: "\(group.title) (\(group.notes.count))")) {
                    ForEach(Array(group.notes.enumerated()), id: \.offset) { _, note in
                        Text(verbatim: note.message).font(.footnote)
                    }
                }
            }
            DisclosureGroup(String(localized: "Every Step (\(preview.steps.count))")) {
                ForEach(preview.steps) { step in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(step.op) \u{00B7} \(step.name)")
                            .font(.footnote)
                        if let reason = step.reason {
                            Text(verbatim: reason)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } header: {
            Text("What Cannot Be Carried Over")
        }
    }
}

/// What became of the latest copy.
private struct MirrorReportRows: View {
    let report: MirrorReport

    var body: some View {
        if report.failed.isEmpty {
            Text("Every step that could be done was done.")
        } else {
            DisclosureGroup(String(localized: "Could Not Be Copied (\(report.failed.count))")) {
                ForEach(Array(report.failed.enumerated()), id: \.offset) { _, item in
                    Text(verbatim: item.detail.isEmpty ? item.name : "\(item.name): \(item.detail)")
                        .font(.footnote)
                }
            }
        }
        ForEach(MirrorNoteGroup.groups(report.notes)) { group in
            DisclosureGroup(String(localized: "\(group.title) (\(group.notes.count))")) {
                ForEach(Array(group.notes.enumerated()), id: \.offset) { _, note in
                    Text(verbatim: note.message).font(.footnote)
                }
            }
        }
        if let line = report.bridgeLine {
            Text(verbatim: line)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

/// "Copy again": the same preview as the first time, then a new copy of what changed.
private struct MirrorCopyAgainView: View {
    let model: MirrorModel
    @State private var isConfirming = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            if let preview = model.preview {
                MirrorPreviewSections(preview: preview)
                Section {
                    Button(String(localized: "Copy to \(preview.targetName ?? "Fluxer")")) { isConfirming = true }
                        .disabled(!preview.ok || !model.isOwner || model.isWorking)
                }
            } else if let problem = model.previewError {
                Section { StatusMessage(problem, kind: .error) }
            } else {
                Section {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Reading both servers…").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Copy Again")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { dismiss() }
            }
        }
        .task { await model.loadPreview() }
        .confirmationDialog(
            String(localized: "Copy this server to \(model.preview?.targetName ?? String(localized: "the Fluxer server"))?"),
            isPresented: $isConfirming, titleVisibility: .visible
        ) {
            Button("Start the Copy") {
                Task {
                    if await model.start() { dismiss() }
                }
            }
        } message: {
            Text("Sylo copies again what changed since the last copy, as the preview shows. It does not delete anything there.")
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadMirror else { return nil }
        return MirrorState(
            pair: MirrorPair(id: 1, status: .live, otherID: "fluxer:1", otherName: "Sylo on Fluxer", copiedAt: .now, copyRun: 1),
            progress: MirrorProgress(total: 40, done: 38, skipped: 1, failed: 1, percent: 100, waitingChanges: 2))
    }
    NavigationStack {
        MirrorView(server: "1", session: session)
    }
    .environment(session)
}
