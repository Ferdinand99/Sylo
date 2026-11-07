import Foundation

/// What a notification says, from `GET /api/mobile/push/events/:ref` (``Endpoints/PushEvent``).
/// Plain text; the server never sends its own address (the app knows it).
public struct PushEventContent: Decodable, Sendable, Equatable {
    public let title: String
    public let subtitle: String?
    public let body: String
    /// Notifications with the same thread id group together.
    public let threadId: String?
    /// Where a tap goes; nil for a kind this version doesn't know or data that is incomplete.
    public let link: NotificationLink?

    public init(
        title: String, subtitle: String? = nil, body: String, threadId: String? = nil, link: NotificationLink? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.threadId = threadId
        self.link = link
    }

    private enum CodingKeys: String, CodingKey { case title, subtitle, body, threadId, kind, data }

    /// `data`: `{kind: "ticket", guildId, ticketId}` or `{kind: "devlog", level}`.
    private struct LinkData: Decodable {
        let kind: String?
        let guildId: String?
        let ticketId: Int?
        let level: String?

        private enum CodingKeys: String, CodingKey { case kind, guildId, ticketId, level }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try? c.decodeIfPresent(String.self, forKey: .kind)
            guildId = try? c.decodeIfPresent(String.self, forKey: .guildId)
            level = try? c.decodeIfPresent(String.self, forKey: .level)
            // A whole number, or spelled as a string.
            if let number = try? c.decodeIfPresent(Int.self, forKey: .ticketId) {
                ticketId = number
            } else if let text = try? c.decodeIfPresent(String.self, forKey: .ticketId) {
                ticketId = Int(text)
            } else {
                ticketId = nil
            }
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        subtitle = try? c.decodeIfPresent(String.self, forKey: .subtitle)
        body = (try? c.decodeIfPresent(String.self, forKey: .body)) ?? ""
        threadId = try? c.decodeIfPresent(String.self, forKey: .threadId)
        let linkData: LinkData? = try? c.decodeIfPresent(LinkData.self, forKey: .data)
        let topLevelKind: String? = try? c.decodeIfPresent(String.self, forKey: .kind)
        switch (linkData?.kind ?? topLevelKind) ?? "" {
        case "ticket":
            if let guild = linkData?.guildId, !guild.isEmpty, let ticket = linkData?.ticketId, ticket > 0 {
                link = .ticket(guildID: ServerID(guild), ticketID: ticket)
            } else {
                link = nil
            }
        case "devlog":
            link = .devLog(linkData?.level.flatMap(DevLogLevel.init(rawValue:)) ?? .error)
        default:
            link = nil
        }
    }
}

/// Where a tapped notification goes, as the app's notification handling reads it from
/// `userInfo["sylo"]` (``TicketNotification``, ``DevLogNotification``).
public enum NotificationLink: Equatable, Sendable {
    case ticket(guildID: ServerID, ticketID: Int)
    case devLog(DevLogLevel)

    /// The `sylo` entry of the notification's `userInfo`. `server` comes from the app's own
    /// record of which server the notification belongs to, never from the push.
    public func userInfo(server: ServerURL) -> [String: Any] {
        switch self {
        case .ticket(let guild, let ticket):
            ["kind": "ticket", "server": server.description, "guildId": guild.rawValue, "ticketId": ticket]
        case .devLog(let level):
            ["kind": "devlog", "server": server.description, "level": level.rawValue]
        }
    }
}
