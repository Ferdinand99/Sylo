import Foundation
import Observation

/// One option of a command (`/ban user [reason]`).
public struct CommandOption: Decodable, Sendable, Hashable, Identifiable {
    public let name: String
    public let isRequired: Bool
    public let description: String
    /// The fixed values the option accepts, when it has a list.
    public let choices: [String]

    public var id: String { name }

    public init(name: String, isRequired: Bool = false, description: String = "", choices: [String] = []) {
        self.name = name
        self.isRequired = isRequired
        self.description = description
        self.choices = choices
    }

    private enum CodingKeys: String, CodingKey { case name, required, description, choices }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        isRequired = try c.decodeIfPresent(Bool.self, forKey: .required) ?? false
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        choices = try c.decodeIfPresent([String].self, forKey: .choices) ?? []
    }
}

/// One slash command (a subcommand is its own row), from `GET /api/v2/public/commands`.
public struct CommandReference: Decodable, Sendable, Hashable, Identifiable {
    /// `/ban <user> [reason]`.
    public let signature: String
    public let description: String
    /// The permissions a member needs to use it, nil when anyone can.
    public let permissions: [String]?
    public let options: [CommandOption]

    public var id: String { signature }

    public init(signature: String, description: String = "", permissions: [String]? = nil, options: [CommandOption] = []) {
        self.signature = signature
        self.description = description
        self.permissions = permissions
        self.options = options
    }

    private enum CodingKeys: String, CodingKey { case signature, description, permissions, options }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        signature = try c.decode(String.self, forKey: .signature)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        let permissions = try c.decodeIfPresent([String].self, forKey: .permissions)
        self.permissions = (permissions?.isEmpty ?? true) ? nil : permissions
        options = try c.decodeLossyArray(of: CommandOption.self, forKey: .options)
    }
}

/// The answer of `GET /api/v2/public/commands`.
public struct CommandListPage: Decodable, Sendable, Equatable {
    public let commands: [CommandReference]

    public init(commands: [CommandReference]) { self.commands = commands }

    private enum CodingKeys: String, CodingKey { case commands }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commands = try c.decodeLossyArray(of: CommandReference.self, forKey: .commands)
    }
}

extension Endpoints {
    /// `GET /api/v2/public/commands`: every slash command Sylo has. Public on the server, so no
    /// token goes with it.
    public struct CommandList: APIEndpoint {
        public typealias Response = CommandListPage
        public init() {}
        public var path: String { "/api/v2/public/commands" }
        public var requiresAuth: Bool { false }
    }
}

/// The Command list page: every slash command, searchable by name or by what it does.
@MainActor
@Observable
public final class CommandListModel {
    public private(set) var commands: [CommandReference] = []
    public private(set) var hasLoaded = false
    public private(set) var isLoading = false
    /// Why the list could not be loaded.
    public var errorMessage: String?
    public var query = ""

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    /// The commands whose signature or description contains the query (ignoring case); all of
    /// them for an empty query.
    public var filtered: [CommandReference] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return commands }
        return commands.filter {
            $0.signature.localizedCaseInsensitiveContains(text) || $0.description.localizedCaseInsensitiveContains(text)
        }
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            commands = try await session.send(Endpoints.CommandList()).commands
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized { return }
            // A Sylo that predates the public command list answers 404.
            errorMessage = error == .notFound ? "This Sylo server has no command list to show." : error.userMessage
        }
    }
}
