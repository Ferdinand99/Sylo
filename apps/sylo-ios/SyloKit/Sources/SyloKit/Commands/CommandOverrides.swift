import Foundation
import Observation

// Command limits (src/web/routes/v2Staff.js: `GET /commands` and `POST /commands/:command`). Staff
// turn a command off for the server, or limit it to some channels and roles. Empty channel and
// role lists mean "everywhere, for everyone". Members who may not use a command get no answer.

/// One command and how this server has limited it.
public struct ManagedCommand: Decodable, Sendable, Hashable, Identifiable {
    public let name: String
    public let description: String
    public let enabled: Bool
    /// Channel ids the command works in; empty for every channel.
    public let allowedChannels: [String]
    /// Role ids that may use it; empty for everyone.
    public let allowedRoles: [String]

    public var id: String { name }

    /// Whether any channel or role limit is set.
    public var isLimited: Bool { !allowedChannels.isEmpty || !allowedRoles.isEmpty }

    public init(
        name: String, description: String = "", enabled: Bool = true, allowedChannels: [String] = [],
        allowedRoles: [String] = []
    ) {
        self.name = name
        self.description = description
        self.enabled = enabled
        self.allowedChannels = allowedChannels
        self.allowedRoles = allowedRoles
    }

    private enum CodingKeys: String, CodingKey { case name, description, enabled, allowedChannels, allowedRoles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(String.self, forKey: .name),
            description: try c.decodeIfPresent(String.self, forKey: .description) ?? "",
            enabled: try c.decode(forKey: .enabled, or: true),
            allowedChannels: try c.decode(forKey: .allowedChannels, or: []),
            allowedRoles: try c.decode(forKey: .allowedRoles, or: []))
    }

    /// Whether the command's name or description contains `query` (ignoring case and accents).
    public func matches(_ query: String) -> Bool {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return true }
        return [name, description].contains { $0.range(of: text, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
}

/// `GET /commands`: every command with its limits, and the channels and roles to limit it to.
public struct CommandsPage: Decodable, Sendable, Equatable {
    /// By name.
    public let commands: [ManagedCommand]
    public let channels: [ChannelOption]
    /// Highest role first.
    public let roles: [RoleOption]

    public init(commands: [ManagedCommand] = [], channels: [ChannelOption] = [], roles: [RoleOption] = []) {
        self.commands = commands
        self.channels = channels
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey { case commands, channels, roles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            commands: try c.decodeLossyArray(of: ManagedCommand.self, forKey: .commands),
            channels: try c.decodeLossyArray(of: ChannelOption.self, forKey: .channels),
            roles: try c.decodeLossyArray(of: RoleOption.self, forKey: .roles))
    }
}

/// The answer to saving a command: it as the server stored it.
public struct SavedCommand: Decodable, Sendable, Equatable {
    public let command: ManagedCommand

    public init(command: ManagedCommand) { self.command = command }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/commands`.
    public struct LoadCommands: APIEndpoint {
        public typealias Response = CommandsPage
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/commands" }
    }

    /// `POST /api/v2/guilds/:id/commands/:command`: sets the whole override (on or off, the
    /// channels, the roles). 404 for a command the bot does not have.
    public struct SaveCommand: APIEndpoint {
        public typealias Response = SavedCommand
        public let server: ServerID
        public let name: String
        public let enabled: Bool
        public let channels: [String]
        public let roles: [String]

        public init(server: ServerID, name: String, enabled: Bool, channels: [String] = [], roles: [String] = []) {
            self.server = server
            self.name = name
            self.enabled = enabled
            self.channels = channels
            self.roles = roles
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/commands/\(name.encodedPathSegment)" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(enabled: enabled, channels: channels, roles: roles) }

        private struct Body: Encodable, Sendable {
            let enabled: Bool
            let channels: [String]
            let roles: [String]
        }
    }
}

/// The command list: search, and saving one command's switch and limits.
@MainActor
@Observable
public final class CommandsModel {
    public let server: ServerID
    public private(set) var commands: [ManagedCommand] = []
    public private(set) var channels: [ChannelOption] = []
    public private(set) var roles: [RoleOption] = []
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    public var searchText = ""
    /// Why the list could not be loaded (the last list, if any, stays).
    public var errorMessage: String?
    /// Why a save did not go through, in the server's words.
    public var actionError: String?
    /// Names of the commands being saved now.
    public private(set) var saving: Set<String> = []
    /// Goes up with every save that went through, for a haptic.
    public private(set) var saveCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// The commands that match the search.
    public var shown: [ManagedCommand] { commands.filter { $0.matches(searchText) } }

    public func command(named name: String) -> ManagedCommand? { commands.first { $0.name == name } }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await session.send(Endpoints.LoadCommands(server: server))
            commands = page.commands
            channels = page.channels
            roles = page.roles
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Saves a command's switch and limits. The list takes the command as the server stored it.
    /// - Returns: Whether it went through. On failure ``actionError`` says why and the command
    ///   stays as it was.
    @discardableResult
    public func save(_ name: String, enabled: Bool, channels: [String], roles: [String]) async -> Bool {
        guard !saving.contains(name) else { return false }
        saving.insert(name)
        defer { saving.remove(name) }
        actionError = nil
        do {
            let saved = try await session.send(
                Endpoints.SaveCommand(server: server, name: name, enabled: enabled, channels: channels, roles: roles))
            if let index = commands.firstIndex(where: { $0.name == name }) {
                let old = commands[index]
                // The answer carries no description; keep the one the list has.
                commands[index] = ManagedCommand(
                    name: name, description: old.description, enabled: saved.command.enabled,
                    allowedChannels: saved.command.allowedChannels, allowedRoles: saved.command.allowedRoles)
            }
            saveCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
    }
}
