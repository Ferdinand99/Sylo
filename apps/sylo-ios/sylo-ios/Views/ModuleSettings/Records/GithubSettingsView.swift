import SwiftUI
import SyloKit
import UIKit

/// GitHub alerts: GitHub activity from a repository posted to a channel through a webhook. Mirrors
/// web-v2/src/moduleForms/GithubAlerts.jsx.
struct GithubSettingsView: View {
    let server: ServerID

    @State private var model: RecordListModel<GithubPage>
    @State private var note: ModulePlatformNoteModel
    @State private var editing: GithubWatchDraft?
    @State private var settingUp: GithubWatch?
    @State private var pendingDelete: GithubWatch?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(github: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: GithubPage.moduleID, session: session))
    }

    var body: some View {
        RecordScreen("GitHub Alerts", model: model, note: note) { page in
            ModuleIntro("Post GitHub activity from a repository to a channel: pushes, releases, issues and pull requests. Each repository gets its own webhook address and secret to paste into that repository's Settings, Webhooks page.")

            if !page.hasPublicAddress {
                Section {
                    Label(
                        "This Sylo server's public address isn't set, so GitHub has nowhere to send events. Set it before adding a repository.",
                        systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(Color.syloWarn)
                }
            }

            Section {
                if page.watches.isEmpty {
                    Text("None yet. Add a repository to start posting its activity.")
                        .foregroundStyle(Color.syloMuted)
                }
                ForEach(page.watches) { watch in
                    RecordRow(
                        title: watch.repo, details: details(of: watch, page: page),
                        status: watch.isEnabled ? LocalizedStringKey("Active") : LocalizedStringKey("Paused"),
                        isActive: watch.isEnabled
                    ) {
                        editing = GithubWatchDraft(watch: watch)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = watch }
                        Button(
                            watch.isEnabled ? "Pause" : "Resume",
                            systemImage: watch.isEnabled ? "pause.circle" : "play.circle"
                        ) {
                            Task { _ = await model.toggle(watch) }
                        }
                        .tint(Color.syloWarn)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button("Webhook", systemImage: "link") { settingUp = watch }
                            .tint(Color.syloCyan)
                    }
                    .contextMenu {
                        Button("Webhook Setup", systemImage: "link") { settingUp = watch }
                        Button(
                            watch.isEnabled ? "Pause" : "Resume",
                            systemImage: watch.isEnabled ? "pause.circle" : "play.circle"
                        ) {
                            Task { _ = await model.toggle(watch) }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = watch }
                    }
                    .accessibilityAction(named: Text("Webhook setup")) { settingUp = watch }
                    .accessibilityAction(named: Text(watch.isEnabled ? "Pause" : "Resume")) {
                        Task { _ = await model.toggle(watch) }
                    }
                    .accessibilityAction(named: Text("Delete")) { pendingDelete = watch }
                }
                Button("Add Repository", systemImage: "plus") {
                    editing = GithubWatchDraft()
                }
            } header: {
                Text("Watched repositories (\(page.watches.count))")
            }
        }
        .sheet(item: $editing) { draft in
            if let page = model.page {
                WatchEditor(
                    draft: draft, page: page, model: model, save: { await model.save($0) },
                    failure: { model.takeActionError() })
            }
        }
        .sheet(item: $settingUp) { watch in
            WebhookSetupSheet(watchID: watch.id, model: model)
        }
        .confirmationDialog(
            "Delete this repository?", isPresented: isConfirmingDelete, titleVisibility: .visible,
            presenting: pendingDelete
        ) { watch in
            Button("Delete Repository", role: .destructive) { Task { _ = await model.delete(watch) } }
        } message: { _ in
            Text("Sylo stops posting its activity and its webhook address stops working.")
        }
    }

    private func details(of watch: GithubWatch, page: GithubPage) -> String {
        let channel = page.channels.first { $0.id == watch.channelId }.map { "#\($0.name)" } ?? String(localized: "deleted channel")
        var parts = [channel, (watch.events.count == 1 ? String(localized: "1 event type") : String(localized: "\(watch.events.count) event types"))]
        if !watch.roleId.isEmpty {
            let role = page.roles.first { $0.id == watch.roleId }?.name ?? String(localized: "deleted role")
            parts.append(String(localized: "pings @\(role)"))
        }
        if !watch.changelogPath.isEmpty {
            parts.append(String(localized: "watching \(watch.changelogPath)"))
        }
        return parts.joined(separator: " · ")
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }
}

/// Edits one watched repository in a sheet.
private struct WatchEditor: View {
    @State var draft: GithubWatchDraft
    let page: GithubPage
    let model: RecordListModel<GithubPage>
    let save: (GithubWatchDraft) async -> Bool
    let failure: () -> String?

    @State private var initial: GithubWatchDraft?

    var body: some View {
        RecordEditor(
            title: draft.watchID == nil ? "Add Repository" : "Edit Repository", problem: draft.problem,
            hasChanges: initial.map { $0 != draft } ?? false,
            save: { await save(draft) }, failure: failure
        ) {
            Section {
                TextField("owner/repo", text: $draft.repo)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                ChannelPicker(
                    title: "Announce in", selection: $draft.channelId, channels: page.channels,
                    noneTitle: "Choose a channel")
                RolePicker(title: "Ping role", selection: $draft.roleId, roles: page.roles)
            } header: {
                Text("Repository")
            } footer: {
                Text("Either owner/repo or the full github.com address. Pinging a role is optional.")
            }

            Section {
                ForEach(page.eventTypes) { type in
                    Toggle(type.label, isOn: eventBinding(type.key))
                }
            } header: {
                Text("What to post")
            }

            Section {
                TextField("CHANGELOG.md", text: $draft.changelogPath)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: draft.changelogPath) {
                        if draft.changelogPath.count > GithubWatchDraft.maxChangelogPathLength {
                            draft.changelogPath = String(draft.changelogPath.prefix(GithubWatchDraft.maxChangelogPathLength))
                        }
                    }
            } header: {
                Text("Changelog file")
            } footer: {
                Text("Optional. When a push changes this file, Sylo posts only its newest entry, whatever is chosen above. Public repositories only.")
            }

            if let id = draft.watchID {
                Section {
                    NavigationLink {
                        WebhookSetupForm(watchID: id, model: model)
                    } label: {
                        Label("Webhook Setup", systemImage: "link")
                    }
                } footer: {
                    Text("The address and secret to paste into the repository's webhook settings.")
                }
            }
        }
        .onAppear { if initial == nil { initial = draft } }
    }

    private func eventBinding(_ key: String) -> Binding<Bool> {
        Binding(
            get: { draft.events.contains(key) },
            set: { draft.setEvent(key, on: $0) })
    }
}

/// The webhook setup in its own sheet, for a repository's swipe action.
private struct WebhookSetupSheet: View {
    let watchID: Int
    let model: RecordListModel<GithubPage>

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WebhookSetupForm(watchID: watchID, model: model)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                            .toolbarSaveStyle()
                    }
                }
        }
        .presentationDragIndicator(.visible)
    }
}

/// The address and secret to paste into GitHub, with Copy and a new secret.
private struct WebhookSetupForm: View {
    let watchID: Int
    let model: RecordListModel<GithubPage>

    @State private var isConfirmingRegenerate = false
    @State private var copied: String?
    /// Why a new secret could not be made. Kept here, not in the model's own error, so the list
    /// screen behind this one does not show a second alert for the same thing.
    @State private var setupError: String?

    private var watch: GithubWatch? { model.page?.watches.first { $0.id == watchID } }

    var body: some View {
        Form {
            if let watch {
                Group {
                    Section {
                        Text("In the repository on GitHub, open Settings, Webhooks, Add webhook. Choose the content type application/json and send everything: Sylo only posts the event types you checked.")
                            .font(.subheadline)
                            .foregroundStyle(Color.syloMuted)
                            .listRowBackground(Color.clear)
                    }
                    Section("Payload URL") {
                        copyRow(
                            watch.webhookURL ?? String(localized: "The server's public address isn't set"),
                            canCopy: watch.webhookURL != nil, label: "Payload URL")
                    }
                    Section("Secret") {
                        copyRow(watch.secret, canCopy: !watch.secret.isEmpty, label: "Secret")
                        Button("Generate a New Secret", role: .destructive) { isConfirmingRegenerate = true }
                    }
                }
                .syloSectionCards()
            }
        }
        .syloFormStyle()
        .disabled(model.isWorking)
        .navigationTitle(watch?.repo ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Generate a new webhook secret?", isPresented: $isConfirmingRegenerate, titleVisibility: .visible
        ) {
            Button("Generate New Secret", role: .destructive) {
                if let watch {
                    Task {
                        if !(await model.regenerateSecret(watch)) { setupError = model.takeActionError() }
                    }
                }
            }
        } message: {
            Text("The old secret, and the one saved in GitHub's webhook settings, stops working at once. You will need to paste the new one into GitHub.")
        }
        .alert("Couldn't Complete", isPresented: isShowingError, presenting: setupError) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: copied)
    }

    private func copyRow(_ value: String, canCopy: Bool, label: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: SyloSpacing.m) {
            Text(verbatim: value)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if canCopy {
                Button {
                    copy(value)
                    copied = label
                } label: {
                    Label(copied == label ? "Copied" : "Copy", systemImage: copied == label ? "checkmark" : "doc.on.doc")
                        .labelStyle(.iconOnly)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.syloBrand)
                .accessibilityLabel(Text("Copy \(label)"))
            }
        }
    }

    /// Puts the text on this device's clipboard only (no Universal Clipboard) and lets it expire.
    private func copy(_ value: String) {
        UIPasteboard.general.setItems(
            [["public.utf8-plain-text": value]],
            options: [.localOnly: true, .expirationDate: Date.now.addingTimeInterval(120)])
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { setupError != nil }, set: { if !$0 { setupError = nil } })
    }
}
