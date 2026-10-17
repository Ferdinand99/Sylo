import Foundation

// Starboard (src/modules/starboard.js, normaliseStarboard; web form
// web-v2/src/moduleForms/Starboard.jsx): re-posts messages that get enough of a reaction into a
// highlights channel. Several boards, each with its own emoji, threshold and rules.
//
// The GET answer gives each board's emoji twice: `emojis` (stored keys) and `emojiText` (typed
// form, custom emoji as `<:name:id>`). The form edits `emojiText` and sends it as `emojis`.

/// The Starboard settings page.
public struct StarboardPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "starboard"

    public let settings: StarboardSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(settings: StarboardSettings, channels: [ChannelOption] = [], roles: [RoleOption] = []) {
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
        settings = try c.decode(forKey: .settings, or: StarboardSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

/// How a board's role or channel list is used. The stored names are kept as the server has them:
/// `allow` means everyone (every channel) except the list, `deny` means only the list.
public enum StarboardListMode: String, Codable, Sendable, CaseIterable {
    case allow, deny

    public init(from decoder: any Decoder) throws {
        self = StarboardListMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .allow
    }
}

public struct StarboardSettings: Codable, Sendable, Equatable {
    public var boards: [Board]

    public init(boards: [Board] = []) {
        self.boards = boards
    }

    /// The server keeps at most this many boards.
    public static let maxBoards = 10
    public static let thresholdRange = 1...100
    /// Message age limits, in minutes (up to a year).
    public static let ageRange = 0...525600

    public struct Board: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// The server's id for the board, sent back as `id` so its posts stay linked ("" for a new
        /// board; the server numbers it).
        public var boardId: String
        /// Shown on the dashboard only (at most 60 characters).
        public var name: String
        public var channelId: String
        /// Emoji separated by spaces; the first is shown on the post.
        public var emojiText: String
        public var threshold: Int
        /// Count every matching emoji from a member, not just one.
        public var multiPerUser: Bool
        public var autoReact: Bool
        public var autoReactFirstOnly: Bool
        public var removeOnUnstar: Bool
        public var repostCooldown: Bool
        public var removeOnDelete: Bool
        public var ignoreSelfStars: Bool
        public var removeSelfStarReactions: Bool
        public var ignoreBotMessages: Bool
        public var removeBotReactions: Bool
        public var minAgeMinutes: Int
        /// 0 for no limit.
        public var maxAgeMinutes: Int
        public var roleMode: StarboardListMode
        public var roleList: [String]
        public var channelMode: StarboardListMode
        public var channelList: [String]

        public init(boardId: String = "", name: String = "Starboard", channelId: String = "",
                    emojiText: String = "⭐", threshold: Int = 3, multiPerUser: Bool = false,
                    autoReact: Bool = true, autoReactFirstOnly: Bool = false, removeOnUnstar: Bool = true,
                    repostCooldown: Bool = false, removeOnDelete: Bool = true, ignoreSelfStars: Bool = true,
                    removeSelfStarReactions: Bool = false, ignoreBotMessages: Bool = true,
                    removeBotReactions: Bool = false, minAgeMinutes: Int = 0, maxAgeMinutes: Int = 0,
                    roleMode: StarboardListMode = .allow, roleList: [String] = [],
                    channelMode: StarboardListMode = .allow, channelList: [String] = []) {
            id = UUID()
            self.boardId = boardId
            self.name = name
            self.channelId = channelId
            self.emojiText = emojiText
            self.threshold = threshold
            self.multiPerUser = multiPerUser
            self.autoReact = autoReact
            self.autoReactFirstOnly = autoReactFirstOnly
            self.removeOnUnstar = removeOnUnstar
            self.repostCooldown = repostCooldown
            self.removeOnDelete = removeOnDelete
            self.ignoreSelfStars = ignoreSelfStars
            self.removeSelfStarReactions = removeSelfStarReactions
            self.ignoreBotMessages = ignoreBotMessages
            self.removeBotReactions = removeBotReactions
            self.minAgeMinutes = minAgeMinutes
            self.maxAgeMinutes = maxAgeMinutes
            self.roleMode = roleMode
            self.roleList = roleList
            self.channelMode = channelMode
            self.channelList = channelList
        }

        public static let maxNameLength = 60

        private enum CodingKeys: String, CodingKey {
            case boardId = "id"
            case name, channelId, emojis, emojiText, threshold, multiPerUser, autoReact, autoReactFirstOnly,
                 removeOnUnstar, repostCooldown, removeOnDelete, ignoreSelfStars, removeSelfStarReactions,
                 ignoreBotMessages, removeBotReactions, minAgeMinutes, maxAgeMinutes, roleMode, roleList,
                 channelMode, channelList
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let storedEmojis = try c.decodeIfPresent([String].self, forKey: .emojis)
            self.init(
                boardId: try c.decode(forKey: .boardId, or: ""),
                name: try c.decode(forKey: .name, or: "Starboard"),
                channelId: try c.decode(forKey: .channelId, or: ""),
                emojiText: try c.decode(forKey: .emojiText, or: storedEmojis?.joined(separator: " ") ?? "⭐"),
                threshold: try c.decode(forKey: .threshold, or: 3),
                multiPerUser: try c.decode(forKey: .multiPerUser, or: false),
                autoReact: try c.decode(forKey: .autoReact, or: true),
                autoReactFirstOnly: try c.decode(forKey: .autoReactFirstOnly, or: false),
                removeOnUnstar: try c.decode(forKey: .removeOnUnstar, or: true),
                repostCooldown: try c.decode(forKey: .repostCooldown, or: false),
                removeOnDelete: try c.decode(forKey: .removeOnDelete, or: true),
                ignoreSelfStars: try c.decode(forKey: .ignoreSelfStars, or: true),
                removeSelfStarReactions: try c.decode(forKey: .removeSelfStarReactions, or: false),
                ignoreBotMessages: try c.decode(forKey: .ignoreBotMessages, or: true),
                removeBotReactions: try c.decode(forKey: .removeBotReactions, or: false),
                minAgeMinutes: try c.decode(forKey: .minAgeMinutes, or: 0),
                maxAgeMinutes: try c.decode(forKey: .maxAgeMinutes, or: 0),
                roleMode: try c.decode(forKey: .roleMode, or: .allow),
                roleList: try c.decode(forKey: .roleList, or: []),
                channelMode: try c.decode(forKey: .channelMode, or: .allow),
                channelList: try c.decode(forKey: .channelList, or: []))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(boardId, forKey: .boardId)
            try c.encode(name, forKey: .name)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(emojiText, forKey: .emojis)
            try c.encode(threshold, forKey: .threshold)
            try c.encode(multiPerUser, forKey: .multiPerUser)
            try c.encode(autoReact, forKey: .autoReact)
            try c.encode(autoReactFirstOnly, forKey: .autoReactFirstOnly)
            try c.encode(removeOnUnstar, forKey: .removeOnUnstar)
            try c.encode(repostCooldown, forKey: .repostCooldown)
            try c.encode(removeOnDelete, forKey: .removeOnDelete)
            try c.encode(ignoreSelfStars, forKey: .ignoreSelfStars)
            try c.encode(removeSelfStarReactions, forKey: .removeSelfStarReactions)
            try c.encode(ignoreBotMessages, forKey: .ignoreBotMessages)
            try c.encode(removeBotReactions, forKey: .removeBotReactions)
            try c.encode(minAgeMinutes, forKey: .minAgeMinutes)
            try c.encode(maxAgeMinutes, forKey: .maxAgeMinutes)
            try c.encode(roleMode, forKey: .roleMode)
            try c.encode(roleList, forKey: .roleList)
            try c.encode(channelMode, forKey: .channelMode)
            try c.encode(channelList, forKey: .channelList)
        }
    }

    private enum CodingKeys: String, CodingKey { case boards }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        boards = try c.decode(forKey: .boards, or: [])
    }
}
