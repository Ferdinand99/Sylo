import SwiftUI
import SyloKit

/// Reminders: a text or embed message posted to a channel, once or on a repeating schedule. Mirrors
/// web-v2/src/moduleForms/Reminders.jsx.
struct RemindersSettingsView: View {
    let server: ServerID

    @State private var model: RecordListModel<RemindersPage>
    @State private var note: ModulePlatformNoteModel
    @State private var editing: ReminderDraft?
    @State private var pendingDelete: Reminder?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(reminders: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: RemindersPage.moduleID, session: session))
    }

    var body: some View {
        RecordScreen("Reminders", model: model, note: note) { page in
            ModuleIntro("Post a text or embed message to a channel, once or on a repeating schedule.")

            Section {
                Toggle("Let reminders ping @everyone, @here and roles", isOn: pings(page))
            } header: {
                Text("Pings")
            } footer: {
                Text("When off, mentions in a reminder are shown but nobody is notified. It is off for new servers. Only the server owner or someone with Manage Server can change this.")
            }

            Section {
                if page.reminders.isEmpty {
                    Text("None yet. Create one below.")
                        .foregroundStyle(Color.syloMuted)
                }
                ForEach(page.reminders) { reminder in
                    RecordRow(
                        title: reminder.name, details: details(of: reminder, page: page),
                        status: reminder.isEnabled ? LocalizedStringKey("Active") : LocalizedStringKey("Paused"),
                        isActive: reminder.isEnabled
                    ) {
                        editing = ReminderDraft(reminder: reminder)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = reminder }
                        Button(
                            reminder.isEnabled ? "Pause" : "Resume",
                            systemImage: reminder.isEnabled ? "pause.circle" : "play.circle"
                        ) {
                            Task { _ = await model.toggle(reminder) }
                        }
                        .tint(.orange)
                    }
                    .contextMenu {
                        Button(
                            reminder.isEnabled ? "Pause" : "Resume",
                            systemImage: reminder.isEnabled ? "pause.circle" : "play.circle"
                        ) {
                            Task { _ = await model.toggle(reminder) }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = reminder }
                    }
                    .accessibilityAction(named: Text(reminder.isEnabled ? "Pause" : "Resume")) {
                        Task { _ = await model.toggle(reminder) }
                    }
                    .accessibilityAction(named: Text("Delete")) { pendingDelete = reminder }
                }
                Button("New Reminder", systemImage: "plus") {
                    editing = ReminderDraft()
                }
            } header: {
                Text("Your reminders (\(page.reminders.count))")
            }
        }
        .sheet(item: $editing) { draft in
            if let page = model.page {
                ReminderEditor(
                    draft: draft, page: page,
                    save: { await model.save($0) }, test: { await model.sendTest($0) },
                    failure: { model.takeActionError() })
            }
        }
        .confirmationDialog(
            "Delete this reminder?", isPresented: isConfirmingDelete, titleVisibility: .visible,
            presenting: pendingDelete
        ) { reminder in
            Button("Delete Reminder", role: .destructive) { Task { _ = await model.delete(reminder) } }
        } message: { _ in
            Text("It won't be posted again. This can't be undone.")
        }
    }

    private func pings(_ page: RemindersPage) -> Binding<Bool> {
        Binding(
            get: { page.allowPings },
            set: { allowed in Task { _ = await model.setPings(allowed) } })
    }

    private func details(of reminder: Reminder, page: RemindersPage) -> String {
        let channel = page.channels.first { $0.id == reminder.channelId }.map { "#\($0.name)" } ?? String(localized: "deleted channel")
        let schedule = reminder.scheduleSummary(
            presets: page.schedulePresets, weekdays: page.weekdays,
            once: { $0.formatted(date: .abbreviated, time: .shortened) })
        return "\(channel) · \(schedule)"
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }
}

/// Edits one reminder in a sheet.
private struct ReminderEditor: View {
    @State var draft: ReminderDraft
    let page: RemindersPage
    let save: (ReminderDraft) async -> Bool
    let test: (ReminderDraft) async -> Bool
    let failure: () -> String?

    @State private var initial: ReminderDraft?
    @State private var isTesting = false
    @State private var testResult: TestResult?

    private enum TestResult {
        case sent
        case failed(String)
    }

    var body: some View {
        RecordEditor(
            title: draft.reminderID == nil ? "New Reminder" : "Edit Reminder", problem: draft.problem,
            hasChanges: initial.map { $0 != draft } ?? false,
            save: { await save(draft) }, failure: failure
        ) {
            Section {
                TextField("Name", text: $draft.name)
                    .onChange(of: draft.name) {
                        if draft.name.count > ReminderDraft.maxNameLength {
                            draft.name = String(draft.name.prefix(ReminderDraft.maxNameLength))
                        }
                    }
                ChannelPicker(
                    title: "Channel", selection: $draft.channelId, channels: page.channels,
                    noneTitle: "Choose a channel")
            } footer: {
                Text("The name is shown on the dashboard only.")
            }

            Section {
                Picker("Message type", selection: $draft.isEmbed) {
                    Text("Text").tag(false)
                    Text("Embed").tag(true)
                }
                .pickerStyle(.segmented)
                TextArea(
                    title: draft.isEmbed ? "Optional text above the embed" : "Hey, I'm a reminder!",
                    text: $draft.content, limit: ReminderDraft.maxContentLength, lines: 3...8)
                if draft.isEmbed {
                    NavigationLink {
                        EmbedEditorScreen(title: "Embed", embed: $draft.embed, showsTimestamp: false)
                    } label: {
                        LabeledContent("Embed") {
                            Text(verbatim: draft.embed.title)
                        }
                    }
                }
                Button {
                    runTest()
                } label: {
                    if isTesting {
                        ProgressView()
                    } else {
                        Label("Send Test Message", systemImage: "paperplane")
                    }
                }
                .disabled(isTesting || draft.channelId.isEmpty)
            } header: {
                Text("Message")
            } footer: {
                switch testResult {
                case .sent:
                    Label("Test message sent to the channel.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(Color.syloBrand)
                case .failed(let message):
                    Text(message)
                case nil:
                    EmptyView()
                }
            }

            Section {
                Picker("Reminder", selection: $draft.mode) {
                    Text("Single").tag(ReminderMode.single)
                    Text("Multiple").tag(ReminderMode.multiple)
                }
                .pickerStyle(.segmented)
                if draft.mode == .single {
                    DatePicker("Send once at", selection: $draft.runAt)
                } else {
                    Picker("Every", selection: $draft.intervalMinutes) {
                        ForEach(intervalChoices) { preset in
                            Text(verbatim: preset.name).tag(preset.minutes)
                        }
                    }
                    Toggle("Start time", isOn: $draft.hasStart)
                    if draft.hasStart {
                        DatePicker("Starts", selection: $draft.startAt)
                    }
                    Toggle("End time", isOn: $draft.hasEnd)
                    if draft.hasEnd {
                        DatePicker("Ends", selection: $draft.endAt)
                    }
                }
            } header: {
                Text("Schedule")
            } footer: {
                if draft.mode == .multiple {
                    Text("Every \(page.minIntervalMinutes) to \(page.maxIntervalMinutes) minutes.")
                }
            }

            if draft.mode == .multiple {
                Section("Days of the week") {
                    WeekdayPicker(weekdays: page.weekdays, selection: $draft.days)
                }
            }
        }
        .onAppear { if initial == nil { initial = draft } }
    }

    /// The server's choices, plus the reminder's own interval when it is not one of them.
    private var intervalChoices: [SchedulePreset] {
        var choices = page.schedulePresets
        if !choices.contains(where: { $0.minutes == draft.intervalMinutes }) {
            choices.append(SchedulePreset(minutes: draft.intervalMinutes, name: "Every \(draft.intervalMinutes) minutes"))
        }
        return choices
    }

    private func runTest() {
        isTesting = true
        testResult = nil
        Task {
            let sent = await test(draft)
            isTesting = false
            testResult = sent ? .sent : .failed(failure() ?? String(localized: "The test message could not be sent."))
        }
    }
}
