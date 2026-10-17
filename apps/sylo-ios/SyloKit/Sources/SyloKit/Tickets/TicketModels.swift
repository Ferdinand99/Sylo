import Foundation

// The ticket inbox, from `/api/v2/guilds/:id/tickets` (src/web/routes/v2Staff.js). A ticket is a
// DM conversation between a member and the server's staff, relayed by Sylo. The epoch-ms times
// (`lastAt`, `openedAt`, `at`) are newer than the rest; an older server leaves them out, so they
// are optional and the server's own "5m ago" text is always there to fall back on.

/// Who wrote a ticket message: the member, the server's staff, or Sylo itself.
public enum TicketAuthorKind: Hashable, Sendable, RawRepresentable, Codable {
    case user
    case staff
    case system
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "user": self = .user
        case "staff": self = .staff
        case "system": self = .system
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .user: "user"
        case .staff: "staff"
        case .system: "system"
        case .other(let raw): raw
        }
    }
}

/// Whether a ticket still takes replies.
public enum TicketStatus: Hashable, Sendable, RawRepresentable, Codable {
    case open
    case closed
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "open": self = .open
        case "closed": self = .closed
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .open: "open"
        case .closed: "closed"
        case .other(let raw): raw
        }
    }
}

/// One row of the inbox (`GET /tickets`).
public struct TicketSummary: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    /// The member's tag, or their id when Sylo could not look it up.
    public let user: String
    public let userId: String
    /// The start of the last message, empty when there is none.
    public let preview: String
    /// Who wrote the last message; nil when there is none.
    public let previewKind: TicketAuthorKind?
    /// When the last message came; nil from an older server.
    public let lastAt: Date?
    /// The server's "5m ago" for the last message.
    public let ago: String
    /// Open, with something new since staff last looked.
    public let isUnread: Bool

    public init(
        id: Int, user: String, userId: String, preview: String = "", previewKind: TicketAuthorKind? = nil,
        lastAt: Date? = nil, ago: String = "", isUnread: Bool = false
    ) {
        self.id = id
        self.user = user
        self.userId = userId
        self.preview = preview
        self.previewKind = previewKind
        self.lastAt = lastAt
        self.ago = ago
        self.isUnread = isUnread
    }

    private enum CodingKeys: String, CodingKey { case id, user, userId, preview, previewKind, lastAt, ago, unread }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        userId = try c.decodeIfPresent(String.self, forKey: .userId) ?? ""
        user = try c.decodeIfPresent(String.self, forKey: .user) ?? userId
        preview = try c.decodeIfPresent(String.self, forKey: .preview) ?? ""
        previewKind = try c.decodeIfPresent(TicketAuthorKind.self, forKey: .previewKind)
        lastAt = try c.decodeEpochMillisecondsIfPresent(forKey: .lastAt)
        ago = try c.decodeIfPresent(String.self, forKey: .ago) ?? ""
        isUnread = try c.decodeIfPresent(Bool.self, forKey: .unread) ?? false
    }
}

/// The inbox: the open tickets (up to 100) and the latest closed ones (up to 25), newest first.
public struct TicketList: Decodable, Sendable, Equatable {
    public let open: [TicketSummary]
    public let closed: [TicketSummary]

    public init(open: [TicketSummary], closed: [TicketSummary] = []) {
        self.open = open
        self.closed = closed
    }

    private enum CodingKeys: String, CodingKey { case open, closed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        open = try c.decodeLossyArray(of: TicketSummary.self, forKey: .open)
        closed = try c.decodeLossyArray(of: TicketSummary.self, forKey: .closed)
    }
}

/// The ticket at the top of a thread.
public struct TicketInfo: Decodable, Sendable, Equatable {
    public let id: Int
    public let status: TicketStatus
    public let user: String
    public let userId: String
    /// When the member opened it; nil from an older server.
    public let openedAt: Date?
    public let openedAgo: String

    public init(id: Int, status: TicketStatus, user: String, userId: String, openedAt: Date? = nil, openedAgo: String = "") {
        self.id = id
        self.status = status
        self.user = user
        self.userId = userId
        self.openedAt = openedAt
        self.openedAgo = openedAgo
    }

    private enum CodingKeys: String, CodingKey { case id, status, user, userId, openedAt, openedAgo }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        status = try c.decode(TicketStatus.self, forKey: .status)
        userId = try c.decodeIfPresent(String.self, forKey: .userId) ?? ""
        user = try c.decodeIfPresent(String.self, forKey: .user) ?? userId
        openedAt = try c.decodeEpochMillisecondsIfPresent(forKey: .openedAt)
        openedAgo = try c.decodeIfPresent(String.self, forKey: .openedAgo) ?? ""
    }

    /// This ticket with another status.
    func with(status: TicketStatus) -> TicketInfo {
        TicketInfo(id: id, status: status, user: user, userId: userId, openedAt: openedAt, openedAgo: openedAgo)
    }
}

/// One message in a ticket.
public struct TicketMessage: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let kind: TicketAuthorKind
    /// The member's tag, "Staff" or "System". In ``TicketUpdate`` the member is just "User".
    public let who: String
    public let content: String
    /// Files the member sent along (Discord or Fluxer CDN links).
    public let attachments: [URL]
    /// For a staff reply: whether Sylo got it to the member as a DM. True for everything else.
    public let isDelivered: Bool
    /// When it was written; nil from an older server.
    public let at: Date?
    public let ago: String

    public init(
        id: Int, kind: TicketAuthorKind, who: String, content: String, attachments: [URL] = [],
        isDelivered: Bool = true, at: Date? = nil, ago: String = ""
    ) {
        self.id = id
        self.kind = kind
        self.who = who
        self.content = content
        self.attachments = attachments
        self.isDelivered = isDelivered
        self.at = at
        self.ago = ago
    }

    private enum CodingKeys: String, CodingKey { case id, kind, who, content, attachments, delivered, at, ago }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        kind = try c.decode(TicketAuthorKind.self, forKey: .kind)
        who = try c.decodeIfPresent(String.self, forKey: .who) ?? ""
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        // Stored as free JSON on the server: keep the strings that are links, drop anything else.
        attachments = try c.decodeLossyArray(of: String.self, forKey: .attachments)
            .compactMap { $0.isEmpty ? nil : URL(string: $0) }
        isDelivered = try c.decodeIfPresent(Bool.self, forKey: .delivered) ?? true
        at = try c.decodeEpochMillisecondsIfPresent(forKey: .at)
        ago = try c.decodeIfPresent(String.self, forKey: .ago) ?? ""
    }
}

/// A ticket with all its messages (`GET /tickets/:id`). Opening it marks it seen by staff.
public struct TicketThread: Decodable, Sendable, Equatable {
    public let ticket: TicketInfo
    public let messages: [TicketMessage]
    /// The last message's id (0 when there are none), for asking what came after it.
    public let lastId: Int

    public init(ticket: TicketInfo, messages: [TicketMessage], lastId: Int? = nil) {
        self.ticket = ticket
        self.messages = messages
        self.lastId = lastId ?? messages.last?.id ?? 0
    }

    private enum CodingKeys: String, CodingKey { case ticket, messages, lastId }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ticket = try c.decode(TicketInfo.self, forKey: .ticket)
        messages = try c.decodeLossyArray(of: TicketMessage.self, forKey: .messages)
        lastId = try c.decodeIfPresent(Int.self, forKey: .lastId) ?? messages.last?.id ?? 0
    }
}

/// What changed since a message (`GET /tickets/:id/messages?after=`): the status and newer messages.
public struct TicketUpdate: Decodable, Sendable, Equatable {
    public let status: TicketStatus
    public let messages: [TicketMessage]

    public init(status: TicketStatus, messages: [TicketMessage]) {
        self.status = status
        self.messages = messages
    }

    private enum CodingKeys: String, CodingKey { case status, messages }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(TicketStatus.self, forKey: .status)
        messages = try c.decodeLossyArray(of: TicketMessage.self, forKey: .messages)
    }
}

/// The answer to a staff reply. The reply is stored either way; `isDelivered` is false when Sylo
/// could not DM it to the member (DMs closed, member left).
public struct TicketReplyResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let isDelivered: Bool

    public init(ok: Bool = true, isDelivered: Bool) {
        self.ok = ok
        self.isDelivered = isDelivered
    }

    private enum CodingKeys: String, CodingKey { case ok, delivered }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        isDelivered = try c.decodeIfPresent(Bool.self, forKey: .delivered) ?? true
    }
}
