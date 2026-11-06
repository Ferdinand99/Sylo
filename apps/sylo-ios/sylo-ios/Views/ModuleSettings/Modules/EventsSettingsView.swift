import SwiftUI
import SyloKit

/// Events: the default channel and reminder, DM reminders, event pages, the time zone commands
/// read times in and the staff roles, with the events listed read only. Creating, editing and
/// cancelling an event are on their own screen. Mirrors web-v2/src/moduleForms/Events.jsx.
struct EventsSettingsView: View {
    @State private var model: ModuleSettingsModel<EventsPage>
    @State private var note: ModulePlatformNoteModel
    private let server: ServerID

    @Environment(AppSession.self) private var session

    init(server: ServerID, session: AppSession) {
        self.server = server
        _model = State(initialValue: ModuleSettingsModel(server: server, session: session))
        _note = State(initialValue: ModulePlatformNoteModel(server: server, module: EventsPage.moduleID, session: session))
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

            Section {
                NavigationLink {
                    EventsManageView(server: server, session: session)
                } label: {
                    LabeledContent {
                        Text("\(page.upcoming.count) upcoming")
                    } label: {
                        Label("Events", systemImage: "calendar")
                    }
                }
            } footer: {
                Text("Post, change and cancel events.")
            }
        }
        .task { await note.load() }
    }

    @ViewBuilder
    private func eventSection(_ title: LocalizedStringKey, _ events: [EventSummary], emptyText: LocalizedStringKey) -> some View {
        Section(title) {
            if events.isEmpty {
                Text(emptyText).foregroundStyle(.secondary)
            }
            ForEach(events) { event in
                ListLine(title: "#\(event.id) · \(event.title)", details: Self.details(of: event))
            }
        }
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

/// The time zone commands read times in: a row that opens a searchable list. "" is UTC.
struct TimeZoneRow: View {
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

struct TimeZoneList: View {
    @Binding var selection: String
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
            if search.isEmpty {
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
