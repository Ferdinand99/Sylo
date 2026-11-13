import Foundation

/// One embed in a list of embeds (a composed message, the Welcome Channel message): an
/// ``EmbedDraft`` with an id for the list. Decoded from a stored embed object and encoded the way
/// the web embed editor serialises one (``EmbedDraft/spec(_:)`` with the default options), so a
/// stored `banner` stays a banner and keys this app does not know come back unchanged.
public struct EmbedItem: Codable, Sendable, Equatable, Identifiable {
    /// For lists only; never sent.
    public let id: UUID
    public var draft: EmbedDraft

    public init(_ draft: EmbedDraft = EmbedDraft()) {
        id = UUID()
        self.draft = draft
    }

    /// The options of every embed list: the web editor's defaults (no message text, no timestamp,
    /// the footer under `footerText`).
    public static let options = EmbedOptions()

    /// Equal when the embeds are (the id is only for lists), so "unchanged" holds after a reload.
    public static func == (lhs: EmbedItem, rhs: EmbedItem) -> Bool { lhs.draft == rhs.draft }

    /// A banner is an embed that is only a big picture with a caption (`kind: "banner"`).
    public var isBanner: Bool {
        get { draft.kind == "banner" }
        set { draft.kind = newValue ? "banner" : "embed" }
    }

    public init(from decoder: any Decoder) throws {
        id = UUID()
        draft = try EmbedDraft(from: decoder)
    }

    public func encode(to encoder: any Encoder) throws {
        try draft.spec(Self.options).encode(to: encoder)
    }

    /// A copy with its own id and its own field ids.
    public func duplicated() -> EmbedItem {
        var copy = draft
        copy.fields = copy.fields.map { EmbedDraft.Field(name: $0.name, value: $0.value, inline: $0.inline) }
        return EmbedItem(copy)
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
