import SwiftUI
import SyloKit

/// Events: the default channel and reminder, DM reminders, event pages, the time zone commands
/// read times in and the staff roles, and the events themselves: post a new one, edit an upcoming
/// one or cancel it. Mirrors web-v2/src/moduleForms/Events.jsx.
struct EventsSettingsView: View {
    @State private var model: ModuleSettingsModel<EventsPage>
    @State private var note: ModulePlatformNoteModel
    @State private var actions: EventActionsModel
    @State private var editor: EventEditorTarget?
    @State private var cancelling: EventSummary?
    @Environment(AppSession.self) private var session

    init(server: ServerID, session: AppSession) {
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: EventsPage.moduleID, session: session))
        _actions = State(initialValue: EventActionsModel(server: server, session: session))
    }

    var body: some View {
        ModuleSettingsForm("Events", model: model) { $settings, page in
            ModuleIntro("Post an event with Join, Maybe and Leave sign-ups. Sylo reminds everyone who joined and closes the event when it is over.")
            PlatformNoteSection(model: note)

            Section {
                ChannelPicker(title: "Default channel", selection: $settings.channel, channels: page.channels,
                              noneTitle: "Where the command is used")
            } footer: {
                Text("Where a new event is posted when the command names no channel.")
            }

            Section {
                Picker("Default reminder", selection: $settings.reminderMinutes) {
                    ForEach(EventsSettings.reminderOptions(including: settings.reminderMinutes), id: \.self) { minutes in
                        Text(verbatim: Self.reminderTitle(minutes)).tag(minutes)
                    }
                }
                Toggle("Also DM the reminder", isOn: $settings.dmReminders)
            } footer: {
                Text("The DM goes to everyone who pressed Join. Members with DMs closed are skipped quietly.")
            }

            Section {
                Toggle("Event pages", isOn: $settings.publicPages)
            } footer: {
                Text("Every event gets a page with its title, time, place, image and sign-up counts: no names, no host and no roles. The link is added to the event's post. Saving this updates the posts of the server's events, finished ones too.")
            }

            Section {
                TimeZoneRow(selection: $settings.timeZone)
            } footer: {
                Text("Commands read their times in this zone unless the command names another. Blank is UTC.")
            }

            Section {
                MultiPicker(title: "Staff roles", selection: $settings.staffRoles, options: page.roles, prefix: "@")
            } footer: {
                Text("May manage events without Manage Events.")
            }

            let events = actions.events ?? page.events
            upcomingSection(events.filter { $0.state == .scheduled })
            let past = events.filter { $0.state != .scheduled }
            if !past.isEmpty {
                Section("Past events") {
                    ForEach(past) { event in
                        EventRow(event: event, pageURL: pageURL(of: event))
                    }
                }
            }
        }
        .task { await note.load() }
        // A fresh page replaces what the last action answered.
        .onChange(of: model.page?.events) { actions.forgetAnswer() }
        // Saving can change which events have a page, so the list comes again after a save.
        .onChange(of: model.saveCount) { Task { await model.load() } }
        .sheet(item: $editor) { target in
            EventEditorView(
                target: target, actions: actions, channels: model.page?.channels ?? [],
                roles: model.page?.roles ?? [], defaults: model.page?.settings ?? EventsSettings())
        }
        .confirmationDialog(
            "Cancel This Event?", isPresented: isCancelling, titleVisibility: .visible, presenting: cancelling
        ) { event in
            Button("Cancel Event", role: .destructive) {
                Task { await actions.cancel(id: event.id) }
            }
            Button("Keep Event", role: .cancel) {}
        } message: { event in
            Text("“\(event.title)” is marked as cancelled, the participant role is taken back and sign-ups stop.")
        }
        .alert("Couldn't Update Events", isPresented: isShowingError, presenting: actions.errorMessage) { _ in
            Button("OK") {}
        } message: { message in
            Text(message)
        }
        .sensoryFeedback(.success, trigger: actions.doneCount)
    }

    private func upcomingSection(_ upcoming: [EventSummary]) -> some View {
        Section {
            if upcoming.isEmpty {
                Text("None scheduled.").foregroundStyle(.secondary)
            }
            ForEach(upcoming) { event in
                EventRow(event: event, pageURL: pageURL(of: event)) {
                    editor = .edit(event)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button("Cancel Event", systemImage: "xmark.circle", role: .destructive) { cancelling = event }
                }
                .contextMenu {
                    Button("Edit", systemImage: "pencil") { editor = .edit(event) }
                    Button("Cancel Event", systemImage: "xmark.circle", role: .destructive) { cancelling = event }
                }
            }
            Button("New Event", systemImage: "plus") { editor = .new }
        } header: {
            Text("Upcoming events (\(upcoming.count))")
        }
    }

    private func pageURL(of event: EventSummary) -> URL? {
        guard let path = event.pagePath, let base = session.server else { return nil }
        return base.url(for: path)
    }

    private var isCancelling: Binding<Bool> {
        Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } })
    }

    /// The editor shows its own errors while it is open.
    private var isShowingError: Binding<Bool> {
        Binding(
            get: { actions.errorMessage != nil && editor == nil },
            set: { if !$0 { actions.errorMessage = nil } })
    }

    /// "Thu 24 Sep, 19:00 · #events · 4/12 going · 1 maybe".
    static func details(of event: EventSummary) -> String {
        var parts: [String] = []
        if let start = event.startDate {
            parts.append(DateText.dayAndTime(start, timeZone: event.zone))
        }
        if !event.channel.isEmpty { parts.append("#\(event.channel)") }
        switch event.state {
        case .cancelled: parts.append("cancelled")
        case .ended: parts.append("ended")
        default: break
        }
        var going = "\(event.joined)" + (event.capacity.map { "/\($0)" } ?? "") + " going"
        if event.maybe > 0 { going += " · \(event.maybe) maybe" }
        parts.append(going)
        return parts.joined(separator: " · ")
    }

    /// "No reminder", "30 min before", "2 h before".
    static func reminderTitle(_ minutes: Int) -> String {
        if minutes == 0 { return String(localized: "No reminder") }
        if minutes >= 60, minutes % 60 == 0 { return String(localized: "\(minutes / 60) h before") }
        return String(localized: "\(minutes) min before")
    }
}

/// One event in the lists: its number and title, when and where, the sign-ups and, when the event has
/// one, the link to its page. A row with `onSelect` opens the event for editing.
struct EventRow: View {
    let event: EventSummary
    let pageURL: URL?
    var onSelect: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let onSelect {
                Button(action: onSelect) { line }
                    .buttonStyle(.plain)
            } else {
                line
            }
            if let pageURL {
                Link(event.isPageMembersOnly ? "Members-only page" : "Public page", destination: pageURL)
                    .font(.footnote)
                    .buttonStyle(.borderless)
            } else if event.pageHidden {
                Text("No page: the channel is age-restricted, or Sylo cannot see it.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var line: some View {
        ListLine(title: "#\(event.id) · \(event.title)", details: EventsSettingsView.details(of: event))
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
    }
}

/// The time zone commands read times in: a row that opens a searchable list. "" is UTC.
private struct TimeZoneRow: View {
    @Binding var selection: String

    var body: some View {
        NavigationLink {
            TimeZoneList(selection: $selection)
        } label: {
            LabeledContent("Time zone for commands") {
                Text(verbatim: selection.isEmpty ? "UTC" : selection)
            }
        }
    }
}

/// A searchable list of time zones. With `includesDefault` the first row is "" (UTC), the
/// setting's way of saying "none"; an event always names its zone, so its picker leaves it out.
struct TimeZoneList: View {
    @Binding var selection: String
    var includesDefault = true
    @State private var search = ""

    private var zones: [String] {
        var all = TimeZone.knownTimeZoneIdentifiers.sorted()
        // A zone the server stores that this device does not list stays selectable.
        if !selection.isEmpty, !all.contains(selection) { all.insert(selection, at: 0) }
        let text = search.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? all : all.filter { $0.localizedCaseInsensitiveContains(text) }
    }

    var body: some View {
        List {
            if includesDefault, search.isEmpty {
                row("UTC (default)", value: "")
            }
            ForEach(zones, id: \.self) { zone in
                row(zone, value: zone)
            }
        }
        .searchable(text: $search, prompt: "Search time zones")
        .navigationTitle("Time zone")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ title: String, value: String) -> some View {
        Button {
            selection = value
        } label: {
            HStack {
                Text(verbatim: title).foregroundStyle(.primary)
                Spacer()
                if selection == value {
                    Image(systemName: "checkmark").foregroundStyle(.tint).fontWeight(.semibold)
                }
            }
        }
        .accessibilityAddTraits(selection == value ? .isSelected : [])
    }
}

#Preview {
    let session = AppSession.preview(.signedIn) { endpoint in
        if endpoint is Endpoints.LoadPlatformInfo { return PlatformInfo(platform: .discord) }
        guard endpoint is Endpoints.LoadModuleSettings<EventsPage> else { return nil }
        return EventsPage(
            settings: EventsSettings(channel: "c1", reminderMinutes: 60, timeZone: "Europe/Oslo"),
            channels: [ChannelOption(id: "c1", name: "events")],
            roles: [RoleOption(id: "r1", name: "Moderators")],
            events: [EventSummary(id: 12, title: "Game night", startAt: 1_794_000_000_000, timeZone: "Europe/Oslo",
                                  channel: "events", joined: 4, maybe: 1, capacity: 12)])
    }
    NavigationStack {
        EventsSettingsView(server: "1", session: session)
    }
    .environment(session)
}
