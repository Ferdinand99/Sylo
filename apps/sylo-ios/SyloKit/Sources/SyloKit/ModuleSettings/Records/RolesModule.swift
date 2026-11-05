import Foundation

// Reaction roles & autoroles (src/modules/roles.js and the routes in src/web/routes/v2Api.js under
// /modules/roles; web form web-v2/src/moduleForms/Roles.jsx). Reaction-role sets are records, each
// published as a message in a channel; the autoroles are one list of roles given on join.

/// How members pick a role from a set.
public enum ReactionRoleStyle: String, Sendable, CaseIterable, Codable {
    /// Members react with an emoji.
    case reaction
    /// Members click a button.
    case buttons
    /// Members pick from a menu.
    case select

    public init(from decoder: any Decoder) throws {
        self = ReactionRoleStyle(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .reaction
    }

    /// The most roles a set of this style can hold (Discord's own caps).
    public var maxRoles: Int {
        switch self {
        case .reaction: 20
        case .buttons, .select: 25
        }
    }
}

/// What the interaction does with the role.
public enum ReactionRoleMode: String, Sendable, CaseIterable, Codable {
    /// The interaction adds the role; undoing it takes it away.
    case standard = "default"
    /// The interaction removes the role (opt-out); undoing it gives it back.
    case reverse

    public init(from decoder: any Decoder) throws {
        self = ReactionRoleMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .standard
    }
}

/// The colour of a role button.
public enum RoleButtonStyle: String, Sendable, CaseIterable, Codable {
    case secondary, primary, success, danger

    public init(from decoder: any Decoder) throws {
        self = RoleButtonStyle(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .secondary
    }
}

/// `GET /api/v2/guilds/:id/modules/roles/list`.
public struct RolesPage: Decodable, Sendable, Equatable {
    public static let moduleID: ModuleID = "roles"

    public let sets: [ReactionRoleSet]
    /// Roles given to every new member.
    public let autoroles: [String]
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(
        sets: [ReactionRoleSet] = [], autoroles: [String] = [], channels: [ChannelOption] = [],
        roles: [RoleOption] = []
    ) {
        self.sets = sets
        self.autoroles = autoroles
        self.channels = channels
        self.roles = roles
    }

    /// The most reaction-role sets a server can have.
    public static let maxSets = 50
    /// The most autoroles.
    public static let maxAutoroles = 100

    private enum CodingKeys: String, CodingKey { case reactionMessages, autoroles, channels, roles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sets = try c.decodeLossyArray(of: ReactionRoleSet.self, forKey: .reactionMessages)
        autoroles = try c.decode(forKey: .autoroles, or: [])
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

/// One reaction-role message: where it is, how members pick, and which roles they can pick.
public struct ReactionRoleSet: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let channelId: String
    /// The posted message's id; "" while it was never posted.
    public let messageId: String
    public let style: ReactionRoleStyle
    public let message: String
    public let embed: EmbedSpec
    public let exclusive: Bool
    public let mode: ReactionRoleMode
    public let placeholder: String
    public let selMin: Int
    public let selMax: Int
    public let pairs: [Pair]

    public struct Pair: Decodable, Sendable, Equatable {
        /// The emoji as written (`🎮`, or `<:name:id>` for a custom one).
        public let display: String
        public let roleId: String
        public let label: String
        public let buttonStyle: RoleButtonStyle

        public init(display: String = "", roleId: String = "", label: String = "", buttonStyle: RoleButtonStyle = .secondary) {
            self.display = display
            self.roleId = roleId
            self.label = label
            self.buttonStyle = buttonStyle
        }

        private enum CodingKeys: String, CodingKey { case display, roleId, label, btnStyle }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            display = try c.decode(forKey: .display, or: "")
            roleId = try c.decode(forKey: .roleId, or: "")
            label = try c.decode(forKey: .label, or: "")
            buttonStyle = try c.decode(forKey: .btnStyle, or: .secondary)
        }
    }

    public init(
        id: String, channelId: String, messageId: String = "", style: ReactionRoleStyle = .reaction,
        message: String = "", embed: EmbedSpec = EmbedSpec(), exclusive: Bool = false,
        mode: ReactionRoleMode = .standard, placeholder: String = "", selMin: Int = 0, selMax: Int = 0,
        pairs: [Pair] = []
    ) {
        self.id = id
        self.channelId = channelId
        self.messageId = messageId
        self.style = style
        self.message = message
        self.embed = embed
        self.exclusive = exclusive
        self.mode = mode
        self.placeholder = placeholder
        self.selMin = selMin
        self.selMax = selMax
        self.pairs = pairs
    }

    private enum CodingKeys: String, CodingKey {
        case id, channelId, messageId, style, message, embed, exclusive, mode, placeholder, selMin, selMax, pairs
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let text = try? c.decodeIfPresent(String.self, forKey: .id) {
            id = text
        } else if let number = try? c.decodeIfPresent(Int.self, forKey: .id) {
            id = String(number)
        } else {
            id = ""
        }
        channelId = try c.decode(forKey: .channelId, or: "")
        messageId = try c.decode(forKey: .messageId, or: "")
        style = try c.decode(forKey: .style, or: .reaction)
        message = try c.decode(forKey: .message, or: "")
        embed = try c.decode(forKey: .embed, or: EmbedSpec(color: ""))
        exclusive = try c.decode(forKey: .exclusive, or: false)
        mode = try c.decode(forKey: .mode, or: .standard)
        placeholder = try c.decode(forKey: .placeholder, or: "")
        selMin = try c.decode(forKey: .selMin, or: 0)
        selMax = try c.decode(forKey: .selMax, or: 0)
        pairs = try c.decodeLossyArray(of: Pair.self, forKey: .pairs)
    }

    public var isPublished: Bool { !messageId.isEmpty }

    /// A name for the set in a list: the embed's title, else the start of the text.
    public var title: String {
        if !embed.title.isEmpty { return embed.title }
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "Reaction role" : String(text.prefix(60))
    }
}

/// A reaction-role set while it is edited, and the body that saves it.
public struct ReactionRoleDraft: Sendable, Equatable, Identifiable {
    public let localID = LocalID()
    /// The set's id; "" for a new set.
    public var setID: String
    public var channelId: String
    public var style: ReactionRoleStyle
    /// Text above the embed.
    public var message: String
    public var embed: EmbedSpec
    public var exclusive: Bool
    public var mode: ReactionRoleMode
    /// The menu's placeholder (menu style).
    public var placeholder: String
    /// Fewest and most roles a member can pick from the menu; 0 for the most means no limit.
    public var selMin: Int
    public var selMax: Int
    public var rows: [Row]

    public var id: UUID { localID.value }

    public struct Row: Sendable, Equatable, Identifiable {
        public let localID = LocalID()
        public var emoji: String
        public var label: String
        public var roleId: String
        public var buttonStyle: RoleButtonStyle

        public var id: UUID { localID.value }

        public init(emoji: String = "", label: String = "", roleId: String = "", buttonStyle: RoleButtonStyle = .secondary) {
            self.emoji = emoji
            self.label = label
            self.roleId = roleId
            self.buttonStyle = buttonStyle
        }

        public static let maxLabelLength = 80
    }

    public static let maxMessageLength = 2000
    public static let maxPlaceholderLength = 150
    public static let pickRange = 0...25

    /// A new set: one empty row, as the web form starts.
    public init() {
        setID = ""
        channelId = ""
        style = .reaction
        message = ""
        embed = EmbedSpec()
        exclusive = false
        mode = .standard
        placeholder = ""
        selMin = 0
        selMax = 0
        rows = [Row()]
    }

    public init(set: ReactionRoleSet) {
        setID = set.id
        channelId = set.channelId
        style = set.style
        message = set.message
        embed = set.embed.withDefaultColor()
        exclusive = set.exclusive
        mode = set.mode
        placeholder = set.placeholder
        selMin = set.selMin
        selMax = set.selMax
        rows = set.pairs.isEmpty
            ? [Row()]
            : set.pairs.map {
                Row(emoji: $0.display, label: $0.label, roleId: $0.roleId, buttonStyle: $0.buttonStyle)
            }
    }

    /// Why the set cannot be published yet, in words for the person; nil when it can.
    public var problem: String? {
        if channelId.isEmpty { return "Choose a channel." }
        let filled = rows.filter { !$0.roleId.isEmpty || !$0.emoji.isEmpty || !$0.label.isEmpty }
        if filled.isEmpty { return "Add at least one role." }
        if filled.count > style.maxRoles {
            let extra = filled.count - style.maxRoles
            let other = style == .reaction ? " or switch to Buttons" : ""
            return "This style holds at most \(style.maxRoles) roles. Remove \(extra) row\(extra == 1 ? "" : "s")\(other)."
        }
        if filled.contains(where: { $0.roleId.isEmpty }) { return "Every row needs a role." }
        if style == .reaction, filled.contains(where: { $0.emoji.trimmingCharacters(in: .whitespaces).isEmpty }) {
            return "The Reactions style needs an emoji on every row."
        }
        return nil
    }

    /// The body of `POST /api/v2/guilds/:id/modules/roles/rr`.
    struct Body: Encodable, Sendable {
        let id: String
        let channelId: String
        let style: ReactionRoleStyle
        let message: String
        let embed: EmbedSpec
        let exclusive: Bool
        let mode: ReactionRoleMode
        let placeholder: String
        let selMin: Int
        let selMax: Int
        let pairs: [Pair]

        struct Pair: Encodable, Sendable {
            let emoji: String
            let label: String
            let roleId: String
            let btnStyle: RoleButtonStyle
        }
    }

    var body: Body {
        Body(
            id: setID, channelId: channelId, style: style, message: message, embed: embed, exclusive: exclusive,
            mode: mode, placeholder: placeholder, selMin: selMin, selMax: selMax,
            pairs: rows.map { Body.Pair(emoji: $0.emoji, label: $0.label, roleId: $0.roleId, btnStyle: $0.buttonStyle) })
    }
}

/// The answer to saving a set: the stored set, and why it could not be posted when it saved but
/// the post failed (a missing permission).
public struct SavedReactionRoleSet: Decodable, Sendable, Equatable {
    public let set: ReactionRoleSet
    public let publishError: String?

    private enum CodingKeys: String, CodingKey { case reactionMessage, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        set = try c.decode(ReactionRoleSet.self, forKey: .reactionMessage)
        let error = try c.decodeIfPresent(String.self, forKey: .error)
        publishError = (error ?? "").isEmpty ? nil : error
    }
}

/// The answer to saving the autoroles.
public struct SavedAutoroles: Decodable, Sendable, Equatable {
    public let autoroles: [String]
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/roles/list`.
    public struct LoadRoles: APIEndpoint {
        public typealias Response = RolesPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/roles/list" }
    }

    /// `POST /api/v2/guilds/:id/modules/roles/rr`: saves a set and posts (or edits) its message.
    public struct SaveReactionRoleSet: APIEndpoint {
        public typealias Response = SavedReactionRoleSet
        public let server: ServerID
        public let draft: ReactionRoleDraft
        public init(server: ServerID, draft: ReactionRoleDraft) {
            self.server = server
            self.draft = draft
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/roles/rr" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { draft.body }
    }

    /// `POST /api/v2/guilds/:id/modules/roles/rr/:id/delete`: deletes a set and its message.
    public struct DeleteReactionRoleSet: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let setID: String
        public init(server: ServerID, setID: String) {
            self.server = server
            self.setID = setID
        }
        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/roles/rr/\(setID.encodedPathSegment)/delete"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST /api/v2/guilds/:id/modules/roles/autoroles`.
    public struct SaveAutoroles: APIEndpoint {
        public typealias Response = SavedAutoroles
        public let server: ServerID
        public let autoroles: [String]
        public init(server: ServerID, autoroles: [String]) {
            self.server = server
            self.autoroles = autoroles
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/roles/autoroles" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(autoroles: autoroles) }
        private struct Body: Encodable, Sendable { let autoroles: [String] }
    }
}

/// A body with nothing in it (`{}`), for the calls that act on the path alone.
struct EmptyBody: Encodable, Sendable {}

extension RecordListModel where Page == RolesPage {
    /// The reaction roles & autoroles screen's model.
    public convenience init(roles server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.LoadRoles(server: server))
        }
    }

    /// Saves a set and posts its message.
    /// - Returns: The answer, or nil when it did not go through.
    public func save(_ draft: ReactionRoleDraft) async -> SavedReactionRoleSet? {
        await perform { session, server in
            try await session.send(Endpoints.SaveReactionRoleSet(server: server, draft: draft))
        }
    }

    public func delete(_ set: ReactionRoleSet) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.DeleteReactionRoleSet(server: server, setID: set.id))
            return true
        }
        return done != nil
    }

    public func saveAutoroles(_ roles: [String]) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SaveAutoroles(server: server, autoroles: roles))
            return true
        }
        return done != nil
    }
}
