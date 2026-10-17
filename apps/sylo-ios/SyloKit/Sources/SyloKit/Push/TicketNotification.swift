import Foundation

/// A ticket notification's deep link, read from the notification's `userInfo`:
/// `{"sylo": {"kind": "ticket", "server": "<Sylo address>", "guildId": "…", "ticketId": 12}}`.
public struct TicketNotification: Hashable, Sendable {
    /// The Sylo server that sent it.
    public let server: ServerURL
    /// The chat server the ticket belongs to.
    public let guildID: ServerID
    public let ticketID: Int

    public init(server: ServerURL, guildID: ServerID, ticketID: Int) {
        self.server = server
        self.guildID = guildID
        self.ticketID = ticketID
    }

    /// Nil for anything that is not a whole ticket notification from a valid Sylo address.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let sylo = userInfo["sylo"] as? [AnyHashable: Any],
            sylo["kind"] as? String == "ticket",
            let address = sylo["server"] as? String,
            let server = try? ServerURL(address),
            let guild = sylo["guildId"] as? String, !guild.isEmpty,
            let ticket = Self.int(sylo["ticketId"]), ticket > 0
        else { return nil }
        self.init(server: server, guildID: ServerID(guild), ticketID: ticket)
    }

    /// Whether it came from `server`, the Sylo server the app is signed in to.
    public func matches(_ server: ServerURL) -> Bool { self.server == server }

    /// A whole number, from JSON (a number object) or spelled as a string.
    private static func int(_ value: Any?) -> Int? {
        switch value {
        case let value as Int: value
        case let value as String: Int(value)
        default: nil
        }
    }
}
