import Foundation
import Observation

// Embed messages (src/web/routes/v2Api.js "Embed messages": `GET /guilds/:id/messages`, `GET` and
// `POST /guilds/:id/messages/:id`, `/unpublish` and `/delete`; web pages Messages.jsx and
// MessageBuilder.jsx). A composed message is a draft the dashboard keeps (a name, a channel, and a
// spec of text, embeds and button rows) that can be posted to the channel as Sylo and edited in
// place afterwards.

// MARK: - The list

/// One row of the list of embed messages.
public struct ComposedMessageSummary: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    /// The message's name; the server falls back to its first title when it has none.
    public let name: String
    /// The channel's name (its id when the channel is gone).
    public let channel: String
    public let published: Bool
    /// When it was last edited, worded by the server ("5m ago").
    public let when: String

    public init(id: Int, name: String = "", channel: String = "", published: Bool = false, when: String = "") {
        self.id = id
        self.name = name
        self.channel = channel
        self.published = published
        self.when = when
    }

    private enum CodingKeys: String, CodingKey { case id, name, channel, published, when }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            name: try c.decode(forKey: .name, or: ""),
            channel: try c.decode(forKey: .channel, or: ""),
            published: try c.decode(forKey: .published, or: false),
            when: try c.decode(forKey: .when, or: ""))
    }
}

/// `GET /guilds/:id/messages`.
public struct ComposedMessageList: Decodable, Sendable, Equatable {
    public let items: [ComposedMessageSummary]

    public init(items: [ComposedMessageSummary] = []) { self.items = items }

    private enum CodingKeys: String, CodingKey { case items }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeLossyArray(of: ComposedMessageSummary.self, forKey: .items)
    }
}

// MARK: - One message

/// Which message an endpoint means: a brand new one, or a saved one.
public enum ComposedMessageID: Hashable, Sendable {
    case new
    case saved(Int)

    /// What goes into the path (`new` or the number).
    public var pathComponent: String {
        switch self {
        case .new: "new"
        case .saved(let id): String(id)
        }
    }
}

/// A link button under the message (`style: "link"`).
public struct ComposedLinkButton: Sendable, Equatable, Identifiable {
    /// For lists only; never sent.
    public let id: UUID
    public var label: String
    /// A unicode emoji or a custom one as `<:name:id>`.
    public var emoji: String
    public var url: String
    /// Keys of the stored button that this page does not know, sent back as they came.
    public var extra: [String: JSONValue]

    public init(label: String = "", emoji: String = "", url: String = "", extra: [String: JSONValue] = [:]) {
        id = UUID()
        self.label = label
        self.emoji = emoji
        self.url = url
        self.extra = extra
    }

    public static let maxLabelLength = 80
    public static let maxEmojiLength = 64

    /// Equal when the content is (the id is only for lists).
    public static func == (lhs: ComposedLinkButton, rhs: ComposedLinkButton) -> Bool {
        lhs.label == rhs.label && lhs.emoji == rhs.emoji && lhs.url == rhs.url && lhs.extra == rhs.extra
    }

    /// Whether the server keeps this button: it needs a link and a label or an emoji.
    public var isComplete: Bool {
        !url.trimmingCharacters(in: .whitespaces).isEmpty
            && !(label.trimmingCharacters(in: .whitespaces).isEmpty && emoji.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    /// The emoji as text for a preview: a custom emoji `<:name:123>` reads `:name:`.
    public var emojiText: String {
        let trimmed = emoji.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("<"), trimmed.hasSuffix(">") else { return trimmed }
        let parts = trimmed.dropFirst().dropLast().split(separator: ":", omittingEmptySubsequences: false)
        // `<:name:id>` or `<a:name:id>`
        guard parts.count == 3 else { return trimmed }
        return ":\(parts[1]):"
    }
}

/// What a message holds: its text, embeds and link buttons, and the button rows this page does not
/// build.
///
/// A message's `rows` can also hold a role-select or role-button row, made by the Reaction roles
/// module. Everything that is not the first plain link-button row is kept as it came
/// (``keptRows``), so saving here never drops it. The editable link buttons are written back as one
/// row in the place the stored link row had (at the end for a message without one).
public struct ComposedMessageSpec: Sendable, Equatable {
    /// Text above the embeds (at most 2000 characters).
    public var content: String
    public var embeds: [EmbedItem]
    /// The link buttons, shown in one row (the first plain link-button row of the message).
    public var links: [ComposedLinkButton]
    /// Rows other than the editable link row, untouched.
    public private(set) var keptRows: [JSONValue]
    /// How many kept rows come before the link row, so it is written back where it was; nil: last.
    public private(set) var linkRowPosition: Int?
    /// Keys of the stored link row besides `type` and `buttons`, sent back as they came.
    public private(set) var linkRowExtra: [String: JSONValue]

    public static let maxContentLength = 2000
    public static let maxEmbeds = 10
    public static let maxLinks = 5
    /// A message holds at most five rows; the server cuts the rest.
    public static let maxRows = 5

    public init(content: String = "", embeds: [EmbedItem] = [], links: [ComposedLinkButton] = [],
                keptRows: [JSONValue] = [], linkRowPosition: Int? = nil,
                linkRowExtra: [String: JSONValue] = [:]) {
        self.content = content
        self.embeds = embeds
        self.links = links
        self.keptRows = keptRows
        self.linkRowPosition = linkRowPosition
        self.linkRowExtra = linkRowExtra
    }

    /// Whether another link button fits: up to five in the row, and a message that has none yet
    /// needs a row of its own.
    public var canAddLink: Bool {
        links.count < Self.maxLinks && (!links.isEmpty || keptRows.count < Self.maxRows)
    }

    /// Whether the rows kept from elsewhere leave no room for a row of link buttons.
    public var linkRowHasNoRoom: Bool { links.isEmpty && keptRows.count >= Self.maxRows }

    /// Whether the message has button rows or menus from elsewhere (reaction roles), kept as they are.
    public var hasKeptRows: Bool { !keptRows.isEmpty }

    /// Whether any link button would be sent.
    public var hasLinks: Bool { links.contains(where: \.isComplete) }

    public var canAddEmbed: Bool { embeds.count < Self.maxEmbeds }
}

extension ComposedMessageSpec: Codable {
    private enum CodingKeys: String, CodingKey { case content, embeds, rows }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rows = (try? c.decodeIfPresent([JSONValue].self, forKey: .rows)) ?? []
        var kept: [JSONValue] = []
        var links: [ComposedLinkButton] = []
        var position: Int?
        var rowExtra: [String: JSONValue] = [:]
        for row in rows {
            // The first row of only link buttons becomes the editable link buttons. Anything else stays
            // as it is: role rows and menus, a row of an unknown type, a row that mixes link buttons
            // with role buttons (its link buttons stay in it), and any further link row.
            if position == nil, case .object(let object) = row, object["type"] == .string("buttons"),
               case .array(let buttons)? = object["buttons"] {
                let all = buttons.compactMap { ComposedLinkButton(json: $0) }
                if all.count == buttons.count, !all.isEmpty {
                    links = all
                    position = kept.count
                    rowExtra = object.filter { $0.key != "type" && $0.key != "buttons" }
                    continue
                }
            }
            kept.append(row)
        }
        self.init(
            content: try c.decode(forKey: .content, or: ""),
            embeds: try c.decodeLossyArray(of: EmbedItem.self, forKey: .embeds),
            links: links, keptRows: kept, linkRowPosition: position, linkRowExtra: rowExtra)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(content, forKey: .content)
        try c.encode(embeds, forKey: .embeds)
        var rows = keptRows
        let buttons = links.filter(\.isComplete).map(\.json)
        if !buttons.isEmpty {
            var object = linkRowExtra
            object["type"] = .string("buttons")
            object["buttons"] = .array(buttons)
            rows.insert(.object(object), at: min(linkRowPosition ?? rows.count, rows.count))
        }
        try c.encode(rows, forKey: .rows)
    }
}

extension ComposedLinkButton {
    /// A stored link button, nil when it is not one (a role button, say) or when it holds something
    /// this page could not write back faithfully (a label that is not text).
    fileprivate init?(json: JSONValue) {
        guard case .object(let object) = json else { return nil }
        let style = object["style"]
        guard style == .string("link") || (style == nil && object["url"] != nil) else { return nil }
        var text: [String: String] = [:]
        for key in ["label", "emoji", "url"] {
            switch object[key] {
            case .string(let value)?: text[key] = value
            case nil, .null?: text[key] = ""
            default: return nil
            }
        }
        let known: Set<String> = ["style", "label", "emoji", "url"]
        self.init(
            label: text["label"] ?? "", emoji: text["emoji"] ?? "", url: text["url"] ?? "",
            extra: object.filter { !known.contains($0.key) })
    }

    /// The button as the web page writes it, trimmed, with the keys this page does not know.
    fileprivate var json: JSONValue {
        var object = extra
        object["style"] = .string("link")
        object["label"] = .string(label.trimmingCharacters(in: .whitespaces))
        object["emoji"] = .string(emoji.trimmingCharacters(in: .whitespaces))
        object["url"] = .string(url.trimmingCharacters(in: .whitespaces))
        return .object(object)
    }
}

/// A saved (or new) message as the server holds it.
public struct ComposedMessage: Decodable, Sendable, Equatable {
    /// nil for a message that was never saved (the server sends an empty id for `new`).
    public let id: Int?
    public let name: String
    /// "" when no channel is picked.
    public let channelId: String
    /// The posted message's id; nil while it is only a draft.
    public let messageId: String?
    public let spec: ComposedMessageSpec

    public init(id: Int? = nil, name: String = "", channelId: String = "", messageId: String? = nil,
                spec: ComposedMessageSpec = ComposedMessageSpec()) {
        self.id = id
        self.name = name
        self.channelId = channelId
        self.messageId = messageId
        self.spec = spec
    }

    public var isPublished: Bool { !(messageId ?? "").isEmpty }

    private enum CodingKeys: String, CodingKey { case id, name, channelId, messageId, spec }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // `id` is a number, or "" for a new message.
        let id = try? c.decodeIfPresent(Int.self, forKey: .id)
        let messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
        self.init(
            id: id,
            name: try c.decode(forKey: .name, or: ""),
            channelId: try c.decode(forKey: .channelId, or: ""),
            messageId: (messageId ?? "").isEmpty ? nil : messageId,
            spec: try c.decode(forKey: .spec, or: ComposedMessageSpec()))
    }
}

/// `GET /guilds/:id/messages/:id` (also `new`): the message and the channels it can be posted to.
public struct ComposedMessageDetail: Decodable, Sendable, Equatable {
    public let message: ComposedMessage
    public let channels: [ChannelOption]

    public init(message: ComposedMessage = ComposedMessage(), channels: [ChannelOption] = []) {
        self.message = message
        self.channels = channels
    }

    private enum CodingKeys: String, CodingKey { case rec, channels }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            message: try c.decode(forKey: .rec, or: ComposedMessage()),
            channels: try c.decodeLossyArray(of: ChannelOption.self, forKey: .channels))
    }
}

/// What a save did on the server.
public enum ComposedSaveStatus: Hashable, Sendable, RawRepresentable {
    /// Kept as a draft.
    case saved
    /// Posted to the channel as a new message.
    case sent
    /// The message already in the channel was edited.
    case updated
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "saved": self = .saved
        case "sent": self = .sent
        case "updated": self = .updated
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .saved: "saved"
        case .sent: "sent"
        case .updated: "updated"
        case .other(let raw): raw
        }
    }

    /// Whether the message is in the channel after this.
    public var isInChannel: Bool { self == .sent || self == .updated }
}

/// The answer to a save or publish: the stored message and what happened. The server answers a
/// failed publish with HTTP 400 and `{error, rec}` (the draft was still saved); the client throws
/// that as a ``NetworkError`` carrying the server's words. An `error` in a 2xx answer is kept too, so
/// a server that reports it that way is not read as a success.
public struct ComposedSaveResult: Decodable, Sendable, Equatable {
    public let message: ComposedMessage
    public let status: ComposedSaveStatus?
    public let error: String?

    public init(message: ComposedMessage = ComposedMessage(), status: ComposedSaveStatus? = nil, error: String? = nil) {
        self.message = message
        self.status = status
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case rec, status, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let status = try c.decodeIfPresent(String.self, forKey: .status)
        let error = try c.decodeIfPresent(String.self, forKey: .error)
        self.init(
            message: try c.decode(forKey: .rec, or: ComposedMessage()),
            status: status.map(ComposedSaveStatus.init(rawValue:)),
            error: (error ?? "").isEmpty ? nil : error)
    }
}

/// What a save is asked to do.
public enum ComposedSaveAction: String, Sendable {
    /// Keep it as a draft.
    case save
    /// Keep it and post it (or edit the posted message).
    case publish
}

extension Endpoints {
    private static func messagesPath(_ server: ServerID) -> String {
        "/api/v2/guilds/\(server.pathComponent)/messages"
    }

    /// `GET /api/v2/guilds/:id/messages`: up to 200, most recently edited first.
    public struct ListComposedMessages: APIEndpoint {
        public typealias Response = ComposedMessageList
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.messagesPath(server) }
    }

    /// `GET /api/v2/guilds/:id/messages/:id`; `new` gives an empty message and the channel list.
    public struct LoadComposedMessage: APIEndpoint {
        public typealias Response = ComposedMessageDetail
        public let server: ServerID
        public let id: ComposedMessageID
        public init(server: ServerID, id: ComposedMessageID) {
            self.server = server
            self.id = id
        }
        public var path: String { Endpoints.messagesPath(server) + "/" + id.pathComponent }
    }

    /// `POST /api/v2/guilds/:id/messages/:id` with `{name, channelId, action, spec}`. `new` makes a
    /// message; a number saves over it. With `action: publish` the server also posts it (404 when the
    /// message is gone, 400 with the server's words when posting fails).
    public struct SaveComposedMessage: APIEndpoint {
        public typealias Response = ComposedSaveResult
        public let server: ServerID
        public let id: ComposedMessageID
        public let name: String
        public let channelId: String
        public let action: ComposedSaveAction
        public let spec: ComposedMessageSpec

        public init(server: ServerID, id: ComposedMessageID, name: String, channelId: String,
                    action: ComposedSaveAction, spec: ComposedMessageSpec) {
            self.server = server
            self.id = id
            self.name = name
            self.channelId = channelId
            self.action = action
            self.spec = spec
        }

        public var path: String { Endpoints.messagesPath(server) + "/" + id.pathComponent }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(name: name, channelId: channelId, action: action.rawValue, spec: spec)
        }

        private struct Body: Encodable, Sendable {
            let name: String
            let channelId: String
            let action: String
            let spec: ComposedMessageSpec
        }
    }

    /// `POST /api/v2/guilds/:id/messages/:id/unpublish`: deletes the posted message; the draft stays.
    public struct UnpublishComposedMessage: APIEndpoint {
        public typealias Response = ComposedMessageRecord
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { Endpoints.messagesPath(server) + "/\(id)/unpublish" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/messages/:id/delete`: deletes the draft, and the posted message with it.
    public struct DeleteComposedMessage: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let id: Int
        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }
        public var path: String { Endpoints.messagesPath(server) + "/\(id)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

/// The answer to an unpublish: the message as it is now.
public struct ComposedMessageRecord: Decodable, Sendable, Equatable {
    public let message: ComposedMessage

    private enum CodingKeys: String, CodingKey { case rec }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        message = try c.decode(forKey: .rec, or: ComposedMessage())
    }
}
