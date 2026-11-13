import SwiftUI
import SyloKit

/// Reminders: post a text or embed message to a channel, once or on a repeating schedule. Make
/// one, change it, pause it, delete it, and say whether reminders may ping. Mirrors
/// web-v2/src/moduleForms/Reminders.jsx.
struct RemindersView: View {
    @State private var model: RemindersModel
    @State private var editor: ReminderEditorTarget?
    @State private var deleting: Reminder?

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: RemindersModel(server: server, session: session))
    }

    var body: some View {
        content
            .navigationTitle("Reminders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.hasLoaded {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New Reminder", systemImage: "plus") { editor = .new }
                    }
                }
            }
            .task { await model.load() }
            .sheet(item: $editor) { target in
                ReminderEditorView(target: target, model: model)
            }
            .confirmationDialog(
                "Delete this reminder?", isPresented: isDeleting, titleVisibility: .visible, presenting: deleting
            ) { reminder in
                Button("Delete Reminder", role: .destructive) { Task { await model.delete(reminder.id) } }
            } message: { _ in
                Text("It won't be posted again. This can't be undone.")
            }
            .alert("Couldn't Change Reminder", isPresented: isShowingActionError, presenting: model.actionError) { _ in
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
                ModuleIntro("Post a text or embed message to a channel, once or on a repeating schedule.")
                if model.hasPingSwitch {
                    Section {
                        Toggle("Let reminders ping @everyone, @here and roles", isOn: pingsBinding)
                    } header: {
                        Text("Pings")
                    } footer: {
                        Text("When off, mentions in a reminder are shown but nobody is notified. It is off for new servers. Only the server owner or someone with Manage Server can change this.")
                    }
                }
                remindersSection
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load Reminders", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        } else {
            ProgressView()
        }
    }

    private var remindersSection: some View {
        Section {
            ForEach(model.reminders) { reminder in
                Button {
                    editor = .edit(reminder)
                } label: {
                    ReminderRow(
                        reminder: reminder, channelName: channelName(of: reminder), presets: model.schedulePresets,
                        weekdays: model.weekdays)
                }
                .buttonStyle(.plain)
                .disabled(model.busy.contains(reminder.id))
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button("Delete", systemImage: "trash", role: .destructive) { deleting = reminder }
                    toggleButton(for: reminder)
                }
                .contextMenu {
                    Button("Edit", systemImage: "pencil") { editor = .edit(reminder) }
                    toggleButton(for: reminder)
                    Button("Delete", systemImage: "trash", role: .destructive) { deleting = reminder }
                }
            }
            Button("New Reminder", systemImage: "plus") { editor = .new }
        } header: {
            Text("Your reminders (\(model.reminders.count))")
        } footer: {
            if model.reminders.isEmpty {
                Text("None yet. Create one to post a message on a schedule.")
            }
        }
    }

    @ViewBuilder
    private func toggleButton(for reminder: Reminder) -> some View {
        if reminder.enabled {
            Button("Pause", systemImage: "pause.circle") { Task { await model.toggle(reminder.id) } }
                .tint(.orange)
        } else {
            Button("Resume", systemImage: "play.circle") { Task { await model.toggle(reminder.id) } }
                .tint(.green)
        }
    }

    private func channelName(of reminder: Reminder) -> String {
        model.channels.first { $0.id == reminder.channelId }?.name ?? reminder.channelId
    }

    private var pingsBinding: Binding<Bool> {
        Binding(
            get: { model.allowPings ?? false },
            set: { allow in Task { await model.setAllowPings(allow) } })
    }

    private var isDeleting: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// What the reminder sheet is for: a new reminder, or one that is already stored.
enum ReminderEditorTarget: Identifiable {
    case new
    case edit(Reminder)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let reminder): "edit-\(reminder.id)"
        }
    }
}

/// A reminder's name with its Active or Paused tag, over its channel and schedule and when it last posted.
private struct ReminderRow: View {
    let reminder: Reminder
    let channelName: String
    let presets: [ReminderPreset]
    let weekdays: [ScheduleWeekday]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: reminder.name)
                    .lineLimit(2)
                ActiveBadge(isActive: reminder.enabled)
            }
            Text(verbatim: "#\(channelName) \u{00B7} " + reminder.scheduleSummary(presets: presets, weekdays: weekdays))
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let last = reminder.lastRunAt {
                Text("Last posted \(DateText.relative(last))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        guard endpoint is Endpoints.LoadReminders else { return nil }
        return RemindersPage(
            reminders: [
                Reminder(id: 1, name: "Stand-up", channelId: "c1", content: "Stand-up in five minutes.",
                         intervalMinutes: 1440, days: [1, 2, 3, 4, 5]),
                Reminder(id: 2, name: "Launch", channelId: "c1", content: "We are live.", mode: .single,
                         runAt: Date().addingTimeInterval(86_400), enabled: false),
            ],
            allowPings: false, channels: [ChannelOption(id: "c1", name: "announcements")])
    }
    NavigationStack {
        RemindersView(server: "1", session: session)
    }
    .environment(session)
}
