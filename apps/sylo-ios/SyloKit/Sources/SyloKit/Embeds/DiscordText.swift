import Foundation

// Discord counts the length of text in UTF-16 code units, not in Swift Characters: an emoji such as
// "👍" is one Character but two units, and a family emoji can be eleven. Every Discord limit in the
// embed editor goes through these two helpers.

extension String {
    /// The length Discord counts for this text: its UTF-16 code units.
    public var discordLength: Int { utf16.count }

    /// The text cut to at most `limit` UTF-16 code units, never in the middle of a character.
    public func truncatedForDiscord(to limit: Int) -> String {
        guard utf16.count > limit else { return self }
        var used = 0
        var end = startIndex
        for index in indices {
            let next = self.index(after: index)
            let size = self[index..<next].utf16.count
            if used + size > limit { break }
            used += size
            end = next
        }
        return String(self[..<end])
    }
}
