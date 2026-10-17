import Foundation

// A module's settings page, as `GET /api/v2/guilds/:id/modules/<module>/config` sends it, and
// how they are saved (`POST` to the same path, answered with `{config}`). Each module has its own
// hand-written page type and settings struct in Modules/; this file is what they share.

/// One module's settings page: the settings themselves (the answer's `config`) plus whatever the
/// page needs to edit them (channel and role lists, choices, recent activity).
public protocol ModuleSettingsPage: Decodable, Sendable {
    /// What the person edits. Its `Encodable` form is the save body: exactly the fields the web
    /// dashboard's form sends, never bot-managed ones (counters, message ids).
    associatedtype Settings: Codable & Sendable & Equatable
    static var moduleID: ModuleID { get }
    var settings: Settings { get }
}

/// The answer to a save: the settings as the server stored them (normalised and clamped).
public struct SavedModuleSettings<Settings: Decodable & Sendable>: Decodable, Sendable {
    public let settings: Settings

    public init(settings: Settings) { self.settings = settings }

    private enum CodingKeys: String, CodingKey { case settings = "config" }
}

/// Something a setting can point at, such as a channel or a role.
public protocol NamedOption: Identifiable, Hashable, Sendable {
    var id: String { get }
    var name: String { get }
}

/// A channel the bot can use, from a settings page (`{id, name}`).
public struct ChannelOption: Decodable, NamedOption {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// A role the bot can assign or check, from a settings page (`{id, name}`), highest first.
public struct RoleOption: Decodable, NamedOption {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/<module>/config`.
    public struct LoadModuleSettings<Page: ModuleSettingsPage>: APIEndpoint {
        public typealias Response = Page
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/\(Page.moduleID.pathComponent)/config"
        }
    }

    /// `POST /api/v2/guilds/:id/modules/<module>/config` with the settings as the body.
    public struct SaveModuleSettings<Page: ModuleSettingsPage>: APIEndpoint {
        public typealias Response = SavedModuleSettings<Page.Settings>
        public let server: ServerID
        public let settings: Page.Settings

        public init(server: ServerID, settings: Page.Settings) {
            self.server = server
            self.settings = settings
        }

        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/\(Page.moduleID.pathComponent)/config"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { settings }
    }
}

extension KeyedDecodingContainer {
    /// The value for `key`, or `fallback` when it is missing or null, so a server version that
    /// lacks a newer field still loads (the server fills in its default on save).
    func decode<T: Decodable>(_ type: T.Type = T.self, forKey key: Key, or fallback: @autoclosure () -> T) throws -> T {
        try decodeIfPresent(type, forKey: key) ?? fallback()
    }
}
