import Foundation
import Observation

// Game stats (src/web/routes/v2Api.js, `GET /modules/game-stats/config`; the dashboard page is
// web-v2/src/moduleForms/GameStats.jsx). The module has nothing to configure beyond the switch every
// module has: the page explains the `/stats` command and, for the operators of the Sylo server, lists
// the lookups the shared cache holds. There is no save call.

/// How the game API names a console or PC platform, as people write it.
public enum GamePlatform {
    private static let labels: [String: String] = [
        "pc": "PC", "ps3": "PlayStation 3", "ps4": "PlayStation 4", "ps5": "PlayStation 5",
        "xbox360": "Xbox 360", "xboxone": "Xbox One", "xbsx": "Xbox Series X|S",
    ]

    /// "pc" is "PC", "xboxone" is "Xbox One"; an id this list does not know just gets a capital letter.
    public static func label(for id: String) -> String {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if let known = labels[trimmed.lowercased()] { return known }
        guard let first = trimmed.first else { return "" }
        return first.uppercased() + String(trimmed.dropFirst())
    }
}

/// One cached lookup, as the operators' list shows it.
public struct GameLookup: Decodable, Sendable, Equatable, Identifiable {
    public let game: String
    public let title: String
    public let username: String
    public let platform: String
    /// How long ago it was looked up ("5m ago"), in the server's words.
    public let ago: String

    /// The rows have no id of their own: this is the row's place in the list (``GameStatsInfo`` numbers
    /// them), so two identical lookups never share one.
    public let id: Int

    public init(
        id: Int = 0, game: String = "", title: String = "", username: String = "", platform: String = "",
        ago: String = ""
    ) {
        self.id = id
        self.game = game
        self.title = title
        self.username = username
        self.platform = platform
        self.ago = ago
    }

    private enum CodingKeys: String, CodingKey { case game, title, username, platform, ago }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            game: (try? c.decodeIfPresent(String.self, forKey: .game)) ?? "",
            title: (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "",
            username: (try? c.decodeIfPresent(String.self, forKey: .username)) ?? "",
            platform: (try? c.decodeIfPresent(String.self, forKey: .platform)) ?? "",
            ago: (try? c.decodeIfPresent(String.self, forKey: .ago)) ?? "")
    }

    /// The row's heading: the title the game API gave, else the game.
    public var heading: String { title.isEmpty ? game : title }

    /// The same lookup at another place in the list.
    func numbered(_ id: Int) -> GameLookup {
        GameLookup(id: id, game: game, title: title, username: username, platform: platform, ago: ago)
    }

    /// "Player · PC · 5m ago".
    public var details: String {
        [username, GamePlatform.label(for: platform), ago].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }
}

/// The Game stats page.
public struct GameStatsInfo: Decodable, Sendable, Equatable {
    /// Whether the person runs the Sylo server (an operator). Only they see the lookups: the cache
    /// holds every server's. False on a server that does not say.
    public let isOperator: Bool
    public let recent: [GameLookup]

    public init(isOperator: Bool = false, recent: [GameLookup] = []) {
        self.isOperator = isOperator
        self.recent = recent.enumerated().map { $0.element.numbered($0.offset) }
    }

    private enum CodingKeys: String, CodingKey {
        case isOperator = "operator"
        case recent
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isOperator = (try? c.decodeIfPresent(Bool.self, forKey: .isOperator)) ?? false
        let rows = try c.decodeLossyArray(of: GameLookup.self, forKey: .recent)
        recent = rows.enumerated().map { $0.element.numbered($0.offset) }
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/game-stats/config`. Read only: the module has no save call.
    public struct LoadGameStats: APIEndpoint {
        public typealias Response = GameStatsInfo
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/game-stats/config" }
    }
}

/// The Game stats screen's state: the page, and the command prefix the server's platform uses
/// (`/` on Discord, the server's own prefix on Fluxer).
@MainActor
@Observable
public final class GameStatsModel {
    public let server: ServerID
    public private(set) var info: GameStatsInfo?
    /// What goes before a command's name: "/" on Discord, the server's own prefix on Fluxer. Empty
    /// when the server's settings could not be read.
    public private(set) var commandPrefix = "/"
    public private(set) var isLoading = false
    /// Why the page could not be loaded.
    public var errorMessage: String?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// The `/stats` command as members type it.
    public var statsCommand: String { commandPrefix + "stats" }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        async let settings = try? session.send(Endpoints.LoadGuildSettings(server: server))
        do {
            info = try await session.send(Endpoints.LoadGameStats(server: server))
            // Empty when the settings could not be read, so a name is never shown with the wrong prefix.
            commandPrefix = await settings.map(CommandsModel.prefix(from:)) ?? ""
            errorMessage = nil
        } catch {
            if let message = ListFailure.message(for: error) { errorMessage = message }
        }
    }
}
