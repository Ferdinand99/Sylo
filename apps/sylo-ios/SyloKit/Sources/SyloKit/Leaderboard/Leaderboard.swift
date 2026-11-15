import Foundation
import Observation

/// The time window of the XP leaderboard (`?period=`).
public enum LeaderboardPeriod: String, CaseIterable, Sendable, Hashable, Identifiable {
    case allTime = "all"
    case week
    case month

    public var id: String { rawValue }
}

/// One ranked member.
public struct LeaderboardRow: Decodable, Sendable, Hashable, Identifiable {
    public let rank: Int
    public let name: String
    /// The level, only for the all-time board; nil for a week or a month.
    public let level: Int?
    public let xp: Int
    public let voiceMinutes: Int
    public let messages: Int

    public var id: Int { rank }

    public init(rank: Int, name: String, level: Int? = nil, xp: Int = 0, voiceMinutes: Int = 0, messages: Int = 0) {
        self.rank = rank
        self.name = name
        self.level = level
        self.xp = xp
        self.voiceMinutes = voiceMinutes
        self.messages = messages
    }

    private enum CodingKeys: String, CodingKey { case rank, name, level, xp, voiceMinutes, messages }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rank = c.lenientCount(.rank)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        if let level = try? c.decodeIfPresent(Double.self, forKey: .level), level.isFinite {
            self.level = Int(level.rounded())
        } else {
            self.level = nil
        }
        xp = c.lenientCount(.xp)
        voiceMinutes = c.lenientCount(.voiceMinutes)
        messages = c.lenientCount(.messages)
    }
}

/// The answer of `GET /api/v2/guilds/:id/leaderboard`: the top members for a period, and the
/// settings of the public page.
public struct LeaderboardPage: Decodable, Sendable, Equatable {
    /// False while the Leveling module is off: nobody earns XP, so the board stays empty.
    public let levelingEnabled: Bool
    /// Anyone with the link can read the board, without signing in.
    public var isPublic: Bool
    public let period: LeaderboardPeriod
    /// The short link (`/lb/<slug>`), nil when none is set.
    public var vanitySlug: String?
    /// How many members have XP in the period (the list shows the top ten).
    public let total: Int
    public let rows: [LeaderboardRow]

    public init(
        levelingEnabled: Bool = true, isPublic: Bool = false, period: LeaderboardPeriod = .allTime,
        vanitySlug: String? = nil, total: Int = 0, rows: [LeaderboardRow] = []
    ) {
        self.levelingEnabled = levelingEnabled
        self.isPublic = isPublic
        self.period = period
        self.vanitySlug = vanitySlug
        self.total = total
        self.rows = rows
    }

    private enum CodingKeys: String, CodingKey {
        case levelingEnabled, publicLeaderboard, period, vanitySlug, total, rows
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        levelingEnabled = try c.decodeIfPresent(Bool.self, forKey: .levelingEnabled) ?? true
        isPublic = try c.decodeIfPresent(Bool.self, forKey: .publicLeaderboard) ?? false
        let period = try c.decodeIfPresent(String.self, forKey: .period)
        self.period = period.flatMap(LeaderboardPeriod.init(rawValue:)) ?? .allTime
        let slug = try c.decodeIfPresent(String.self, forKey: .vanitySlug)
        vanitySlug = (slug?.isEmpty ?? true) ? nil : slug
        total = c.lenientCount(.total)
        rows = try c.decodeLossyArray(of: LeaderboardRow.self, forKey: .rows)
    }
}

/// The answer to turning the public page on or off.
public struct LeaderboardPublicResult: Decodable, Sendable, Equatable {
    public let isPublic: Bool

    public init(isPublic: Bool) { self.isPublic = isPublic }

    private enum CodingKeys: String, CodingKey { case publicLeaderboard }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isPublic = try c.decodeIfPresent(Bool.self, forKey: .publicLeaderboard) ?? false
    }
}

/// The answer to setting or clearing the short link: the slug as the server saved it (it
/// cleans what was typed), or nil once cleared.
public struct LeaderboardVanityResult: Decodable, Sendable, Equatable {
    public let slug: String?

    public init(slug: String?) { self.slug = slug }

    private enum CodingKeys: String, CodingKey { case vanitySlug }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let slug = try c.decodeIfPresent(String.self, forKey: .vanitySlug)
        self.slug = (slug?.isEmpty ?? true) ? nil : slug
    }
}

// MARK: - Endpoints

extension Endpoints {
    /// `GET /api/v2/guilds/:id/leaderboard?period=`.
    public struct Leaderboard: APIEndpoint {
        public typealias Response = LeaderboardPage
        public let server: ServerID
        public let period: LeaderboardPeriod

        public init(server: ServerID, period: LeaderboardPeriod) {
            self.server = server
            self.period = period
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/leaderboard" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "period", value: period.rawValue)] }
    }

    /// `POST /api/v2/guilds/:id/leaderboard/public` with `{publicLeaderboard}`.
    public struct SetLeaderboardPublic: APIEndpoint {
        public typealias Response = LeaderboardPublicResult
        public let server: ServerID
        public let isPublic: Bool

        public init(server: ServerID, isPublic: Bool) {
            self.server = server
            self.isPublic = isPublic
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/leaderboard/public" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(publicLeaderboard: isPublic) }

        private struct Body: Encodable, Sendable { let publicLeaderboard: Bool }
    }

    /// `POST /api/v2/guilds/:id/leaderboard/vanity` with `{slug}`; an empty slug clears the link.
    public struct SetLeaderboardVanity: APIEndpoint {
        public typealias Response = LeaderboardVanityResult
        public let server: ServerID
        public let slug: String

        public init(server: ServerID, slug: String) {
            self.server = server
            self.slug = slug
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/leaderboard/vanity" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(slug: slug) }

        private struct Body: Encodable, Sendable { let slug: String }
    }
}

// MARK: - Model

/// The Leaderboard page: the XP board for a period, the public page switch and its short link.
@MainActor
@Observable
public final class LeaderboardModel {
    public let server: ServerID
    /// The period shown. Changing it does not load; the view calls ``load()`` for the new one.
    public var period: LeaderboardPeriod = .allTime
    public private(set) var page: LeaderboardPage?
    public private(set) var isLoading = false
    /// A switch or link change is on its way to the server.
    public private(set) var isSaving = false
    /// Why the board could not be loaded.
    public var errorMessage: String?
    /// Why the public switch could not be changed.
    public var publicError: String?
    /// Why the short link was refused, in words for the person (the server only says
    /// `invalid` or `taken`).
    public var vanityError: String?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public func load() async {
        let requested = period
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await session.send(Endpoints.Leaderboard(server: server, period: requested))
            guard requested == period else { return }
            page = loaded
            errorMessage = nil
        } catch {
            guard requested == period else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Turns the public page on or off. The switch shows the server's answer; a failure leaves
    /// it where it was and sets ``publicError``.
    public func setPublic(_ isPublic: Bool) async {
        guard !isSaving, page != nil else { return }
        isSaving = true
        publicError = nil
        defer { isSaving = false }
        do {
            let result = try await session.send(Endpoints.SetLeaderboardPublic(server: server, isPublic: isPublic))
            page?.isPublic = result.isPublic
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { publicError = error.userMessage }
        }
    }

    /// Saves the short link; empty clears it. The server cleans the text (lower case, hyphens),
    /// so the page shows what it kept.
    /// - Returns: Whether the link was saved.
    @discardableResult
    public func saveVanity(_ slug: String) async -> Bool {
        guard !isSaving, page != nil else { return false }
        isSaving = true
        vanityError = nil
        defer { isSaving = false }
        do {
            let result = try await session.send(
                Endpoints.SetLeaderboardVanity(server: server, slug: slug.trimmingCharacters(in: .whitespacesAndNewlines)))
            page?.vanitySlug = result.slug
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { vanityError = Self.vanityMessage(for: error) }
            return false
        }
    }

    /// Where the public board is: the short link when there is one, else the page of the server.
    /// Nil while the board is private or not loaded.
    public func publicURL(on base: ServerURL) -> URL? {
        guard let page, page.isPublic else { return nil }
        if let slug = page.vanitySlug {
            return base.url(for: "lb/" + slug.encodedPathSegment)
        }
        return base.url(for: "leaderboard/" + server.pathComponent)
    }

    /// The server answers a refused short link with `invalid` or `taken`.
    static func vanityMessage(for error: NetworkError) -> String {
        guard case .badRequest = error else { return error.userMessage }
        switch error.serverCode {
        case "taken": return "That link is already used by another server. Pick another one."
        case "invalid": return "Use 3 to 32 letters, numbers or hyphens. It can't start or end with a hyphen."
        default: return error.userMessage
        }
    }
}
