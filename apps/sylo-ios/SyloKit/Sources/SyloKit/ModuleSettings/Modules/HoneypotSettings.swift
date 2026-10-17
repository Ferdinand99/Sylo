import Foundation

// Honeypot (src/modules/honeypot.js, normaliseHoneypotConfig; web form
// web-v2/src/moduleForms/Honeypot.jsx): trap channels and trap messages that punish whoever
// posts in or reacts to them.

/// The Honeypot settings page.
public struct HoneypotPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "honeypot"

    public let settings: HoneypotSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The last catches, newest first.
    public let catches: [HoneypotCatch]

    public init(settings: HoneypotSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                catches: [HoneypotCatch] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.catches = catches
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, catches
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: HoneypotSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        catches = try c.decode(forKey: .catches, or: [])
    }
}

/// What happens to someone who falls for a trap.
public enum HoneypotAction: String, Codable, Sendable, CaseIterable {
    case kick, timeout, ban

    public init(from decoder: any Decoder) throws {
        self = HoneypotAction(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .kick
    }
}

public struct HoneypotSettings: Codable, Sendable, Equatable {
    /// Members with one of these roles (and administrators) are never acted on.
    public var exemptRoles: [String]
    /// Any message posted in one of these channels triggers its action.
    public var channels: [ChannelTrap]
    /// Sylo posts a bait message in each channel; any reaction to it triggers its action.
    public var messages: [MessageTrap]

    public init(exemptRoles: [String] = [], channels: [ChannelTrap] = [], messages: [MessageTrap] = []) {
        self.exemptRoles = exemptRoles
        self.channels = channels
        self.messages = messages
    }

    /// The server keeps at most this many of each kind of trap.
    public static let maxTraps = 25
    /// Discord's timeout cap, in minutes (28 days).
    public static let timeoutRange = 1...40320

    public struct ChannelTrap: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        public var channelId: String
        public var action: HoneypotAction
        public var timeoutMinutes: Int
        public var deleteMessage: Bool
        /// How often it caught someone (bot-managed, read only).
        public let triggerCount: Int

        public init(channelId: String = "", action: HoneypotAction = .kick, timeoutMinutes: Int = 10,
                    deleteMessage: Bool = true, triggerCount: Int = 0) {
            id = UUID()
            self.channelId = channelId
            self.action = action
            self.timeoutMinutes = timeoutMinutes
            self.deleteMessage = deleteMessage
            self.triggerCount = triggerCount
        }

        private enum CodingKeys: String, CodingKey {
            case channelId, action, timeoutMinutes, deleteMessage, triggerCount
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                channelId: try c.decode(forKey: .channelId, or: ""),
                action: try c.decode(forKey: .action, or: .kick),
                timeoutMinutes: try c.decode(forKey: .timeoutMinutes, or: 10),
                deleteMessage: try c.decode(forKey: .deleteMessage, or: true),
                triggerCount: try c.decode(forKey: .triggerCount, or: 0))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(action, forKey: .action)
            try c.encode(timeoutMinutes, forKey: .timeoutMinutes)
            try c.encode(deleteMessage, forKey: .deleteMessage)
        }
    }

    public struct MessageTrap: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        public var channelId: String
        /// The bait message's text (at most 500 characters).
        public var bait: String
        public var action: HoneypotAction
        public var timeoutMinutes: Int
        /// How often it caught someone (bot-managed, read only).
        public let triggerCount: Int

        public init(channelId: String = "", bait: String = "", action: HoneypotAction = .kick,
                    timeoutMinutes: Int = 10, triggerCount: Int = 0) {
            id = UUID()
            self.channelId = channelId
            self.bait = bait
            self.action = action
            self.timeoutMinutes = timeoutMinutes
            self.triggerCount = triggerCount
        }

        public static let maxBaitLength = 500

        private enum CodingKeys: String, CodingKey {
            case channelId, bait, action, timeoutMinutes, triggerCount
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                channelId: try c.decode(forKey: .channelId, or: ""),
                bait: try c.decode(forKey: .bait, or: ""),
                action: try c.decode(forKey: .action, or: .kick),
                timeoutMinutes: try c.decode(forKey: .timeoutMinutes, or: 10),
                triggerCount: try c.decode(forKey: .triggerCount, or: 0))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(bait, forKey: .bait)
            try c.encode(action, forKey: .action)
            try c.encode(timeoutMinutes, forKey: .timeoutMinutes)
        }
    }

    private enum CodingKeys: String, CodingKey { case exemptRoles, channels, messages }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exemptRoles = try c.decode(forKey: .exemptRoles, or: [])
        channels = try c.decode(forKey: .channels, or: [])
        messages = try c.decode(forKey: .messages, or: [])
    }
}

/// One recent catch, for the list under the settings.
public struct HoneypotCatch: Decodable, Sendable, Hashable {
    public let userTag: String
    /// `channel` or `message`.
    public let kind: String
    public let channelName: String
    public let action: String
    /// Already worded by the server ("2h ago").
    public let ago: String
}
