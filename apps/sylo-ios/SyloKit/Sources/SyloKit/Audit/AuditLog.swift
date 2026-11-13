import Foundation
import Observation

/// One change in a server's configuration history.
public struct AuditEntry: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    /// Who did it ("Ferdi (dashboard)", "Dashboard", or the bot's own name for automatic changes).
    public let actor: String
    /// The action key: `module:starboard`, `settings:server`, `moderation:lockdown`, …
    public let action: String
    public let detail: String?
    public let date: Date

    public init(id: String, actor: String, action: String, detail: String? = nil, date: Date) {
        self.id = id
        self.actor = actor
        self.action = action
        self.detail = detail
        self.date = date
    }

    private enum CodingKeys: String, CodingKey { case id, actor, action, detail, at }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // A row id: a number on most databases, a string on some.
        if let number = try? c.decode(Int.self, forKey: .id) {
            id = String(number)
        } else {
            id = try c.decode(String.self, forKey: .id)
        }
        actor = try c.decodeIfPresent(String.self, forKey: .actor) ?? ""
        action = try c.decodeIfPresent(String.self, forKey: .action) ?? ""
        let detail = try c.decodeIfPresent(String.self, forKey: .detail)
        self.detail = (detail?.isEmpty ?? true) ? nil : detail
        date = try c.decodeEpochMilliseconds(forKey: .at)
    }
}

/// The answer of `GET /api/v2/guilds/:id/audit`: the newest entries first.
public struct AuditLogPage: Decodable, Sendable, Equatable {
    /// How many entries the server keeps per server; older ones are dropped.
    public let kept: Int
    public let entries: [AuditEntry]

    public init(kept: Int = 500, entries: [AuditEntry]) {
        self.kept = kept
        self.entries = entries
    }

    private enum CodingKeys: String, CodingKey { case kept, entries }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kept = c.lenientCount(.kept)
        entries = try c.decodeLossyArray(of: AuditEntry.self, forKey: .entries)
    }

    /// The entries grouped by calendar day, newest day first and newest entry first inside a day.
    public func days(calendar: Calendar = .current) -> [AuditDay] {
        var days: [AuditDay] = []
        for entry in entries.sorted(by: { $0.date > $1.date }) {
            let start = calendar.startOfDay(for: entry.date)
            if let last = days.last, last.day == start {
                days[days.count - 1] = AuditDay(day: start, entries: last.entries + [entry])
            } else {
                days.append(AuditDay(day: start, entries: [entry]))
            }
        }
        return days
    }
}

/// The entries of one day.
public struct AuditDay: Sendable, Hashable, Identifiable {
    /// The start of the day, in the calendar the entries were grouped with.
    public let day: Date
    public let entries: [AuditEntry]

    public var id: Date { day }
}

/// Plain names for audit action keys, as the dashboard words them.
public enum AuditAction {
    private static let names: [String: String] = [
        "settings:server": "Server settings",
        "moderation:lockdown": "Lockdown",
        "moderation:unlock": "Channel unlocked",
        "moderation:warn-clear": "Warnings cleared",
        "moderation:case-reason": "Case reason edited",
        "personalizer:identity": "Bot name and avatar",
        "personalizer:presence": "Bot status",
        "personalizer:announcement": "Announcement",
        "leveling:vanity": "Leaderboard link",
        "leveling:setxp": "XP changed",
        "leveling:reset": "XP reset",
        "leveling:leaderboard": "Leaderboard",
        "counting:unbench": "Counting access restored",
        "counting:set": "Count set",
        "counting:reset": "Count reset",
        "privacy:member-data": "Member data",
        "warned": "Warning",
    ]

    /// A readable name for an action key: `module:starboard` is the module's name (from
    /// `moduleNames`, id to name), `settings:server` is "Server settings". A key it does not know
    /// becomes words: `some-new:thing` is "Some new thing".
    public static func title(for action: String, moduleNames: [String: String] = [:]) -> String {
        if let known = names[action] { return known }
        if action.hasPrefix("module:") {
            let id = String(action.dropFirst("module:".count))
            if id == "bulk" { return "Several modules" }
            return moduleNames[id] ?? words(id)
        }
        if action.hasPrefix("appeal:") { return "Appeal \(action.dropFirst("appeal:".count))" }
        if action.hasPrefix("moderation:case-") { return "Case \(action.dropFirst("moderation:case-".count))" }
        if action.hasPrefix("command:") { return "Command \(action.dropFirst("command:".count))" }
        let spoken = words(action)
        return spoken.isEmpty ? action : spoken
    }

    /// Punctuation turned into spaces, first letter capital.
    static func words(_ text: String) -> String {
        let spaced = text
            .split(whereSeparator: { ":_-".contains($0) })
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = spaced.first else { return "" }
        return first.uppercased() + spaced.dropFirst()
    }
}

// MARK: - Endpoint

extension Endpoints {
    /// `GET /api/v2/guilds/:id/audit`: the newest 150 configuration changes of a server.
    public struct AuditLog: APIEndpoint {
        public typealias Response = AuditLogPage
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/audit" }
    }
}

// MARK: - Model

/// The Audit log page: a server's configuration history, grouped by day.
@MainActor
@Observable
public final class AuditLogModel {
    public let server: ServerID
    public private(set) var page: AuditLogPage?
    /// Module ids to their names, for entries like `module:starboard`. Filled from the overview;
    /// without it an entry still reads well, from its id.
    public private(set) var moduleNames: [String: String] = [:]
    public private(set) var isLoading = false
    /// Why the log could not be loaded.
    public var errorMessage: String?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var days: [AuditDay] { page?.days() ?? [] }

    public func title(for entry: AuditEntry) -> String {
        AuditAction.title(for: entry.action, moduleNames: moduleNames)
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        async let names = loadModuleNames()
        do {
            page = try await session.send(Endpoints.AuditLog(server: server))
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
        let loaded = await names
        if !loaded.isEmpty { moduleNames = loaded }
    }

    /// The module names, best effort: the audit log itself does not depend on them.
    private func loadModuleNames() async -> [String: String] {
        guard let overview = try? await session.send(Endpoints.Overview(server: server)) else { return [:] }
        var names: [String: String] = [:]
        for card in overview.groups.flatMap(\.cards) { names[card.id] = card.name }
        return names
    }
}
