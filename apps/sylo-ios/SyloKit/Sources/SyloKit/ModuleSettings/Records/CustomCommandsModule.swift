import Foundation

// Custom commands (src/modules/customCommands.js and the routes in src/web/routes/v2Api.js under
// /modules/custom-commands; web form web-v2/src/moduleForms/CustomCommands.jsx): commands built
// from an ordered list of actions. A command is a record, saved on its own.

/// What one action of a command does.
public enum CommandActionType: String, Sendable, CaseIterable, Codable {
    /// The bot answers in the channel the command was used in.
    case reply
    /// The bot posts to a chosen channel.
    case send
    case addRole = "add-role"
    case removeRole = "remove-role"

    public init(from decoder: any Decoder) throws {
        self = CommandActionType(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .reply
    }

    /// Whether the action posts messages (and not a role change).
    public var postsMessages: Bool { self == .reply || self == .send }
}

/// A custom command: its name, the actions it runs in order, and who may use it where.
public struct CustomCommand: Codable, Sendable, Equatable, Identifiable {
    public let localID = LocalID()
    /// The server's id; "" for a command not saved yet.
    public var commandID: String
    /// Lowercase letters, digits, `-` and `_`; at most 32.
    public var name: String
    /// At most 100 characters; shown in Discord's command list.
    public var description: String
    public var actions: [Action]
    /// Only these roles may use it; empty means everyone.
    public var allowedRoles: [String]
    /// Only in these channels; empty means anywhere.
    public var allowedChannels: [String]
    /// Per member, in seconds.
    public var cooldownSeconds: Int
    /// A built-in command now has this name, so the command is off until it is renamed.
    public let isReserved: Bool

    public var id: UUID { localID.value }

    public static let maxNameLength = 32
    public static let maxDescriptionLength = 100
    public static let maxActions = 10
    public static let maxRoles = 25
    public static let maxChannels = 25
    public static let cooldownRange = 0...86_400
    public static let maxCommands = 200

    public struct Action: Codable, Sendable, Equatable, Identifiable {
        public let localID = LocalID()
        public var type: CommandActionType
        /// For the role actions.
        public var roleId: String
        /// For `send`.
        public var channelId: String
        /// For `reply`: only the person who ran the command sees it.
        public var isPrivate: Bool
        /// For the message actions; with more than one, the bot picks one at random.
        public var messages: [Message]

        public var id: UUID { localID.value }

        public static let maxMessages = 10

        public struct Message: Codable, Sendable, Equatable, Identifiable {
            public let localID = LocalID()
            /// At most 2000 characters; may be empty when there is an embed.
            public var content: String
            public var embed: EmbedSpec?

            public var id: UUID { localID.value }

            public static let maxContentLength = 2000

            public init(content: String = "", embed: EmbedSpec? = nil) {
                self.content = content
                self.embed = embed
            }

            private enum CodingKeys: String, CodingKey { case content, embed }

            public init(from decoder: any Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                content = try c.decode(forKey: .content, or: "")
                embed = try c.decodeIfPresent(EmbedSpec.self, forKey: .embed)
            }

            public func encode(to encoder: any Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(content, forKey: .content)
                if let embed {
                    try c.encode(embed, forKey: .embed)
                } else {
                    try c.encodeNil(forKey: .embed)
                }
            }
        }

        public init(
            type: CommandActionType = .reply, roleId: String = "", channelId: String = "", isPrivate: Bool = false,
            messages: [Message]? = nil
        ) {
            self.type = type
            self.roleId = roleId
            self.channelId = channelId
            self.isPrivate = isPrivate
            self.messages = messages ?? (type.postsMessages ? [Message()] : [])
        }

        private enum CodingKeys: String, CodingKey { case type, roleId, channelId, messages
            case isPrivate = "private"
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let type = try c.decode(forKey: .type, or: CommandActionType.reply)
            self.init(
                type: type, roleId: try c.decode(forKey: .roleId, or: ""),
                channelId: try c.decode(forKey: .channelId, or: ""),
                isPrivate: try c.decode(forKey: .isPrivate, or: false),
                messages: try c.decode(forKey: .messages, or: [Message]()))
        }

        /// The role actions send only the role; the message actions their messages, and `reply`
        /// whether it is private, `send` the channel.
        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(type, forKey: .type)
            switch type {
            case .addRole, .removeRole:
                try c.encode(roleId, forKey: .roleId)
            case .reply:
                try c.encode(messages, forKey: .messages)
                try c.encode(isPrivate, forKey: .isPrivate)
            case .send:
                try c.encode(messages, forKey: .messages)
                try c.encode(channelId, forKey: .channelId)
            }
        }

        /// Whether the action would do anything.
        public var hasEffect: Bool {
            type.postsMessages
                ? messages.contains { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.embed?.isEmpty == false }
                : !roleId.isEmpty
        }
    }

    public init(
        commandID: String = "", name: String = "", description: String = "", actions: [Action] = [Action()],
        allowedRoles: [String] = [], allowedChannels: [String] = [], cooldownSeconds: Int = 0, isReserved: Bool = false
    ) {
        self.commandID = commandID
        self.name = name
        self.description = description
        self.actions = actions
        self.allowedRoles = allowedRoles
        self.allowedChannels = allowedChannels
        self.cooldownSeconds = cooldownSeconds
        self.isReserved = isReserved
    }

    private enum CodingKeys: String, CodingKey {
        case commandID = "id"
        case name, description, actions, allowedRoles, allowedChannels, cooldownSeconds
        case isReserved = "reserved"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let text = try? c.decodeIfPresent(String.self, forKey: .commandID) {
            commandID = text
        } else if let number = try? c.decodeIfPresent(Int.self, forKey: .commandID) {
            commandID = String(number)
        } else {
            commandID = ""
        }
        name = try c.decode(forKey: .name, or: "")
        description = try c.decode(forKey: .description, or: "")
        actions = try c.decodeLossyArray(of: Action.self, forKey: .actions)
        allowedRoles = try c.decode(forKey: .allowedRoles, or: [])
        allowedChannels = try c.decode(forKey: .allowedChannels, or: [])
        cooldownSeconds = try c.decode(forKey: .cooldownSeconds, or: 0)
        isReserved = try c.decode(forKey: .isReserved, or: false)
    }

    /// The body of `POST /api/v2/guilds/:id/modules/custom-commands/cmd`: everything but the
    /// reserved flag.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(commandID, forKey: .commandID)
        try c.encode(name, forKey: .name)
        try c.encode(description, forKey: .description)
        try c.encode(actions, forKey: .actions)
        try c.encode(allowedRoles, forKey: .allowedRoles)
        try c.encode(allowedChannels, forKey: .allowedChannels)
        try c.encode(cooldownSeconds, forKey: .cooldownSeconds)
    }

    /// Whether the name is one the server accepts.
    public var nameIsValid: Bool {
        guard (1...Self.maxNameLength).contains(name.count) else { return false }
        return name.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Why the command cannot be saved yet, in words for the person; nil when it can.
    public var problem: String? {
        if name.isEmpty { return "Give the command a name." }
        if !nameIsValid { return "Names use lowercase letters, numbers, - and _ only." }
        if !actions.contains(where: \.hasEffect) { return "Add at least one message or role." }
        if actions.contains(where: { $0.type == .send && $0.hasEffect && $0.channelId.isEmpty }) {
            return "Choose a channel for the action that posts to a channel."
        }
        return nil
    }
}

/// `GET /api/v2/guilds/:id/modules/custom-commands/list`.
public struct CustomCommandsPage: Decodable, Sendable, Equatable {
    public static let moduleID: ModuleID = "custom-commands"

    public let commands: [CustomCommand]
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// What a message can contain, such as `{user}`.
    public let placeholders: [String]
    /// Fluxer only: the prefix members type before a command. Not part of this page's answer; the
    /// screen's loader fills it in from the server settings.
    public var commandPrefix: String?

    public init(
        commands: [CustomCommand] = [], channels: [ChannelOption] = [], roles: [RoleOption] = [],
        placeholders: [String] = [], commandPrefix: String? = nil
    ) {
        self.commands = commands
        self.channels = channels
        self.roles = roles
        self.placeholders = placeholders
        self.commandPrefix = commandPrefix
    }

    /// How members type the command: `/name` on Discord, the server's prefix and the name on Fluxer
    /// (just the name when the prefix is not known).
    public func trigger(for name: String, isFluxer: Bool) -> String {
        isFluxer ? (commandPrefix ?? "") + name : "/" + name
    }

    private enum CodingKeys: String, CodingKey { case commands, channels, roles, placeholders }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commands = try c.decodeLossyArray(of: CustomCommand.self, forKey: .commands)
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        placeholders = try c.decode(forKey: .placeholders, or: [])
    }
}

/// The answer to saving a command.
public struct SavedCustomCommand: Decodable, Sendable, Equatable {
    public let command: CustomCommand
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/custom-commands/list`.
    public struct LoadCustomCommands: APIEndpoint {
        public typealias Response = CustomCommandsPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/custom-commands/list" }
    }

    /// `POST /api/v2/guilds/:id/modules/custom-commands/cmd`: creates or updates a command (the
    /// body's `id` says which; "" creates).
    public struct SaveCustomCommand: APIEndpoint {
        public typealias Response = SavedCustomCommand
        public let server: ServerID
        public let command: CustomCommand
        public init(server: ServerID, command: CustomCommand) {
            self.server = server
            self.command = command
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/custom-commands/cmd" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { command }
    }

    /// `POST /api/v2/guilds/:id/modules/custom-commands/cmd/:id/delete`.
    public struct DeleteCustomCommand: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let commandID: String
        public init(server: ServerID, commandID: String) {
            self.server = server
            self.commandID = commandID
        }
        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/custom-commands/cmd/\(commandID.encodedPathSegment)/delete"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

extension RecordListModel where Page == CustomCommandsPage {
    /// The custom commands screen's model.
    public convenience init(customCommands server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            var page = try await session.send(Endpoints.LoadCustomCommands(server: server))
            if server.rawValue.hasPrefix("fluxer:") {
                // Fluxer has no slash commands; the prefix is a server setting. A failure only
                // leaves the names bare, it must not stop the list from loading.
                let settings = try? await session.send(Endpoints.LoadGuildSettings(server: server))
                let prefix = settings?.effectiveCommandPrefix ?? ""
                page.commandPrefix = prefix.isEmpty ? nil : prefix
            }
            return page
        }
    }

    public func save(_ command: CustomCommand) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SaveCustomCommand(server: server, command: command))
            return true
        }
        return done != nil
    }

    public func delete(_ command: CustomCommand) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.DeleteCustomCommand(server: server, commandID: command.commandID))
            return true
        }
        return done != nil
    }
}
