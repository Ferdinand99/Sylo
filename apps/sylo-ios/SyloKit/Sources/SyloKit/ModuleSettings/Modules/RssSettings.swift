import Foundation

// RSS alerts (src/modules/rss.js, normaliseRssConfig; web form web-v2/src/moduleForms/RssAlerts.jsx):
// post new items from RSS/Atom feeds, or from Reddit, Mastodon and Bluesky handles the server
// turns into feeds.

/// The RSS alerts settings page.
public struct RssPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "rss"

    public let settings: RssSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The template used when a feed's own template is empty.
    public let defaultTemplate: String

    public init(settings: RssSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                defaultTemplate: String = "") {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.defaultTemplate = defaultTemplate
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, defaultTemplate
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: RssSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        defaultTemplate = try c.decode(forKey: .defaultTemplate, or: "")
    }
}

/// Where a feed comes from: a raw feed URL, or a handle on a platform the server knows.
public enum RssFeedType: String, Codable, Sendable, CaseIterable {
    case url, reddit, mastodon, bluesky

    public init(from decoder: any Decoder) throws {
        self = RssFeedType(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .url
    }
}

public struct RssSettings: Codable, Sendable, Equatable {
    public var feeds: [Feed]

    public init(feeds: [Feed] = []) {
        self.feeds = feeds
    }

    /// The server keeps at most this many feeds.
    public static let maxFeeds = 15
    public static let maxRefLength = 500
    public static let maxTemplateLength = 1000

    /// One feed. The server drops feeds whose reference doesn't parse or that have no channel.
    public struct Feed: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// The server's id for the feed (sent as `id`), "" until the first save. Sent back
        /// unchanged so the feed keeps its record of already-posted items.
        public let feedId: String
        public var type: RssFeedType
        /// The feed URL, subreddit, or handle, depending on `type`.
        public var ref: String
        public var channelId: String
        /// The role to ping, or "" for none.
        public var roleId: String
        /// Empty means the server's default template.
        public var template: String

        public init(feedId: String = "", type: RssFeedType = .url, ref: String = "", channelId: String = "",
                    roleId: String = "", template: String = "") {
            id = UUID()
            self.feedId = feedId
            self.type = type
            self.ref = ref
            self.channelId = channelId
            self.roleId = roleId
            self.template = template
        }

        private enum CodingKeys: String, CodingKey {
            case feedId = "id"
            case type, ref, channelId, roleId, template
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                feedId: try c.decode(forKey: .feedId, or: ""),
                type: try c.decode(forKey: .type, or: .url),
                ref: try c.decode(forKey: .ref, or: ""),
                channelId: try c.decode(forKey: .channelId, or: ""),
                roleId: try c.decode(forKey: .roleId, or: ""),
                template: try c.decode(forKey: .template, or: ""))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(feedId, forKey: .feedId)
            try c.encode(type, forKey: .type)
            try c.encode(ref, forKey: .ref)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(roleId, forKey: .roleId)
            try c.encode(template, forKey: .template)
        }
    }

    private enum CodingKeys: String, CodingKey { case feeds }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        feeds = try c.decode(forKey: .feeds, or: [])
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(feeds, forKey: .feeds)
    }
}
