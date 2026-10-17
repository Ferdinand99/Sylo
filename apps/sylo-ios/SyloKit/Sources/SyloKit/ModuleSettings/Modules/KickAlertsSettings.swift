import Foundation

// Kick alerts (src/modules/kickAlerts.js, normaliseKickConfig; web form
// web-v2/src/moduleForms/KickAlerts.jsx): announce in a channel when a streamer goes live.

/// The Kick alerts settings page.
public struct KickAlertsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "kick-alerts"

    public let settings: KickAlertsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// False when the bot has no Kick app credentials, so alerts never fire.
    public let kickEnabled: Bool
    /// The message used when an alert's own message is empty.
    public let defaultMessage: String

    public init(settings: KickAlertsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                kickEnabled: Bool = true, defaultMessage: String = "") {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.kickEnabled = kickEnabled
        self.defaultMessage = defaultMessage
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, kickEnabled, defaultMessage
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: KickAlertsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        kickEnabled = try c.decode(forKey: .kickEnabled, or: true)
        defaultMessage = try c.decode(forKey: .defaultMessage, or: "")
    }
}

/// What happens to the alert message when the stream ends.
public enum KickAlertsEndAction: String, Codable, Sendable, CaseIterable {
    case delete, edit, keep

    public init(from decoder: any Decoder) throws {
        self = KickAlertsEndAction(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .delete
    }
}

public struct KickAlertsSettings: Codable, Sendable, Equatable {
    public var alerts: [Alert]

    public init(alerts: [Alert] = []) {
        self.alerts = alerts
    }

    /// The server keeps at most this many streamers.
    public static let maxAlerts = 50
    /// Kick usernames are at most 25 characters.
    public static let maxSlugLength = 25
    public static let maxMessageLength = 1500

    /// One streamer to announce. The server drops rows without a valid username or channel.
    public struct Alert: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// The Kick username (a kick.com link works too).
        public var slug: String
        public var channelId: String
        /// The role to ping, or "" for none.
        public var roleId: String
        /// Empty means the server's default message.
        public var message: String
        /// Post a plain message with no embed.
        public var plainText: Bool
        public var onEnd: KickAlertsEndAction

        public init(slug: String = "", channelId: String = "", roleId: String = "", message: String = "",
                    plainText: Bool = false, onEnd: KickAlertsEndAction = .delete) {
            id = UUID()
            self.slug = slug
            self.channelId = channelId
            self.roleId = roleId
            self.message = message
            self.plainText = plainText
            self.onEnd = onEnd
        }

        private enum CodingKeys: String, CodingKey {
            case slug, channelId, roleId, message, plainText, onEnd
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                slug: try c.decode(forKey: .slug, or: ""),
                channelId: try c.decode(forKey: .channelId, or: ""),
                roleId: try c.decode(forKey: .roleId, or: ""),
                message: try c.decode(forKey: .message, or: ""),
                plainText: try c.decode(forKey: .plainText, or: false),
                onEnd: try c.decode(forKey: .onEnd, or: .delete))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(slug, forKey: .slug)
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
