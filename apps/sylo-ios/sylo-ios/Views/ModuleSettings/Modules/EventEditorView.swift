import SwiftUI
import SyloKit

/// What the event sheet is for: a new event, or one that is already posted.
enum EventEditorTarget: Identifiable {
    case new
    case edit(EventSummary)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let event): "edit-\(event.id)"
        }
    }
}

/// The form for a new event or an upcoming one. Mirrors `EventForm` in
/// web-v2/src/moduleForms/Events.jsx: the channel and the participant role are picked when the
/// event is posted and cannot be changed afterwards.
///
/// The times are wall-clock times in the event's time zone, like the dashboard's: the pickers show
/// them without the phone's own zone getting in the way (see ``EventTime``).
struct EventEditorView: View {
    let target: EventEditorTarget
    let actions: EventActionsModel
    let channels: [ChannelOption]
    let roles: [RoleOption]

    @State private var draft: EventDraft
    @Environment(\.dismiss) private var dismiss

    init(target: EventEditorTarget, actions: EventActionsModel, channels: [ChannelOption], roles: [RoleOption],
         defaults: EventsSettings) {
        self.target = target
        self.actions = actions
        self.channels = channels
        self.roles = roles
        switch target {
        case .new: _draft = State(initialValue: EventDraft(defaults: defaults))
        case .edit(let event): _draft = State(initialValue: EventDraft(editing: event))
        }
    }

    private var editingID: Int? {
        guard case .edit(let event) = target else { return nil }
        return event.id
    }

    private var isNew: Bool { editingID == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LimitedTextField(title: "Title", text: $draft.title, limit: EventDraft.titleLimit)
                    LimitedTextField(title: "Description (optional)", text: $draft.description, limit: EventDraft.descriptionLimit, lines: 3...8)
                }

                Section {
                    DatePicker("Starts", selection: $draft.start, displayedComponents: [.date, .hourAndMinute])
                        .environment(\.timeZone, EventTime.floatingZone)
                    Toggle("Set an end time", isOn: hasEnd)
                    if let end = draft.end {
                        DatePicker("Ends", selection: endBinding(end), displayedComponents: [.date, .hourAndMinute])
                            .environment(\.timeZone, EventTime.floatingZone)
                    }
                    NavigationLink {
                        TimeZoneList(selection: $draft.timeZone, includesDefault: false)
                    } label: {
                        LabeledContent("Time zone") {
                            Text(verbatim: draft.timeZone)
                        }
                    }
                } footer: {
                    Text("The times are read in this time zone. Members see them in their own zone in the post.")
                }

                if isNew {
                    Section {
                        ChannelPicker(title: "Post in", selection: $draft.channelID, channels: channels,
                                      noneTitle: "Select a channel")
                        RolePicker(title: "Participant role", selection: $draft.roleID, roles: roles)
                    } footer: {
                        Text("The participant role is optional: people have it while they are signed up.")
                    }
                }

                Section {
                    LimitedTextField(title: "Where (optional)", text: $draft.location, limit: EventDraft.locationLimit)
                    Toggle("Limit sign-ups", isOn: hasCapacity)
                    if draft.capacity != nil {
                        NumberField(title: "Capacity", value: capacity, range: EventDraft.capacityRange)
                    }
                    Picker("Reminder", selection: $draft.reminderMinutes) {
                        ForEach(EventsSettings.reminderOptions(including: draft.reminderMinutes), id: \.self) { minutes in
                            Text(verbatim: EventsSettingsView.reminderTitle(minutes)).tag(minutes)
                        }
                    }
                }

                Section {
                    TextField("Image link (optional)", text: $draft.imageURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    if let problem = shownProblem {
                        Text(problem).foregroundStyle(.red)
                    } else {
                        Text("An https link to a picture that goes in the post.")
                    }
                }
            }
            .disabled(actions.isWorking)
            .navigationTitle(isNew ? "New Event" : "Edit Event")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(actions.isWorking)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if actions.isWorking {
                        ProgressView()
                    } else {
                        Button(isNew ? "Post" : "Save") { Task { await save() } }
                            .toolbarSaveStyle()
                            .disabled(draft.problem(creating: isNew) != nil)
                    }
                }
            }
            .alert("Couldn't Save Event", isPresented: isShowingError, presenting: actions.errorMessage) { _ in
                Button("OK") {}
            } message: { message in
                Text(message)
            }
        }
        .interactiveDismissDisabled(actions.isWorking)
        .onAppear { actions.errorMessage = nil }
    }

    private func save() async {
        let done: Bool
        if let id = editingID {
            done = await actions.update(id: id, draft)
        } else {
            done = await actions.create(draft)
        }
        if done { dismiss() }
    }

    /// Why the draft cannot be saved, once there is a title to be wrong about.
    private var shownProblem: String? {
        draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : draft.problem(creating: isNew)
    }

    private var hasEnd: Binding<Bool> {
        Binding(
            get: { draft.end != nil },
            set: { draft.end = $0 ? draft.start.addingTimeInterval(3600) : nil })
    }

    private func endBinding(_ end: Date) -> Binding<Date> {
        Binding(get: { draft.end ?? end }, set: { draft.end = $0 })
    }

    private var hasCapacity: Binding<Bool> {
        Binding(
            get: { draft.capacity != nil },
            set: { draft.capacity = $0 ? (draft.capacity ?? 10) : nil })
    }

    private var capacity: Binding<Int> {
        Binding(get: { draft.capacity ?? 10 }, set: { draft.capacity = $0 })
    }

    private var isShowingError: Binding<Bool> {
        Binding(get: { actions.errorMessage != nil }, set: { if !$0 { actions.errorMessage = nil } })
    }
}
