import Foundation

// Server logging (src/modules/logging.js, LOG_EVENTS; the config is built in the logging routes
// of src/web/routes/v2Api.js; web form web-v2/src/moduleForms/Logging.jsx): posts member,
// message, role and channel events to a log channel.

/// The Server logging settings page.
public struct LoggingPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "logging"

    public let settings: LoggingSettings
    public let channels: [ChannelOption]
    /// The events that can be logged, in the server's order.
    public let logEvents: [LoggingEvent]

    public init(settings: LoggingSettings, channels: [ChannelOption] = [], logEvents: [LoggingEvent] = []) {
        self.settings = settings
        self.channels = channels
        self.logEvents = logEvents
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, logEvents
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: LoggingSettings())
        channels = try c.decode(forKey: .channels, or: [])
        logEvents = try c.decode(forKey: .logEvents, or: [])
    }
}

/// One event that can be logged. The server sends it as a `[key, label]` pair.
public struct LoggingEvent: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    /// Already worded by the server ("Member joined").
    public let label: String

    public var id: String { key }

    public init(key: String, label: String) {
        self.key = key
        self.label = label
    }

    public init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        key = try c.decode(String.self)
        label = try c.decodeIfPresent(String.self) ?? key
    }
}

public struct LoggingSettings: Codable, Sendable, Equatable {
    /// The log channel; "" for none (nothing is logged without one).
    public var channel: String
    /// Which events are logged, by `LoggingEvent.key`. A missing key is off.
    public var events: [String: Bool]

    public init(channel: String = "", events: [String: Bool] = [:]) {
        self.channel = channel
        self.events = events
    }

    public func isLogging(_ key: String) -> Bool { events[key] ?? false }

    public mutating func setLogging(_ key: String, _ isOn: Bool) { events[key] = isOn }

    private enum CodingKeys: String, CodingKey { case channel, events }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channel = try c.decode(forKey: .channel, or: "")
        events = try c.decode(forKey: .events, or: [:])
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(channel, forKey: .channel)
        try c.encode(events, forKey: .events)
    }
}
