import Foundation

// Events (src/modules/events.js, normaliseEventsConfig; page route src/web/routes/v2Events.js; web
// form web-v2/src/moduleForms/Events.jsx): staff post an event with Join / Maybe / Leave sign-ups,
// Sylo reminds the people who joined and closes the event when it is over. The app edits the
// server-wide settings and lists the events; creating, editing and cancelling an event is left to
// the web dashboard.

/// The Events settings page.
public struct EventsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "events"

    public let settings: EventsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The coming events, then the latest finished or cancelled ones.
    public let events: [EventSummary]

    public init(settings: EventsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                events: [EventSummary] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.events = events
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, events
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: EventsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        events = try c.decodeLossyArray(of: EventSummary.self, forKey: .events)
    }

    /// Events that have not happened yet.
    public var upcoming: [EventSummary] { events.filter { $0.state == .scheduled } }
    /// Events that ended or were cancelled.
    public var past: [EventSummary] { events.filter { $0.state != .scheduled } }
}

public struct EventsSettings: Codable, Sendable, Equatable {
    /// Where an event is posted when the command names no channel; "" = the channel it is used in.
    public var channel: String
    /// Minutes before the start that everyone who joined is reminded; 0 = no reminder.
    public var reminderMinutes: Int
    /// May manage events without Manage Events.
    public var staffRoles: [String]
    /// Also send the reminder as a DM to everyone who pressed Join.
    public var dmReminders: Bool
    /// The zone commands read times in ("Europe/Oslo"); "" = UTC.
    public var timeZone: String
    /// Every event gets a web page, linked from its post.
    public var publicPages: Bool

    public init(channel: String = "", reminderMinutes: Int = 60, staffRoles: [String] = [],
                dmReminders: Bool = false, timeZone: String = "", publicPages: Bool = false) {
        self.channel = channel
        self.reminderMinutes = reminderMinutes
        self.staffRoles = staffRoles
        self.dmReminders = dmReminders
        self.timeZone = timeZone
        self.publicPages = publicPages
    }

    /// The server keeps a reminder inside this range (0 turns it off).
    public static let reminderRange = 5...1440
    /// The choices the web form offers for the reminder, in minutes.
    public static let reminderChoices = [0, 5, 10, 15, 30, 60, 120, 360, 720, 1440]
    public static let maxStaffRoles = 25

    /// The reminder choices to offer: the usual ones, plus the current value when it is another
    /// (set through a command), so showing the screen never changes it.
    public static func reminderOptions(including current: Int) -> [Int] {
        (reminderChoices.contains(current) ? reminderChoices : (reminderChoices + [current])).sorted()
    }

    private enum CodingKeys: String, CodingKey {
        case channel, reminderMinutes, staffRoles, dmReminders, timeZone, publicPages
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channel = try c.decode(forKey: .channel, or: "")
        reminderMinutes = try c.decode(forKey: .reminderMinutes, or: 60)
        staffRoles = try c.decode(forKey: .staffRoles, or: [])
        dmReminders = try c.decode(forKey: .dmReminders, or: false)
        timeZone = try c.decode(forKey: .timeZone, or: "")
        publicPages = try c.decode(forKey: .publicPages, or: false)
    }
}

/// Where an event is in its life.
public enum EventState: Hashable, Sendable, RawRepresentable, Decodable {
    case scheduled
    case ended
    case cancelled
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "scheduled": self = .scheduled
        case "ended": self = .ended
        case "cancelled": self = .cancelled
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .scheduled: "scheduled"
        case .ended: "ended"
        case .cancelled: "cancelled"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One event in the list under the settings (read only here).
public struct EventSummary: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let title: String
    /// The start, in milliseconds since 1970.
    public let startAt: Double?
    /// The zone the creator set the time in; "" when none.
    public let timeZone: String
    /// The channel's name (or its id when it is gone).
    public let channel: String
    public let state: EventState
    public let joined: Int
    public let maybe: Int
    /// nil = no limit.
    public let capacity: Int?

    public init(id: Int, title: String, startAt: Double? = nil, timeZone: String = "", channel: String = "",
                state: EventState = .scheduled, joined: Int = 0, maybe: Int = 0, capacity: Int? = nil) {
        self.id = id
        self.title = title
        self.startAt = startAt
        self.timeZone = timeZone
        self.channel = channel
        self.state = state
        self.joined = joined
        self.maybe = maybe
        self.capacity = capacity
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, startAt, timeZone, channel, state, joined, maybe, capacity
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            title: try c.decode(forKey: .title, or: ""),
            startAt: try c.decodeIfPresent(Double.self, forKey: .startAt),
            timeZone: try c.decode(forKey: .timeZone, or: ""),
            channel: try c.decode(forKey: .channel, or: ""),
            state: try c.decode(forKey: .state, or: .scheduled),
            joined: try c.decode(forKey: .joined, or: 0),
            maybe: try c.decode(forKey: .maybe, or: 0),
            capacity: try c.decodeIfPresent(Int.self, forKey: .capacity))
    }

    /// The start as a date.
    public var startDate: Date? { startAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// The zone to show the start in: the event's own, else the device's.
    public var zone: TimeZone { TimeZone(identifier: timeZone) ?? .current }
}
