import Foundation
import Observation

// The stats cache, for the operators of a Sylo server (web-v2/src/pages/Stats.jsx, `GET /api/v2/stats`,
// `requireOwner`): the game-stats lookups made through the stats command on every server, newest
// first. Read only; it never calls a game API. This is the page the dashboard's game stats module
// links to as "Full cache view", so there is no separate operator page for the module.

/// One cached lookup.
public struct StatsCacheRow: Decodable, Sendable, Equatable, Identifiable {
    public let game: String
    public let title: String
    public let username: String
    public let platform: String
    /// "5m ago", as the server words it.
    public let ago: String
    /// Whether the cached answer is still inside its lifetime; a stale row is refreshed by the next lookup.
    public let isFresh: Bool
    /// K/D, win rate and time played, as the game gave them; nil when it did not.
    public let kd: String?
    public let winRate: String?
    public let timePlayed: String?

    /// The row's place in the list; the rows have no id of their own.
    public let id: Int

    public init(
        id: Int = 0, game: String = "", title: String = "", username: String = "", platform: String = "",
        ago: String = "", isFresh: Bool = false, kd: String? = nil, winRate: String? = nil, timePlayed: String? = nil
    ) {
        self.id = id
        self.game = game
        self.title = title
        self.username = username
        self.platform = platform
        self.ago = ago
        self.isFresh = isFresh
        self.kd = kd
        self.winRate = winRate
        self.timePlayed = timePlayed
    }

    private enum CodingKeys: String, CodingKey {
        case game, title, username, platform, ago, fresh, kd, winRate, timePlayed
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String { (try? c.decodeIfPresent(String.self, forKey: key)) ?? "" }
        // The server sends "—" for what the game did not give; a number would be a number.
        func stat(_ key: CodingKeys) -> String? {
            if let string = try? c.decodeIfPresent(String.self, forKey: key) { return Self.present(string) }
            if let number = try? c.decodeIfPresent(Double.self, forKey: key) { return Self.present(String(number)) }
            return nil
        }
        self.init(
            game: text(.game), title: text(.title), username: text(.username), platform: text(.platform),
            ago: text(.ago), isFresh: (try? c.decodeIfPresent(Bool.self, forKey: .fresh)) ?? false,
            kd: stat(.kd), winRate: stat(.winRate), timePlayed: stat(.timePlayed))
    }

    private static func present(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == "\u{2014}" ? nil : trimmed
    }

    func numbered(_ id: Int) -> StatsCacheRow {
        StatsCacheRow(
            id: id, game: game, title: title, username: username, platform: platform, ago: ago,
            isFresh: isFresh, kd: kd, winRate: winRate, timePlayed: timePlayed)
    }

    /// The title the game API gave (else the game), then the player: "Battlefield 4 \u{2014} player_one".
    public var heading: String {
        let name = title.isEmpty ? game : title
        return username.isEmpty ? name : "\(name) \u{2014} \(username)"
    }

    /// "412 h played" from what the game gave: a number of seconds, "412h", or text; nil when unknown.
    public static func played(_ value: String?) -> String? {
        guard let s = value?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        if s.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }), let seconds = Double(s), seconds.isFinite,
            seconds < 1e15
        {
            return "\(Int((seconds / 3600).rounded())) h played"
        }
        let lower = s.lowercased()
        for suffix in ["hours", "hour", "h"] where lower.hasSuffix(suffix) {
            let number = lower.dropLast(suffix.count).trimmingCharacters(in: .whitespaces)
            if !number.isEmpty, number.allSatisfy({ $0.isNumber || $0 == "," || $0 == "." }) { return "\(number) h played" }
        }
        return "\(s) played"
    }

    /// The facts of the lookup the game has, in the dashboard's order: platform, K/D, win rate, time
    /// played, age.
    public var facts: [String] {
        [
            GamePlatform.label(for: platform),
            kd.map { "K/D \($0)" } ?? "",
            winRate.map { "Win \($0)" } ?? "",
            Self.played(timePlayed) ?? "",
            ago,
        ].filter { !$0.isEmpty }
    }
}

/// `GET /api/v2/stats`.
public struct StatsCache: Decodable, Sendable, Equatable {
    public let rows: [StatsCacheRow]
    /// How long an answer is kept before the next lookup refreshes it.
    public let ttlMinutes: Int

    public init(rows: [StatsCacheRow] = [], ttlMinutes: Int = 0) {
        self.rows = rows
        self.ttlMinutes = ttlMinutes
    }

    private enum CodingKeys: String, CodingKey { case rows, ttlMinutes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let decoded = try c.decodeLossyArray(of: StatsCacheRow.self, forKey: .rows)
        rows = decoded.enumerated().map { $1.numbered($0) }
        ttlMinutes = c.lenientCount(.ttlMinutes)
    }
}

extension Endpoints {
    /// `GET /api/v2/stats`: the newest 50 cached lookups (operators only).
    public struct StatsCacheLoad: APIEndpoint {
        public typealias Response = StatsCache
        public init() {}
        public var path: String { "/api/v2/stats" }
    }
}

/// The Stats cache screen.
@MainActor
@Observable
public final class StatsCacheModel {
    public private(set) var cache: StatsCache?
    public private(set) var isLoading = false
    /// The server said this account is not an operator (403): nothing is shown.
    public private(set) var isRefused = false
    public var errorMessage: String?

    private let session: AppSession

    public init(session: AppSession) {
        self.session = session
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        let generation = session.generation
        do {
            let loaded = try await session.send(Endpoints.StatsCacheLoad())
            guard session.generation == generation else { return }
            cache = loaded
            isRefused = false
            errorMessage = nil
        } catch {
            guard session.generation == generation else { return }
            let error = NetworkError(error)
            if error == .cancelled || error == .unauthorized { return }
            if OperatorOnly.isRefusal(error) {
                isRefused = true
                cache = nil
                errorMessage = OperatorOnly.refusal
            } else {
                errorMessage = error.userMessage
            }
        }
    }
}
