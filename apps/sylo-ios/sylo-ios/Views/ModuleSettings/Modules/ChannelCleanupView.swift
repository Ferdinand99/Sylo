import SwiftUI
import SyloKit

/// Channel cleanup: delete the messages older than a set age from a channel, on the days and at the
/// time a schedule names. Make one, change it, pause it or delete it. Mirrors
/// web-v2/src/moduleForms/ChannelCleanup.jsx.
struct ChannelCleanupView: View {
    @State private var model: ChannelCleanupModel
    @State private var editor: CleanupEditorTarget?
    @State private var deleting: CleanupSchedule?

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ChannelCleanupModel(server: server, session: session))
    }

    var body: some View {
        content
            .navigationTitle("Channel Cleanup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.hasLoaded {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New Schedule", systemImage: "plus") { editor = .new }
                    }
                }
            }
            .task { await model.load() }
            .sheet(item: $editor) { target in
                CleanupEditorView(target: target, model: model)
            }
            .confirmationDialog(
                "Delete this cleanup schedule?", isPresented: isDeleting, titleVisibility: .visible,
                presenting: deleting
            ) { schedule in
                Button("Delete Schedule", role: .destructive) { Task { await model.delete(schedule.id) } }
            } message: { _ in
                Text("It stops running straight away. Messages it already deleted stay deleted.")
            }
            .alert("Couldn't Change Schedule", isPresented: isShowingActionError, presenting: model.actionError) { _ in
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
                ModuleIntro("Delete messages older than a set age from a channel, on a weekly schedule you pick. Sylo needs Manage Messages in the channel.")
                Section {
                    ForEach(model.schedules) { schedule in
                        Button {
                            editor = .edit(schedule)
                        } label: {
                            ScheduleRow(
                                schedule: schedule, channelName: channelName(of: schedule), weekdays: model.weekdays,
                                clock: model.clock)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy.contains(schedule.id))
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = schedule }
                            toggleButton(for: schedule)
                        }
                        .contextMenu {
                            Button("Edit", systemImage: "pencil") { editor = .edit(schedule) }
                            toggleButton(for: schedule)
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = schedule }
                        }
                    }
                    Button("New Schedule", systemImage: "plus") { editor = .new }
                } header: {
                    Text("Your schedules (\(model.schedules.count))")
                } footer: {
                    if model.schedules.isEmpty {
                        Text("None yet. Create one to start cleaning up a channel.")
                    }
                }
            }
            .refreshable { await model.load() }
        } else if let message = model.errorMessage {
            ContentUnavailableView {
                Label("Couldn't Load Schedules", systemImage: "exclamationmark.triangle")
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
    private func toggleButton(for schedule: CleanupSchedule) -> some View {
        if schedule.enabled {
            Button("Pause", systemImage: "pause.circle") { Task { await model.toggle(schedule.id) } }
                .tint(.orange)
        } else {
            Button("Resume", systemImage: "play.circle") { Task { await model.toggle(schedule.id) } }
                .tint(.green)
        }
    }

    private func channelName(of schedule: CleanupSchedule) -> String {
        model.channels.first { $0.id == schedule.channelId }?.name ?? schedule.channelId
    }

    private var isDeleting: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    private var isShowingActionError: Binding<Bool> {
        Binding(get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } })
    }
}

/// What the schedule sheet is for: a new schedule, or one that is already stored.
enum CleanupEditorTarget: Identifiable {
    case new
    case edit(CleanupSchedule)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let schedule): "edit-\(schedule.id)"
        }
    }
}

/// A schedule's channel with its Active or Paused tag, over when it runs, how old a message must be
/// and when it last ran.
private struct ScheduleRow: View {
    let schedule: CleanupSchedule
    let channelName: String
    let weekdays: [ScheduleWeekday]
    let clock: ServerClock

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: "#\(channelName)")
                    .lineLimit(2)
                ActiveBadge(isActive: schedule.enabled)
            }
            Text(verbatim: details)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// "Mon/Wed at 03:00 · older than 1d · last ran 2026-11-12 (5 deleted)".
    private var details: String {
        var parts = [
            schedule.whenSummary(weekdays: weekdays, clock: clock),
            String(localized: "older than \(CleanupSchedule.ageLabel(hours: schedule.maxAgeHours))"),
        ]
        if let last = schedule.lastRunSummary { parts.append(last) }
        return parts.joined(separator: " \u{00B7} ")
    }
}

/// The form for a new schedule or a stored one. Mirrors `ScheduleForm` in
/// web-v2/src/moduleForms/ChannelCleanup.jsx.
private struct CleanupEditorView: View {
    let target: CleanupEditorTarget
    let model: ChannelCleanupModel

    @State private var draft: CleanupDraft
    @State private var initial: CleanupDraft
    @State private var limits = ModuleFieldLimits.unlimited
    @State private var isConfirmingDiscard = false
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSession.self) private var session

    init(target: CleanupEditorTarget, model: ChannelCleanupModel) {
        self.target = target
        self.model = model
        let start: CleanupDraft
        switch target {
        case .new: start = CleanupDraft()
        case .edit(let schedule): start = CleanupDraft(editing: schedule)
        }
        _draft = State(initialValue: start)
        _initial = State(initialValue: start)
    }

    private var editingID: Int? {
        guard case .edit(let schedule) = target else { return nil }
        return schedule.id
    }

    private var isNew: Bool { editingID == nil }
    private var hasChanges: Bool { draft != initial }
    private var ageRange: ClosedRange<Int> {
        let low = max(1, limits["maxAgeHours"].min ?? 1)
        let high = min(model.maxAgeHoursCap, limits["maxAgeHours"].max ?? model.maxAgeHoursCap)
        return low...max(low, high)
    }
    private var problem: String? { draft.problem(maxAgeHoursCap: ageRange.upperBound) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ChannelPicker(title: "Channel", selection: $draft.channelId, channels: model.channels,
                                  noneTitle: "Select a channel")
                }

                Section {
                    ScheduleDayPicker(selection: daysBinding, weekdays: model.weekdays)
                } header: {
                    if model.clock.needsServerTimeLabel {
                        Text("Run on (server time)")
                    } else {
                        Text("Run on")
                    }
                } footer: {
                    Text("With no day picked, the schedule runs every day.")
                }

                Section {
                    DatePicker("At", selection: timeBinding, displayedComponents: .hourAndMinute)
                        .environment(\.timeZone, CleanupTime.floatingZone)
                } header: {
                    if model.clock.needsServerTimeLabel {
                        Text("At (server time)")
                    }
                } footer: {
                    if model.clock.needsServerTimeLabel {
                        Text("The time is on the server's clock, which may not be your time zone.")
                    }
                }

                Section {
                    NumberField(title: "Older than", value: $draft.maxAgeHours, range: ageRange, unit: "hours")
                } header: {
                    Text("Delete messages")
                } footer: {
                    Text("That is \(CleanupSchedule.ageLabel(hours: draft.maxAgeHours)). The most is \(ageRange.upperBound) hours.")
                }

                Section {
                    Toggle("Never delete pinned messages", isOn: $draft.skipPinned)
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
            .navigationTitle(isNew ? "New Schedule" : "Edit Schedule")
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
                            .disabled(problem != nil || (!isNew && !hasChanges))
                    }
                }
            }
            .confirmationDialog("Discard your changes?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
            }
        }
        .interactiveDismissDisabled(hasChanges || model.isSaving)
        .onAppear { model.saveError = nil }
        .task { limits = await session.moduleLimits()["channel-cleanup"] }
    }

    /// The draft holds the time and days as the server counts them. When the server's zone is known
    /// and differs from the phone's, the pickers show them on the phone's clock and the draft is
    /// converted back on every change; with a zone that is not known they show the server's own.
    private var phoneSchedule: (time: String, days: Set<Int>) {
        model.clock.phoneSchedule(time: draft.timeHhmm, days: draft.days)
    }

    /// The time of day as a floating date for the picker (see ``CleanupTime``).
    private var timeBinding: Binding<Date> {
        Binding(
            get: { CleanupTime.date(from: phoneSchedule.time) ?? CleanupTime.date(from: "03:00") ?? .now },
            set: { newTime in
                // The days the person sees stay as they are while the time moves, even when the
                // server's day changes with it.
                let shown = phoneSchedule.days
                let server = model.clock.serverSchedule(time: CleanupTime.text(from: newTime), days: shown)
                draft.timeHhmm = server.time
                draft.days = server.days
            })
    }

    private var daysBinding: Binding<Set<Int>> {
        Binding(
            get: { phoneSchedule.days },
            set: { newDays in
                draft.days = model.clock.serverSchedule(time: phoneSchedule.time, days: newDays).days
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
        guard endpoint is Endpoints.LoadCleanupSchedules else { return nil }
        return CleanupPage(
            schedules: [
                CleanupSchedule(id: 1, channelId: "c1", days: [1, 3, 5], timeHhmm: "03:00", maxAgeHours: 48,
                                lastRunDate: "2026-11-12", lastRunCount: 14),
                CleanupSchedule(id: 2, channelId: "c1", maxAgeHours: 36, enabled: false),
            ],
            channels: [ChannelOption(id: "c1", name: "off-topic")])
    }
    NavigationStack {
        ChannelCleanupView(server: "1", session: session)
    }
    .environment(session)
}
