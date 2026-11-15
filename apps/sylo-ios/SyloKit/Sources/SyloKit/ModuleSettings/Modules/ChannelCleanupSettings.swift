import Foundation
import Observation

// Channel cleanup (src/web/routes/v2Api.js, `/modules/channel-cleanup/schedules`; the dashboard form is
// web-v2/src/moduleForms/ChannelCleanup.jsx). A schedule deletes the messages older than a set age
// from one channel on the days and at the time it names. Schedules are rows of their own table, not
// module settings, so they have their own list page and their own calls.

/// The time of day a cleanup runs, kept as the "HH:MM" text the server stores. The server reads it
/// on its own clock, so the app never turns it into an instant: the picker shows the same hour and
/// minute in a fixed zone (a "floating" time), whatever zone the phone is in.
public enum CleanupTime {
    /// The zone a floating time is shown in.
    public static let floatingZone = TimeZone(secondsFromGMT: 0)!

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = floatingZone
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }

    /// The floating time of "03:00"; nil when the text is not an hour and a minute.
    public static func date(from text: String) -> Date? {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 2, parts[1].count == 2,
              let hour = Int(parts[0]), let minute = Int(parts[1]),
              (0...23).contains(hour), (0...59).contains(minute)
        else { return nil }
        return calendar.date(from: DateComponents(year: 2000, month: 1, day: 1, hour: hour, minute: minute))
    }

    /// "03:00": the hour and minute of a floating time.
    public static func text(from date: Date) -> String {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        let hour = c.hour ?? 0
        let minute = c.minute ?? 0
        return (hour < 10 ? "0" : "") + String(hour) + ":" + (minute < 10 ? "0" : "") + String(minute)
    }

    /// Whether the server accepts the text (`HH:MM`).
    public static func isValid(_ text: String) -> Bool { date(from: text) != nil }
}

/// One cleanup schedule as the server lists it.
public struct CleanupSchedule: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let channelId: String
    public let days: [Int]
    /// "03:00" on the server's clock.
    public let timeHhmm: String
    public let maxAgeHours: Int
    public let skipPinned: Bool
    public let enabled: Bool
    /// The day it last ran ("2026-11-12"), or nil.
    public let lastRunDate: String?
    /// How many messages it deleted that time.
    public let lastRunCount: Int?

    public init(
        id: Int, channelId: String = "", days: [Int] = Array(0...6), timeHhmm: String = "03:00",
        maxAgeHours: Int = 24, skipPinned: Bool = true, enabled: Bool = true, lastRunDate: String? = nil,
        lastRunCount: Int? = nil
    ) {
        self.id = id
        self.channelId = channelId
        self.days = days
        self.timeHhmm = timeHhmm
        self.maxAgeHours = maxAgeHours
        self.skipPinned = skipPinned
        self.enabled = enabled
        self.lastRunDate = lastRunDate
        self.lastRunCount = lastRunCount
    }

    private enum CodingKeys: String, CodingKey {
        case id, channelId, days, timeHhmm, maxAgeHours, skipPinned, enabled, lastRunDate, lastRunCount
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let lastRunDate = (try? c.decodeIfPresent(String.self, forKey: .lastRunDate)) ?? nil
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            channelId: (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? "",
            days: ((try? c.decodeIfPresent([Int].self, forKey: .days)) ?? []).filter { (0...6).contains($0) },
            timeHhmm: (try? c.decodeIfPresent(String.self, forKey: .timeHhmm)) ?? "03:00",
            maxAgeHours: (try? c.decodeIfPresent(Int.self, forKey: .maxAgeHours)) ?? 24,
            skipPinned: (try? c.decodeIfPresent(Bool.self, forKey: .skipPinned)) ?? true,
            enabled: (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true,
            lastRunDate: (lastRunDate?.isEmpty ?? true) ? nil : lastRunDate,
            lastRunCount: (try? c.decodeIfPresent(Int.self, forKey: .lastRunCount)) ?? nil)
    }

    /// "1d" for whole days, else "36h" (the dashboard's wording).
    public static func ageLabel(hours: Int) -> String {
        hours > 0 && hours % 24 == 0 ? "\(hours / 24)d" : "\(hours)h"
    }

    /// "Mon/Wed at 03:00". The server counts the days and the time on its own clock: with its zone
    /// known and different from the phone's both are shown on the phone's clock, with the zone not
    /// known they end in "(server time)", and with the same zone they are shown as they are.
    public func whenSummary(
        weekdays: [ScheduleWeekday] = ScheduleWeekday.standard, clock: ServerClock = .unknown, now: Date = .now
    ) -> String {
        let shown = clock.phoneSchedule(time: timeHhmm, days: Set(days), now: now)
        let label = ScheduleDays.label(for: Array(shown.days), weekdays: weekdays)
        if clock.needsServerTimeLabel {
            return String(localized: "\(label) at \(shown.time) (server time)")
        }
        return String(localized: "\(label) at \(shown.time)")
    }

    /// "last ran 2026-11-12 (5 deleted)", or nil when it never ran.
    public var lastRunSummary: String? {
        guard let lastRunDate else { return nil }
        if let lastRunCount, lastRunCount > 0 {
            return String(localized: "last ran \(lastRunDate) (\(lastRunCount) deleted)")
        }
        return String(localized: "last ran \(lastRunDate)")
    }
}

/// The Channel cleanup page: the schedules and what the form offers.
public struct CleanupPage: Decodable, Sendable, Equatable {
    public let schedules: [CleanupSchedule]
    public let channels: [ChannelOption]
    public let weekdays: [ScheduleWeekday]
    /// The most hours a schedule's age can be (90 days).
    public let maxAgeHoursCap: Int
    /// The zone the server counts the days and the time in (an IANA name). nil on a server that does
    /// not say: they are then labelled "server time".
    public let timeZone: String?

    /// What the server allows today; used when an older server does not say.
    public static let defaultMaxAgeHours = 24 * 90

    public init(
        schedules: [CleanupSchedule] = [], channels: [ChannelOption] = [],
        weekdays: [ScheduleWeekday] = ScheduleWeekday.standard, maxAgeHoursCap: Int = CleanupPage.defaultMaxAgeHours,
        timeZone: String? = nil
    ) {
        self.timeZone = timeZone
        self.schedules = schedules
        self.channels = channels
        self.weekdays = weekdays
        self.maxAgeHoursCap = maxAgeHoursCap
    }

    private enum CodingKeys: String, CodingKey { case schedules, channels, weekdays, maxAgeHoursCap, timeZone }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let days = try c.decodeLossyArray(of: ScheduleWeekday.self, forKey: .weekdays)
        self.init(
            schedules: try c.decodeLossyArray(of: CleanupSchedule.self, forKey: .schedules),
            channels: try c.decodeLossyArray(of: ChannelOption.self, forKey: .channels),
            weekdays: days.isEmpty ? ScheduleWeekday.standard : days,
            maxAgeHoursCap: (try? c.decodeIfPresent(Int.self, forKey: .maxAgeHoursCap)) ?? Self.defaultMaxAgeHours,
            timeZone: (try? c.decodeIfPresent(String.self, forKey: .timeZone)) ?? nil)
    }
}

/// The answer to a save or a toggle: the schedule as it is now. nil when it is gone (a toggle of a
/// schedule someone deleted meanwhile).
public struct CleanupScheduleAnswer: Decodable, Sendable, Equatable {
    public let schedule: CleanupSchedule?

    public init(schedule: CleanupSchedule? = nil) { self.schedule = schedule }

    private enum CodingKeys: String, CodingKey { case schedule }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schedule = (try? c.decodeIfPresent(CleanupSchedule.self, forKey: .schedule)) ?? nil
    }
}

/// What the schedule form edits: a new schedule, or one that is already stored.
public struct CleanupDraft: Sendable, Equatable {
    public var channelId: String
    public var days: Set<Int>
    /// "HH:MM" on the server's clock.
    public var timeHhmm: String
    public var maxAgeHours: Int
    public var skipPinned: Bool

    /// A new schedule: every day at 03:00, messages older than a day, pinned ones kept (the
    /// dashboard's blank form).
    public init() {
        channelId = ""
        days = ScheduleDays.all
        timeHhmm = "03:00"
        maxAgeHours = 24
        skipPinned = true
    }

    public init(editing schedule: CleanupSchedule) {
        channelId = schedule.channelId
        days = Set(schedule.days)
        timeHhmm = schedule.timeHhmm
        maxAgeHours = schedule.maxAgeHours
        skipPinned = schedule.skipPinned
    }

    /// Why this cannot be sent yet, in a sentence; nil when it can. A schedule with no day is
    /// allowed: the server stores it as every day, as the dashboard's form does.
    public func problem(maxAgeHoursCap: Int = CleanupPage.defaultMaxAgeHours) -> String? {
        if channelId.isEmpty { return String(localized: "Pick a channel.") }
        if !CleanupTime.isValid(timeHhmm) { return String(localized: "Pick a valid time.") }
        if maxAgeHours < 1 || maxAgeHours > maxAgeHoursCap {
            return String(localized: "The age is between 1 and \(maxAgeHoursCap) hours.")
        }
        return nil
    }
}

/// The body of a create or an edit: the fields the dashboard's form sends.
struct CleanupBody: Encodable, Sendable {
    let draft: CleanupDraft

    private enum CodingKeys: String, CodingKey { case channelId, days, timeHhmm, maxAgeHours, skipPinned }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(draft.channelId, forKey: .channelId)
        try c.encode(draft.days.sorted(), forKey: .days)
        try c.encode(draft.timeHhmm, forKey: .timeHhmm)
        try c.encode(draft.maxAgeHours, forKey: .maxAgeHours)
        try c.encode(draft.skipPinned, forKey: .skipPinned)
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/channel-cleanup/schedules`.
    public struct LoadCleanupSchedules: APIEndpoint {
        public typealias Response = CleanupPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/channel-cleanup/schedules" }
    }

    /// `POST .../channel-cleanup/schedules` for a new schedule, `POST .../schedules/:id` for a stored one.
    public struct SaveCleanupSchedule: APIEndpoint {
        public typealias Response = CleanupScheduleAnswer
        public let server: ServerID
        /// nil creates a schedule.
        public let id: Int?
        public let draft: CleanupDraft

        public init(server: ServerID, id: Int? = nil, draft: CleanupDraft) {
            self.server = server
            self.id = id
            self.draft = draft
        }

        public var path: String {
            let base = "/api/v2/guilds/\(server.pathComponent)/modules/channel-cleanup/schedules"
            return id.map { "\(base)/\($0)" } ?? base
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CleanupBody(draft: draft) }
    }

    /// `POST .../schedules/:id/delete`.
    public struct DeleteCleanupSchedule: APIEndpoint {
        public typealias Response = EmptyResponse
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
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }

    /// `POST .../schedules/:id/toggle`: pauses an active schedule, resumes a paused one.
    public struct ToggleCleanupSchedule: APIEndpoint {
        public typealias Response = CleanupScheduleAnswer
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
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }
}

/// The Channel cleanup screen's state: the schedules, and every action on them. Each answer carries
/// the schedule as it is now, which replaces the one in the list.
@MainActor
@Observable
public final class ChannelCleanupModel {
    public let server: ServerID
    public private(set) var schedules: [CleanupSchedule] = []
    public private(set) var channels: [ChannelOption] = []
    public private(set) var weekdays = ScheduleWeekday.standard
    public private(set) var maxAgeHoursCap = CleanupPage.defaultMaxAgeHours
    /// The server's zone, when it says (see ``ServerClock``).
    public private(set) var timeZone: String?
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    /// Why the page could not be loaded (the last list, if any, stays).
    public var errorMessage: String?
    /// Why the last pause, resume or delete did not go through.
    public var actionError: String?
    /// Why the last save did not go through; the form shows it.
    public var saveError: String?
    public private(set) var isSaving = false
    /// The schedules a pause, resume or delete is running for.
    public private(set) var busy: Set<Int> = []
    /// Goes up with every action that went through, for a haptic.
    public private(set) var successCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public func schedule(id: Int) -> CleanupSchedule? { schedules.first { $0.id == id } }

    /// The server's clock against the phone's.
    public var clock: ServerClock { ServerClock(serverZone: timeZone) }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await session.send(Endpoints.LoadCleanupSchedules(server: server))
            schedules = page.schedules
            channels = page.channels
            weekdays = page.weekdays
            maxAgeHoursCap = page.maxAgeHoursCap
            timeZone = page.timeZone
            hasLoaded = true
            errorMessage = nil
        } catch {
            if let message = ListFailure.message(for: error) { errorMessage = message }
        }
    }

    /// Creates a schedule (`id` nil) or saves one.
    /// - Returns: Whether it went through. On failure ``saveError`` says why.
    @discardableResult
    public func save(_ draft: CleanupDraft, editing id: Int?) async -> Bool {
        guard !isSaving else { return false }
        saveError = nil
        if let problem = draft.problem(maxAgeHoursCap: maxAgeHoursCap) {
            saveError = problem
            return false
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let answer = try await session.send(Endpoints.SaveCleanupSchedule(server: server, id: id, draft: draft))
            if let saved = answer.schedule {
                if let index = schedules.firstIndex(where: { $0.id == saved.id }) {
                    schedules[index] = saved
                } else {
                    schedules.append(saved)
                }
            } else {
                await load()
            }
            successCount += 1
            return true
        } catch {
            if let message = ListFailure.message(for: error) { saveError = message }
            // Deleted elsewhere: the stale row goes, and the message says why.
            if let id, ListFailure.isGone(error) { schedules.removeAll { $0.id == id } }
            return false
        }
    }

    /// Pauses an active schedule or resumes a paused one.
    public func toggle(_ id: Int) async {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        actionError = nil
        do {
            let answer = try await session.send(Endpoints.ToggleCleanupSchedule(server: server, id: id))
            if let updated = answer.schedule {
                if let index = schedules.firstIndex(where: { $0.id == id }) { schedules[index] = updated }
            } else {
                // Deleted elsewhere in the meantime.
                schedules.removeAll { $0.id == id }
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
            _ = try await session.send(Endpoints.DeleteCleanupSchedule(server: server, id: id))
            schedules.removeAll { $0.id == id }
            successCount += 1
        } catch {
            if let message = ListFailure.message(for: error) { actionError = message }
        }
    }
}
