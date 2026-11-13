import SwiftUI
import SyloKit

/// The form for a new reminder or a stored one: a name, the channel, the message (text, or an
/// embed in the shared embed editor), a test, and the schedule (once at a time, or every so often
/// with an optional window and days of the week). Mirrors `ReminderForm` in
/// web-v2/src/moduleForms/Reminders.jsx.
///
/// Times are exact moments: the pickers use the phone's own time zone and the app sends them as
/// instants. The days of the week are counted on the server's clock.
struct ReminderEditorView: View {
    let target: ReminderEditorTarget
    let model: RemindersModel

    @State private var draft: ReminderDraft
    @State private var initial: ReminderDraft
    @State private var limits = ModuleFieldLimits.unlimited
    @State private var isConfirmingDiscard = false
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSession.self) private var session

    init(target: ReminderEditorTarget, model: RemindersModel) {
        self.target = target
        self.model = model
        let start: ReminderDraft
        switch target {
        case .new: start = ReminderDraft()
        case .edit(let reminder): start = ReminderDraft(editing: reminder)
        }
        _draft = State(initialValue: start)
        _initial = State(initialValue: start)
    }

    private var editingID: Int? {
        guard case .edit(let reminder) = target else { return nil }
        return reminder.id
    }

    private var isNew: Bool { editingID == nil }

    /// A stored reminder that is switched off (paused, or a single one that already posted).
    private var isPaused: Bool {
        guard case .edit(let reminder) = target else { return false }
        return !reminder.enabled
    }
    private var hasChanges: Bool { draft != initial }
    private var nameLimit: Int { limits["name"].maxLength ?? ReminderDraft.nameLimit }
    private var contentLimit: Int { limits["content"].maxLength ?? ReminderDraft.contentLimit }

    var body: some View {
        NavigationStack {
            Form {
                nameSection
                messageSection
                scheduleSection
                if let message = model.saveError {
                    Section {
                        StatusMessage(message, kind: .error)
                    }
                }
            }
            .disabled(model.isSaving)
            .navigationTitle(isNew ? "New Reminder" : "Edit Reminder")
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
                        Button(isNew ? "Create" : "Save") { save() }
                            .toolbarSaveStyle()
                            .disabled(draft.problem != nil || (!isNew && !hasChanges))
                    }
                }
            }
            .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
            }
        }
        .interactiveDismissDisabled(hasChanges || model.isSaving)
        .tracksUnsavedChanges(hasChanges)
        .onAppear {
            model.saveError = nil
            model.clearTestOutcome()
        }
        .task { limits = await session.moduleLimits()["reminders"] }
    }

    // MARK: - Sections

    private var nameSection: some View {
        Section {
            LimitedTextField(title: "Name", text: $draft.name, limit: nameLimit, prompt: Text("my new reminder"))
            ChannelPicker(title: "Channel", selection: $draft.channelId, channels: model.channels,
                          noneTitle: "Select a channel")
        } footer: {
            Text("The name is only for finding the reminder in the app and the dashboard. Sylo needs Send Messages and Embed Links in the channel.")
        }
    }

    private var messageSection: some View {
        Section {
            Picker("Message type", selection: $draft.kind) {
                Text("Text").tag(ReminderDraft.MessageKind.text)
                Text("Embed").tag(ReminderDraft.MessageKind.embed)
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)

            switch draft.kind {
            case .text:
                LimitedTextField(title: "Hey, I'm a reminder!", text: $draft.content, limit: contentLimit, lines: 3...8)
            case .embed:
                NavigationLink {
                    EmbedEditorView(draft: $draft.embed, options: ReminderDraft.embedOptions)
                } label: {
                    EmbedSummary(draft: draft.embed)
                }
            }

            Button {
                Task { await model.sendTest(draft) }
            } label: {
                if model.isTesting {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Sending…")
                    }
                } else {
                    Label("Send Test Message", systemImage: "paperplane")
                }
            }
            .disabled(draft.channelId.isEmpty || !draft.hasMessage || model.isTesting)

            switch model.testOutcome {
            case .sent?:
                StatusMessage("Test message sent to the channel.", kind: .notice)
            case .failed(let message)?:
                StatusMessage(message, kind: .error)
            case nil:
                EmptyView()
            }
        } header: {
            Text("Message")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text("The test posts this message to the channel now. Nothing is saved.")
                if draft.droppedEmbeds > 0 {
                    Text("This reminder holds \(draft.droppedEmbeds + 1) embeds. Only the first is kept when you save.")
                }
            }
        }
    }

    @ViewBuilder
    private var scheduleSection: some View {
        Section {
            Picker("Schedule", selection: $draft.mode) {
                Text("Once").tag(ReminderMode.single)
                Text("Repeat").tag(ReminderMode.multiple)
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)

            switch draft.mode {
            case .single:
                DatePicker("Send at", selection: $draft.runAt, displayedComponents: [.date, .hourAndMinute])
            case .multiple:
                Picker("Every", selection: $draft.intervalMinutes) {
                    ForEach(ReminderPreset.options(including: draft.intervalMinutes, in: model.schedulePresets)) { preset in
                        Text(verbatim: preset.label).tag(preset.minutes)
                    }
                }
                .pickerStyle(.navigationLink)
            }
        } header: {
            Text("When")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if draft.mode == .multiple {
                    Text("Every \(model.minIntervalMinutes) to \(model.maxIntervalMinutes) minutes.")
                }
                if let note = draft.timingNote(isPaused: isPaused) {
                    timingNoteText(note)
                }
            }
        }

        if draft.mode == .multiple {
            Section {
                Toggle("Add start time", isOn: $draft.enableStart)
                if draft.enableStart {
                    DatePicker("Starts", selection: $draft.startAt, displayedComponents: [.date, .hourAndMinute])
                }
                Toggle("Add end time", isOn: $draft.enableEnd)
                if draft.enableEnd {
                    DatePicker("Ends", selection: $draft.endAt, displayedComponents: [.date, .hourAndMinute])
                }
            } header: {
                Text("Window")
            } footer: {
                Text("Without them the reminder runs until you pause or delete it.")
            }

            Section {
                ScheduleDayPicker(selection: $draft.days, weekdays: model.weekdays)
            } header: {
                if model.clock.needsServerTimeLabel {
                    Text("Day of the week (server time)")
                } else {
                    Text("Day of the week")
                }
            } footer: {
                daysFooter
            }
        }

        if let problem = draft.problem {
            Section {
                StatusMessage(problem, kind: .notice)
            }
        }
    }

    /// What saving does with the timing, in words (see ``ReminderDraft/TimingNote``).
    @ViewBuilder
    private func timingNoteText(_ note: ReminderDraft.TimingNote) -> some View {
        switch note {
        case .postedOnce:
            Text("Posted once at this time, then switched off.")
        case .postsNow:
            Text("That time has passed: the reminder is posted as soon as you save it.")
        case .pausedPostsAtTime:
            Text("This reminder is off. Saving keeps it off; resume it from the list and it posts at this time.")
        case .pausedPostsOnResume:
            Text("That time has passed and this reminder is off. Saving keeps it off; resume it from the list and it posts at once.")
        case .pausedRepeating:
            Text("This reminder is paused. Saving keeps it paused; resume it from the list.")
        }
    }

    /// The days are counted on the server's clock, which the app cannot move to the phone's (each run
    /// has its own time of day): say which clock it is, unless it is the phone's.
    @ViewBuilder
    private var daysFooter: some View {
        if let zone = model.clock.differingZoneName() {
            Text("Days are counted in the server's time zone, \(zone). With no day picked, the reminder runs every day.")
        } else if model.clock.needsServerTimeLabel {
            Text("Days are counted on the server's clock, which may not be your time zone. With no day picked, the reminder runs every day.")
        } else {
            Text("With no day picked, the reminder runs every day.")
        }
    }

    // MARK: - Save

    private func save() {
        Task {
            if await model.save(draft, editing: editingID) { dismiss() }
        }
    }
}

/// The row that opens the embed editor: the embed's title, or the start of its text.
private struct EmbedSummary: View {
    let draft: EmbedDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !draft.title.isEmpty {
                Text(verbatim: draft.title)
            } else {
                Text("Edit Embed")
            }
            if !draft.description.isEmpty {
                Text(verbatim: draft.description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else if !draft.content.isEmpty {
                Text(verbatim: draft.content)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}
