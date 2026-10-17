import Foundation

// Twitch alerts (src/modules/twitchAlerts.js, normaliseTwitchConfig; web form
// web-v2/src/moduleForms/TwitchAlerts.jsx): announce in a channel when a streamer goes live.

/// The Twitch alerts settings page.
public struct TwitchAlertsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "twitch-alerts"

    public let settings: TwitchAlertsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// False when the bot has no Twitch app credentials, so alerts never fire.
    public let twitchEnabled: Bool
    /// The message used when an alert's own message is empty.
    public let defaultMessage: String

    public init(settings: TwitchAlertsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                twitchEnabled: Bool = true, defaultMessage: String = "") {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.twitchEnabled = twitchEnabled
        self.defaultMessage = defaultMessage
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, twitchEnabled, defaultMessage
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: TwitchAlertsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        twitchEnabled = try c.decode(forKey: .twitchEnabled, or: true)
        defaultMessage = try c.decode(forKey: .defaultMessage, or: "")
    }
}

/// What happens to the alert message when the stream ends.
public enum TwitchAlertsEndAction: String, Codable, Sendable, CaseIterable {
    case delete, edit, keep

    public init(from decoder: any Decoder) throws {
        self = TwitchAlertsEndAction(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .delete
    }
}

public struct TwitchAlertsSettings: Codable, Sendable, Equatable {
    public var alerts: [Alert]

    public init(alerts: [Alert] = []) {
        self.alerts = alerts
    }

    /// The server keeps at most this many streamers.
    public static let maxAlerts = 50
    /// Twitch usernames are at most 25 characters.
    public static let maxLoginLength = 25
    public static let maxMessageLength = 1500

    /// One streamer to announce. The server drops rows without a valid username or channel.
    public struct Alert: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// The Twitch username (a twitch.tv link works too).
        public var login: String
        public var channelId: String
        /// The role to ping, or "" for none.
        public var roleId: String
        /// Empty means the server's default message.
        public var message: String
        /// Post a plain message with no embed.
        public var plainText: Bool
        public var onEnd: TwitchAlertsEndAction

        public init(login: String = "", channelId: String = "", roleId: String = "", message: String = "",
                    plainText: Bool = false, onEnd: TwitchAlertsEndAction = .delete) {
            id = UUID()
            self.login = login
            self.channelId = channelId
            self.roleId = roleId
            self.message = message
            self.plainText = plainText
            self.onEnd = onEnd
        }

        private enum CodingKeys: String, CodingKey {
            case login, channelId, roleId, message, plainText, onEnd
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                login: try c.decode(forKey: .login, or: ""),
                channelId: try c.decode(forKey: .channelId, or: ""),
                roleId: try c.decode(forKey: .roleId, or: ""),
                message: try c.decode(forKey: .message, or: ""),
                plainText: try c.decode(forKey: .plainText, or: false),
                onEnd: try c.decode(forKey: .onEnd, or: .delete))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(login, forKey: .login)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(roleId, forKey: .roleId)
            try c.encode(message, forKey: .message)
            try c.encode(plainText, forKey: .plainText)
            try c.encode(onEnd, forKey: .onEnd)
        }
    }

    private enum CodingKeys: String, CodingKey { case alerts }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        alerts = try c.decode(forKey: .alerts, or: [])
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(alerts, forKey: .alerts)
    }
}
