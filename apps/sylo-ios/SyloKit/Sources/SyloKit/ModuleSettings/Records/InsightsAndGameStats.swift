import Foundation
import Observation

// The two modules that have nothing to set: Server insights (src/web/routes/v2Api.js,
// GET /guilds/:id/insights; web page web-v2/src/pages/Insights.jsx) shows activity over time, and
// Game stats (GET /modules/game-stats/config; web form web-v2/src/moduleForms/GameStats.jsx) lists
// the latest player lookups. The app shows their data and has no Save for them.

// MARK: - Server insights

/// The time ranges insights can show.
public enum InsightsRange: Int, Sendable, CaseIterable, Identifiable {
    case day = 24
    case twoDays = 48
    case week = 7
    case month = 30
    case quarter = 90

    public var id: Int { rawValue }

    /// Hourly for the first two, daily for the rest.
    public var isHourly: Bool { self == .day || self == .twoDays }

    /// The server's default.
    public static let standard = InsightsRange.month
}

/// One hour or day of activity.
public struct InsightsPoint: Decodable, Sendable, Equatable, Identifiable {
    /// `YYYY-MM-DD` for a day, `YYYY-MM-DDTHH` (UTC) for an hour.
    public let label: String
    public let messages: Int
    public let joins: Int
    public let leaves: Int
    public let activeMembers: Int
    public let voiceMinutes: Int
    public let voicePeak: Int

    public var id: String { label }

    public init(
        label: String, messages: Int = 0, joins: Int = 0, leaves: Int = 0, activeMembers: Int = 0,
        voiceMinutes: Int = 0, voicePeak: Int = 0
    ) {
        self.label = label
        self.messages = messages
        self.joins = joins
        self.leaves = leaves
        self.activeMembers = activeMembers
        self.voiceMinutes = voiceMinutes
        self.voicePeak = voicePeak
    }

    private enum CodingKeys: String, CodingKey {
        case label, messages, joins, leaves, activeMembers, voiceMinutes, voicePeak
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(forKey: .label, or: "")
        messages = try c.decode(forKey: .messages, or: 0)
        joins = try c.decode(forKey: .joins, or: 0)
        leaves = try c.decode(forKey: .leaves, or: 0)
        activeMembers = try c.decode(forKey: .activeMembers, or: 0)
        voiceMinutes = try c.decode(forKey: .voiceMinutes, or: 0)
        voicePeak = try c.decode(forKey: .voicePeak, or: 0)
    }
}

/// The totals over the range.
public struct InsightsTotals: Decodable, Sendable, Equatable {
    public let messages: Int
    public let joins: Int
    public let leaves: Int
    /// Joins minus leaves.
    public let net: Int
    public let peakActive: Int
    public let voiceMinutes: Int
    public let voicePeak: Int

    public init(
        messages: Int = 0, joins: Int = 0, leaves: Int = 0, net: Int = 0, peakActive: Int = 0,
        voiceMinutes: Int = 0, voicePeak: Int = 0
    ) {
        self.messages = messages
        self.joins = joins
        self.leaves = leaves
        self.net = net
        self.peakActive = peakActive
        self.voiceMinutes = voiceMinutes
        self.voicePeak = voicePeak
    }

    private enum CodingKeys: String, CodingKey {
        case messages, joins, leaves, net, peakActive, voiceMinutes, voicePeak
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = try c.decode(forKey: .messages, or: 0)
        joins = try c.decode(forKey: .joins, or: 0)
        leaves = try c.decode(forKey: .leaves, or: 0)
        net = try c.decode(forKey: .net, or: 0)
        peakActive = try c.decode(forKey: .peakActive, or: 0)
        voiceMinutes = try c.decode(forKey: .voiceMinutes, or: 0)
        voicePeak = try c.decode(forKey: .voicePeak, or: 0)
    }
}

/// A channel with how much it was used.
public struct InsightsChannel: Decodable, Sendable, Equatable, Identifiable {
    public let name: String
    /// Messages for a text channel, minutes for a voice channel.
    public let amount: Int

    public var id: String { name }

    public init(name: String, amount: Int) {
        self.name = name
        self.amount = amount
    }

    private enum CodingKeys: String, CodingKey { case name, messages, minutes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(forKey: .name, or: "")
        let messages = try c.decodeIfPresent(Int.self, forKey: .messages)
        amount = try messages ?? c.decode(forKey: .minutes, or: 0)
    }
}

/// `GET /api/v2/guilds/:id/insights?range=…`.
public struct InsightsPage: Decodable, Sendable, Equatable {
    /// Hours for an hourly range, days for a daily one.
    public let range: Int
    public let isHourly: Bool
    public let series: [InsightsPoint]
    public let totals: InsightsTotals
    public let topChannels: [InsightsChannel]
    public let topVoice: [InsightsChannel]

    public init(
        range: Int = 30, isHourly: Bool = false, series: [InsightsPoint] = [], totals: InsightsTotals = InsightsTotals(),
        topChannels: [InsightsChannel] = [], topVoice: [InsightsChannel] = []
    ) {
        self.range = range
        self.isHourly = isHourly
        self.series = series
        self.totals = totals
        self.topChannels = topChannels
        self.topVoice = topVoice
    }

    private enum CodingKeys: String, CodingKey { case range, granularity, series, totals, topChannels, topVoice }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        range = try c.decode(forKey: .range, or: 30)
        isHourly = try c.decode(forKey: .granularity, or: "day") == "hour"
        series = try c.decodeLossyArray(of: InsightsPoint.self, forKey: .series)
        totals = try c.decode(forKey: .totals, or: InsightsTotals())
        topChannels = try c.decodeLossyArray(of: InsightsChannel.self, forKey: .topChannels)
        topVoice = try c.decodeLossyArray(of: InsightsChannel.self, forKey: .topVoice)
    }

    /// Members gained since the start of the range, after each hour or day: a running total of
    /// joins minus leaves.
    public var memberGrowth: [Int] {
        var running = 0
        return series.map { point in
            running += point.joins - point.leaves
            return running
        }
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/insights?range=…`.
    public struct Insights: APIEndpoint {
        public typealias Response = InsightsPage
        public let server: ServerID
        public let range: InsightsRange
        public init(server: ServerID, range: InsightsRange) {
            self.server = server
            self.range = range
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/insights" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "range", value: String(range.rawValue))] }
    }

    /// `POST /api/v2/guilds/:id/insights/refresh`: counts the latest activity in now (the numbers
    /// otherwise update every ten minutes).
    public struct RefreshInsights: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/insights/refresh" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

/// Server insights for one server and range.
@MainActor
@Observable
public final class InsightsModel {
    public let server: ServerID
    public private(set) var page: InsightsPage?
    public private(set) var isLoading = false
    public private(set) var isRefreshing = false
    /// Why the numbers could not be loaded.
    public var errorMessage: String?
    /// The range shown; setting it loads the numbers for it.
    public private(set) var range = InsightsRange.standard

    private let session: AppSession

    public init(server: ServerID, session: AppSession, range: InsightsRange = .standard) {
        self.server = server
        self.session = session
        self.range = range
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        let requested = range
        do {
            let page = try await session.send(Endpoints.Insights(server: server, range: requested))
            // The person may have picked another range while this one was on its way.
            guard requested == range else { return }
            self.page = page
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
        }
    }

    /// Shows another range.
    public func select(_ range: InsightsRange) async {
        guard range != self.range else { return }
        self.range = range
        await load()
    }

    /// Counts the latest activity in, then loads the numbers again.
    public func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            _ = try await session.send(Endpoints.RefreshInsights(server: server))
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
            return
        }
        await load()
    }
}

// MARK: - Game stats

/// One player lookup in the cache.
public struct GameStatsLookup: Decodable, Sendable, Equatable, Identifiable {
    public let localID = LocalID()
    public let game: String
    public let title: String
    public let username: String
    public let platform: String
    /// When it was looked up, as "3m ago".
    public let ago: String

    public var id: UUID { localID.value }

    public init(game: String, title: String = "", username: String, platform: String = "", ago: String = "") {
        self.game = game
        self.title = title
        self.username = username
        self.platform = platform
        self.ago = ago
    }

    private enum CodingKeys: String, CodingKey { case game, title, username, platform, ago }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        game = try c.decode(forKey: .game, or: "")
        title = try c.decode(forKey: .title, or: "")
        username = try c.decode(forKey: .username, or: "")
        platform = try c.decode(forKey: .platform, or: "")
        ago = try c.decode(forKey: .ago, or: "")
    }

    /// What to call the lookup in a list: its title, else the game.
    public var heading: String { title.isEmpty ? game : title }

    /// "xboxone" as "Xbox One"; an unknown platform just gets a capital letter.
    public var platformName: String {
        let labels = [
            "pc": "PC", "ps3": "PlayStation 3", "ps4": "PlayStation 4", "ps5": "PlayStation 5",
            "xbox360": "Xbox 360", "xboxone": "Xbox One", "xbsx": "Xbox Series X|S",
        ]
        let trimmed = platform.trimmingCharacters(in: .whitespaces)
        return labels[trimmed.lowercased()] ?? (String(trimmed.prefix(1)).uppercased() + String(trimmed.dropFirst()))
    }
}

/// `GET /api/v2/guilds/:id/modules/game-stats/config`.
public struct GameStatsPage: Decodable, Sendable, Equatable {
    public static let moduleID: ModuleID = "game-stats"

    /// Whether the person runs this Sylo; only they see the lookups, which come from every server.
    public let isOperator: Bool
    public let recent: [GameStatsLookup]

    public init(isOperator: Bool = false, recent: [GameStatsLookup] = []) {
        self.isOperator = isOperator
        self.recent = recent
    }

    private enum CodingKeys: String, CodingKey {
        case isOperator = "operator"
        case recent
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isOperator = try c.decode(forKey: .isOperator, or: false)
        recent = try c.decodeLossyArray(of: GameStatsLookup.self, forKey: .recent)
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/game-stats/config`.
    public struct LoadGameStats: APIEndpoint {
        public typealias Response = GameStatsPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/game-stats/config" }
    }
}

extension RecordListModel where Page == GameStatsPage {
    /// The game stats screen's model (read only).
    public convenience init(gameStats server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.LoadGameStats(server: server))
        }
    }
}
