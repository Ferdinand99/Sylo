import Foundation

// Reminders (src/modules/scheduledMessages.js and the routes in src/web/routes/v2Api.js under
// /modules/reminders; web form web-v2/src/moduleForms/Reminders.jsx): a text or embed message
// posted to a channel once or on a repeating schedule. A reminder is a record with its own table.

/// How often a repeating reminder runs, as the server lists the choices: `["60", "Every hour"]`.
public struct SchedulePreset: Decodable, Sendable, Equatable, Hashable, Identifiable {
    public let minutes: Int
    public let name: String

    public var id: Int { minutes }

    public init(minutes: Int, name: String) {
        self.minutes = minutes
        self.name = name
    }

    public init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        let raw = try c.decode(JSONValue.self)
        let name = try c.decode(String.self)
        switch raw {
        case .string(let text):
            guard let minutes = Int(text) else {
                throw DecodingError.typeMismatch(
                    Int.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Minutes"))
            }
            self.init(minutes: minutes, name: name)
        case .number(let number):
            self.init(minutes: Int(number), name: name)
        default:
            throw DecodingError.typeMismatch(
                Int.self, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Minutes"))
        }
    }
}

/// Once, or on a schedule.
public enum ReminderMode: String, Sendable, CaseIterable, Codable {
    case single
    case multiple

    public init(from decoder: any Decoder) throws {
        self = ReminderMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .multiple
    }
}

/// A reminder as the server lists it.
public struct Reminder: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let name: String
    public let channelId: String
    public let content: String
    /// The first embed of the message; nil for a text message.
    public let embed: EmbedSpec?
    public let mode: ReminderMode
    public let intervalMinutes: Int
    public let days: [Int]
    public let startAt: Date?
    public let endAt: Date?
    public let runAt: Date?
    public let isEnabled: Bool
    public let lastRunAt: Date?

    public init(
        id: Int, name: String, channelId: String, content: String = "", embed: EmbedSpec? = nil,
        mode: ReminderMode = .multiple, intervalMinutes: Int = 60, days: [Int] = .allWeek, startAt: Date? = nil,
        endAt: Date? = nil, runAt: Date? = nil, isEnabled: Bool = true, lastRunAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.channelId = channelId
        self.content = content
        self.embed = embed
        self.mode = mode
        self.intervalMinutes = intervalMinutes
        self.days = days
        self.startAt = startAt
        self.endAt = endAt
        self.runAt = runAt
        self.isEnabled = isEnabled
        self.lastRunAt = lastRunAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, channelId, spec, mode, intervalMinutes, days, startAt, endAt, runAt, enabled, lastRunAt
    }

    private struct Spec: Decodable {
        let content: String
        let embeds: [EmbedSpec]

        private enum CodingKeys: String, CodingKey { case content, embeds }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            content = try c.decode(forKey: .content, or: "")
            embeds = try c.decode(forKey: .embeds, or: [])
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(forKey: .name, or: "")
        channelId = try c.decode(forKey: .channelId, or: "")
        let spec = try c.decodeIfPresent(Spec.self, forKey: .spec)
        content = spec?.content ?? ""
        embed = spec?.embeds.first
        mode = try c.decode(forKey: .mode, or: .multiple)
        intervalMinutes = try c.decode(forKey: .intervalMinutes, or: 60)
        days = try c.decode(forKey: .days, or: .allWeek)
        startAt = try c.decodeEpochMillisecondsIfPresent(forKey: .startAt)
        endAt = try c.decodeEpochMillisecondsIfPresent(forKey: .endAt)
        runAt = try c.decodeEpochMillisecondsIfPresent(forKey: .runAt)
        isEnabled = try c.decode(forKey: .enabled, or: true)
        lastRunAt = try c.decodeEpochMillisecondsIfPresent(forKey: .lastRunAt)
    }

    /// "once, 14:30" or "every hour · Mon/Wed", for a list row.
    public func scheduleSummary(
        presets: [SchedulePreset], weekdays: [WeekdayOption], once: (Date) -> String
    ) -> String {
        if mode == .single {
            guard let runAt else { return "once, no time set" }
            return "once, \(once(runAt))"
        }
        let every = presets.first { $0.minutes == intervalMinutes }?.name.lowercased() ?? "every \(intervalMinutes)m"
        guard Set(days).count < 7 else { return every }
        return "\(every) · \(WeekdayOption.summary(of: days, in: weekdays))"
    }
}

/// `GET /api/v2/guilds/:id/modules/reminders/list`.
public struct RemindersPage: Decodable, Sendable, Equatable {
    public static let moduleID: ModuleID = "reminders"

    public let reminders: [Reminder]
    /// Whether reminders may ping @everyone, @here and roles.
    public let allowPings: Bool
    public let channels: [ChannelOption]
    public let schedulePresets: [SchedulePreset]
    public let weekdays: [WeekdayOption]
    public let minIntervalMinutes: Int
    public let maxIntervalMinutes: Int

    public init(
        reminders: [Reminder] = [], allowPings: Bool = false, channels: [ChannelOption] = [],
        schedulePresets: [SchedulePreset] = [], weekdays: [WeekdayOption] = WeekdayOption.week,
        minIntervalMinutes: Int = 1, maxIntervalMinutes: Int = 40_320
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
        reminders = try c.decodeLossyArray(of: Reminder.self, forKey: .reminders)
        allowPings = try c.decode(forKey: .allowPings, or: false)
        channels = try c.decode(forKey: .channels, or: [])
        schedulePresets = try c.decode(forKey: .schedulePresets, or: [])
        weekdays = try c.decode(forKey: .weekdays, or: WeekdayOption.week)
        minIntervalMinutes = try c.decode(forKey: .minIntervalMinutes, or: 1)
        maxIntervalMinutes = try c.decode(forKey: .maxIntervalMinutes, or: 40_320)
    }
}

/// A reminder while it is edited, and the body that saves or tests it.
public struct ReminderDraft: Sendable, Equatable, Identifiable {
    public let localID = LocalID()
    /// The reminder's id; nil for a new one.
    public var reminderID: Int?
    /// At most 100 characters; shown in the dashboard only.
    public var name: String
    public var channelId: String
    /// Whether the message is an embed (with the text above it) or plain text.
    public var isEmbed: Bool
    /// The text: the whole message, or the text above the embed.
    public var content: String
    public var embed: EmbedSpec
    public var mode: ReminderMode
    public var runAt: Date
    public var intervalMinutes: Int
    public var hasStart: Bool
    public var startAt: Date
    public var hasEnd: Bool
    public var endAt: Date
    public var days: Set<Int>

    public var id: UUID { localID.value }

    public static let maxNameLength = 100
    public static let maxContentLength = 2000

    /// A new reminder: every hour, every day, to be filled in.
    public init(now: Date = Date()) {
        reminderID = nil
        name = ""
        channelId = ""
        isEmbed = false
        content = ""
        embed = EmbedSpec()
        mode = .multiple
        runAt = now.addingTimeInterval(3600)
        intervalMinutes = 60
        hasStart = false
        startAt = now
        hasEnd = false
        endAt = now.addingTimeInterval(7 * 86_400)
        days = Set([Int].allWeek)
    }

    public init(reminder: Reminder, now: Date = Date()) {
        self.init(now: now)
        reminderID = reminder.id
        name = reminder.name
        channelId = reminder.channelId
        isEmbed = reminder.embed != nil
        content = reminder.content
        embed = (reminder.embed ?? EmbedSpec()).withDefaultColor()
        mode = reminder.mode
        runAt = reminder.runAt ?? now.addingTimeInterval(3600)
        intervalMinutes = reminder.intervalMinutes
        hasStart = reminder.startAt != nil
        startAt = reminder.startAt ?? now
        hasEnd = reminder.endAt != nil
        endAt = reminder.endAt ?? now.addingTimeInterval(7 * 86_400)
        days = Set(reminder.days.isEmpty ? [Int].allWeek : reminder.days)
    }

    /// Why the reminder cannot be saved yet, in words for the person; nil when it can.
    public var problem: String? {
        if channelId.isEmpty { return "Choose a channel." }
        let hasText = !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if isEmbed ? (embed.isEmpty && !hasText) : !hasText { return "Add a message or an embed." }
        if mode == .multiple, days.isEmpty { return "Choose at least one day of the week." }
        return nil
    }

    /// The body of a create, an update and a test. Times go as ISO 8601 with their zone, which the
    /// server reads exactly (the web form sends local times without one).
    struct Body: Encodable, Sendable {
        let name: String
        let channelId: String
        let msgType: String
        let content: String
        let embedSpec: EmbedWithContent
        let mode: ReminderMode
        let runAt: String
        let intervalMinutes: Int
        let enableStart: Bool
        let startAt: String
        let enableEnd: Bool
        let endAt: String
        let days: [Int]
    }

    var body: Body {
        let format = Date.ISO8601FormatStyle()
        return Body(
            name: name, channelId: channelId, msgType: isEmbed ? "embed" : "text", content: content,
            embedSpec: EmbedWithContent(embed: embed, content: content), mode: mode,
            runAt: runAt.formatted(format), intervalMinutes: intervalMinutes, enableStart: hasStart,
            startAt: startAt.formatted(format), enableEnd: hasEnd, endAt: endAt.formatted(format),
            days: days.sorted())
    }
}

/// The answer to creating, editing or switching a reminder.
public struct SavedReminder: Decodable, Sendable, Equatable {
    public let reminder: Reminder?
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/reminders/list`.
    public struct LoadReminders: APIEndpoint {
        public typealias Response = RemindersPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/list" }
    }

    /// `POST …/reminders/new` creates a reminder; `POST …/reminders/:id` updates it.
    public struct SaveReminder: APIEndpoint {
        public typealias Response = SavedReminder
        public let server: ServerID
        public let draft: ReminderDraft
        public init(server: ServerID, draft: ReminderDraft) {
            self.server = server
            self.draft = draft
        }
        public var path: String {
            let id = draft.reminderID.map(String.init) ?? "new"
            return "/api/v2/guilds/\(server.pathComponent)/modules/reminders/\(id)"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { draft.body }
    }

    /// `POST …/reminders/test`: posts the message to the channel once, to see it.
    public struct TestReminder: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let draft: ReminderDraft
        public init(server: ServerID, draft: ReminderDraft) {
            self.server = server
            self.draft = draft
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/test" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { draft.body }
    }

    /// `POST …/reminders/:id/toggle`: pauses or resumes a reminder.
    public struct ToggleReminder: APIEndpoint {
        public typealias Response = SavedReminder
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/\(id)/toggle" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/reminders/:id/delete`.
    public struct DeleteReminder: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/reminders/settings` with `{allowPings}`.
    public struct SetReminderPings: APIEndpoint {
        public typealias Response = SavedReminderPings
        public let server: ServerID
        public let allowPings: Bool
        public init(server: ServerID, allowPings: Bool) {
            self.server = server
            self.allowPings = allowPings
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/reminders/settings" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(allowPings: allowPings) }
        private struct Body: Encodable, Sendable { let allowPings: Bool }
    }
}

/// The answer to the pings switch.
public struct SavedReminderPings: Decodable, Sendable, Equatable {
    public let allowPings: Bool
}

extension RecordListModel where Page == RemindersPage {
    /// The reminders screen's model.
    public convenience init(reminders server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.LoadReminders(server: server))
        }
    }

    public func save(_ draft: ReminderDraft) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SaveReminder(server: server, draft: draft))
            return true
        }
        return done != nil
    }

    public func delete(_ reminder: Reminder) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.DeleteReminder(server: server, id: reminder.id))
            return true
        }
        return done != nil
    }

    /// Pauses a reminder that runs, resumes one that is paused.
    public func toggle(_ reminder: Reminder) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.ToggleReminder(server: server, id: reminder.id))
            return true
        }
        return done != nil
    }

    public func setPings(_ allowed: Bool) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SetReminderPings(server: server, allowPings: allowed))
            return true
        }
        return done != nil
    }

    /// Posts the draft's message to its channel once. Not a change to the reminders, so the list
    /// is not reloaded.
    /// - Returns: Whether it was posted; ``actionError`` says why not.
    public func sendTest(_ draft: ReminderDraft) async -> Bool {
        let done: Bool? = await attempt { session, server in
            _ = try await session.send(Endpoints.TestReminder(server: server, draft: draft))
            return true
        }
        return done != nil
    }
}
