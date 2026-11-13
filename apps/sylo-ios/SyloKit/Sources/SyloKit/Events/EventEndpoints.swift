import Foundation
import Observation

// Creating, editing and cancelling an event (src/web/routes/v2Events.js: `POST /modules/events/events`,
// `POST /modules/events/events/:id` and `POST /modules/events/events/:id/cancel`), the same calls the
// dashboard makes. Every one answers with the whole event list again (`{events}`).

/// Wall-clock times the way the server reads them. The dashboard's form sends `start` and `end` as
/// "2026-11-06T22:00" plus a zone name, and the server reads the text in that zone, so a time is
/// never an instant on the phone. The app keeps it as a "floating" date: a `Date` whose UTC fields
/// are the wall-clock fields, shown by a picker set to UTC. Changing the zone then leaves the
/// typed time alone, like the dashboard's `datetime-local` input does.
public enum EventTime {
    /// The zone a floating date is shown in.
    public static let floatingZone = TimeZone(secondsFromGMT: 0)!

    private static let fields: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute]

    private static var floatingCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = floatingZone
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }

    private static func pad(_ value: Int?, _ width: Int) -> String {
        let text = String(value ?? 0)
        return String(repeating: "0", count: max(0, width - text.count)) + text
    }

    /// "2026-11-06T22:00": the floating date as the server reads it.
    public static func wallClockText(_ floating: Date) -> String {
        let c = floatingCalendar.dateComponents(fields, from: floating)
        return "\(pad(c.year, 4))-\(pad(c.month, 2))-\(pad(c.day, 2))T\(pad(c.hour, 2)):\(pad(c.minute, 2))"
    }

    /// The floating date of "2026-11-06T22:00" (a space instead of the T is fine); nil when it does not read.
    public static func floating(fromText text: String) -> Date? {
        let pieces = text.trimmingCharacters(in: .whitespaces)
            .split(whereSeparator: { $0 == "T" || $0 == " " })
        guard pieces.count == 2 else { return nil }
        let date = pieces[0].split(separator: "-").compactMap { Int($0) }
        let time = pieces[1].split(separator: ":").compactMap { Int($0) }
        guard date.count == 3, time.count >= 2,
              (1...12).contains(date[1]), (1...31).contains(date[2]),
              (0...23).contains(time[0]), (0...59).contains(time[1])
        else { return nil }
        return floatingCalendar.date(from: DateComponents(
            year: date[0], month: date[1], day: date[2], hour: time[0], minute: time[1]))
    }

    /// The wall clock of an instant in a zone, as a floating date.
    public static func floating(of instant: Date, in zone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return floatingCalendar.date(from: calendar.dateComponents(fields, from: instant)) ?? instant
    }

    /// Whether the wall-clock time of a floating date happens in `zone`. A clock change that skips an
    /// hour (spring forward) leaves times that never show on a wall clock there.
    public static func exists(_ floating: Date, in zone: TimeZone) -> Bool {
        let wall = floatingCalendar.dateComponents(fields, from: floating)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let own = DateComponents(year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute)
        guard let instant = calendar.date(from: own) else { return false }
        let back = calendar.dateComponents(fields, from: instant)
        return back.year == wall.year && back.month == wall.month && back.day == wall.day
            && back.hour == wall.hour && back.minute == wall.minute
    }

    /// The floating date of the next full hour after `minimumLead` seconds from now, in `zone`: where
    /// a new event's start begins. An hour a clock change skips is passed over for the next one.
    public static func nextFullHour(after now: Date = .now, in zone: TimeZone, minimumLead: TimeInterval = 3600) -> Date {
        let wall = floating(of: now.addingTimeInterval(minimumLead), in: zone)
        var start = Date(timeIntervalSince1970: (wall.timeIntervalSince1970 / 3600).rounded(.up) * 3600)
        var steps = 0
        while !exists(start, in: zone), steps < 48 {
            start = start.addingTimeInterval(3600)
            steps += 1
        }
        return start
    }
}

/// What the event form edits: a new event, or one that is already posted.
public struct EventDraft: Equatable, Sendable {
    public var title: String
    public var description: String
    public var location: String
    /// An https link, or "".
    public var imageURL: String
    /// The start on the wall clock of ``timeZone`` (see ``EventTime``).
    public var start: Date
    /// The end on the same clock; nil for none.
    public var end: Date?
    /// An IANA zone name; always sent.
    public var timeZone: String
    /// nil = no limit.
    public var capacity: Int?
    /// 0 = no reminder.
    public var reminderMinutes: Int
    /// Where a new event is posted (not changeable afterwards).
    public var channelID: String
    /// The role people get while they are signed up, or "" (not changeable afterwards).
    public var roleID: String

    public init(title: String = "", description: String = "", location: String = "", imageURL: String = "",
                start: Date, end: Date? = nil, timeZone: String, capacity: Int? = nil,
                reminderMinutes: Int = 60, channelID: String = "", roleID: String = "") {
        self.title = title
        self.description = description
        self.location = location
        self.imageURL = imageURL
        self.start = start
        self.end = end
        self.timeZone = timeZone
        self.capacity = capacity
        self.reminderMinutes = reminderMinutes
        self.channelID = channelID
        self.roleID = roleID
    }

    /// A new event with the server's defaults: the device's time zone (the dashboard uses the
    /// browser's), the default channel and reminder, starting at the next full hour.
    public init(defaults settings: EventsSettings, now: Date = .now, deviceZone: String = TimeZone.current.identifier) {
        let zone = TimeZone(identifier: deviceZone) ?? .gmt
        self.init(
            start: EventTime.nextFullHour(after: now, in: zone), timeZone: zone.identifier,
            reminderMinutes: settings.reminderMinutes, channelID: settings.channel)
    }

    /// An event as it is posted now, ready to be edited.
    public init(editing event: EventSummary, now: Date = .now) {
        let zoneName = event.timeZone.isEmpty ? "UTC" : event.timeZone
        let zone = TimeZone(identifier: zoneName) ?? .gmt
        let start = EventTime.floating(fromText: event.start)
            ?? event.startDate.map { EventTime.floating(of: $0, in: zone) }
            ?? EventTime.nextFullHour(after: now, in: zone)
        let end = event.end.isEmpty ? nil : EventTime.floating(fromText: event.end)
        self.init(
            title: event.title, description: event.description, location: event.location,
            imageURL: event.imageUrl, start: start, end: end, timeZone: zoneName, capacity: event.capacity,
            reminderMinutes: event.reminderMinutes ?? EventsSettings().reminderMinutes,
            channelID: event.channelId, roleID: event.roleId)
    }

    // The server's limits (LIMITS in src/modules/events.js).
    public static let titleLimit = 100
    public static let descriptionLimit = 2000
    public static let locationLimit = 200
    public static let imageURLLimit = 500
    public static let capacityRange = 1...500

    /// Why this cannot be sent yet, in a sentence; nil when it can. The server checks the rest
    /// (a start in the past, a zone it does not know) and answers with its own words.
    public func problem(creating: Bool) -> String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Give the event a title." }
        let image = imageURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !image.isEmpty, !Self.isAcceptableImageURL(image) {
            return "The image must be an https link of at most \(Self.imageURLLimit) characters."
        }
        if let zone = TimeZone(identifier: timeZone) {
            if !EventTime.exists(start, in: zone) { return "The start time does not exist in \(timeZone): the clocks skip it. Pick another time." }
            if let end, !EventTime.exists(end, in: zone) { return "The end time does not exist in \(timeZone): the clocks skip it. Pick another time." }
        }
        if let end, end <= start { return "The end time must be after the start time." }
        if let capacity, !Self.capacityRange.contains(capacity) {
            return "The capacity is between \(Self.capacityRange.lowerBound) and \(Self.capacityRange.upperBound)."
        }
        if creating, channelID.isEmpty { return "Pick a channel to post in." }
        return nil
    }

    /// An https address without spaces that the server keeps (it drops a longer one).
    static func isAcceptableImageURL(_ text: String) -> Bool {
        text.count <= imageURLLimit
            && text.lowercased().hasPrefix("https://")
            && !text.contains(where: \.isWhitespace)
            && URL(string: text) != nil
    }
}

/// The body of a create or an edit: the fields the dashboard's event form sends. A new event also
/// names its channel and role; those cannot be changed afterwards, so an edit leaves them out.
struct EventBody: Encodable, Sendable {
    let draft: EventDraft
    let includesPlacement: Bool

    private enum CodingKeys: String, CodingKey {
        case title, description, start, end, timeZone, location, imageUrl, capacity, reminderMinutes
        case channelId, roleId
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(draft.title.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .title)
        try c.encode(draft.description.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .description)
        try c.encode(EventTime.wallClockText(draft.start), forKey: .start)
        try c.encode(draft.end.map(EventTime.wallClockText) ?? "", forKey: .end)
        try c.encode(draft.timeZone, forKey: .timeZone)
        try c.encode(draft.location.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .location)
        try c.encode(draft.imageURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: .imageUrl)
        // The dashboard sends null for "no limit".
        if let capacity = draft.capacity {
            try c.encode(capacity, forKey: .capacity)
        } else {
            try c.encodeNil(forKey: .capacity)
        }
        try c.encode(draft.reminderMinutes, forKey: .reminderMinutes)
        if includesPlacement {
            try c.encode(draft.channelID, forKey: .channelId)
            try c.encode(draft.roleID, forKey: .roleId)
        }
    }
}

/// What every event call answers: the events as they are now.
public struct EventListAnswer: Decodable, Sendable, Equatable {
    public let events: [EventSummary]

    public init(events: [EventSummary] = []) { self.events = events }

    private enum CodingKeys: String, CodingKey { case events }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = try c.decodeLossyArray(of: EventSummary.self, forKey: .events)
    }
}

extension Endpoints {
    /// `POST /api/v2/guilds/:id/modules/events/events`: posts a new event. 400 with the server's
    /// reason when something is wrong (the module is off, the start is in the past, Sylo cannot post
    /// in the channel).
    public struct CreateEvent: APIEndpoint {
        public typealias Response = EventListAnswer
        public let server: ServerID
        public let draft: EventDraft

        public init(server: ServerID, draft: EventDraft) {
            self.server = server
            self.draft = draft
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/events/events" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EventBody(draft: draft, includesPlacement: true) }
    }

    /// `POST /api/v2/guilds/:id/modules/events/events/:id`: changes an upcoming event and its post.
    public struct UpdateEvent: APIEndpoint {
        public typealias Response = EventListAnswer
        public let server: ServerID
        public let id: Int
        public let draft: EventDraft

        public init(server: ServerID, id: Int, draft: EventDraft) {
            self.server = server
            self.id = id
            self.draft = draft
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/events/events/\(id)" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EventBody(draft: draft, includesPlacement: false) }
    }

    /// `POST /api/v2/guilds/:id/modules/events/events/:id/cancel`: marks the event cancelled, takes
    /// the participant role back and stops sign-ups.
    public struct CancelEvent: APIEndpoint {
        public typealias Response = EventListAnswer
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/events/events/\(id)/cancel" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { CommunityEmptyBody() }
    }
}

/// Creating, editing and cancelling events. Each answer carries the whole list, kept in
/// ``events`` so the screen can show it without loading the page again.
@MainActor
@Observable
public final class EventActionsModel {
    public let server: ServerID
    /// The events as the last action answered them; nil until one did, or after ``forgetAnswer()``.
    public private(set) var events: [EventSummary]?
    public private(set) var isWorking = false
    /// Why the last action did not go through, in the server's words where it gave any.
    public var errorMessage: String?
    /// Goes up with every action that went through, for a haptic.
    public private(set) var doneCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Posts a new event.
    /// - Returns: Whether it went through. On failure ``errorMessage`` says why.
    @discardableResult
    public func create(_ draft: EventDraft) async -> Bool {
        if let problem = draft.problem(creating: true) {
            errorMessage = problem
            return false
        }
        return await run(Endpoints.CreateEvent(server: server, draft: draft), grantingRole: !draft.roleID.isEmpty)
    }

    /// Saves the changes to an upcoming event.
    @discardableResult
    public func update(id: Int, _ draft: EventDraft) async -> Bool {
        if let problem = draft.problem(creating: false) {
            errorMessage = problem
            return false
        }
        return await run(Endpoints.UpdateEvent(server: server, id: id, draft: draft))
    }

    /// Cancels an upcoming event.
    @discardableResult
    public func cancel(id: Int) async -> Bool {
        await run(Endpoints.CancelEvent(server: server, id: id))
    }

    /// Drops the answer, so the screen shows the page's own list again (after the page was loaded anew).
    public func forgetAnswer() {
        events = nil
    }

    private func run<E: APIEndpoint>(_ endpoint: E, grantingRole: Bool = false) async -> Bool
    where E.Response == EventListAnswer {
        guard !isWorking else {
            errorMessage = CommunityMessage.busy
            return false
        }
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        do {
            events = try await session.send(endpoint).events
            doneCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized {
                errorMessage = error.communityMessage(grantingRole: grantingRole)
            }
            return false
        }
    }
}
