import Foundation

// Auto-react (src/modules/autoReact.js, normaliseAutoReact; web form
// web-v2/src/moduleForms/AutoReact.jsx): react (and optionally give or take a role) when a message
// comes from chosen users or a chosen role. The first rule that matches wins.
//
// The save body is the web form's, not the stored config: per rule, the target users as one
// typed string (`targetUsersText`), one target role (`targetRoleId`) and the emoji as one typed
// string (`emojis`). The server splits and validates them.

/// The Auto-react settings page.
public struct AutoReactPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "auto-react"

    public let settings: AutoReactSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(settings: AutoReactSettings, channels: [ChannelOption] = [], roles: [RoleOption] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: AutoReactSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

/// When a matching rule reacts.
public enum AutoReactMode: String, Codable, Sendable, CaseIterable {
    /// On every matching message.
    case always
    /// At the rule's percentage chance.
    case random

    public init(from decoder: any Decoder) throws {
        self = AutoReactMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .always
    }
}

/// What a rule does with its role, when it has one.
public enum AutoReactRoleAction: String, Codable, Sendable, CaseIterable {
    case add, remove

    public init(from decoder: any Decoder) throws {
        self = AutoReactRoleAction(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .add
    }
}

public struct AutoReactSettings: Codable, Sendable, Equatable {
    /// How long to wait before reacting to the same person again.
    public var cooldownSeconds: Int
    /// Where a line is posted every time a rule triggers ("" for none).
    public var logChannelId: String
    public var rules: [Rule]

    public init(cooldownSeconds: Int = 5, logChannelId: String = "", rules: [Rule] = []) {
        self.cooldownSeconds = cooldownSeconds
        self.logChannelId = logChannelId
        self.rules = rules
    }

    public static let cooldownRange = 0...300
    public static let chanceRange = 1...100
    /// The server keeps at most this many rules.
    public static let maxRules = 25

    public struct Rule: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// User ids or @mentions, separated by spaces or commas.
        public var targetUsersText: String
        /// Anyone with this role matches too ("" for none).
        public var targetRoleId: String
        /// Locks the rule to one channel ("" for every channel).
        public var channelId: String
        /// Emoji separated by spaces or commas: unicode, or a custom emoji (its id or `<:name:id>`).
        public var emojisText: String
        public var mode: AutoReactMode
        /// Percentage, used only in the `random` mode.
        public var chance: Int
        /// A role to give or take from the author ("" for no role change).
        public var roleId: String
        public var roleAction: AutoReactRoleAction

        public init(targetUsersText: String = "", targetRoleId: String = "", channelId: String = "",
                    emojisText: String = "", mode: AutoReactMode = .always, chance: Int = 50,
                    roleId: String = "", roleAction: AutoReactRoleAction = .add) {
            id = UUID()
            self.targetUsersText = targetUsersText
            self.targetRoleId = targetRoleId
            self.channelId = channelId
            self.emojisText = emojisText
            self.mode = mode
            self.chance = chance
            self.roleId = roleId
            self.roleAction = roleAction
        }

        /// The stored config's keys.
        private enum StoredKeys: String, CodingKey {
            case targetUsers, targetRoles, channelId, emojis, mode, chance, roleId, roleAction
        }

        /// The web form's save keys.
        private enum BodyKeys: String, CodingKey {
            case targetUsersText, targetRoleId, channelId, emojis, mode, chance, roleId, roleAction
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: StoredKeys.self)
            self.init(
                targetUsersText: try c.decode([String].self, forKey: .targetUsers, or: []).joined(separator: " "),
                targetRoleId: try c.decode([String].self, forKey: .targetRoles, or: []).first ?? "",
                channelId: try c.decode(forKey: .channelId, or: ""),
                emojisText: try c.decode([String].self, forKey: .emojis, or: []).joined(separator: " "),
                mode: try c.decode(forKey: .mode, or: .always),
                chance: try c.decode(forKey: .chance, or: 50),
                roleId: try c.decode(forKey: .roleId, or: ""),
                roleAction: try c.decode(forKey: .roleAction, or: .add))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: BodyKeys.self)
            try c.encode(targetUsersText, forKey: .targetUsersText)
            try c.encode(targetRoleId, forKey: .targetRoleId)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(emojisText, forKey: .emojis)
            try c.encode(mode, forKey: .mode)
            try c.encode(chance, forKey: .chance)
            try c.encode(roleId, forKey: .roleId)
            try c.encode(roleAction, forKey: .roleAction)
        }
    }

    private enum CodingKeys: String, CodingKey { case cooldownSeconds, logChannelId, rules }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cooldownSeconds = try c.decode(forKey: .cooldownSeconds, or: 5)
        logChannelId = try c.decode(forKey: .logChannelId, or: "")
        rules = try c.decode(forKey: .rules, or: [])
    }
}
