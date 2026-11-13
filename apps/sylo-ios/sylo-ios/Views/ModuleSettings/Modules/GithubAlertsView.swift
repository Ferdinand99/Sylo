import SwiftUI
import SyloKit

/// GitHub alerts: post activity from a repository (pushes, releases, issues, pull requests) to a
/// channel. Each repository is a watch with its own webhook address and secret, which are pasted into
/// that repository's Settings, Webhooks page on GitHub. Mirrors web-v2/src/moduleForms/GithubAlerts.jsx.
struct GithubAlertsView: View {
    @State private var model: GithubAlertsModel
    @State private var editor: GithubWatchEditorTarget?
    @State private var deleting: GithubWatch?

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: GithubAlertsModel(server: server, session: session))
    }

    var body: some View {
        content
            .navigationTitle("GitHub Alerts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.hasLoaded {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Add Repository", systemImage: "plus") { editor = .new }
                    }
                }
            }
            .task { await model.load() }
            .sheet(item: $editor) { target in
                GithubWatchEditorView(target: target, model: model)
            }
            .confirmationDialog(
                "Delete this repo watch?", isPresented: isDeleting, titleVisibility: .visible, presenting: deleting
            ) { watch in
                Button("Delete Watch", role: .destructive) { Task { await model.delete(watch.id) } }
            } message: { _ in
                Text("Sylo stops posting its activity and the webhook address stops working.")
            }
            .alert("Couldn't Change Watch", isPresented: isShowingActionError, presenting: model.actionError) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
            .sensoryFeedback(.success, trigger: model.successCount)
    }

    @ViewBuilder
    private var content: some View {
        if model.hasLoaded {
            List {
                if let message = model.errorMessage {
                    Section {
                        StatusMessage(message, kind: .error)
                    }
                }
                ModuleIntro("Post GitHub activity from a repository straight to a channel: pushes, releases, issues and pull requests. Each repository gets its own webhook address and secret to paste into that repository's Settings, Webhooks page on GitHub.")
                if !model.dashboardUrlSet {
                    Section {
                        StatusMessage(
                            String(localized: "This server has no public address set (DASHBOARD_URL), so GitHub has nowhere to send events. Set it before adding a repository."),
                            kind: .notice)
                    }
                }
                Section {
                    ForEach(model.watches) { watch in
                        NavigationLink {
                            GithubWatchView(watchID: watch.id, model: model)
                        } label: {
                            WatchRow(watch: watch, model: model)
                        }
                        .disabled(model.busy.contains(watch.id))
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = watch }
                            toggleButton(for: watch)
                        }
                        .contextMenu {
                            Button("Edit", systemImage: "pencil") { editor = .edit(watch) }
                            toggleButton(for: watch)
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = watch }
                        }
                    }
                    Button("Add Repository", systemImage: "plus") { editor = .new }
                } header: {
                    Text("Watched repos (\(model.watches.count))")
                } footer: {
                    if model.watches.isEmpty {
                        Text("None yet. Add a repository to start posting its activity here.")
                    }
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load GitHub Alerts", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private func toggleButton(for watch: GithubWatch) -> some View {
        if watch.enabled {
            Button("Pause", systemImage: "pause.circle") { Task { await model.toggle(watch.id) } }
                .tint(.orange)
        } else {
            Button("Resume", systemImage: "play.circle") { Task { await model.toggle(watch.id) } }
                .tint(.green)
        }
    }

    private var isDeleting: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// What the watch sheet is for: a new watch, or one that is already stored.
enum GithubWatchEditorTarget: Identifiable {
    case new
    case edit(GithubWatch)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let watch): "edit-\(watch.id)"
        }
    }
}

/// A watch's repository with its Active or Paused tag, over its channel, event count, role and changelog.
private struct WatchRow: View {
    let watch: GithubWatch
    let model: GithubAlertsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: watch.repo)
                    .lineLimit(2)
                ActiveBadge(isActive: watch.enabled)
            }
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    /// "#releases · 2 event types · pings @Devs · watching CHANGELOG.md".
    private var details: String {
        var parts = ["#" + (model.channels.first { $0.id == watch.channelId }?.name ?? watch.channelId)]
        if watch.events.count == 1 {
            parts.append(String(localized: "1 event type"))
        } else {
            parts.append(String(localized: "\(watch.events.count) event types"))
        }
        if !watch.roleId.isEmpty {
            let role = model.roles.first { $0.id == watch.roleId }?.name ?? watch.roleId
            parts.append(String(localized: "pings @\(role)"))
        }
        if !watch.changelogPath.isEmpty { parts.append(String(localized: "watching \(watch.changelogPath)")) }
        return parts.joined(separator: " \u{00B7} ")
    }
}

/// One watch: what it posts, its webhook address and secret (hidden until shown), and the actions on
/// it. The watch is read from the model, so a new secret shows up here the moment it is made.
private struct GithubWatchView: View {
    let watchID: Int
    let model: GithubAlertsModel

    @State private var editor: GithubWatchEditorTarget?
    @State private var showsSecret = false
    @State private var isConfirmingRegenerate = false
    @State private var isConfirmingDelete = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if let watch = model.watch(id: watchID) {
                form(for: watch)
            } else {
                ContentUnavailableView("Watch Not Found", systemImage: "questionmark.circle")
            }
        }
        .navigationTitle(model.watch(id: watchID)?.repo ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editor) { target in
            GithubWatchEditorView(target: target, model: model)
        }
        // A secret on screen is hidden again when the app goes to the background.
        .onChange(of: scenePhase) {
            if scenePhase != .active { showsSecret = false }
        }
        .confirmationDialog(
            "Generate a new webhook secret?", isPresented: $isConfirmingRegenerate, titleVisibility: .visible
        ) {
            Button("Generate New Secret", role: .destructive) {
                Task {
                    if await model.regenerateSecret(watchID) { showsSecret = true }
                }
            }
        } message: {
            Text("The old secret, and the value saved in GitHub's webhook settings, stops working immediately. You'll need to paste the new one into GitHub.")
        }
        .confirmationDialog("Delete this repo watch?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
            Button("Delete Watch", role: .destructive) {
                Task {
                    await model.delete(watchID)
                    if model.watch(id: watchID) == nil { dismiss() }
                }
            }
        } message: {
            Text("Sylo stops posting its activity and the webhook address stops working.")
        }
    }

    private func form(for watch: GithubWatch) -> some View {
        Form {
            Section {
                LabeledContent("Repository") { Text(verbatim: watch.repo) }
                LabeledContent("Announce in") { Text(verbatim: "#" + channelName(of: watch)) }
                if !watch.roleId.isEmpty {
                    LabeledContent("Ping role") { Text(verbatim: "@" + roleName(of: watch)) }
                }
                if !watch.changelogPath.isEmpty {
                    LabeledContent("Changelog file") { Text(verbatim: watch.changelogPath) }
                }
                LabeledContent("Status") { ActiveBadge(isActive: watch.enabled) }
            } header: {
                Text("What it posts")
            } footer: {
                Text(verbatim: eventSummary(of: watch))
            }

            webhookSection(for: watch)

            Section {
                Button("Edit", systemImage: "pencil") { editor = .edit(watch) }
                if watch.enabled {
                    Button("Pause", systemImage: "pause.circle") { Task { await model.toggle(watch.id) } }
                } else {
                    Button("Resume", systemImage: "play.circle") { Task { await model.toggle(watch.id) } }
                }
                Button("Delete Watch", systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
            }
        }
        .disabled(model.busy.contains(watch.id))
    }

    private func webhookSection(for watch: GithubWatch) -> some View {
        Section {
            if let address = watch.webhookUrl {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Payload URL")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text(verbatim: address)
                        .font(.footnote.monospaced())
                        .lineLimit(3)
                        .truncationMode(.middle)
                }
                CopyValueButton(title: "Copy Payload URL", value: address)
            } else {
                Label("No public address on this server yet.", systemImage: "exclamationmark.triangle.fill")
                    .symbolRenderingMode(.multicolor)
                    .font(.subheadline)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Secret")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if showsSecret {
                    Text(verbatim: watch.secret)
                        .font(.footnote.monospaced())
                        .lineLimit(3)
                } else {
                    Text(verbatim: String(repeating: "\u{2022}", count: 24))
                        .accessibilityLabel("Hidden")
                }
            }
            if showsSecret {
                Button("Hide Secret", systemImage: "eye.slash") { showsSecret = false }
            } else {
                Button("Show Secret", systemImage: "eye") { showsSecret = true }
            }
            CopyValueButton(title: "Copy Secret", value: watch.secret)
            Button("Generate New Secret", systemImage: "arrow.triangle.2.circlepath", role: .destructive) {
                isConfirmingRegenerate = true
            }
        } header: {
            Text("Webhook setup")
        } footer: {
            Text("On GitHub, open the repository's Settings, then Webhooks, then Add webhook. Set the content type to application/json and the events to Send me everything: Sylo only posts the event types you checked. Copied values stay on this device and leave the clipboard after two minutes.")
        }
    }

    private func channelName(of watch: GithubWatch) -> String {
        model.channels.first { $0.id == watch.channelId }?.name ?? watch.channelId
    }

    private func roleName(of watch: GithubWatch) -> String {
        model.roles.first { $0.id == watch.roleId }?.name ?? watch.roleId
    }

    /// "Posts: Commits pushed, Release published." (the labels the server gave the event keys).
    private func eventSummary(of watch: GithubWatch) -> String {
        if watch.events.isEmpty { return String(localized: "No event types: only the changelog file is posted.") }
        let labels = watch.events.map { key in model.eventTypes.first { $0.key == key }?.label ?? key }
        return String(localized: "Posts: \(labels.joined(separator: ", ")).")
    }
}

/// The form for a new watch or a stored one. Mirrors `WatchForm` in
/// web-v2/src/moduleForms/GithubAlerts.jsx.
private struct GithubWatchEditorView: View {
    let target: GithubWatchEditorTarget
    let model: GithubAlertsModel

    @State private var draft: GithubWatchDraft
    @State private var initial: GithubWatchDraft
    @State private var limits = ModuleFieldLimits.unlimited
    @State private var isConfirmingDiscard = false
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSession.self) private var session

    init(target: GithubWatchEditorTarget, model: GithubAlertsModel) {
        self.target = target
        self.model = model
        let start: GithubWatchDraft
        switch target {
        case .new: start = GithubWatchDraft()
        case .edit(let watch): start = GithubWatchDraft(editing: watch)
        }
        _draft = State(initialValue: start)
        _initial = State(initialValue: start)
    }

    private var editingID: Int? {
        guard case .edit(let watch) = target else { return nil }
        return watch.id
    }

    private var isNew: Bool { editingID == nil }
    private var hasChanges: Bool { draft != initial }
    private var changelogLimit: Int { limits["changelogPath"].maxLength ?? GithubInput.changelogPathLimit }
    private var problem: String? { draft.problem(changelogLimit: changelogLimit) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Repository", text: $draft.repo, prompt: Text(verbatim: "owner/repo"))
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Either owner/repo or the full github.com/owner/repo address.")
                }

                Section {
                    ChannelPicker(title: "Announce in", selection: $draft.channelId, channels: model.channels,
                                  noneTitle: "Select a channel")
                    RolePicker(title: "Ping role", selection: $draft.roleId, roles: model.roles)
                } footer: {
                    Text("The role is optional. It is pinged with every post.")
                }

                Section {
                    ForEach(model.eventTypes) { type in
                        Toggle(isOn: eventBinding(type.key)) {
                            Text(verbatim: type.label)
                        }
                    }
                } header: {
                    Text("What to post")
                }

                Section {
                    LimitedTextField(
                        title: "Changelog file path (optional)", text: $draft.changelogPath, limit: changelogLimit,
                        prompt: Text(verbatim: "CHANGELOG.md"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Changelog")
                } footer: {
                    Text("When a push changes this exact file, Sylo posts only its newest entry, whatever event types are checked above. Public repositories only.")
                }

                if let message = model.saveError {
                    Section {
                        StatusMessage(message, kind: .error)
                    }
                } else if let problem {
                    Section {
                        StatusMessage(problem, kind: .notice)
                    }
                }
            }
            .disabled(model.isSaving)
            .navigationTitle(isNew ? "Add Repository" : "Edit Watch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if hasChanges { isConfirmingDiscard = true } else { dismiss() }
                    }
                    .disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isSaving {
                        ProgressView()
                    } else {
                        Button(isNew ? "Add" : "Save") { save() }
                            .toolbarSaveStyle()
                            .disabled(problem != nil || (!isNew && !hasChanges))
                    }
                }
            }
            .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
            }
        }
        .interactiveDismissDisabled(hasChanges || model.isSaving)
        .tracksUnsavedChanges(hasChanges)
        .onAppear { model.saveError = nil }
        .task { limits = await session.moduleLimits()["github"] }
    }

    private func eventBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { draft.events.contains(key) },
            set: { isOn in
                if isOn { draft.events.insert(key) } else { draft.events.remove(key) }
            })
    }

    private func save() {
        Task {
            if await model.save(draft, editing: editingID) { dismiss() }
        }
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadGithubWatches else { return nil }
        return GithubWatchesPage(
            watches: [
                GithubWatch(id: 1, repo: "Ferdinand99/Sylo", channelId: "c1", roleId: "r1", changelogPath: "CHANGELOG.md",
                            events: ["push", "release"], secret: "preview-secret",
                            webhookUrl: "https://sylo.example.com/webhooks/github/abc"),
                GithubWatch(id: 2, repo: "example/app", channelId: "c1", events: ["issues"], enabled: false,
                            secret: "preview-secret-2"),
            ],
            channels: [ChannelOption(id: "c1", name: "dev-feed")], roles: [RoleOption(id: "r1", name: "Devs")])
    }
    NavigationStack {
        GithubAlertsView(server: "1", session: session)
    }
    .environment(session)
}
