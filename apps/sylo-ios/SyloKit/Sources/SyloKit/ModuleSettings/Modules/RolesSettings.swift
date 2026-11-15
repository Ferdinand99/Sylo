import Foundation

// Reaction roles and autoroles (src/web/routes/v2Api.js "Reaction roles & autoroles"; web page
// web-v2/src/moduleForms/Roles.jsx). Unlike most modules this one has no `/config` page: the list
// lives at `GET /guilds/:id/modules/roles/list`, autoroles are saved on their own, and every
// reaction-role message is a record that is saved (and posted to its channel) one at a time.

// MARK: - Emoji

/// A custom emoji of the server, from `GET /api/v2/guilds/:id/emojis`.
public struct GuildEmoji: Decodable, Sendable, Equatable, Hashable, Identifiable {
    public let name: String
    /// What goes into an emoji field: `<:name:id>` (`<a:name:id>` when animated).
    public let display: String
    /// A small picture of it.
    public let url: String

    public var id: String { display }

    public init(name: String, display: String, url: String = "") {
        self.name = name
        self.display = display
        self.url = url
    }

    private enum CodingKeys: String, CodingKey { case name, display, url }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(forKey: .name, or: ""),
            display: try c.decode(forKey: .display, or: ""),
            url: try c.decode(forKey: .url, or: ""))
    }
}

/// `GET /api/v2/guilds/:id/emojis`: `{custom: [{name, display, url}]}`.
public struct GuildEmojis: Decodable, Sendable, Equatable {
    public let custom: [GuildEmoji]

    public init(custom: [GuildEmoji] = []) { self.custom = custom }

    private enum CodingKeys: String, CodingKey { case custom }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // An entry that cannot be read, or has no usable text, is dropped.
        custom = try c.decodeLossyArray(of: GuildEmoji.self, forKey: .custom).filter { !$0.display.isEmpty }
    }
}

/// What a person typed into an emoji field, read the way the server reads it (`parseEmoji` in
/// src/modules/roles.js): a custom emoji as `<:name:id>` or `<a:name:id>`, a `:shortcode:` the server
/// looks up among the server's emojis, or anything else, which counts as a unicode emoji.
public enum EmojiToken: Sendable, Equatable {
    case empty
    case custom(name: String, id: String, animated: Bool)
    case shortcode(String)
    case unicode(String)

    public static func parse(_ raw: String) -> EmojiToken {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .empty }
        if text.hasPrefix("<"), text.hasSuffix(">") {
            let parts = text.dropFirst().dropLast().split(separator: ":", omittingEmptySubsequences: false)
            if parts.count == 3, parts[0] == "" || parts[0] == "a", isName(parts[1]), isDigits(parts[2]) {
                return .custom(name: String(parts[1]), id: String(parts[2]), animated: parts[0] == "a")
            }
        }
        if text.count > 2, text.hasPrefix(":"), text.hasSuffix(":") {
            let inner = text.dropFirst().dropLast()
            if isName(inner) { return .shortcode(String(inner)) }
        }
        return .unicode(text)
    }

    /// The text for a custom emoji: `<:name:id>`, or `<a:name:id>` when animated.
    public static func customText(name: String, id: String, animated: Bool = false) -> String {
        "<\(animated ? "a" : ""):\(name):\(id)>"
    }

    /// Whether the server would accept it for the reaction style: something it can react with. A
    /// `:shortcode:` counts only when the server has an emoji of that name.
    public func isUsable(among custom: [GuildEmoji]) -> Bool {
        switch self {
        case .empty: false
        case .custom, .unicode: true
        case .shortcode(let name): custom.contains { $0.name == name }
        }
    }

    /// The text the server stores for it: a `:shortcode:` becomes the custom emoji it names.
    public func resolvedText(among custom: [GuildEmoji]) -> String? {
        switch self {
        case .empty: nil
        case .custom(let name, let id, let animated): Self.customText(name: name, id: id, animated: animated)
        case .unicode(let text): text
        case .shortcode(let name): custom.first { $0.name == name }?.display
        }
    }

    private static func isName(_ text: Substring) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
    }

    private static func isDigits(_ text: Substring) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && $0.isNumber }
    }
}

// MARK: - One row of a reaction-role message

/// One role of a reaction-role message: an emoji (required for reactions, optional for buttons and
/// menus), an optional label, the role, and the colour of its button.
public struct ReactionRolePair: Sendable, Equatable, Identifiable {
    public static let buttonStyles = ["secondary", "primary", "success", "danger"]
    public static let defaultButtonStyle = "secondary"

    /// For lists only; never sent.
    public let id: UUID
    /// A unicode emoji, `<:name:id>`, or a `:shortcode:`; the stored `display`.
    public var emoji: String
    public var label: String
    public var roleId: String
    public var buttonStyle: String

    public init(emoji: String = "", label: String = "", roleId: String = "",
                buttonStyle: String = ReactionRolePair.defaultButtonStyle) {
        id = UUID()
        self.emoji = emoji
        self.label = label
        self.roleId = roleId
        self.buttonStyle = buttonStyle
    }

    /// Equal when the content is (the id is only for lists), so "unchanged" holds after a reload.
    public static func == (lhs: ReactionRolePair, rhs: ReactionRolePair) -> Bool {
        lhs.emoji == rhs.emoji && lhs.label == rhs.label && lhs.roleId == rhs.roleId
            && lhs.buttonStyle == rhs.buttonStyle
    }

    /// A row with nothing in it: the server ignores it.
    public var isBlank: Bool { roleId.isEmpty && emoji.isEmpty && label.isEmpty }
}

extension ReactionRolePair: Codable {
    private enum CodingKeys: String, CodingKey { case display, label, roleId, btnStyle }

    /// Reads a stored pair (`{key, display, react, roleId, label, btnStyle}`).
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            emoji: (try? c.decodeIfPresent(String.self, forKey: .display)) ?? "",
            label: (try? c.decodeIfPresent(String.self, forKey: .label)) ?? "",
            roleId: (try? c.decodeIfPresent(String.self, forKey: .roleId)) ?? "",
            buttonStyle: (try? c.decodeIfPresent(String.self, forKey: .btnStyle)) ?? Self.defaultButtonStyle)
    }

    /// Writes a pair the way the dashboard's form sends it: `{emoji, label, roleId, btnStyle}`.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(emoji, forKey: AnyCodingKey("emoji"))
        try c.encode(label, forKey: AnyCodingKey("label"))
        try c.encode(roleId, forKey: AnyCodingKey("roleId"))
        try c.encode(buttonStyle, forKey: AnyCodingKey("btnStyle"))
    }
}

// MARK: - A reaction-role message

/// One reaction-role message: the channel, how members pick (reactions, buttons or a menu), the text
/// and embed above, and the rows of emoji and roles. Decoded from the list and encoded as the save
/// body (`POST /modules/roles/rr`), which always posts the message as well.
public struct ReactionRoleMessage: Sendable, Equatable, Identifiable {
    public static let styles = ["reaction", "buttons", "select"]
    public static let modes = ["default", "reverse"]

    /// The server's number for the set; empty for a new one.
    public var id: String
    public var channelId: String
    /// The posted message's id; empty while the set is only a draft (the last post failed).
    public var messageId: String
    /// `reaction`, `buttons` or `select`. Anything else comes back as it was read.
    public var style: String
    /// Plain text above the embed.
    public var message: String
    public var embed: EmbedItem
    /// Only one role of the set at a time.
    public var exclusive: Bool
    /// `default`, or `reverse` (the interaction removes the role).
    public var mode: String
    /// The menu's placeholder (style `select`).
    public var placeholder: String
    public var selMin: Int
    public var selMax: Int
    public var pairs: [ReactionRolePair]

    public init(
        id: String = "", channelId: String = "", messageId: String = "", style: String = "reaction",
        message: String = "", embed: EmbedItem = EmbedItem(), exclusive: Bool = false, mode: String = "default",
        placeholder: String = "", selMin: Int = 0, selMax: Int = 0,
        pairs: [ReactionRolePair] = [ReactionRolePair()]
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

    public var isNew: Bool { id.isEmpty }
    public var isPublished: Bool { !messageId.isEmpty }

    /// Reactions and buttons can be reversed; a menu cannot.
    public var hasMode: Bool { style != "select" }

    /// The fewest rows a form shows: one empty row, like the dashboard's.
    public var rowsOrBlank: [ReactionRolePair] { pairs.isEmpty ? [ReactionRolePair()] : pairs }

    // MARK: Limits

    /// The server's own caps (`LIMITS` in src/modules/roles.js), used until the server sends its limits.
    public enum Limits {
        public static let reactionMessages = 50
        public static let autoroles = 100
        public static let messageLength = 2000
        public static let placeholderLength = 150
        public static let labelLength = 80
        public static let pairs = 25
        public static let picks = 25
    }

    /// The most rows a message of this style holds: Discord's own cap per style (20 reactions, 25
    /// buttons or menu options), never above what the server accepts (`pairsLimit`).
    public static func maxRows(style: String, pairsLimit: Int?) -> Int {
        let discord = style == "reaction" ? 20 : 25
        return min(discord, pairsLimit ?? Limits.pairs)
    }

    // MARK: Checks, as the server makes them

    /// Whether an emoji the person typed will do for a reaction. When the server's emoji list could not
    /// be read (`listKnown` false), a `:shortcode:` is let through: the server looks it up itself.
    static func isUsable(_ text: String, among custom: [GuildEmoji], listKnown: Bool) -> Bool {
        let token = EmojiToken.parse(text)
        if !listKnown, case .shortcode = token { return true }
        return token.isUsable(among: custom)
    }

    /// Whether a row holds a `:shortcode:` that this app could not check, because the server's emoji
    /// list is not available. It is sent as typed.
    public func hasUncheckedShortcode(listKnown: Bool) -> Bool {
        guard !listKnown, style == "reaction" else { return false }
        return pairs.contains { row in
            if case .shortcode = EmojiToken.parse(row.emoji) { return true }
            return false
        }
    }

    /// What stops the set from being saved, in the dashboard's words (`buildReactionPairs` in
    /// src/web/lib/reactionPairs.js and the checks in the route). Row numbers are the rows as shown.
    /// Empty: the server will take it.
    public func problems(
        customEmojis: [GuildEmoji] = [], pairsLimit: Int? = nil, emojiListKnown: Bool = true
    ) -> [String] {
        var problems: [String] = []
        if channelId.isEmpty { problems.append("Pick a channel.") }
        let maxPairs = pairsLimit ?? Limits.pairs
        if pairs.count > maxPairs { problems.append("Use at most \(maxPairs) roles per message.") }
        var valid = 0
        var hadRowError = false
        for (index, row) in pairs.enumerated() where !row.isBlank {
            if row.roleId.isEmpty {
                problems.append("Row \(index + 1): select a role.")
                hadRowError = true
            } else if style == "reaction", !Self.isUsable(row.emoji, among: customEmojis, listKnown: emojiListKnown) {
                problems.append("Row \(index + 1): enter a valid emoji (required for the Reactions style).")
                hadRowError = true
            } else {
                valid += 1
            }
        }
        if valid == 0, !hadRowError { problems.append("Add at least one role.") }
        return problems
    }

    /// The set as the screen sends it: a `:shortcode:` is swapped for the server emoji it names, so what
    /// is posted is what the person picked.
    public func resolvingShortcodes(among custom: [GuildEmoji]) -> ReactionRoleMessage {
        var copy = self
        for index in copy.pairs.indices {
            if case .shortcode = EmojiToken.parse(copy.pairs[index].emoji),
               let text = EmojiToken.parse(copy.pairs[index].emoji).resolvedText(among: custom) {
                copy.pairs[index].emoji = text
            }
        }
        return copy
    }

    /// Whether the embed has something in it. An untouched embed goes out as `{}`, so the server's own
    /// default look stays, as in the dashboard.
    var embedIsPlain: Bool {
        guard !embed.isOpaque else { return false }
        let draft = embed.draft
        return draft.isEmpty() && draft.color.isEmpty && !draft.timestamp && draft.kind == "embed"
            && draft.extra.isEmpty
    }
}

extension ReactionRoleMessage: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, messageId, style, message, embed, exclusive, mode, placeholder, selMin, selMax, pairs
    }

    /// Reads a stored set. Anything missing or of the wrong type is empty or off.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String { (try? c.decodeIfPresent(String.self, forKey: key)) ?? "" }
        func number(_ key: CodingKeys) -> Int {
            if let value = try? c.decodeIfPresent(Int.self, forKey: key) { return value }
            if let value = try? c.decodeIfPresent(Double.self, forKey: key) { return Int(value) }
            return 0
        }
        // The id is a number the server made from the time; some servers send it as a number.
        var id = text(.id)
        if id.isEmpty, let value = try? c.decodeIfPresent(Int.self, forKey: .id) { id = String(value) }
        let style = text(.style)
        let mode = text(.mode)
        self.init(
            id: id, channelId: text(.channelId), messageId: text(.messageId),
            style: style.isEmpty ? "reaction" : style, message: text(.message),
            embed: (try? c.decodeIfPresent(EmbedItem.self, forKey: .embed)) ?? EmbedItem(),
            exclusive: (try? c.decodeIfPresent(Bool.self, forKey: .exclusive)) ?? false,
            mode: mode == "reverse" ? "reverse" : "default", placeholder: text(.placeholder),
            selMin: number(.selMin), selMax: number(.selMax),
            pairs: try c.decodeLossyArray(of: ReactionRolePair.self, forKey: .pairs))
    }

    /// Writes the save body the dashboard sends: `{id, channelId, style, message, embed, exclusive,
    /// mode, placeholder, selMin, selMax, pairs}`. The posted message's id is the bot's, never sent.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(channelId, forKey: .channelId)
        try c.encode(style, forKey: .style)
        try c.encode(message, forKey: .message)
        if embedIsPlain {
            try c.encode([String: JSONValue](), forKey: .embed)
        } else {
            try c.encode(embed, forKey: .embed)
        }
        try c.encode(exclusive, forKey: .exclusive)
        try c.encode(mode, forKey: .mode)
        try c.encode(placeholder, forKey: .placeholder)
        try c.encode(selMin, forKey: .selMin)
        try c.encode(selMax, forKey: .selMax)
        try c.encode(pairs, forKey: .pairs)
    }
}

// MARK: - The page

/// `GET /guilds/:id/modules/roles/list`.
public struct RolesPage: Decodable, Sendable, Equatable {
    public let reactionMessages: [ReactionRoleMessage]
    /// Role ids given to every new member.
    public let autoroles: [String]
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(
        reactionMessages: [ReactionRoleMessage] = [], autoroles: [String] = [], channels: [ChannelOption] = [],
        roles: [RoleOption] = []
    ) {
        self.reactionMessages = reactionMessages
        self.autoroles = autoroles
        self.channels = channels
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey { case reactionMessages, autoroles, channels, roles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reactionMessages = try c.decodeLossyArray(of: ReactionRoleMessage.self, forKey: .reactionMessages)
        autoroles = (try? c.decodeIfPresent([String].self, forKey: .autoroles)) ?? []
        channels = try c.decodeLossyArray(of: ChannelOption.self, forKey: .channels)
        roles = try c.decodeLossyArray(of: RoleOption.self, forKey: .roles)
    }
}

/// The answer to saving a reaction-role message: the set as the server stored it, and `error` when
/// the set was saved but posting it failed (the bot lacks a permission in the channel).
public struct ReactionRoleSaved: Decodable, Sendable, Equatable {
    public let reactionMessage: ReactionRoleMessage?
    /// Why the post failed; nil when it went through.
    public let error: String?

    public init(reactionMessage: ReactionRoleMessage? = nil, error: String? = nil) {
        self.reactionMessage = reactionMessage
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case reactionMessage, error }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reactionMessage = try? c.decodeIfPresent(ReactionRoleMessage.self, forKey: .reactionMessage)
        let text = (try? c.decodeIfPresent(String.self, forKey: .error))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        error = (text?.isEmpty ?? true) ? nil : text
    }
}

/// The answer to saving autoroles: the list as the server stored it (de-duplicated and capped).
public struct AutorolesSaved: Decodable, Sendable, Equatable {
    public let autoroles: [String]

    public init(autoroles: [String] = []) { self.autoroles = autoroles }

    private enum CodingKeys: String, CodingKey { case autoroles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        autoroles = (try? c.decodeIfPresent([String].self, forKey: .autoroles)) ?? []
    }
}

// MARK: - Endpoints

extension Endpoints {
    private static func rolesPath(_ server: ServerID) -> String {
        "/api/v2/guilds/\(server.pathComponent)/modules/roles"
    }

    /// `GET /api/v2/guilds/:id/modules/roles/list`.
    public struct LoadRoles: APIEndpoint {
        public typealias Response = RolesPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.rolesPath(server) + "/list" }
    }

    /// `POST /api/v2/guilds/:id/modules/roles/autoroles` with `{autoroles}`.
    public struct SaveAutoroles: APIEndpoint {
        public typealias Response = AutorolesSaved
        public let server: ServerID
        public let autoroles: [String]

        public init(server: ServerID, autoroles: [String]) {
            self.server = server
            self.autoroles = autoroles
        }

        public var path: String { Endpoints.rolesPath(server) + "/autoroles" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(autoroles: autoroles) }

        private struct Body: Encodable, Sendable { let autoroles: [String] }
    }

    /// `POST /api/v2/guilds/:id/modules/roles/rr` with the whole set. An empty `id` makes a new set;
    /// every save posts (or edits) the message in the channel. 400 with the server's words when the set
    /// is wrong, 403 when the person may not hand out a role, and `error` in a 200 answer when only the
    /// post failed.
    public struct SaveReactionRole: APIEndpoint {
        public typealias Response = ReactionRoleSaved
        public let server: ServerID
        public let message: ReactionRoleMessage

        public init(server: ServerID, message: ReactionRoleMessage) {
            self.server = server
            self.message = message
        }

        public var path: String { Endpoints.rolesPath(server) + "/rr" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { message }
    }

    /// `POST /api/v2/guilds/:id/modules/roles/rr/:id/delete`: deletes the set and its posted message.
    public struct DeleteReactionRole: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let id: String

        public init(server: ServerID, id: String) {
            self.server = server
            self.id = id
        }

        public var path: String { Endpoints.rolesPath(server) + "/rr/\(id.encodedPathSegment)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `GET /api/v2/guilds/:id/emojis`: the server's custom emojis. Missing on some older servers.
    public struct LoadGuildEmojis: APIEndpoint {
        public typealias Response = GuildEmojis
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/emojis" }
    }
}
