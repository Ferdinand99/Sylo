import Foundation
import Observation

/// How far back the server insights reach: the last day or two by hour, or the last weeks by day
/// (`GET /api/v2/guilds/:id/insights?range=`).
public enum InsightsRange: String, CaseIterable, Sendable, Hashable, Identifiable {
    case last24Hours = "24"
    case last48Hours = "48"
    case last7Days = "7"
    case last30Days = "30"
    case last90Days = "90"

    public var id: String { rawValue }

    /// How many buckets the range holds: hours for the two short ranges, days for the others.
    public var count: Int { Int(rawValue) ?? 30 }

    /// Hours for 24 and 48, days for the rest.
    public var granularity: InsightsGranularity {
        switch self {
        case .last24Hours, .last48Hours: .hour
        case .last7Days, .last30Days, .last90Days: .day
        }
    }

    /// The value sent as `range`.
    public var queryValue: String { rawValue }
}

/// The size of one bucket in a series.
public enum InsightsGranularity: String, Sendable, Hashable {
    case hour
    case day
}

extension KeyedDecodingContainer {
    /// A whole count the server sent as a number; missing, null or odd values read as 0.
    func lenientCount(_ key: Key) -> Int {
        guard let value = try? decodeIfPresent(Double.self, forKey: key), value.isFinite else { return 0 }
        return Int(value.rounded())
    }
}

/// One bucket of a series: a day or an hour of activity.
public struct InsightsPoint: Decodable, Sendable, Hashable, Identifiable {
    /// `YYYY-MM-DD` for a day, `YYYY-MM-DDTHH` for an hour, both in UTC.
    public let label: String
    /// The start of the bucket, nil when the label is not one the app can read.
    public let date: Date?
    public let joins: Int
    public let leaves: Int
    public let messages: Int
    public let activeMembers: Int
    public let voiceMinutes: Int
    public let voiceActiveMembers: Int
    public let voicePeak: Int

    public var id: String { label }

    public init(
        label: String, joins: Int = 0, leaves: Int = 0, messages: Int = 0, activeMembers: Int = 0,
        voiceMinutes: Int = 0, voiceActiveMembers: Int = 0, voicePeak: Int = 0
    ) {
        self.label = label
        self.date = Self.date(fromLabel: label)
        self.joins = joins
        self.leaves = leaves
        self.messages = messages
        self.activeMembers = activeMembers
        self.voiceMinutes = voiceMinutes
        self.voiceActiveMembers = voiceActiveMembers
        self.voicePeak = voicePeak
    }

    private enum CodingKeys: String, CodingKey {
        case label, joins, leaves, messages, activeMembers, voiceMinutes, voiceActiveMembers, voicePeak
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        date = Self.date(fromLabel: label)
        joins = c.lenientCount(.joins)
        leaves = c.lenientCount(.leaves)
        messages = c.lenientCount(.messages)
        activeMembers = c.lenientCount(.activeMembers)
        voiceMinutes = c.lenientCount(.voiceMinutes)
        voiceActiveMembers = c.lenientCount(.voiceActiveMembers)
        voicePeak = c.lenientCount(.voicePeak)
    }

    /// The UTC start of the bucket a label names: `2026-11-05` is a day, `2026-11-05T14` an hour.
    public static func date(fromLabel label: String) -> Date? {
        let halves = label.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false)
        guard let first = halves.first else { return nil }
        let day = first.split(separator: "-", omittingEmptySubsequences: false)
        guard day.count == 3, let year = Int(day[0]), let month = Int(day[1]), let dayOfMonth = Int(day[2]) else {
            return nil
        }
        var hour = 0
        if halves.count == 2 {
            guard let parsed = Int(halves[1]), (0..<24).contains(parsed) else { return nil }
            hour = parsed
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar.date(from: DateComponents(year: year, month: month, day: dayOfMonth, hour: hour))
    }
}

/// The sums over a range.
public struct InsightsTotals: Decodable, Sendable, Hashable {
    public let messages: Int
    public let joins: Int
    public let leaves: Int
    /// Joins minus leaves; negative when the server shrank.
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
        messages = c.lenientCount(.messages)
        joins = c.lenientCount(.joins)
        leaves = c.lenientCount(.leaves)
        net = c.lenientCount(.net)
        peakActive = c.lenientCount(.peakActive)
        voiceMinutes = c.lenientCount(.voiceMinutes)
        voicePeak = c.lenientCount(.voicePeak)
    }
}

/// A channel in the top lists, with its messages or voice minutes.
public struct InsightsChannel: Decodable, Sendable, Hashable {
    public let name: String
    /// Messages for a text channel, minutes for a voice channel.
    public let value: Int

    public init(name: String, value: Int) {
        self.name = name
        self.value = value
    }

    private enum CodingKeys: String, CodingKey { case name, messages, minutes }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        // Text channels carry `messages`, voice channels `minutes`.
        let messages = c.lenientCount(.messages)
        value = messages != 0 ? messages : c.lenientCount(.minutes)
    }
}

/// The answer of `GET /api/v2/guilds/:id/insights`.
public struct InsightsReport: Decodable, Sendable, Equatable {
    /// How many buckets the server returned.
    public let range: Int
    public let granularity: InsightsGranularity
    /// Oldest first, with empty buckets filled in, so a chart has no gaps.
    public let series: [InsightsPoint]
    public let totals: InsightsTotals
    public let topChannels: [InsightsChannel]
    public let topVoice: [InsightsChannel]

    public init(
        range: Int, granularity: InsightsGranularity, series: [InsightsPoint], totals: InsightsTotals,
        topChannels: [InsightsChannel] = [], topVoice: [InsightsChannel] = []
    ) {
        self.range = range
        self.granularity = granularity
        self.series = series
        self.totals = totals
        self.topChannels = topChannels
        self.topVoice = topVoice
    }

    private enum CodingKeys: String, CodingKey {
        case range, granularity, series, totals, topChannels, topVoice
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        range = c.lenientCount(.range)
        let granularity = try c.decodeIfPresent(String.self, forKey: .granularity)
        self.granularity = granularity.flatMap(InsightsGranularity.init(rawValue:)) ?? .day
        series = try c.decodeLossyArray(of: InsightsPoint.self, forKey: .series)
        totals = try c.decodeIfPresent(InsightsTotals.self, forKey: .totals) ?? InsightsTotals()
        topChannels = try c.decodeLossyArray(of: InsightsChannel.self, forKey: .topChannels)
        topVoice = try c.decodeLossyArray(of: InsightsChannel.self, forKey: .topVoice)
    }

    /// The member count's change since the start of the range, bucket by bucket (joins minus
    /// leaves, added up).
    public var growth: [InsightsGrowthPoint] {
        var running = 0
        return series.compactMap { point in
            running += point.joins - point.leaves
            guard let date = point.date else { return nil }
            return InsightsGrowthPoint(date: date, total: running)
        }
    }

    /// The buckets a chart can place on a time axis.
    public var datedSeries: [InsightsPoint] { series.filter { $0.date != nil } }
}

/// One step of the cumulative member growth line.
public struct InsightsGrowthPoint: Sendable, Hashable, Identifiable {
    public let date: Date
    public let total: Int
    public var id: Date { date }
}

/// Time spent in voice, worded like the dashboard's tiles.
public enum InsightsFormat {
    /// "45 min", "3 h 5 m" (hours and minutes, the minutes only when there are some).
    public static func duration(minutes: Int) -> String {
        let minutes = max(0, minutes)
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "\(hours) h" : "\(hours) h \(rest) m"
    }

    /// Like ``duration(minutes:)``, but from ten hours up whole hours only ("2402 h"), so a long
    /// total fits a tile.
    public static func shortDuration(minutes: Int) -> String {
        let minutes = max(0, minutes)
        if minutes < 600 { return duration(minutes: minutes) }
        return "\(Int((Double(minutes) / 60).rounded())) h"
    }
}

// MARK: - Endpoints

extension Endpoints {
    /// `GET /api/v2/guilds/:id/insights?range=`: activity charts and totals for a server.
    public struct Insights: APIEndpoint {
        public typealias Response = InsightsReport
        public let server: ServerID
        public let range: InsightsRange

        public init(server: ServerID, range: InsightsRange) {
            self.server = server
            self.range = range
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/insights" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "range", value: range.queryValue)] }
    }

    /// `POST /api/v2/guilds/:id/insights/refresh`: writes the activity the bot still holds in
    /// memory to the database, so the next read is current.
    public struct RefreshInsights: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/insights/refresh" }
        public var method: HTTPMethod { .post }
    }
}

// MARK: - Model

/// The Insights page: one server's activity for a range, and refreshing it.
@MainActor
@Observable
public final class InsightsModel {
    public let server: ServerID
    /// The range shown. Changing it does not load; the view calls ``load()`` for the new one.
    public var range: InsightsRange = .last30Days
    public private(set) var report: InsightsReport?
    public private(set) var isLoading = false
    public private(set) var isRefreshing = false
    /// Why the report could not be loaded.
    public var errorMessage: String?
    /// Why the last refresh did not go through.
    public var refreshError: String?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Loads the report for ``range``. An answer for a range the person has since left is dropped.
    public func load() async {
        let requested = range
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await session.send(Endpoints.Insights(server: server, range: requested))
            guard requested == range else { return }
            report = loaded
            errorMessage = nil
        } catch {
            guard requested == range else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// "Refresh now": the bot writes what it has counted since its last save, then the report is
    /// read again. A refresh that fails still reads the report, which is only older.
    public func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        refreshError = nil
        defer { isRefreshing = false }
        do {
            _ = try await session.send(Endpoints.RefreshInsights(server: server))
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { refreshError = error.userMessage }
        }
        await load()
    }
}
