import Foundation

// Server statistics (src/modules/serverStats.js, normaliseServerStats; web form
// web-v2/src/moduleForms/ServerStats.jsx): voice channels Sylo renames to show a live count.

/// The server statistics settings page.
public struct ServerStatsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "server-stats"

    public let settings: ServerStatsSettings
    /// Voice and stage channels, the only kind a stat can rename.
    public let voiceChannels: [ChannelOption]

    public init(settings: ServerStatsSettings, voiceChannels: [ChannelOption] = []) {
        self.settings = settings
        self.voiceChannels = voiceChannels
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case voiceChannels
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: ServerStatsSettings())
        voiceChannels = try c.decode(forKey: .voiceChannels, or: [])
    }
}

/// What a stat channel counts.
public enum ServerStatsStat: String, Codable, Sendable, CaseIterable {
    case members, humans, bots, roles, channels, boosts

    public init(from decoder: any Decoder) throws {
        self = ServerStatsStat(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .members
    }
}

public struct ServerStatsSettings: Codable, Sendable, Equatable {
    /// How often the channel names are updated, in minutes.
    public var refreshMinutes: Int
    public var channels: [StatChannel]

    public init(refreshMinutes: Int = 10, channels: [StatChannel] = []) {
        self.refreshMinutes = refreshMinutes
        self.channels = channels
    }

    /// Discord limits channel renames, so the server keeps the refresh in this range.
    public static let refreshRange = 5...60
    /// The server keeps at most this many stat channels.
    public static let maxChannels = 10
    public static let maxTemplateLength = 80
    /// The placeholder every template must contain; the server drops rows without it.
    public static let countPlaceholder = "{count}"

    /// One voice channel and the count its name shows.
    public struct StatChannel: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        public var channelId: String
        public var type: ServerStatsStat
        /// The channel name, with `{count}` where the number goes.
        public var template: String

        public init(channelId: String = "", type: ServerStatsStat = .members, template: String = "Members: {count}") {
            id = UUID()
            self.channelId = channelId
            self.type = type
            self.template = template
        }

        private enum CodingKeys: String, CodingKey { case channelId, type, template }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                channelId: try c.decode(forKey: .channelId, or: ""),
                type: try c.decode(forKey: .type, or: .members),
                template: try c.decode(forKey: .template, or: ServerStatsSettings.countPlaceholder))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(type, forKey: .type)
            try c.encode(template, forKey: .template)
        }
    }

    private enum CodingKeys: String, CodingKey { case refreshMinutes, channels }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        refreshMinutes = try c.decode(forKey: .refreshMinutes, or: 10)
        channels = try c.decode(forKey: .channels, or: [])
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(refreshMinutes, forKey: .refreshMinutes)
        try c.encode(channels, forKey: .channels)
    }
}
