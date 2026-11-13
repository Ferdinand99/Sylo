import Foundation
import Observation

// Reminders (src/web/routes/v2Api.js, `/modules/reminders/...`; the dashboard form is
// web-v2/src/moduleForms/Reminders.jsx). A reminder posts a text or an embed to a channel, once at
// a set time or on a repeating schedule. Reminders are rows of their own table, not module
// settings, so they have their own list page and their own calls, and the create path is
// `/reminders/new` (`/reminders` itself is the module's on/off switch).

/// A day of the week the way the server numbers it (0 is Sunday, 6 is Saturday), with its short name.
public struct ScheduleWeekday: Sendable, Hashable, Identifiable {
    public let number: Int
    public let label: String

    public var id: Int { number }

    public init(number: Int, label: String) {
        self.number = number
        self.label = label
    }

    /// What the server sends today; used when an older server does not send its list.
    public static let standard: [ScheduleWeekday] = [
        ScheduleWeekday(number: 0, label: "Sun"), ScheduleWeekday(number: 1, label: "Mon"),
        ScheduleWeekday(number: 2, label: "Tue"), ScheduleWeekday(number: 3, label: "Wed"),
        ScheduleWeekday(number: 4, label: "Thu"), ScheduleWeekday(number: 5, label: "Fri"),
        ScheduleWeekday(number: 6, label: "Sat"),
    ]
}

extension ScheduleWeekday: Decodable {
    /// The server sends a day as a pair: `[0, "Sun"]`.
    public init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        number = try c.decodeFlexibleInt()
        label = try c.decode(String.self)
    }
}

extension UnkeyedDecodingContainer {
    /// A whole number that may have been sent as text (`"60"`), as the server's preset list does.
    mutating func decodeFlexibleInt() throws -> Int {
        if let number = try? decode(Int.self) { return number }
        let text = try decode(String.self)
        guard let number = Int(text.trimmingCharacters(in: .whitespaces)) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: codingPath, debugDescription: "Not a whole number: \(text)"))
        }
        return number
    }
}

/// The days of the week a schedule runs on.
public enum ScheduleDays {
    public static let all: Set<Int> = Set(0...6)

    /// "every day" for all seven, else the short names in week order ("Mon/Wed"). A number the
    /// list does not name is left out.
    public static func label(for days: [Int], weekdays: [ScheduleWeekday] = ScheduleWeekday.standard) -> String {
        let unique = Set(days)
        if unique.count == 7 { return String(localized: "every day") }
        let names = Dictionary(weekdays.map { ($0.number, $0.label) }, uniquingKeysWith: { first, _ in first })
        return unique.sorted().compactMap { names[$0] }.joined(separator: "/")
    }
}

/// A repeat interval the server offers (`["60", "Every hour"]`).
public struct ReminderPreset: Sendable, Hashable, Identifiable {
    public let minutes: Int
    public let label: String

    public var id: Int { minutes }

    public init(minutes: Int, label: String) {
        self.minutes = minutes
        self.label = label
    }

    /// What the server sends today; used when an older server does not send its list.
    public static let standard: [ReminderPreset] = [
        ReminderPreset(minutes: 1, label: "Every minute"),
        ReminderPreset(minutes: 5, label: "Every 5 minutes"),
        ReminderPreset(minutes: 10, label: "Every 10 minutes"),
        ReminderPreset(minutes: 15, label: "Every 15 minutes"),
        ReminderPreset(minutes: 30, label: "Every 30 minutes"),
        ReminderPreset(minutes: 60, label: "Every hour"),
        ReminderPreset(minutes: 120, label: "Every 2 hours"),
        ReminderPreset(minutes: 180, label: "Every 3 hours"),
        ReminderPreset(minutes: 360, label: "Every 6 hours"),
        ReminderPreset(minutes: 720, label: "Every 12 hours"),
        ReminderPreset(minutes: 1440, label: "Every day"),
        ReminderPreset(minutes: 2880, label: "Every 2 days"),
        ReminderPreset(minutes: 10080, label: "Every week"),
    ]

    /// The presets, and the interval a reminder already has when it is none of them, so opening
    /// the form never changes it by itself.
    public static func options(including minutes: Int, in presets: [ReminderPreset]) -> [ReminderPreset] {
        if presets.contains(where: { $0.minutes == minutes }) { return presets }
        return presets + [ReminderPreset(minutes: minutes, label: Self.label(forMinutes: minutes))]
    }

    /// "Every 45 min" for an interval no preset names.
    public static func label(forMinutes minutes: Int) -> String {
        String(localized: "Every \(minutes) min")
    }
}

extension ReminderPreset: Decodable {
    public init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        minutes = try c.decodeFlexibleInt()
        label = try c.decode(String.self)
    }
}

/// How often a reminder posts.
public enum ReminderMode: String, Sendable, Equatable {
    /// Once, at a set time (`single`).
    case single
    /// On a repeating interval (`multiple`).
    case multiple
}

/// A reminder as the server stores and lists it.
public struct Reminder: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let name: String
    public let channelId: String
    /// The message text. With an embed it is the text above the embed.
    public let content: String
    /// The embed, when the reminder posts one. A reminder holds one embed in the dashboard.
    public let embed: EmbedDraft?
    /// How many embeds the stored message has. More than one is not editable: a save keeps the first.
    public let embedCount: Int
    public let mode: ReminderMode
    public let intervalMinutes: Int
    public let days: [Int]
    public let startAt: Date?
    public let endAt: Date?
    public let runAt: Date?
    public let lastRunAt: Date?
    public let enabled: Bool

    public init(
        id: Int, name: String = "", channelId: String = "", content: String = "", embed: EmbedDraft? = nil,
        embedCount: Int? = nil, mode: ReminderMode = .multiple, intervalMinutes: Int = 60,
        days: [Int] = Array(0...6), startAt: Date? = nil, endAt: Date? = nil, runAt: Date? = nil,
        lastRunAt: Date? = nil, enabled: Bool = true
    ) {
        self.id = id
        self.name = name
        self.channelId = channelId
        self.content = content
        self.embed = embed
        self.embedCount = embedCount ?? (embed == nil ? 0 : 1)
        self.mode = mode
        self.intervalMinutes = intervalMinutes
        self.days = days
        self.startAt = startAt
        self.endAt = endAt
        self.runAt = runAt
        self.lastRunAt = lastRunAt
        self.enabled = enabled
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, channelId, spec, mode, intervalMinutes, days, startAt, endAt, runAt, lastRunAt, enabled
    }

    private struct Spec: Decodable {
        let content: String
        let embeds: [EmbedDraft]

        private enum CodingKeys: String, CodingKey { case content, embeds }

        init(content: String, embeds: [EmbedDraft]) {
            self.content = content
            self.embeds = embeds
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            content = (try? c.decodeIfPresent(String.self, forKey: .content)) ?? ""
            embeds = try c.decodeLossyArray(of: EmbedDraft.self, forKey: .embeds)
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let spec = (try? c.decodeIfPresent(Spec.self, forKey: .spec)) ?? Spec(content: "", embeds: [])
        // The stored days are 0 to 6; the server treats an empty list as every day.
        let storedDays = ((try? c.decodeIfPresent([Int].self, forKey: .days)) ?? []).filter { (0...6).contains($0) }
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "",
            channelId: (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? "",
            content: spec.content,
            embed: spec.embeds.first,
            embedCount: spec.embeds.count,
            mode: ReminderMode(rawValue: (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? "") ?? .multiple,
            intervalMinutes: (try? c.decodeIfPresent(Int.self, forKey: .intervalMinutes)) ?? 60,
            days: storedDays.isEmpty ? Array(0...6) : storedDays,
            startAt: (try? c.decodeEpochMillisecondsIfPresent(forKey: .startAt)) ?? nil,
            endAt: (try? c.decodeEpochMillisecondsIfPresent(forKey: .endAt)) ?? nil,
            runAt: (try? c.decodeEpochMillisecondsIfPresent(forKey: .runAt)) ?? nil,
            lastRunAt: (try? c.decodeEpochMillisecondsIfPresent(forKey: .lastRunAt)) ?? nil,
            enabled: (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true)
    }

    /// "Once, Thu 24 Sep, 19:00", "Every hour · Mon/Wed" (the way the dashboard words a schedule).
    public func scheduleSummary(
        presets: [ReminderPreset] = ReminderPreset.standard, weekdays: [ScheduleWeekday] = ScheduleWeekday.standard,
        now: Date = .now, timeZone: TimeZone? = nil
    ) -> String {
        if mode == .single {
            guard let runAt else { return String(localized: "Once, no time set") }
            return String(localized: "Once, \(DateText.dayAndTime(runAt, now: now, timeZone: timeZone))")
        }
        let every = presets.first { $0.minutes == intervalMinutes }?.label
            ?? ReminderPreset.label(forMinutes: intervalMinutes)
        let unique = Set(days)
        if unique.count == 7 || unique.isEmpty { return every }
        return every + " \u{00B7} " + ScheduleDays.label(for: days, weekdays: weekdays)
    }
}

/// The Reminders page: the reminders, whether they may ping, and what the form offers.
public struct RemindersPage: Decodable, Sendable, Equatable {
    public let reminders: [Reminder]
    /// Whether reminders may ping `@everyone`, `@here` and roles. nil on a server from before the
    /// setting: the app then offers no switch and never sends one.
    public let allowPings: Bool?
    public let channels: [ChannelOption]
    public let schedulePresets: [ReminderPreset]
    public let weekdays: [ScheduleWeekday]
    public let minIntervalMinutes: Int
    public let maxIntervalMinutes: Int

    public init(
        reminders: [Reminder] = [], allowPings: Bool? = nil, channels: [ChannelOption] = [],
        schedulePresets: [ReminderPreset] = ReminderPreset.standard,
        weekdays: [ScheduleWeekday] = ScheduleWeekday.standard, minIntervalMinutes: Int = 1,
        maxIntervalMinutes: Int = 40320
    ) {
        self.reminders = reminders
        self.allowPings = allowPings
        self.channels = channels
        self.schedulePresets = schedulePresets
        self.weekdays = weekdays
        self.minIntervalMinutes = minIntervalMinutes
        self.maxIntervalMinutes = maxIntervalMinutes
    }

    private enum CodingKeys: String, CodingKey {
        case reminders, allowPings, channels, schedulePresets, weekdays, minIntervalMinutes, maxIntervalMinutes
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let presets = try c.decodeLossyArray(of: ReminderPreset.self, forKey: .schedulePresets)
        let days = try c.decodeLossyArray(of: ScheduleWeekday.self, forKey: .weekdays)
        self.init(
            reminders: try c.decodeLossyArray(of: Reminder.self, forKey: .reminders),
            allowPings: try? c.decodeIfPresent(Bool.self, forKey: .allowPings),
            channels: try c.decodeLossyArray(of: ChannelOption.self, forKey: .channels),
            schedulePresets: presets.isEmpty ? ReminderPreset.standard : presets,
            weekdays: days.isEmpty ? ScheduleWeekday.standard : days,
            minIntervalMinutes: (try? c.decodeIfPresent(Int.self, forKey: .minIntervalMinutes)) ?? 1,
            maxIntervalMinutes: (try? c.decodeIfPresent(Int.self, forKey: .maxIntervalMinutes)) ?? 40320)
    }
}

/// The answer to a save or a toggle: the reminder as it is now. nil when it is gone (a toggle of a
/// reminder someone deleted meanwhile).
public struct ReminderAnswer: Decodable, Sendable, Equatable {
    public let reminder: Reminder?

    public init(reminder: Reminder? = nil) { self.reminder = reminder }

    private enum CodingKeys: String, CodingKey { case reminder }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reminder = (try? c.decodeIfPresent(Reminder.self, forKey: .reminder)) ?? nil
    }
}

/// The answer to the pings switch: the value the server stored.
public struct ReminderPingsAnswer: Decodable, Sendable, Equatable {
    public let allowPings: Bool?

    public init(allowPings: Bool? = nil) { self.allowPings = allowPings }

    private enum CodingKeys: String, CodingKey { case allowPings }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        allowPings = (try? c.decodeIfPresent(Bool.self, forKey: .allowPings)) ?? nil
    }
}

/// What the reminder form edits: a new reminder, or one that is already stored.
public struct ReminderDraft: Sendable, Equatable {
    /// A plain text, or an embed (with an optional text above it).
    public enum MessageKind: Sendable, Equatable {
        case text, embed
    }

    public var name: String
    public var channelId: String
    public var kind: MessageKind
    /// The text of a text message.
    public var content: String
    /// The embed; its `content` is the text above it.
    public var embed: EmbedDraft
    public var mode: ReminderMode
    /// When a single reminder posts.
    public var runAt: Date
    public var intervalMinutes: Int
    public var enableStart: Bool
    public var startAt: Date
    public var enableEnd: Bool
    public var endAt: Date
    /// The days of the week a repeating reminder runs on (an empty set runs every day).
    public var days: Set<Int>
    /// How many embeds the stored message had: only the first is kept on a save.
    public var droppedEmbeds: Int

    // The server's limits (LIMITS in src/modules/scheduledMessages.js).
    public static let nameLimit = 100
    public static let contentLimit = 2000

    /// What the embed editor offers for a reminder: the text above the embed, and the switch that
    /// shows the current time (a stored one is kept).
    public static let embedOptions = EmbedOptions(content: true, timestamp: true)

    /// A new reminder: every hour, every day, no window, text.
    public init(now: Date = .now, calendar: Calendar = .current) {
        let next = Self.nextFullHour(after: now, calendar: calendar)
        name = ""
        channelId = ""
        kind = .text
        content = ""
        embed = EmbedDraft()
        mode = .multiple
        runAt = next
        intervalMinutes = 60
        enableStart = false
        startAt = next
        enableEnd = false
        endAt = next.addingTimeInterval(7 * 86_400)
        days = ScheduleDays.all
        droppedEmbeds = 0
    }

    /// A stored reminder, ready to be edited.
    public init(editing reminder: Reminder, now: Date = .now, calendar: Calendar = .current) {
        self.init(now: now, calendar: calendar)
        name = reminder.name
        channelId = reminder.channelId
        if let stored = reminder.embed {
            kind = .embed
            embed = stored
            embed.content = reminder.content
        } else {
            content = reminder.content
        }
        droppedEmbeds = max(0, reminder.embedCount - 1)
        mode = reminder.mode
        intervalMinutes = reminder.intervalMinutes
        if let run = reminder.runAt { runAt = run }
        if let start = reminder.startAt {
            enableStart = true
            startAt = start
        }
        if let end = reminder.endAt {
            enableEnd = true
            endAt = end
        }
        days = reminder.days.isEmpty ? ScheduleDays.all : Set(reminder.days)
    }

    /// The next whole hour after `now`, on the device's clock.
    public static func nextFullHour(after now: Date, calendar: Calendar = .current) -> Date {
        calendar.nextDate(
            after: now, matching: DateComponents(minute: 0, second: 0), matchingPolicy: .nextTime)
            ?? now.addingTimeInterval(3600)
    }

    /// Whether the message has anything to post.
    public var hasMessage: Bool {
        switch kind {
        case .text: !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .embed: !embed.isEmpty(Self.embedOptions)
        }
    }

    /// Why this cannot be sent yet, in a sentence; nil when it can. The server checks the rest.
    public var problem: String? {
        if channelId.isEmpty { return String(localized: "Pick a channel.") }
        if !hasMessage { return String(localized: "Add a message or an embed.") }
        if mode == .multiple, enableStart, enableEnd, endAt <= startAt {
            return String(localized: "The end time must be after the start time.")
        }
        return nil
    }

    /// Whether a single reminder is set for a time that has passed: the server posts it at once.
    public func postsImmediately(now: Date = .now) -> Bool {
        mode == .single && runAt <= now
    }
}

/// The body of a create, an edit and a test: what the dashboard's form sends. Times go as exact
/// instants (`2026-11-06T19:00:00Z`): the dashboard sends a wall-clock text that the server reads in
/// its own zone, which is only right when the browser and the server share a zone.
struct ReminderBody: Encodable, Sendable {
    let draft: ReminderDraft

    private enum CodingKeys: String, CodingKey {
        case name, channelId, msgType, content, embedSpec, mode, runAt, intervalMinutes
        case enableStart, startAt, enableEnd, endAt, days
    }

    /// An instant as the server reads it, cut to the minute like the dashboard's time field.
    static func instantText(_ date: Date) -> String {
        let minute = (date.timeIntervalSince1970 / 60).rounded(.down) * 60
        return Date(timeIntervalSince1970: minute).formatted(Date.ISO8601FormatStyle())
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(draft.name.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .name)
        try c.encode(draft.channelId, forKey: .channelId)
        try c.encode(draft.kind == .embed ? "embed" : "text", forKey: .msgType)
        try c.encode(draft.content, forKey: .content)
        try c.encode(draft.embed.spec(ReminderDraft.embedOptions), forKey: .embedSpec)
        try c.encode(draft.mode.rawValue, forKey: .mode)
        try c.encode(draft.mode == .single ? Self.instantText(draft.runAt) : "", forKey: .runAt)
        try c.encode(draft.intervalMinutes, forKey: .intervalMinutes)
        try c.encode(draft.enableStart, forKey: .enableStart)
        try c.encode(draft.enableStart ? Self.instantText(draft.startAt) : "", forKey: .startAt)
        try c.encode(draft.enableEnd, forKey: .enableEnd)
        try c.encode(draft.enableEnd ? Self.instantText(draft.endAt) : "", forKey: .endAt)
        try c.encode(draft.days.sorted(), forKey: .days)
    }
}

private struct ReminderPingsBody: Encodable, Sendable {
    let allowPings: Bool
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/reminders/list`.
    public struct LoadReminders: APIEndpoint {
        public typealias Response = RemindersPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/list" }
    }

    /// `POST /modules/reminders/new` for a new reminder, `POST /modules/reminders/:id` for a stored one.
    /// Not `/modules/reminders`: that path is the module's on/off switch.
    public struct SaveReminder: APIEndpoint {
        public typealias Response = ReminderAnswer
        public let server: ServerID
        /// nil creates a reminder.
        public let id: Int?
        public let draft: ReminderDraft

        public init(server: ServerID, id: Int? = nil, draft: ReminderDraft) {
            self.server = server
            self.id = id
            self.draft = draft
        }

        public var path: String {
            let base = "/api/v2/guilds/\(server.pathComponent)/modules/reminders"
            return id.map { "\(base)/\($0)" } ?? "\(base)/new"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { ReminderBody(draft: draft) }
    }

    /// `POST /modules/reminders/:id/delete`.
    public struct DeleteReminder: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST /modules/reminders/:id/toggle`: pauses an active reminder, resumes a paused one.
    public struct ToggleReminder: APIEndpoint {
        public typealias Response = ReminderAnswer
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/\(id)/toggle" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST /modules/reminders/settings` with `{allowPings}`. Only the server owner or someone with
    /// Manage Server may change it; the server answers with its own words otherwise.
    public struct SetReminderPings: APIEndpoint {
        public typealias Response = ReminderPingsAnswer
        public let server: ServerID
        public let allowPings: Bool
        public init(server: ServerID, allowPings: Bool) {
            self.server = server
            self.allowPings = allowPings
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/settings" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { ReminderPingsBody(allowPings: allowPings) }
    }

    /// `POST /modules/reminders/test`: posts the form's message to its channel right now.
    public struct TestReminder: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let draft: ReminderDraft
        public init(server: ServerID, draft: ReminderDraft) {
            self.server = server
            self.draft = draft
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/test" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { ReminderBody(draft: draft) }
    }
}

/// How a list action's failure is worded: the server's own words where it gave any. nil for a
/// call that was cancelled or whose sign-in ran out (the app handles those itself).
enum ListFailure {
    static func message(for error: any Error) -> String? {
        let error = NetworkError(error)
        if error == .cancelled || error == .unauthorized { return nil }
        return error.communityMessage
    }
}

/// The Reminders screen's state: the list, and every action on it. Each answer carries the
/// reminder as it is now, which replaces the one in the list, so the page is not loaded again.
@MainActor
@Observable
public final class RemindersModel {
    public let server: ServerID
    public private(set) var reminders: [Reminder] = []
    /// nil until the page loads, and on a server that has no pings setting.
    public private(set) var allowPings: Bool?
    public private(set) var channels: [ChannelOption] = []
    public private(set) var schedulePresets = ReminderPreset.standard
    public private(set) var weekdays = ScheduleWeekday.standard
    public private(set) var minIntervalMinutes = 1
    public private(set) var maxIntervalMinutes = 40320
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    /// Why the page could not be loaded (the last list, if any, stays).
    public var errorMessage: String?
    /// Why the last switch, pause or delete did not go through.
    public var actionError: String?
    /// Why the last save did not go through; the form shows it.
    public var saveError: String?
    public private(set) var isSaving = false
    public private(set) var isTesting = false
    /// What the last test message did.
    public private(set) var testOutcome: TestOutcome?
    /// The reminders a pause, resume or delete is running for.
    public private(set) var busy: Set<Int> = []
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0

    public enum TestOutcome: Sendable, Equatable {
        case sent
        case failed(String)
    }

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public func reminder(id: Int) -> Reminder? { reminders.first { $0.id == id } }

    /// Whether the server offers the pings switch.
    public var hasPingSwitch: Bool { allowPings != nil }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await session.send(Endpoints.LoadReminders(server: server))
            reminders = page.reminders
            allowPings = page.allowPings
            channels = page.channels
            schedulePresets = page.schedulePresets
            weekdays = page.weekdays
            minIntervalMinutes = page.minIntervalMinutes
            maxIntervalMinutes = page.maxIntervalMinutes
            hasLoaded = true
            errorMessage = nil
        } catch {
            if let message = ListFailure.message(for: error) { errorMessage = message }
        }
    }

    /// Creates a reminder (`id` nil) or saves one.
    /// - Returns: Whether it went through. On failure ``saveError`` says why.
    @discardableResult
    public func save(_ draft: ReminderDraft, editing id: Int?) async -> Bool {
        guard !isSaving else { return false }
        saveError = nil
        if let problem = draft.problem {
            saveError = problem
            return false
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let answer = try await session.send(Endpoints.SaveReminder(server: server, id: id, draft: draft))
            if let saved = answer.reminder {
                if let index = reminders.firstIndex(where: { $0.id == saved.id }) {
                    reminders[index] = saved
                } else {
                    reminders.insert(saved, at: 0)
                }
                successCount += 1
            } else {
                // The server did not send the reminder back: the list is read again.
                await load()
                successCount += 1
            }
            return true
        } catch {
            if let message = ListFailure.message(for: error) { saveError = message }
            return false
        }
    }

    /// Pauses an active reminder or resumes a paused one.
    public func toggle(_ id: Int) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            let answer = try await session.send(Endpoints.ToggleReminder(server: server, id: id))
            if let updated = answer.reminder, let index = reminders.firstIndex(where: { $0.id == id }) {
                reminders[index] = updated
            } else if answer.reminder == nil {
                // Deleted elsewhere in the meantime.
                reminders.removeAll { $0.id == id }
            }
            successCount += 1
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
        }
    }

    public func delete(_ id: Int) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.DeleteReminder(server: server, id: id))
            reminders.removeAll { $0.id == id }
            successCount += 1
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
        }
    }

    /// Lets reminders ping `@everyone`, `@here` and roles, or stops them.
    public func setAllowPings(_ allow: Bool) async {
        guard allowPings != nil, allowPings != allow else { return }
        actionError = nil
        do {
            let answer = try await session.send(Endpoints.SetReminderPings(server: server, allowPings: allow))
            allowPings = answer.allowPings ?? allow
            successCount += 1
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
        }
    }

    /// Posts the form's message to its channel now (the saved reminders are untouched).
    public func sendTest(_ draft: ReminderDraft) async {
        guard !isTesting else { return }
        testOutcome = nil
        if let problem = draft.problem, draft.channelId.isEmpty || !draft.hasMessage {
            testOutcome = .failed(problem)
            return
        }
        isTesting = true
        defer { isTesting = false }
        do {
            _ = try await session.send(Endpoints.TestReminder(server: server, draft: draft))
            testOutcome = .sent
        } catch {
            if let message = ListFailure.message(for: error) { testOutcome = .failed(message) }
        }
    }

    /// Forgets the last test result (a form that opens fresh).
    public func clearTestOutcome() { testOutcome = nil }
}
