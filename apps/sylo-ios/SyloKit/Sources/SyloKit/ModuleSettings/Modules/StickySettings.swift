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
        public var embed: StickyEmbed?
        /// Also re-post after messages from other apps and webhooks (and Sylo's own alerts).
        public var repostOnBots: Bool
        /// Minimum seconds between re-posts; 0 means the default of 4 seconds.
        public var cooldownSeconds: Int

        public init(channelId: String = "", content: String = "", embed: StickyEmbed? = nil,
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
                embed: try c.decodeIfPresent(StickyEmbed.self, forKey: .embed),
                repostOnBots: try c.decode(forKey: .repostOnBots, or: false),
                cooldownSeconds: try c.decode(forKey: .cooldownSeconds, or: 0))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(content, forKey: .content)
            if let embed {
                try c.encode(embed, forKey: .embed)
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

/// A sticky's embed, as the web dashboard's embed editor sends it. URLs that aren't http(s) are
/// dropped by the server, and an embed with nothing in it is removed.
public struct StickyEmbed: Codable, Sendable, Equatable {
    /// At most 256 characters.
    public var title: String
    /// At most 4096 characters.
    public var description: String
    /// `#rrggbb`, or "" for the default colour.
    public var color: String
    public var image: String
    public var thumbnail: String
    /// At most 256 characters.
    public var authorName: String
    public var authorIcon: String
    /// At most 2048 characters.
    public var footerText: String
    public var footerIcon: String
    /// At most 25; the server drops a field without both a name and a value.
    public var fields: [Field]

    public init(title: String = "", description: String = "", color: String = StickyEmbed.defaultColor,
                image: String = "", thumbnail: String = "", authorName: String = "", authorIcon: String = "",
                footerText: String = "", footerIcon: String = "", fields: [Field] = []) {
        self.title = title
        self.description = description
        self.color = color
        self.image = image
        self.thumbnail = thumbnail
        self.authorName = authorName
        self.authorIcon = authorIcon
        self.footerText = footerText
        self.footerIcon = footerIcon
        self.fields = fields
    }

    public static let defaultColor = "#5865f2"
    public static let maxTitleLength = 256
    public static let maxDescriptionLength = 4096
    public static let maxAuthorNameLength = 256
    public static let maxFooterLength = 2048
    public static let maxFields = 25

    public struct Field: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// At most 256 characters.
        public var name: String
        /// At most 1024 characters.
        public var value: String
        public var inline: Bool

        public init(name: String = "", value: String = "", inline: Bool = false) {
            id = UUID()
            self.name = name
            self.value = value
            self.inline = inline
        }

        public static let maxNameLength = 256
        public static let maxValueLength = 1024

        private enum CodingKeys: String, CodingKey { case name, value, inline }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                name: try c.decode(forKey: .name, or: ""),
                value: try c.decode(forKey: .value, or: ""),
                inline: try c.decode(forKey: .inline, or: false))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(name, forKey: .name)
            try c.encode(value, forKey: .value)
            try c.encode(inline, forKey: .inline)
        }
    }

    /// The colour as 0...1 sRGB components, for a colour picker. An empty or unreadable colour
    /// reads as the default one.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let value = Self.hexValue(color) ?? Self.hexValue(Self.defaultColor) ?? 0
        return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
    }

    /// Sets the colour from 0...1 sRGB components (clamped, since wide-gamut colours can go past
    /// them).
    public mutating func setRGB(red: Double, green: Double, blue: Double) {
        func hexByte(_ component: Double) -> String {
            let text = String(Int((min(max(component, 0), 1) * 255).rounded()), radix: 16)
            return text.count == 1 ? "0" + text : text
        }
        color = "#" + hexByte(red) + hexByte(green) + hexByte(blue)
    }

    private static func hexValue(_ color: String) -> Int? {
        let hex = color.hasPrefix("#") ? color.dropFirst() : Substring(color)
        guard hex.count == 6, hex.allSatisfy(\.isHexDigit) else { return nil }
        return Int(hex, radix: 16)
    }

    private enum CodingKeys: String, CodingKey {
        case kind, color, title, image, authorName, authorIcon, description, thumbnail, footerText, footerIcon, fields
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(forKey: .title, or: "")
        description = try c.decode(forKey: .description, or: "")
        // Kept as stored (the server stores "" for "default"), so opening the screen changes nothing.
        color = try c.decode(forKey: .color, or: "")
        image = try c.decode(forKey: .image, or: "")
        thumbnail = try c.decode(forKey: .thumbnail, or: "")
        authorName = try c.decode(forKey: .authorName, or: "")
        authorIcon = try c.decode(forKey: .authorIcon, or: "")
        footerText = try c.decode(forKey: .footerText, or: "")
        footerIcon = try c.decode(forKey: .footerIcon, or: "")
        fields = try c.decode(forKey: .fields, or: [])
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode("embed", forKey: .kind)
        try c.encode(color, forKey: .color)
        try c.encode(title, forKey: .title)
        try c.encode(image, forKey: .image)
        try c.encode(authorName, forKey: .authorName)
        try c.encode(authorIcon, forKey: .authorIcon)
        try c.encode(description, forKey: .description)
        try c.encode(thumbnail, forKey: .thumbnail)
        try c.encode(footerText, forKey: .footerText)
        try c.encode(footerIcon, forKey: .footerIcon)
        try c.encode(fields, forKey: .fields)
    }
}
