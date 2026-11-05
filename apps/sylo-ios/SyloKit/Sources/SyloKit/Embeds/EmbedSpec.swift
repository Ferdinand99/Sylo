import Foundation

// One Discord embed as the dashboard's embed editor stores it (web-v2/src/components/EmbedCard.jsx
// and EmbedEditor.jsx; the server cleans it in src/modules/welcomeChannel.js, normaliseEmbedSpec,
// and builds it in src/modules/messageCreator.js, buildEmbed). Shared by the embed messages page,
// reaction roles, custom commands and reminders.

/// A single embed: text, colour, pictures and fields.
public struct EmbedSpec: Codable, Sendable, Equatable, Identifiable {
    /// For lists only; not sent, and ignored when comparing.
    public let id: UUID
    /// At most 256 characters.
    public var title: String
    /// At most 4096 characters.
    public var description: String
    /// `#rrggbb`, or "" for the server's default.
    public var color: String
    public var image: String
    public var thumbnail: String
    /// At most 256 characters.
    public var authorName: String
    public var authorIcon: String
    /// At most 2048 characters.
    public var footerText: String
    public var footerIcon: String
    /// Show the time the message was posted in the footer.
    public var timestamp: Bool
    /// At most 25. The server drops a field without both a name and a value.
    public var fields: [Field]
    /// Anything else the stored embed holds (a title link, an author link), sent back unchanged.
    public var extra: [String: JSONValue]

    public init(
        title: String = "", description: String = "", color: String = EmbedSpec.defaultColor,
        image: String = "", thumbnail: String = "", authorName: String = "", authorIcon: String = "",
        footerText: String = "", footerIcon: String = "", timestamp: Bool = false, fields: [Field] = [],
        extra: [String: JSONValue] = [:]
    ) {
        id = UUID()
        self.title = title
        self.description = description
        self.color = color
        self.image = image
        self.thumbnail = thumbnail
        self.authorName = authorName
        self.authorIcon = authorIcon
        self.footerText = footerText
        self.footerIcon = footerIcon
        self.timestamp = timestamp
        self.fields = fields
        self.extra = extra
    }

    public static let defaultColor = "#5865f2"
    public static let maxTitleLength = 256
    public static let maxDescriptionLength = 4096
    public static let maxAuthorNameLength = 256
    public static let maxFooterLength = 2048
    public static let maxFields = 25

    /// The dashboard's colour presets, as `#rrggbb`.
    public static let colorPresets = [
        "#99aab5", "#5865f2", "#eb459e", "#ed4245", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db",
        "#9b59b6",
    ]

    public struct Field: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent, and ignored when comparing.
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

        public static func == (lhs: Field, rhs: Field) -> Bool {
            lhs.name == rhs.name && lhs.value == rhs.value && lhs.inline == rhs.inline
        }
    }

    /// Whether nothing visible is set: the server drops such an embed.
    public var isEmpty: Bool {
        title.isEmpty && description.isEmpty && image.isEmpty && thumbnail.isEmpty && authorName.isEmpty
            && footerText.isEmpty && !fields.contains { !$0.name.isEmpty && !$0.value.isEmpty }
    }

    /// The characters Discord counts toward the 6000 of a message: title, description, author name,
    /// footer text and the names and values of the fields that are sent.
    public var characterCount: Int {
        title.count + description.count + authorName.count + footerText.count
            + fields.filter { !$0.name.isEmpty || !$0.value.isEmpty }.reduce(0) { $0 + $1.name.count + $1.value.count }
    }

    /// A copy with its own identity, for duplicating an embed in a list.
    public func duplicated() -> EmbedSpec {
        EmbedSpec(
            title: title, description: description, color: color, image: image, thumbnail: thumbnail,
            authorName: authorName, authorIcon: authorIcon, footerText: footerText, footerIcon: footerIcon,
            timestamp: timestamp, fields: fields.map { Field(name: $0.name, value: $0.value, inline: $0.inline) },
            extra: extra)
    }

    /// This embed with an unreadable or empty colour replaced by `fallback`, the way the web
    /// editor opens it.
    public func withDefaultColor(_ fallback: String = EmbedSpec.defaultColor) -> EmbedSpec {
        var copy = self
        if Self.hexValue(color) == nil { copy.color = fallback }
        return copy
    }

    // MARK: Colour

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

    /// The 24-bit value of `#rrggbb`, nil for anything else.
    public static func hexValue(_ color: String) -> Int? {
        guard color.hasPrefix("#") else { return nil }
        let hex = color.dropFirst()
        guard hex.count == 6, hex.allSatisfy(\.isHexDigit) else { return nil }
        return Int(hex, radix: 16)
    }

    /// Whether the text is an `http://` or `https://` link, the only kind the server keeps.
    public static func isWebLink(_ text: String) -> Bool {
        let lower = text.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return false }
        return !text.contains(where: \.isWhitespace) && text.count > 8
    }

    // MARK: Coding

    private struct AnyKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(_ string: String) { stringValue = string }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    private static let knownKeys: Set<String> = [
        "kind", "color", "title", "image", "authorName", "authorIcon", "description", "thumbnail", "footerText",
        "footerIcon", "timestamp", "fields",
    ]

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        func text(_ key: String) throws -> String {
            try c.decodeIfPresent(String.self, forKey: AnyKey(key)) ?? ""
        }
        var extra: [String: JSONValue] = [:]
        for key in c.allKeys where !Self.knownKeys.contains(key.stringValue) && key.stringValue != "content" {
            extra[key.stringValue] = try c.decode(JSONValue.self, forKey: key)
        }
        self.init(
            title: try text("title"),
            description: try text("description"),
            // Kept as stored, so opening a screen changes nothing.
            color: try text("color"),
            image: try text("image"),
            thumbnail: try text("thumbnail"),
            authorName: try text("authorName"),
            authorIcon: try text("authorIcon"),
            footerText: try text("footerText"),
            footerIcon: try text("footerIcon"),
            timestamp: try c.decodeIfPresent(Bool.self, forKey: AnyKey("timestamp")) ?? false,
            fields: try c.decodeIfPresent([Field].self, forKey: AnyKey("fields")) ?? [],
            extra: extra)
    }

    public func encode(to encoder: any Encoder) throws {
        try encode(to: encoder, content: nil)
    }

    /// Writes the embed, with `content` (the text above an embed, which reminders keep on the
    /// embed's own object) alongside when it is given.
    func encode(to encoder: any Encoder, content: String?) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        for (key, value) in extra where !Self.knownKeys.contains(key) && key != "content" {
            try c.encode(value, forKey: AnyKey(key))
        }
        try c.encode("embed", forKey: AnyKey("kind"))
        try c.encode(color, forKey: AnyKey("color"))
        try c.encode(title, forKey: AnyKey("title"))
        try c.encode(image, forKey: AnyKey("image"))
        try c.encode(authorName, forKey: AnyKey("authorName"))
        try c.encode(authorIcon, forKey: AnyKey("authorIcon"))
        try c.encode(description, forKey: AnyKey("description"))
        try c.encode(thumbnail, forKey: AnyKey("thumbnail"))
        try c.encode(footerText, forKey: AnyKey("footerText"))
        try c.encode(footerIcon, forKey: AnyKey("footerIcon"))
        try c.encode(timestamp, forKey: AnyKey("timestamp"))
        try c.encode(fields.filter { !$0.name.isEmpty || !$0.value.isEmpty }, forKey: AnyKey("fields"))
        if let content {
            try c.encode(content, forKey: AnyKey("content"))
        }
    }

    public static func == (lhs: EmbedSpec, rhs: EmbedSpec) -> Bool {
        lhs.title == rhs.title && lhs.description == rhs.description && lhs.color == rhs.color
            && lhs.image == rhs.image && lhs.thumbnail == rhs.thumbnail && lhs.authorName == rhs.authorName
            && lhs.authorIcon == rhs.authorIcon && lhs.footerText == rhs.footerText
            && lhs.footerIcon == rhs.footerIcon && lhs.timestamp == rhs.timestamp && lhs.fields == rhs.fields
            && lhs.extra == rhs.extra
    }
}

/// An embed together with the plain text posted above it, the way reminders send it.
struct EmbedWithContent: Encodable {
    let embed: EmbedSpec
    let content: String

    func encode(to encoder: any Encoder) throws {
        try embed.encode(to: encoder, content: content)
    }
}
