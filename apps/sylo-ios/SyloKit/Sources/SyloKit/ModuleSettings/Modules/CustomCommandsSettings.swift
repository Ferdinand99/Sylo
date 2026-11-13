import Foundation
import Observation

// Custom commands (src/modules/customCommands.js, src/web/routes/v2Api.js "Custom commands"; web page
// web-v2/src/moduleForms/CustomCommands.jsx). Like reaction roles this module has no `/config` page:
// the list is `GET /guilds/:id/modules/custom-commands/list` and each command is saved on its own.
//
// A command is an ordered list of actions (reply, send to a channel, add or remove a role). The
// order matters and a newer server may know kinds of action this app does not: those are kept as
// the raw JSON they came as, at their place in the list, and sent back unchanged.

// MARK: - Placeholders

/// The `{tokens}` a command's text fills in.
public enum CommandPlaceholders {
    /// What the server fills in when it does not list its own (`CC_PLACEHOLDERS`).
    public static let standard = ["{user}", "{username}", "{server}", "{channel}", "{args}"]

    /// A short plain description of a token, empty for one the app does not know.
    public static func hint(for token: String) -> String {
        switch token {
        case "{user}": String(localized: "Mentions the member")
        case "{username}": String(localized: "The member's username")
        case "{server}": String(localized: "The server name")
        case "{channel}": String(localized: "Mentions the channel")
        case "{args}": String(localized: "The text typed after the command")
        default: ""
        }
    }

    /// Every distinct `{token}` written in the text, in order: letters, digits, `_` and `.` inside the
    /// braces, starting with a letter (the web's `findTokens`).
    public static func tokens(in text: String) -> [String] {
        var found: [String] = []
        var index = text.startIndex
        while let open = text[index...].firstIndex(of: "{") {
            guard let close = text[text.index(after: open)...].firstIndex(of: "}") else { break }
            let name = text[text.index(after: open)..<close]
            if let first = name.first, first.isASCII, first.isLetter,
               name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == ".") }) {
                let token = "{\(name)}"
                if !found.contains(token) { found.append(token) }
            }
            index = text.index(after: open)
        }
        return found
    }

    /// The tokens in the text that the command does not fill in. Saving is never blocked by them.
    public static func unknownTokens(in text: String, known: [String]) -> [String] {
        tokens(in: text).filter { !known.contains($0) }
    }
}

// MARK: - One message of an action

/// One message block of a reply or send action: text and/or an embed. With several blocks the bot
/// picks one at random.
public struct CommandMessage: Sendable, Equatable, Identifiable {
    /// For lists only; never sent.
    public let id: UUID
    public var content: String
    /// nil: no embed.
    public var embed: EmbedItem?
    /// Keys of the stored block that this app does not know, sent back as they came.
    public var extra: [String: JSONValue]

    public init(content: String = "", embed: EmbedItem? = nil, extra: [String: JSONValue] = [:]) {
        id = UUID()
        self.content = content
        self.embed = embed
        self.extra = extra
    }

    /// Equal when the content is (the id is only for lists), so "unchanged" holds after a reload.
    public static func == (lhs: CommandMessage, rhs: CommandMessage) -> Bool {
        lhs.content == rhs.content && lhs.embed == rhs.embed && lhs.extra == rhs.extra
    }

    /// Whether the block says anything: text, or an embed that has something in it (the server drops an
    /// empty embed, one with only a colour or icons).
    public var hasContent: Bool {
        if !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        guard let embed else { return false }
        if embed.isOpaque { return true }
        let draft = embed.draft
        return !draft.title.isEmpty || !draft.description.isEmpty || !draft.image.isEmpty
            || !draft.thumbnail.isEmpty || !draft.authorName.isEmpty || !draft.footerText.isEmpty
            || draft.fields.contains { !$0.name.isEmpty || !$0.value.isEmpty }
    }
}

extension CommandMessage: Codable {
    private static let knownKeys: Set<String> = ["content", "embed"]

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: ExtraCodingKey.self)
        self.init(
            content: (try? c.decodeIfPresent(String.self, forKey: ExtraCodingKey("content"))) ?? "",
            embed: try? c.decodeIfPresent(EmbedItem.self, forKey: ExtraCodingKey("embed")),
            extra: ExtraKeys.read(from: decoder, known: Self.knownKeys))
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: ExtraCodingKey.self)
        try ExtraKeys.write(extra, to: &c, skipping: Self.knownKeys)
        try c.encode(content, forKey: ExtraCodingKey("content"))
        if let embed {
            try c.encode(embed, forKey: ExtraCodingKey("embed"))
        } else {
            try c.encodeNil(forKey: ExtraCodingKey("embed"))
        }
    }
}

// MARK: - One action

/// One step of a command.
public struct CommandAction: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable, CaseIterable {
        /// The bot answers in the channel the command was used in.
        case reply
        /// The bot posts in a chosen channel.
        case send
        case addRole = "add-role"
        case removeRole = "remove-role"

        public var hasMessages: Bool { self == .reply || self == .send }
        public var isRole: Bool { self == .addRole || self == .removeRole }
    }

    public static let maxMessagesDefault = 10

    /// For lists only; never sent.
    public let id: UUID
    public var kind: Kind
    /// For add-role and remove-role.
    public var roleId: String
    /// For send.
    public var channelId: String
    /// For reply: only the person who ran the command sees it.
    public var isPrivate: Bool
    /// For reply and send; at least one block.
    public var messages: [CommandMessage]
    /// Keys of the stored action that this app does not know, sent back as they came.
    public var extra: [String: JSONValue]
    /// The stored value as it came, for an action of a kind this app does not know. Kept in place and
    /// sent back unchanged; nil for every action the app can edit.
    public private(set) var raw: JSONValue?

    public init(
        kind: Kind = .reply, roleId: String = "", channelId: String = "", isPrivate: Bool = false,
        messages: [CommandMessage]? = nil, extra: [String: JSONValue] = [:]
    ) {
        id = UUID()
        self.kind = kind
        self.roleId = roleId
        self.channelId = channelId
        self.isPrivate = isPrivate
        self.messages = messages ?? (kind.hasMessages ? [CommandMessage()] : [])
        self.extra = extra
        raw = nil
    }

    /// An action of a kind the app does not know, kept as the JSON it came as.
    public init(raw: JSONValue) {
        id = UUID()
        kind = .reply
        roleId = ""
        channelId = ""
        isPrivate = false
        messages = []
        extra = [:]
        self.raw = raw
    }

    /// A new action of that kind, with one empty message when it has messages.
    public static func blank(_ kind: Kind) -> CommandAction { CommandAction(kind: kind) }

    /// Whether the action is kept as it came because the app cannot edit it.
    public var isUnknown: Bool { raw != nil }

    /// The `type` of an unknown action, when it has one.
    public var unknownType: String? {
        guard case .object(let object)? = raw, case .string(let type)? = object["type"] else { return nil }
        return type
    }

    /// Equal when the content is (the id is only for lists).
    public static func == (lhs: CommandAction, rhs: CommandAction) -> Bool {
        lhs.raw == rhs.raw && lhs.kind == rhs.kind && lhs.roleId == rhs.roleId && lhs.channelId == rhs.channelId
            && lhs.isPrivate == rhs.isPrivate && lhs.messages == rhs.messages && lhs.extra == rhs.extra
    }

    /// Whether the action does something: a message with content, or a role. An unknown action counts,
    /// as the app cannot tell.
    public var hasEffect: Bool {
        if isUnknown { return true }
        return kind.hasMessages ? messages.contains { $0.hasContent } : !roleId.isEmpty
    }

    /// A copy of the action with its own ids.
    public func duplicated() -> CommandAction {
        if let raw { return CommandAction(raw: raw) }
        return CommandAction(
            kind: kind, roleId: roleId, channelId: channelId, isPrivate: isPrivate,
            messages: messages.map { CommandMessage(content: $0.content, embed: $0.embed, extra: $0.extra) },
            extra: extra)
    }
}

extension CommandAction: Codable {
    private static let knownKeys: Set<String> = ["type", "roleId", "channelId", "private", "messages"]

    public init(from decoder: any Decoder) throws {
        let stored = try JSONValue(from: decoder)
        guard case .object(let object) = stored else {
            self.init(raw: stored)
            return
        }
        // No type at all is a reply, as the server reads it; a type this app does not know is kept raw.
        let typeText: String?
        switch object["type"] {
        case nil, .null?: typeText = Kind.reply.rawValue
        case .string(let text)?: typeText = text
        default: typeText = nil
        }
        guard let typeText, let kind = Kind(rawValue: typeText) else {
            self.init(raw: stored)
            return
        }
        let c = try decoder.container(keyedBy: ExtraCodingKey.self)
        let messages = (try? c.decodeIfPresent([LossyMessage].self, forKey: ExtraCodingKey("messages")))?
            .compactMap(\.value) ?? []
        self.init(
            kind: kind,
            roleId: (try? c.decodeIfPresent(String.self, forKey: ExtraCodingKey("roleId"))) ?? "",
            channelId: (try? c.decodeIfPresent(String.self, forKey: ExtraCodingKey("channelId"))) ?? "",
            isPrivate: (try? c.decodeIfPresent(Bool.self, forKey: ExtraCodingKey("private"))) ?? false,
            messages: kind.hasMessages ? (messages.isEmpty ? [CommandMessage()] : messages) : [],
            extra: ExtraKeys.read(from: decoder, known: Self.knownKeys))
    }

    public func encode(to encoder: any Encoder) throws {
        if let raw {
            try raw.encode(to: encoder)
            return
        }
        var c = encoder.container(keyedBy: ExtraCodingKey.self)
        try ExtraKeys.write(extra, to: &c, skipping: Self.knownKeys)
        try c.encode(kind.rawValue, forKey: ExtraCodingKey("type"))
        if kind.isRole {
            try c.encode(roleId, forKey: ExtraCodingKey("roleId"))
            return
        }
        try c.encode(messages, forKey: ExtraCodingKey("messages"))
        if kind == .reply { try c.encode(isPrivate, forKey: ExtraCodingKey("private")) }
        if kind == .send { try c.encode(channelId, forKey: ExtraCodingKey("channelId")) }
    }

    /// A message block that is dropped when it cannot be read, so one odd block does not lose the action.
    private struct LossyMessage: Decodable {
        let value: CommandMessage?
        init(from decoder: any Decoder) throws { value = try? CommandMessage(from: decoder) }
    }
}

// MARK: - A command

/// What a command's name must look like (`NAME_RE` in src/modules/customCommands.js).
public enum CustomCommandName {
    public static let defaultMaxLength = 32
    public static let rule = "Lowercase letters, numbers, - and _."

    /// The name as the server reads it: trimmed and lower-cased.
    public static func normalised(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Whether the server would take the name: 1 to `maxLength` of lowercase letters, digits, `-` and `_`.
    public static func isValid(_ text: String, maxLength: Int = defaultMaxLength) -> Bool {
        let name = normalised(text)
        guard !name.isEmpty, name.count <= maxLength else { return false }
        return name.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
                || scalar == "-" || scalar == "_"
        }
    }
}

/// One custom command.
public struct CustomCommand: Sendable, Equatable, Identifiable {
    /// The server's number for the command; empty for a new one.
    public var id: String
    public var name: String
    public var description: String
    public var actions: [CommandAction]
    public var allowedRoles: [String]
    public var allowedChannels: [String]
    public var cooldownSeconds: Int
    /// The name is now a built-in command's, so the command is switched off until it is renamed. Read
    /// only; never sent.
    public var reserved: Bool

    public init(
        id: String = "", name: String = "", description: String = "",
        actions: [CommandAction] = [CommandAction.blank(.reply)], allowedRoles: [String] = [],
        allowedChannels: [String] = [], cooldownSeconds: Int = 0, reserved: Bool = false
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.actions = actions
        self.allowedRoles = allowedRoles
        self.allowedChannels = allowedChannels
        self.cooldownSeconds = cooldownSeconds
        self.reserved = reserved
    }

    public var isNew: Bool { id.isEmpty }

    /// The server's own caps (`LIMITS` in src/modules/customCommands.js), used until the server sends its limits.
    public enum Limits {
        public static let commands = 200
        public static let descriptionLength = 100
        public static let actions = 10
        public static let messages = 10
        public static let contentLength = 2000
        public static let allowedRoles = 25
        public static let allowedChannels = 25
        public static let cooldown = 0...86_400
    }

    /// What stops the command from being saved, in the server's words (the checks of
    /// `POST /modules/custom-commands/cmd`). `others` are the other commands of the server. Empty: the
    /// server will take it, apart from a name a built-in command already has, which only it knows.
    public func problems(others: [CustomCommand], maxNameLength: Int = CustomCommandName.defaultMaxLength) -> [String] {
        var problems: [String] = []
        let trimmed = CustomCommandName.normalised(name)
        if !CustomCommandName.isValid(trimmed, maxLength: maxNameLength) {
            problems.append("Invalid name — lowercase letters, numbers, - and _ only.")
        } else if others.contains(where: { $0.id != id && $0.name == trimmed }) {
            problems.append("/\(trimmed) already exists.")
        }
        if !actions.contains(where: \.hasEffect) {
            problems.append("Every action was empty — add at least one message, role, etc.")
        }
        return problems
    }
}

extension CustomCommand: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, name, description, actions, allowedRoles, allowedChannels, cooldownSeconds, reserved
    }

    /// Reads a stored command. Anything missing or of the wrong type is empty; an action that cannot be
    /// read at all is dropped, one of an unknown kind is kept.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        if id.isEmpty, let value = try? c.decodeIfPresent(Int.self, forKey: .id) { id = String(value) }
        var cooldown = 0
        if let value = try? c.decodeIfPresent(Int.self, forKey: .cooldownSeconds) {
            cooldown = value
        } else if let value = try? c.decodeIfPresent(Double.self, forKey: .cooldownSeconds) {
            cooldown = Int(value)
        }
        self.init(
            id: id,
            name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "",
            description: (try? c.decodeIfPresent(String.self, forKey: .description)) ?? "",
            actions: try c.decodeLossyArray(of: CommandAction.self, forKey: .actions),
            allowedRoles: (try? c.decodeIfPresent([String].self, forKey: .allowedRoles)) ?? [],
            allowedChannels: (try? c.decodeIfPresent([String].self, forKey: .allowedChannels)) ?? [],
            cooldownSeconds: cooldown,
            reserved: (try? c.decodeIfPresent(Bool.self, forKey: .reserved)) ?? false)
    }

    /// Writes the save body the dashboard sends: `{id, name, description, actions, allowedRoles,
    /// allowedChannels, cooldownSeconds}`. The name goes out trimmed and in lower case, as the server
    /// stores it.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(CustomCommandName.normalised(name), forKey: .name)
        try c.encode(description, forKey: .description)
        try c.encode(actions, forKey: .actions)
        try c.encode(allowedRoles, forKey: .allowedRoles)
        try c.encode(allowedChannels, forKey: .allowedChannels)
        try c.encode(cooldownSeconds, forKey: .cooldownSeconds)
    }
}

// MARK: - The page

/// `GET /guilds/:id/modules/custom-commands/list`.
public struct CustomCommandsPage: Decodable, Sendable, Equatable {
    public let commands: [CustomCommand]
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The tokens the server fills in; empty on a server that does not say.
    public let placeholders: [String]

    public init(
        commands: [CustomCommand] = [], channels: [ChannelOption] = [], roles: [RoleOption] = [],
        placeholders: [String] = []
    ) {
        self.commands = commands
        self.channels = channels
        self.roles = roles
        self.placeholders = placeholders
    }

    private enum CodingKeys: String, CodingKey { case commands, channels, roles, placeholders }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commands = try c.decodeLossyArray(of: CustomCommand.self, forKey: .commands)
        channels = try c.decodeLossyArray(of: ChannelOption.self, forKey: .channels)
        roles = try c.decodeLossyArray(of: RoleOption.self, forKey: .roles)
        placeholders = (try? c.decodeIfPresent([String].self, forKey: .placeholders)) ?? []
    }
}

/// The answer to saving a command: the command as the server stored it.
public struct CustomCommandSaved: Decodable, Sendable, Equatable {
    public let command: CustomCommand?

    public init(command: CustomCommand? = nil) { self.command = command }

    private enum CodingKeys: String, CodingKey { case command }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        command = try? c.decodeIfPresent(CustomCommand.self, forKey: .command)
    }
}

// MARK: - Endpoints

extension Endpoints {
    private static func commandsPath(_ server: ServerID) -> String {
        "/api/v2/guilds/\(server.pathComponent)/modules/custom-commands"
    }

    /// `GET /api/v2/guilds/:id/modules/custom-commands/list`.
    public struct LoadCustomCommands: APIEndpoint {
        public typealias Response = CustomCommandsPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.commandsPath(server) + "/list" }
    }

    /// `POST /api/v2/guilds/:id/modules/custom-commands/cmd` with the whole command. An empty `id`
    /// makes a new one. 400 with the server's words for a bad or taken name, a name a built-in command
    /// uses, or a command with nothing in its actions.
    public struct SaveCustomCommand: APIEndpoint {
        public typealias Response = CustomCommandSaved
        public let server: ServerID
        public let command: CustomCommand

        public init(server: ServerID, command: CustomCommand) {
            self.server = server
            self.command = command
        }

        public var path: String { Endpoints.commandsPath(server) + "/cmd" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { command }
    }

    /// `POST /api/v2/guilds/:id/modules/custom-commands/cmd/:id/delete`.
    public struct DeleteCustomCommand: APIEndpoint {
        public typealias Response = EmptyResponse
        public let server: ServerID
        public let id: String

        public init(server: ServerID, id: String) {
            self.server = server
            self.id = id
        }

        public var path: String { Endpoints.commandsPath(server) + "/cmd/\(id.encodedPathSegment)/delete" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

// MARK: - Model

/// The custom commands screen: the commands, and what an editor needs (channels, roles, tokens, limits,
/// the prefix commands are typed with).
@MainActor
@Observable
public final class CustomCommandsModel {
    public let server: ServerID
    public private(set) var commands: [CustomCommand] = []
    public private(set) var channels: [ChannelOption] = []
    public private(set) var roles: [RoleOption] = []
    /// The tokens the server fills in.
    public private(set) var placeholders: [String] = CommandPlaceholders.standard
    public private(set) var limits: ModuleFieldLimits = .unlimited
    /// What goes before a command's name: `/` on Discord, the server's prefix on Fluxer. Empty when the
    /// server's settings could not be read, so a name is never shown with the wrong prefix.
    public private(set) var commandPrefix = "/"
    public private(set) var platform: Platform?
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    /// Why the page could not be loaded.
    public var errorMessage: String?
    /// Why the last save or delete did not go through, in the server's words.
    public var actionError: String?
    /// Goes up with every save or delete that went through, for a haptic.
    public private(set) var successCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var maxCommands: Int { limits["commands"].maxItems ?? CustomCommand.Limits.commands }
    public var maxNameLength: Int { limits["commands[].name"].maxLength ?? CustomCommandName.defaultMaxLength }
    public var descriptionLimit: Int {
        limits["commands[].description"].maxLength ?? CustomCommand.Limits.descriptionLength
    }
    public var maxActions: Int { limits["commands[].actions"].maxItems ?? CustomCommand.Limits.actions }
    public var maxMessages: Int { limits["commands[].actions[].messages"].maxItems ?? CustomCommand.Limits.messages }
    public var contentLimit: Int {
        limits["commands[].actions[].messages[].content"].maxLength ?? CustomCommand.Limits.contentLength
    }
    public var maxAllowedRoles: Int {
        limits["commands[].allowedRoles"].maxItems ?? CustomCommand.Limits.allowedRoles
    }
    public var maxAllowedChannels: Int {
        limits["commands[].allowedChannels"].maxItems ?? CustomCommand.Limits.allowedChannels
    }
    public var cooldownRange: ClosedRange<Int> {
        let limit = limits["commands[].cooldownSeconds"]
        let low = limit.min ?? CustomCommand.Limits.cooldown.lowerBound
        let high = limit.max ?? CustomCommand.Limits.cooldown.upperBound
        return low...max(low, high)
    }

    public var canAddCommand: Bool { commands.count < maxCommands }

    /// The command as members type it: `/hello`, or `!hello` on a Fluxer server with the prefix `!`.
    public func displayName(_ name: String) -> String { commandPrefix + name }

    public func problems(for command: CustomCommand) -> [String] {
        command.problems(others: commands, maxNameLength: maxNameLength)
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        async let settings = try? session.send(Endpoints.LoadGuildSettings(server: server))
        do {
            let page = try await session.send(Endpoints.LoadCustomCommands(server: server))
            let guild = await settings
            commandPrefix = guild.map(CommandsModel.prefix(from:)) ?? ""
            platform = guild?.platform
            commands = page.commands
            channels = page.channels
            roles = page.roles
            placeholders = page.placeholders.isEmpty ? CommandPlaceholders.standard : page.placeholders
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
            return
        }
        limits = await session.moduleLimits()["custom-commands"]
    }

    /// Saves one command. The list takes the command as the server stored it.
    /// - Returns: Whether it is saved; on failure ``actionError`` says why.
    @discardableResult
    public func save(_ command: CustomCommand) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        actionError = nil
        do {
            let saved = try await session.send(Endpoints.SaveCustomCommand(server: server, command: command))
            if let stored = saved.command {
                if let index = commands.firstIndex(where: { $0.id == stored.id }) {
                    commands[index] = stored
                } else {
                    commands.append(stored)
                }
            }
            successCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
    }

    /// Deletes a command.
    /// - Returns: Whether it is gone.
    @discardableResult
    public func delete(_ id: String) async -> Bool {
        guard !isSaving else { return false }
        isSaving = true
        defer { isSaving = false }
        actionError = nil
        do {
            _ = try await session.send(Endpoints.DeleteCustomCommand(server: server, id: id))
            commands.removeAll { $0.id == id }
            successCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
    }
}
