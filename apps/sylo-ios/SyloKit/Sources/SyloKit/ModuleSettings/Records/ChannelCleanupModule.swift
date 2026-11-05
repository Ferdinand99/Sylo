import Foundation

// Channel cleanup (src/modules/channelCleanup.js and the routes in src/web/routes/v2Api.js under
// /modules/channel-cleanup; web form web-v2/src/moduleForms/ChannelCleanup.jsx): per channel, a
// weekly schedule that deletes messages older than a set age. A schedule is a record.

/// One cleanup schedule as the server lists it.
public struct CleanupSchedule: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let channelId: String
    /// 0 is Sunday.
    public let days: [Int]
    /// Server local time, `HH:MM`.
    public let timeHhmm: String
    public let maxAgeHours: Int
    public let skipPinned: Bool
    public let isEnabled: Bool
    /// The day it last ran (`YYYY-MM-DD`), nil before the first run.
    public let lastRunDate: String?
    public let lastRunCount: Int?

    public init(
        id: Int, channelId: String, days: [Int] = .allWeek, timeHhmm: String = "03:00", maxAgeHours: Int = 24,
        skipPinned: Bool = true, isEnabled: Bool = true, lastRunDate: String? = nil, lastRunCount: Int? = nil
    ) {
        self.id = id
        self.channelId = channelId
        self.days = days
        self.timeHhmm = timeHhmm
        self.maxAgeHours = maxAgeHours
        self.skipPinned = skipPinned
        self.isEnabled = isEnabled
        self.lastRunDate = lastRunDate
        self.lastRunCount = lastRunCount
    }

    private enum CodingKeys: String, CodingKey {
        case id, channelId, days, timeHhmm, maxAgeHours, skipPinned, enabled, lastRunDate, lastRunCount
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        channelId = try c.decode(forKey: .channelId, or: "")
        days = try c.decode(forKey: .days, or: .allWeek)
        timeHhmm = try c.decode(forKey: .timeHhmm, or: "03:00")
        maxAgeHours = try c.decode(forKey: .maxAgeHours, or: 24)
        skipPinned = try c.decode(forKey: .skipPinned, or: true)
        isEnabled = try c.decode(forKey: .enabled, or: true)
        lastRunDate = try c.decodeIfPresent(String.self, forKey: .lastRunDate)
        lastRunCount = try c.decodeIfPresent(Int.self, forKey: .lastRunCount)
    }

    /// "1d" for whole days, else "36h".
    public var ageSummary: String {
        CleanupSchedule.ageSummary(hours: maxAgeHours)
    }

    public static func ageSummary(hours: Int) -> String {
        hours > 0 && hours % 24 == 0 ? "\(hours / 24)d" : "\(hours)h"
    }
}

/// `GET /api/v2/guilds/:id/modules/channel-cleanup/schedules`.
public struct ChannelCleanupPage: Decodable, Sendable, Equatable {
    public static let moduleID: ModuleID = "channel-cleanup"

    public let schedules: [CleanupSchedule]
    public let channels: [ChannelOption]
    public let weekdays: [WeekdayOption]
    /// The most hours a message may be kept for (90 days).
    public let maxAgeHoursCap: Int

    public init(
        schedules: [CleanupSchedule] = [], channels: [ChannelOption] = [],
        weekdays: [WeekdayOption] = WeekdayOption.week, maxAgeHoursCap: Int = 2160
    ) {
        self.schedules = schedules
        self.channels = channels
        self.weekdays = weekdays
        self.maxAgeHoursCap = maxAgeHoursCap
    }

    private enum CodingKeys: String, CodingKey { case schedules, channels, weekdays, maxAgeHoursCap }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schedules = try c.decodeLossyArray(of: CleanupSchedule.self, forKey: .schedules)
        channels = try c.decode(forKey: .channels, or: [])
        weekdays = try c.decode(forKey: .weekdays, or: WeekdayOption.week)
        maxAgeHoursCap = try c.decode(forKey: .maxAgeHoursCap, or: 2160)
    }
}

/// A schedule while it is edited, and the body that saves it.
public struct CleanupScheduleDraft: Sendable, Equatable, Identifiable {
    public let localID = LocalID()
    /// The schedule's id; nil for a new one.
    public var scheduleID: Int?
    public var channelId: String
    public var days: Set<Int>
    public var hour: Int
    public var minute: Int
    public var maxAgeHours: Int
    public var skipPinned: Bool

    public var id: UUID { localID.value }

    public static let minAgeHours = 1

    /// A new schedule: every day at 03:00, messages older than a day, pinned ones kept.
    public init() {
        scheduleID = nil
        channelId = ""
        days = Set([Int].allWeek)
        hour = 3
        minute = 0
        maxAgeHours = 24
        skipPinned = true
    }

    public init(schedule: CleanupSchedule) {
        scheduleID = schedule.id
        channelId = schedule.channelId
        days = Set(schedule.days)
        let parts = schedule.timeHhmm.split(separator: ":").compactMap { Int($0) }
        hour = parts.count == 2 ? min(max(parts[0], 0), 23) : 3
        minute = parts.count == 2 ? min(max(parts[1], 0), 59) : 0
        maxAgeHours = schedule.maxAgeHours
        skipPinned = schedule.skipPinned
    }

    /// `HH:MM`, as the server stores it.
    public var timeHhmm: String {
        String(format: "%02d:%02d", hour, minute)
    }

    /// Why the schedule cannot be saved yet, in words for the person; nil when it can.
    public func problem(maxAgeHoursCap: Int) -> String? {
        if channelId.isEmpty { return "Choose a channel." }
        if days.isEmpty { return "Choose at least one day." }
        if !(Self.minAgeHours...maxAgeHoursCap).contains(maxAgeHours) {
            return "Messages can be kept for 1 to \(maxAgeHoursCap) hours."
        }
        return nil
    }

    struct Body: Encodable, Sendable {
        let channelId: String
        let days: [Int]
        let timeHhmm: String
        let maxAgeHours: Int
        let skipPinned: Bool
    }

    var body: Body {
        Body(
            channelId: channelId, days: days.sorted(), timeHhmm: timeHhmm, maxAgeHours: maxAgeHours,
            skipPinned: skipPinned)
    }
}

/// The answer to saving or switching a schedule.
public struct SavedCleanupSchedule: Decodable, Sendable, Equatable {
    public let schedule: CleanupSchedule?
}

extension Endpoints {
    /// `GET …/channel-cleanup/schedules`.
    public struct LoadChannelCleanup: APIEndpoint {
        public typealias Response = ChannelCleanupPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/channel-cleanup/schedules" }
    }

    /// `POST …/schedules` creates a schedule; `POST …/schedules/:id` updates it.
    public struct SaveCleanupSchedule: APIEndpoint {
        public typealias Response = SavedCleanupSchedule
        public let server: ServerID
        public let draft: CleanupScheduleDraft
        public init(server: ServerID, draft: CleanupScheduleDraft) {
            self.server = server
            self.draft = draft
        }
        public var path: String {
            let base = "/api/v2/guilds/\(server.pathComponent)/modules/channel-cleanup/schedules"
            return draft.scheduleID.map { "\(base)/\($0)" } ?? base
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { draft.body }
    }

    /// `POST …/schedules/:id/toggle`.
    public struct ToggleCleanupSchedule: APIEndpoint {
        public typealias Response = SavedCleanupSchedule
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/channel-cleanup/schedules/\(id)/toggle"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/schedules/:id/delete`.
    public struct DeleteCleanupSchedule: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/channel-cleanup/schedules/\(id)/delete"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

extension RecordListModel where Page == ChannelCleanupPage {
    /// The channel cleanup screen's model.
    public convenience init(channelCleanup server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.LoadChannelCleanup(server: server))
        }
    }

    public func save(_ draft: CleanupScheduleDraft) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SaveCleanupSchedule(server: server, draft: draft))
            return true
        }
        return done != nil
    }

    public func toggle(_ schedule: CleanupSchedule) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.ToggleCleanupSchedule(server: server, id: schedule.id))
            return true
        }
        return done != nil
    }

    public func delete(_ schedule: CleanupSchedule) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.DeleteCleanupSchedule(server: server, id: schedule.id))
            return true
        }
        return done != nil
    }
}
