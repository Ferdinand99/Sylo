import Foundation

/// One embed in a list of embeds (a composed message, the Welcome Channel message): an
/// ``EmbedDraft`` with an id for the list. Decoded from a stored embed object and encoded the way
/// the web embed editor serialises one (``EmbedDraft/spec(_:)``), so a stored `banner` stays a
/// banner, a stored `timestamp: true` stays on, and keys this app does not know come back unchanged.
///
/// An embed the editor cannot read faithfully (a number where text belongs, a field of the wrong
/// shape, something that is not an object) is not dropped: it is kept as the raw JSON it came as
/// (``isOpaque``), shown as unsupported, and sent back unchanged.
public struct EmbedItem: Codable, Sendable, Equatable, Identifiable {
    /// For lists only; never sent.
    public let id: UUID
    public var draft: EmbedDraft
    /// The stored value as it came, for an embed the editor cannot read faithfully; nil otherwise.
    public private(set) var raw: JSONValue?

    public init(_ draft: EmbedDraft = EmbedDraft()) {
        id = UUID()
        self.draft = draft
        raw = nil
    }

    /// An embed kept as the raw value it was stored as.
    public init(raw: JSONValue) {
        id = UUID()
        draft = EmbedDraft()
        self.raw = raw
    }

    /// What the editors of an embed list offer: the web editor's defaults and the switch that shows
    /// the current time in the footer.
    public static let options = EmbedOptions(timestamp: true)

    /// Equal when the embeds are (the id is only for lists), so "unchanged" holds after a reload.
    public static func == (lhs: EmbedItem, rhs: EmbedItem) -> Bool {
        lhs.draft == rhs.draft && lhs.raw == rhs.raw
    }

    /// A banner is an embed that is only a big picture with a caption (`kind: "banner"`).
    public var isBanner: Bool {
        get { raw == nil && draft.kind == "banner" }
        set { draft.kind = newValue ? "banner" : "embed" }
    }

    /// Whether the embed is kept as raw JSON because the editor cannot read it faithfully.
    public var isOpaque: Bool { raw != nil }

    public init(from decoder: any Decoder) throws {
        id = UUID()
        let stored = try JSONValue(from: decoder)
        if let draft = try? EmbedDraft(from: decoder), Self.reads(stored, as: draft) {
            self.draft = draft
            raw = nil
        } else {
            draft = EmbedDraft()
            raw = stored
        }
    }

    /// Whether the draft holds everything the stored object had: no field that could not be read was
    /// left out of the list.
    private static func reads(_ stored: JSONValue, as draft: EmbedDraft) -> Bool {
        guard case .object(let object) = stored else { return false }
        switch object["fields"] {
        case .array(let fields)?: return fields.count == draft.fields.count
        case nil, .null?: return true
        default: return false
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if let raw {
            try raw.encode(to: encoder)
            return
        }
        try draft.specKeepingTimestamp().encode(to: encoder)
    }

    /// A copy with its own id and its own field ids.
    public func duplicated() -> EmbedItem {
        if let raw { return EmbedItem(raw: raw) }
        var copy = draft
        copy.fields = copy.fields.map { EmbedDraft.Field(name: $0.name, value: $0.value, inline: $0.inline) }
        return EmbedItem(copy)
    }
}

extension EmbedDraft {
    /// The embed as an editor of a stored embed sends it: the web editor's keys, plus `timestamp`
    /// when it is on, so a stored time in the footer is not lost on save.
    public func specKeepingTimestamp() -> EmbedSpec {
        var sent = EmbedOptions()
        sent.timestamp = timestamp
        return spec(sent)
    }
}

extension Array where Element == EmbedItem {
    /// Moves the embed at `index` up (`-1`) or down (`+1`); does nothing at an end of the list.
    public mutating func moveEmbed(at index: Int, by offset: Int) {
        let target = index + offset
        guard indices.contains(index), indices.contains(target) else { return }
        swapAt(index, target)
    }

    /// Puts a copy of the embed at `index` right after it, unless the list already holds `limit`.
    /// - Returns: Whether a copy was added.
    @discardableResult
    public mutating func duplicateEmbed(at index: Int, limit: Int) -> Bool {
        guard indices.contains(index), count < limit else { return false }
        insert(self[index].duplicated(), at: index + 1)
        return true
    }
}
