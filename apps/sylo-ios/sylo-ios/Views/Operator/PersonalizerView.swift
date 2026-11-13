import SwiftUI
import SyloKit

/// The Bot Personalizer for the operators of a Sylo server: the bot's name and pictures, its status
/// line, and the announcement every signed-in person sees. Bot-wide: it changes Sylo on every server.
/// Mirrors web-v2/src/pages/Personalizer.jsx (the dashboard's /settings page).
struct PersonalizerView: View {
    @State private var model: PersonalizerModel

    init(session: AppSession) {
        _model = State(initialValue: PersonalizerModel(session: session))
    }

    var body: some View {
        Group {
            if model.isRefused {
                OperatorRefusedView()
            } else if model.hasLoaded {
                PersonalizerForm(model: model)
            } else if let message = model.errorMessage {
                ContentUnavailableView {
                    Label("Couldn't Load the Personalizer", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try Again") { Task { await model.load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Bot Personalizer")
        .navigationBarTitleDisplayMode(.inline)
        .task { if !model.hasLoaded { await model.load() } }
    }
}

private struct PersonalizerForm: View {
    @Bindable var model: PersonalizerModel
    @State private var isConfirmingClear = false

    var body: some View {
        Form {
            if let notice = model.notice {
                Section { StatusMessage(notice, kind: .notice) }
            }
            if let message = model.actionError {
                Section { StatusMessage(message, kind: .error) }
            }
            botSection
            identitySection
            presenceSection
            announcementSection
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.load() }
        .typedConfirmation(.clearAnnouncement, isPresented: $isConfirmingClear) { typed in
            Task { await model.clearAnnouncement(typed: typed) }
        }
    }

    // MARK: - Bot

    private var botSection: some View {
        Section {
            if let bot = model.bot {
                HStack(spacing: 12) {
                    AsyncImage(url: bot.avatarURL) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Image(systemName: "person.crop.circle.fill")
                            .resizable()
                            .foregroundStyle(.secondary)
                    }
                    .frame(width: 56, height: 56)
                    .clipShape(Circle())
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: bot.tag)
                            .font(.headline)
                        Text("Bot-wide identity. It changes Sylo on every server it is in.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            } else {
                Text("The bot isn't connected yet. Try again in a moment.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Identity

    private var identitySection: some View {
        Section {
            TextField("Username", text: $model.identity.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            LinkTextField(title: "Avatar Link", text: $model.identity.avatarURL)
                .disabled(model.identity.resetAvatar)
            Toggle("Reset avatar to the default instead", isOn: $model.identity.resetAvatar)
            LinkTextField(title: "Banner Link", text: $model.identity.bannerURL)
            Button {
                Task { await model.saveIdentity() }
            } label: {
                SaveRow(title: "Save Identity", isSaving: model.isSaving, isDirty: model.isIdentityDirty)
            }
            .disabled(model.isSaving || !model.isIdentityDirty)
        } header: {
            Text("Identity")
        } footer: {
            Text("The username needs 2 to 32 characters, and the platform allows only about 2 changes an hour. Pictures are links that start with https://.")
        }
    }

    // MARK: - Presence

    private var presenceSection: some View {
        Section {
            Picker("Status", selection: $model.presence.status) {
                ForEach(Self.options(model.statuses, including: model.presence.status), id: \.self) { status in
                    Text(verbatim: Self.statusLabel(status)).tag(status)
                }
            }
            Picker("Activity", selection: $model.presence.type) {
                ForEach(Self.options(model.types, including: model.presence.type), id: \.self) { type in
                    Text(verbatim: type).tag(type)
                }
            }
            LimitedTextField(title: "Text", text: $model.presence.text, limit: PersonalizerModel.presenceTextLimit)
            Button {
                Task { await model.savePresence() }
            } label: {
                SaveRow(title: "Save Presence", isSaving: model.isSaving, isDirty: model.isPresenceDirty)
            }
            .disabled(model.isSaving || !model.isPresenceDirty)
        } header: {
            Text("Presence")
        } footer: {
            Text(verbatim: "{servers} is how many servers Sylo is in. {members} is how many members those servers have in total.")
        }
    }

    // MARK: - Announcement

    private var announcementSection: some View {
        Section {
            if let live = model.liveAnnouncement {
                LabeledContent("Live now") {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(verbatim: live.title)
                        StatusTag(Self.severityLabel(live.severity.rawValue), tint: Self.tint(live.severity))
                    }
                }
            }
            LimitedTextField(
                title: "Title", text: $model.announcement.title, limit: PersonalizerModel.announcementTitleLimit,
                prompt: Text("e.g. Scheduled maintenance tonight"))
            LimitedTextField(
                title: "Message", text: $model.announcement.body, limit: PersonalizerModel.announcementBodyLimit,
                prompt: Text("Optional details"), lines: 3...8)
            Picker("Severity", selection: $model.announcement.severity) {
                ForEach(Self.options(model.severities, including: model.announcement.severity), id: \.self) { severity in
                    Text(Self.severityLabel(severity)).tag(severity)
                }
            }
            Button {
                Task { await model.publishAnnouncement() }
            } label: {
                SaveRow(title: "Publish Announcement", isSaving: model.isSaving, isDirty: model.isAnnouncementDirty,
                        dirtyText: "Unpublished changes")
            }
            .disabled(model.isSaving || !model.canPublish)
            if model.liveAnnouncement != nil {
                Button("Clear Announcement", role: .destructive) {
                    isConfirmingClear = true
                }
                .disabled(model.isSaving)
            }
        } header: {
            Text("Announcement")
        } footer: {
            Text("Shown to everyone signed in, on every page of the dashboard and in the app: for example to explain an incident or an outage. Critical announcements have no dismiss button and stay until you clear them.")
        }
    }

    // MARK: - Helpers

    /// The server's choices, with the current value added when the server's list does not have it, so
    /// the picker never points at nothing.
    private static func options(_ list: [String], including current: String) -> [String] {
        list.contains(current) || current.isEmpty ? list : list + [current]
    }

    private static func statusLabel(_ status: String) -> String {
        switch status {
        case "online": "Online"
        case "idle": "Idle"
        case "dnd": "Do not disturb"
        case "invisible": "Invisible"
        default: status.prefix(1).uppercased() + status.dropFirst()
        }
    }

    private static func severityLabel(_ severity: String) -> LocalizedStringKey {
        switch severity {
        case "info": "Info"
        case "warning": "Warning"
        case "critical": "Critical"
        default: LocalizedStringKey(severity.prefix(1).uppercased() + severity.dropFirst())
        }
    }

    private static func tint(_ severity: AnnouncementSeverity) -> Color {
        switch severity {
        case .critical: .red
        case .warning: .orange
        default: .secondary
        }
    }
}

/// A save button's label: the action, a spinner while any save runs, and "Unsaved changes" when the
/// form differs from what the server has.
private struct SaveRow: View {
    let title: LocalizedStringKey
    let isSaving: Bool
    let isDirty: Bool
    var dirtyText: LocalizedStringKey = "Unsaved changes"

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            if isSaving {
                ProgressView()
            } else if isDirty {
                Text(dirtyText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
