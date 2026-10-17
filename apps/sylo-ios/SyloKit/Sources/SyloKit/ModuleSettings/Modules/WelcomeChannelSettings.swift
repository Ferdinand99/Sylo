import Foundation

// Welcome Channel (src/modules/welcomeChannel.js, normaliseWelcomeChannelConfig and
// normaliseEmbedSpec; web form web-v2/src/moduleForms/WelcomeChannel.jsx): one rich message
// (text plus up to 10 embeds and banners) for a read-only channel. Saving keeps it as a draft;
// publishing it to the channel, removing the published message and creating the channel are
// separate actions on the web page.

/// The Welcome Channel settings page.
public struct WelcomeChannelPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "welcome-channel"

    public let settings: WelcomeChannelSettings
    public let channels: [ChannelOption]
    /// The "Add element" choices.
    public let presets: [WelcomeChannelPreset]

    public init(settings: WelcomeChannelSettings, channels: [ChannelOption] = [],
                presets: [WelcomeChannelPreset] = []) {
        self.settings = settings
        self.channels = channels
        self.presets = presets
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, presets
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: WelcomeChannelSettings())
        channels = try c.decode(forKey: .channels, or: [])
        presets = try c.decode(forKey: .presets, or: [])
    }
}

/// An embed (title, text, fields, images) or a banner (a big image with a caption).
public enum WelcomeChannelEmbedKind: String, Codable, Sendable, CaseIterable {
    case embed, banner

    public init(from decoder: any Decoder) throws {
        self = WelcomeChannelEmbedKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .embed
    }
}

/// One "Add element" choice: a ready-made embed or banner.
public struct WelcomeChannelPreset: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let defaults: WelcomeChannelSettings.Embed

    public init(id: String, label: String, defaults: WelcomeChannelSettings.Embed) {
        self.id = id
        self.label = label
        self.defaults = defaults
    }

    /// A new element from this preset (its own list id).
    public func makeEmbed() -> WelcomeChannelSettings.Embed {
        let d = defaults
        return WelcomeChannelSettings.Embed(
            kind: d.kind, color: d.color, authorName: d.authorName, authorIcon: d.authorIcon, title: d.title,
            description: d.description, image: d.image, thumbnail: d.thumbnail, footerText: d.footerText,
            footerIcon: d.footerIcon, fields: d.fields.map { WelcomeChannelSettings.Field(name: $0.name, value: $0.value, inline: $0.inline) })
    }

    private enum CodingKeys: String, CodingKey { case id, label, defaults }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(forKey: .label, or: id)
        defaults = try c.decode(forKey: .defaults, or: WelcomeChannelSettings.Embed())
    }
}

public struct WelcomeChannelSettings: Codable, Sendable, Equatable {
    /// The channel the message is published in ("" = none chosen).
    public var channelId: String
    /// The published message (bot-managed, read only; "" = not published).
    public let messageId: String
    /// Text above the embeds; `{server}` and `{memberCount}` are filled in.
    public var content: String
    public var embeds: [Embed]

    public init(channelId: String = "", messageId: String = "", content: String = "", embeds: [Embed] = []) {
        self.channelId = channelId
        self.messageId = messageId
        self.content = content
        self.embeds = embeds
    }

    public var isPublished: Bool { !messageId.isEmpty }

    public static let maxContentLength = 2000
    public static let maxEmbeds = 10

    public struct Embed: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        public var kind: WelcomeChannelEmbedKind
        /// `#rrggbb`.
        public var color: String
        public var authorName: String
        /// Image URLs below are `https://…` or "".
        public var authorIcon: String
        public var title: String
        /// For a banner, its caption.
        public var description: String
        public var image: String
        public var thumbnail: String
        public var footerText: String
        public var footerIcon: String
        public var fields: [Field]

        public init(kind: WelcomeChannelEmbedKind = .embed, color: String = Embed.defaultColor,
                    authorName: String = "", authorIcon: String = "", title: String = "",
                    description: String = "", image: String = "", thumbnail: String = "",
                    footerText: String = "", footerIcon: String = "", fields: [Field] = []) {
            id = UUID()
            self.kind = kind
            self.color = color
            self.authorName = authorName
            self.authorIcon = authorIcon
            self.title = title
            self.description = description
            self.image = image
            self.thumbnail = thumbnail
            self.footerText = footerText
            self.footerIcon = footerIcon
            self.fields = fields
        }

        /// Discord's blurple, what the web form shows for an embed without a valid colour.
        public static let defaultColor = "#5865f2"
        public static let maxTitleLength = 256
        public static let maxDescriptionLength = 4096
        public static let maxAuthorLength = 256
        public static let maxFooterLength = 2048
        public static let maxFields = 25

        /// Whether `color` is a `#rrggbb` colour.
        public static func isValidColor(_ color: String) -> Bool {
            color.count == 7 && color.first == "#" && color.dropFirst().allSatisfy(\.isHexDigit)
        }

        private enum CodingKeys: String, CodingKey {
            case kind, color, authorName, authorIcon, title, description, image, thumbnail
            case footerText, footerIcon, fields
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let color = try c.decode(String.self, forKey: .color, or: "")
            self.init(
                kind: try c.decode(forKey: .kind, or: .embed),
                color: Self.isValidColor(color) ? color : Self.defaultColor,
                authorName: try c.decode(forKey: .authorName, or: ""),
                authorIcon: try c.decode(forKey: .authorIcon, or: ""),
                title: try c.decode(forKey: .title, or: ""),
                description: try c.decode(forKey: .description, or: ""),
                image: try c.decode(forKey: .image, or: ""),
                thumbnail: try c.decode(forKey: .thumbnail, or: ""),
                footerText: try c.decode(forKey: .footerText, or: ""),
                footerIcon: try c.decode(forKey: .footerIcon, or: ""),
                fields: try c.decode(forKey: .fields, or: []))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(kind, forKey: .kind)
            try c.encode(color, forKey: .color)
            try c.encode(authorName, forKey: .authorName)
            try c.encode(authorIcon, forKey: .authorIcon)
            try c.encode(title, forKey: .title)
            try c.encode(description, forKey: .description)
            try c.encode(image, forKey: .image)
            try c.encode(thumbnail, forKey: .thumbnail)
            try c.encode(footerText, forKey: .footerText)
            try c.encode(footerIcon, forKey: .footerIcon)
            // Like the web form, rows with neither a name nor a value are left out.
            try c.encode(fields.filter { !$0.name.isEmpty || !$0.value.isEmpty }, forKey: .fields)
        }
    }

    /// A name/value field in an embed.
    public struct Field: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        public var name: String
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
            self.init(name: try c.decode(forKey: .name, or: ""), value: try c.decode(forKey: .value, or: ""),
                      inline: try c.decode(forKey: .inline, or: false))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(name, forKey: .name)
            try c.encode(value, forKey: .value)
            try c.encode(inline, forKey: .inline)
        }
    }

    private enum CodingKeys: String, CodingKey { case channelId, messageId, spec }
    private enum SpecKeys: String, CodingKey { case content, embeds }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channelId = try c.decode(forKey: .channelId, or: "")
        messageId = try c.decode(forKey: .messageId, or: "")
        if c.contains(.spec), try !c.decodeNil(forKey: .spec) {
            let spec = try c.nestedContainer(keyedBy: SpecKeys.self, forKey: .spec)
            content = try spec.decode(forKey: .content, or: "")
            embeds = try spec.decode(forKey: .embeds, or: [])
        } else {
            content = ""
            embeds = []
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(channelId, forKey: .channelId)
        var spec = c.nestedContainer(keyedBy: SpecKeys.self, forKey: .spec)
        try spec.encode(content, forKey: .content)
        try spec.encode(embeds, forKey: .embeds)
    }
}
