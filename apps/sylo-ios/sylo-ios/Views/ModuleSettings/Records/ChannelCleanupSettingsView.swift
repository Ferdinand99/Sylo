import SwiftUI
import SyloKit

/// Channel cleanup: per channel, a weekly schedule that deletes messages older than a set age.
/// Mirrors web-v2/src/moduleForms/ChannelCleanup.jsx.
struct ChannelCleanupSettingsView: View {
    let server: ServerID

    @State private var model: RecordListModel<ChannelCleanupPage>
    @State private var note: ModulePlatformNoteModel
    @State private var editing: CleanupScheduleDraft?
    @State private var pendingDelete: CleanupSchedule?

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: RecordListModel(channelCleanup: server, session: session))
        _note = State(
            initialValue: ModulePlatformNoteModel(server: server, module: ChannelCleanupPage.moduleID, session: session))
    }

    var body: some View {
        RecordScreen("Channel Cleanup", model: model, note: note) { page in
            ModuleIntro("Delete messages older than a set age from a channel, on a weekly schedule you pick. Sylo needs Manage Messages in the channel.")

            Section {
                if page.schedules.isEmpty {
                    Text("None yet. Create one to start cleaning up a channel.")
                        .foregroundStyle(Color.syloMuted)
                }
                ForEach(page.schedules) { schedule in
                    RecordRow(
                        title: channelName(schedule.channelId, page: page), details: details(of: schedule, page: page),
                        status: schedule.isEnabled ? LocalizedStringKey("Active") : LocalizedStringKey("Paused"),
                        isActive: schedule.isEnabled
                    ) {
                        editing = CleanupScheduleDraft(schedule: schedule)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = schedule }
                        Button(
                            schedule.isEnabled ? "Pause" : "Resume",
                            systemImage: schedule.isEnabled ? "pause.circle" : "play.circle"
                        ) {
                            Task { _ = await model.toggle(schedule) }
                        }
                        .tint(.orange)
                    }
                    .contextMenu {
                        Button(
                            schedule.isEnabled ? "Pause" : "Resume",
                            systemImage: schedule.isEnabled ? "pause.circle" : "play.circle"
                        ) {
                            Task { _ = await model.toggle(schedule) }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = schedule }
                    }
                    .accessibilityAction(named: Text("Delete")) { pendingDelete = schedule }
                }
                Button("New Schedule", systemImage: "plus") {
                    editing = CleanupScheduleDraft()
                }
            } header: {
                Text("Your schedules (\(page.schedules.count))")
            }
        }
        .sheet(item: $editing) { draft in
            if let page = model.page {
                ScheduleEditor(
                    draft: draft, page: page, save: { await model.save($0) }, failure: { model.takeActionError() })
            }
        }
        .confirmationDialog(
            "Delete this cleanup schedule?", isPresented: isConfirmingDelete, titleVisibility: .visible,
            presenting: pendingDelete
        ) { schedule in
            Button("Delete Schedule", role: .destructive) { Task { _ = await model.delete(schedule) } }
        } message: { _ in
            Text("It stops running straight away. Messages it already deleted stay deleted.")
        }
    }

    private func channelName(_ id: String, page: ChannelCleanupPage) -> String {
        page.channels.first { $0.id == id }.map { "#\($0.name)" } ?? String(localized: "Deleted channel")
    }

    private func details(of schedule: CleanupSchedule, page: ChannelCleanupPage) -> String {
        let days = WeekdayOption.summary(of: schedule.days, in: page.weekdays)
        var parts = [
            "\(days) \(String(localized: "at")) \(schedule.timeHhmm)",
            String(localized: "older than \(schedule.ageSummary)"),
        ]
        if let date = schedule.lastRunDate {
            let count = schedule.lastRunCount.map { $0 > 0 ? " (\($0) deleted)" : "" } ?? ""
            parts.append(String(localized: "last ran \(date)") + count)
        }
        return parts.joined(separator: " · ")
    }

    private var isConfirmingDelete: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }
}

/// Edits one cleanup schedule in a sheet.
private struct ScheduleEditor: View {
    @State var draft: CleanupScheduleDraft
    let page: ChannelCleanupPage
    let save: (CleanupScheduleDraft) async -> Bool
    let failure: () -> String?

    @State private var initial: CleanupScheduleDraft?

    var body: some View {
        RecordEditor(
            title: draft.scheduleID == nil ? "New Schedule" : "Edit Schedule",
            problem: draft.problem(maxAgeHoursCap: page.maxAgeHoursCap),
            hasChanges: initial.map { $0 != draft } ?? false,
            save: { await save(draft) }, failure: failure
        ) {
            Section {
                ChannelPicker(
                    title: "Channel", selection: $draft.channelId, channels: page.channels,
                    noneTitle: "Choose a channel")
            }

            Section("Run on") {
                WeekdayPicker(weekdays: page.weekdays, selection: $draft.days)
            }

            Section {
                DatePicker("At", selection: time, displayedComponents: .hourAndMinute)
                NumberField(
                    title: "Delete messages older than", value: $draft.maxAgeHours,
                    range: CleanupScheduleDraft.minAgeHours...page.maxAgeHoursCap, unit: "hours")
                Toggle("Never delete pinned messages", isOn: $draft.skipPinned)
            } header: {
                Text("When")
            } footer: {
                Text("The time is the server's local time. That is \(CleanupSchedule.ageSummary(hours: draft.maxAgeHours)) of messages kept; the most is \(page.maxAgeHoursCap) hours (90 days).")
            }
        }
        .onAppear { if initial == nil { initial = draft } }
    }

    /// The time of day as a date, for the picker.
    private var time: Binding<Date> {
        Binding(
            get: {
                Calendar.current.date(from: DateComponents(hour: draft.hour, minute: draft.minute)) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                draft.hour = parts.hour ?? draft.hour
                draft.minute = parts.minute ?? draft.minute
            })
    }
}
