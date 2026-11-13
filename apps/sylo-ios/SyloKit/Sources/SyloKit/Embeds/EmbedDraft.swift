import Foundation

// One embed being edited, the model behind the shared embed editor. It mirrors the state and the
// `serialize` step of web-v2/src/components/EmbedEditor.jsx: the editor works on an
// ``EmbedDraft``, and ``EmbedDraft/spec(_:)`` gives the server-ready object that the module's
// normaliser (`normaliseEmbedSpec` in src/modules/welcomeChannel.js and the like) expects.

/// Which parts of an embed an editor offers, and how the module names its footer. The same
/// switches as the web editor's props; the defaults are the web defaults.
public struct EmbedOptions: Sendable, Equatable {
    /// The key a module stores the footer text under.
    public enum FooterKey: String, Sendable, Equatable {
        case footerText
        case footer
    }

    /// A plain message text above the embed (`content`).
    public var content: Bool
    /// The author name and icon.
    public var author: Bool
    public var description: Bool
    /// Extra name/value fields.
    public var fields: Bool
    public var thumbnail: Bool
    public var footerIcon: Bool
    /// The "show the current time in the footer" switch.
    public var timestamp: Bool
    public var footerKey: FooterKey
    /// The colour used while none is set, `#rrggbb`.
    public var defaultColor: String

    public static let defaultColorHex = "#5865f2"

    public init(
        content: Bool = false, author: Bool = true, description: Bool = true, fields: Bool = true,
        thumbnail: Bool = true, footerIcon: Bool = true, timestamp: Bool = false,
        footerKey: FooterKey = .footerText, defaultColor: String = EmbedOptions.defaultColorHex
    ) {
        self.content = content
        self.author = author
        self.description = description
        self.fields = fields
        self.thumbnail = thumbnail
        self.footerIcon = footerIcon
        self.timestamp = timestamp
        self.footerKey = footerKey
        self.defaultColor = defaultColor
    }
}

/// An embed as the editor holds it. Every part is kept even when the options hide it, so switching
/// an option never loses text; ``spec(_:)`` sends only what the options ask for.
public struct EmbedDraft: Sendable, Equatable {
    /// Message text above the embed; sent only with ``EmbedOptions/content``.
    public var content: String
    /// `#rrggbb`. An empty or unreadable value reads as the options' default colour.
    public var color: String
    public var authorName: String
    public var authorIcon: String
    public var title: String
    public var description: String
    public var image: String
    public var thumbnail: String
    /// The footer text, whichever key the module stores it under.
    public var footerText: String
    public var footerIcon: String
    public var timestamp: Bool
    public var fields: [Field]

    /// One name/value field. A field with neither is not sent.
    public struct Field: Sendable, Equatable, Identifiable {
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

        // Equal when the content is (the id is only for lists), so "unchanged" holds after a round trip.
        public static func == (lhs: Field, rhs: Field) -> Bool {
            lhs.name == rhs.name && lhs.value == rhs.value && lhs.inline == rhs.inline
        }
    }

    public init(
        content: String = "", color: String = "", authorName: String = "", authorIcon: String = "",
        title: String = "", description: String = "", image: String = "", thumbnail: String = "",
        footerText: String = "", footerIcon: String = "", timestamp: Bool = false, fields: [Field] = []
    ) {
        self.content = content
        self.color = color
        self.authorName = authorName
        self.authorIcon = authorIcon
        self.title = title
        self.description = description
        self.image = image
        self.thumbnail = thumbnail
        self.footerText = footerText
        self.footerIcon = footerIcon
        self.timestamp = timestamp
        self.fields = fields
    }

    /// Whether the embed has nothing in it that would be sent (ignoring the colour).
    public func isEmpty(_ options: EmbedOptions = EmbedOptions()) -> Bool {
        var texts = [title, image, footerText]
        if options.content { texts.append(content) }
        if options.author { texts.append(contentsOf: [authorName, authorIcon]) }
        if options.description { texts.append(description) }
        if options.thumbnail { texts.append(thumbnail) }
        if options.footerIcon { texts.append(footerIcon) }
        let hasField = options.fields && fields.contains { !$0.name.isEmpty || !$0.value.isEmpty }
        return !hasField && texts.allSatisfy(\.isEmpty)
    }

    // MARK: - Colour

    /// The colour to show and send: this one when it is `#rrggbb`, else the options' default.
    public func resolvedColor(_ options: EmbedOptions = EmbedOptions()) -> String {
        if Self.hexValue(color) != nil { return color }
        return Self.hexValue(options.defaultColor) != nil ? options.defaultColor : EmbedOptions.defaultColorHex
    }

    /// The colour as 0...1 sRGB components, for a colour picker.
    public func rgb(_ options: EmbedOptions = EmbedOptions()) -> (red: Double, green: Double, blue: Double) {
        let value = Self.hexValue(resolvedColor(options)) ?? 0
        return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
    }

    /// Sets the colour from 0...1 sRGB components (clamped: wide-gamut colours can go past them).
    public mutating func setRGB(red: Double, green: Double, blue: Double) {
        func hexByte(_ component: Double) -> String {
            let text = String(Int((Swift.min(Swift.max(component, 0), 1) * 255).rounded()), radix: 16)
            return text.count == 1 ? "0" + text : text
        }
        color = "#" + hexByte(red) + hexByte(green) + hexByte(blue)
    }

    private static func hexValue(_ color: String) -> Int? {
        guard color.hasPrefix("#") else { return nil }
        let hex = color.dropFirst()
        guard hex.count == 6, hex.allSatisfy(\.isHexDigit) else { return nil }
        return Int(hex, radix: 16)
    }

    // MARK: - Server shape

    /// The server-ready embed, exactly what `EmbedEditor.jsx` emits for the same options: `kind`,
    /// `color`, `title` and `image` always; the rest only when its option is on; fields without a
    /// name and a value both empty dropped. The footer goes under ``EmbedOptions/footerKey``.
    public func spec(_ options: EmbedOptions = EmbedOptions()) -> EmbedSpec {
        EmbedSpec(draft: self, options: options)
    }
}

extension EmbedDraft: Decodable {
    private enum CodingKeys: String, CodingKey {
        case content, color, authorName, authorIcon, title, description, image, thumbnail
        case footerText, footer, footerIcon, timestamp, fields
    }

    /// Reads a stored embed (a spec from the server). Anything missing or of the wrong type is
    /// empty, and `footer` is read when there is no `footerText`, like the web editor does.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let footerText = try c.decode(forKey: .footerText, or: "")
        let footer = try c.decode(forKey: .footer, or: "")
        self.init(
            content: try c.decode(forKey: .content, or: ""),
            color: try c.decode(forKey: .color, or: ""),
            authorName: try c.decode(forKey: .authorName, or: ""),
            authorIcon: try c.decode(forKey: .authorIcon, or: ""),
            title: try c.decode(forKey: .title, or: ""),
            description: try c.decode(forKey: .description, or: ""),
            image: try c.decode(forKey: .image, or: ""),
            thumbnail: try c.decode(forKey: .thumbnail, or: ""),
            footerText: footerText.isEmpty ? footer : footerText,
            footerIcon: try c.decode(forKey: .footerIcon, or: ""),
            timestamp: try c.decode(forKey: .timestamp, or: false),
            fields: try c.decodeLossyArray(of: Field.self, forKey: .fields))
    }
}

extension EmbedDraft.Field: Decodable {
    private enum CodingKeys: String, CodingKey { case name, value, inline }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(forKey: .name, or: ""),
            value: try c.decode(forKey: .value, or: ""),
            inline: try c.decode(forKey: .inline, or: false))
    }
}

/// An embed in the shape the server stores and posts (see ``EmbedDraft/spec(_:)``). Encode it into a
/// module's settings or a message spec.
public struct EmbedSpec: Encodable, Sendable, Equatable {
    let draft: EmbedDraft
    let options: EmbedOptions

    /// The key names of the embed object, in the order the web editor writes them.
    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(_ string: String) { stringValue = string }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    private struct FieldSpec: Encodable {
        let name: String
        let value: String
        let inline: Bool
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode("embed", forKey: Key("kind"))
        try c.encode(draft.resolvedColor(options), forKey: Key("color"))
        try c.encode(draft.title, forKey: Key("title"))
        try c.encode(draft.image, forKey: Key("image"))
        if options.content { try c.encode(draft.content, forKey: Key("content")) }
        if options.author {
            try c.encode(draft.authorName, forKey: Key("authorName"))
            try c.encode(draft.authorIcon, forKey: Key("authorIcon"))
        }
        if options.description { try c.encode(draft.description, forKey: Key("description")) }
        if options.thumbnail { try c.encode(draft.thumbnail, forKey: Key("thumbnail")) }
        try c.encode(draft.footerText, forKey: Key(options.footerKey.rawValue))
        if options.footerIcon { try c.encode(draft.footerIcon, forKey: Key("footerIcon")) }
        if options.timestamp { try c.encode(draft.timestamp, forKey: Key("timestamp")) }
        if options.fields {
            let sent = draft.fields
                .filter { !$0.name.isEmpty || !$0.value.isEmpty }
                .map { FieldSpec(name: $0.name, value: $0.value, inline: $0.inline) }
            try c.encode(sent, forKey: Key("fields"))
        }
    }
}
