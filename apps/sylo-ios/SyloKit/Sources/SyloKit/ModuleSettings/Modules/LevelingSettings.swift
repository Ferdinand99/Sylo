import Foundation

// Leveling (src/modules/leveling.js, normaliseLevelingConfig; web form
// web-v2/src/moduleForms/Leveling.jsx): XP for messages and voice time, level-up announcements,
// role rewards, XP multipliers and no-XP roles and channels. Only the settings; the leaderboard
// preview and the set-XP / reset tools of the web page are not part of this page.

/// The Leveling settings page.
public struct LevelingPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "leveling"

    public let settings: LevelingSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The XP rates to choose from, lowest first.
    public let xpRates: [Double]

    public init(settings: LevelingSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                xpRates: [Double] = LevelingSettings.xpRates) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.xpRates = xpRates
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, xpRates
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: LevelingSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        let rates = try c.decode([Double].self, forKey: .xpRates, or: [])
        xpRates = rates.isEmpty ? LevelingSettings.xpRates : rates
    }
}

/// Where a level-up is announced.
public enum LevelingAnnounceMode: String, Codable, Sendable, CaseIterable {
    case channel, reply, dm, off

    public init(from decoder: any Decoder) throws {
        self = LevelingAnnounceMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .channel
    }
}

/// How a no-XP list is read: `allow` = everyone gains XP except the listed ones, `deny` = nobody
/// does except the listed ones.
public enum LevelingListMode: String, Codable, Sendable, CaseIterable {
    case allow, deny

    public init(from decoder: any Decoder) throws {
        self = LevelingListMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .allow
    }
}

/// What an XP multiplier applies to.
public enum LevelingMultiplierType: String, Codable, Sendable, CaseIterable {
    case role, channel

    public init(from decoder: any Decoder) throws {
        self = LevelingMultiplierType(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .role
    }
}

public struct LevelingSettings: Codable, Sendable, Equatable {
    /// Seconds between two messages that earn XP.
    public var cooldownSeconds: Int
    /// Scales all XP; one of `xpRates`.
    public var xpRate: Double
    public var announce: LevelingAnnounceMode
    /// "" = the channel they levelled up in.
    public var announceChannel: String
    /// `{player}`, `{level}`, `{username}`, `{server}` are filled in.
    public var announceMessage: String
    public var noXpChannels: [String]
    public var noXpChannelsMode: LevelingListMode
    public var noXpRoles: [String]
    public var noXpRolesMode: LevelingListMode
    /// `true`: a member keeps every reward role they reached; `false`: only the highest.
    public var stackRewards: Bool
    public var removeRewardsOnXpLoss: Bool
    public var voiceXpEnabled: Bool
    public var voiceXpPerMin: Int
    /// Voice XP only with 2+ non-bot members, not deafened, not in the AFK channel.
    public var voiceAfkExcluded: Bool
    public var multipliers: [Multiplier]
    public var rewards: [Reward]

    public init(cooldownSeconds: Int = 60, xpRate: Double = 1, announce: LevelingAnnounceMode = .channel,
                announceChannel: String = "", announceMessage: String = LevelingSettings.defaultAnnounceMessage,
                noXpChannels: [String] = [], noXpChannelsMode: LevelingListMode = .allow,
                noXpRoles: [String] = [], noXpRolesMode: LevelingListMode = .allow,
                stackRewards: Bool = true, removeRewardsOnXpLoss: Bool = false,
                voiceXpEnabled: Bool = false, voiceXpPerMin: Int = 10, voiceAfkExcluded: Bool = true,
                multipliers: [Multiplier] = [], rewards: [Reward] = []) {
        self.cooldownSeconds = cooldownSeconds
        self.xpRate = xpRate
        self.announce = announce
        self.announceChannel = announceChannel
        self.announceMessage = announceMessage
        self.noXpChannels = noXpChannels
        self.noXpChannelsMode = noXpChannelsMode
        self.noXpRoles = noXpRoles
        self.noXpRolesMode = noXpRolesMode
        self.stackRewards = stackRewards
        self.removeRewardsOnXpLoss = removeRewardsOnXpLoss
        self.voiceXpEnabled = voiceXpEnabled
        self.voiceXpPerMin = voiceXpPerMin
        self.voiceAfkExcluded = voiceAfkExcluded
        self.multipliers = multipliers
        self.rewards = rewards
    }

    public static let defaultAnnounceMessage = "GG {player}, you just advanced to level {level}!"
    public static let xpRates: [Double] = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3]
    public static let cooldownRange = 0...3600
    public static let voiceXpRange = 1...60
    public static let maxMessageLength = 2000
    public static let maxMultipliers = 25
    public static let maxRewards = 50

    /// A role handed out once a member reaches a level.
    public struct Reward: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        public var level: Int
        public var roleId: String

        public init(level: Int = 5, roleId: String = "") {
            id = UUID()
            self.level = level
            self.roleId = roleId
        }

        public static let levelRange = 1...1000

        private enum CodingKeys: String, CodingKey { case level, roleId }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(level: try c.decode(forKey: .level, or: 1), roleId: try c.decode(forKey: .roleId, or: ""))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(level, forKey: .level)
            try c.encode(roleId, forKey: .roleId)
        }
    }

    /// More (or less) XP for a role or in a channel.
    public struct Multiplier: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        public var type: LevelingMultiplierType
        /// The role or channel id ("" = not chosen yet). Sent as `id`.
        public var targetId: String
        public var factor: Double

        public init(type: LevelingMultiplierType = .role, targetId: String = "", factor: Double = 2) {
            id = UUID()
            self.type = type
            self.targetId = targetId
            self.factor = factor
        }

        public static let factorRange = 0.1...5.0

        private enum CodingKeys: String, CodingKey {
            case type, factor
            case targetId = "id"
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(type: try c.decode(forKey: .type, or: .role),
                      targetId: try c.decode(forKey: .targetId, or: ""),
                      factor: try c.decode(forKey: .factor, or: 1))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(type, forKey: .type)
            try c.encode(targetId, forKey: .targetId)
            try c.encode(factor, forKey: .factor)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case cooldownSeconds, xpRate, announce, announceChannel, announceMessage
        case noXpChannels, noXpChannelsMode, noXpRoles, noXpRolesMode
        case stackRewards, removeRewardsOnXpLoss
        case voiceXpEnabled, voiceXpPerMin, voiceAfkExcluded
        case multipliers, rewards
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cooldownSeconds = try c.decode(forKey: .cooldownSeconds, or: 60)
        let rate = try c.decode(Double.self, forKey: .xpRate, or: 1)
        xpRate = Self.xpRates.contains(rate) ? rate : 1
        announce = try c.decode(forKey: .announce, or: .channel)
        announceChannel = try c.decode(forKey: .announceChannel, or: "")
        let message = try c.decode(String.self, forKey: .announceMessage, or: "")
        announceMessage = message.isEmpty ? Self.defaultAnnounceMessage : message
        noXpChannels = try c.decode(forKey: .noXpChannels, or: [])
        noXpChannelsMode = try c.decode(forKey: .noXpChannelsMode, or: .allow)
        noXpRoles = try c.decode(forKey: .noXpRoles, or: [])
        noXpRolesMode = try c.decode(forKey: .noXpRolesMode, or: .allow)
        stackRewards = try c.decode(forKey: .stackRewards, or: true)
        removeRewardsOnXpLoss = try c.decode(forKey: .removeRewardsOnXpLoss, or: false)
        voiceXpEnabled = try c.decode(forKey: .voiceXpEnabled, or: false)
        voiceXpPerMin = try c.decode(forKey: .voiceXpPerMin, or: 10)
        voiceAfkExcluded = try c.decode(forKey: .voiceAfkExcluded, or: true)
        multipliers = try c.decode(forKey: .multipliers, or: [])
        rewards = try c.decode(forKey: .rewards, or: [])
    }
}
