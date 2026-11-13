import Foundation

// Sticky messages (src/modules/sticky.js, normaliseStickyConfig; embeds go through
// normaliseEmbedSpec in src/modules/welcomeChannel.js; web form web-v2/src/moduleForms/Sticky.jsx
// with web-v2/src/components/EmbedEditor.jsx): one message per channel that Sylo re-posts at the
// bottom whenever someone else writes there.

/// The Sticky messages settings page.
public struct StickyPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "sticky"

    public let settings: StickySettings
    public let channels: [ChannelOption]

    public init(settings: StickySettings, channels: [ChannelOption] = []) {
        self.settings = settings
        self.channels = channels
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: StickySettings())
        channels = try c.decode(forKey: .channels, or: [])
    }
}

public struct StickySettings: Codable, Sendable, Equatable {
    /// One per channel. The server drops a sticky without a channel, or with neither text nor an
    /// embed.
    public var stickies: [Sticky]

    public init(stickies: [Sticky] = []) {
        self.stickies = stickies
    }

    public struct Sticky: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        public var channelId: String
        /// Plain text (at most 2000 characters); optional when there's an embed.
        public var content: String
        public var embed: EmbedDraft?
        /// Also re-post after messages from other apps and webhooks (and Sylo's own alerts).
        public var repostOnBots: Bool
        /// Minimum seconds between re-posts; 0 means the default of 4 seconds.
        public var cooldownSeconds: Int

        public init(channelId: String = "", content: String = "", embed: EmbedDraft? = nil,
                    repostOnBots: Bool = false, cooldownSeconds: Int = 0) {
            id = UUID()
            self.channelId = channelId
            self.content = content
            self.embed = embed
            self.repostOnBots = repostOnBots
            self.cooldownSeconds = cooldownSeconds
        }

        public static let maxContentLength = 2000
        public static let cooldownRange = 0...3600

        private enum CodingKeys: String, CodingKey {
            case channelId, content, embed, repostOnBots, cooldownSeconds
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                channelId: try c.decode(forKey: .channelId, or: ""),
                content: try c.decode(forKey: .content, or: ""),
                embed: try c.decodeIfPresent(EmbedDraft.self, forKey: .embed),
                repostOnBots: try c.decode(forKey: .repostOnBots, or: false),
                cooldownSeconds: try c.decode(forKey: .cooldownSeconds, or: 0))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(content, forKey: .content)
            if let embed {
                try c.encode(embed.spec(), forKey: .embed)
            } else {
                try c.encodeNil(forKey: .embed)
            }
            try c.encode(repostOnBots, forKey: .repostOnBots)
            try c.encode(cooldownSeconds, forKey: .cooldownSeconds)
        }
    }

    private enum CodingKeys: String, CodingKey { case stickies }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stickies = try c.decode(forKey: .stickies, or: [])
    }
}
