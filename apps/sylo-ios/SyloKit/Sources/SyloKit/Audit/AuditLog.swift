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
    /// The settings this entry changed were kept, so "Show changes" and an undo are possible (Sylo 5.2;
    /// false from an older server and for an entry written before that).
    public let hasChange: Bool
    /// The entry this one undid, when it is an undo.
    public let revertsID: String?

    public init(id: String, actor: String, action: String, detail: String? = nil, date: Date,
                hasChange: Bool = false, revertsID: String? = nil) {
        self.id = id
        self.actor = actor
        self.action = action
        self.detail = detail
        self.date = date
        self.hasChange = hasChange
        self.revertsID = revertsID
    }

    private enum CodingKeys: String, CodingKey { case id, actor, action, detail, at, hasChange, revertsId }

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
        hasChange = (try? c.decodeIfPresent(Bool.self, forKey: .hasChange)) ?? false
        // A row id like the entry's own: a number or a string; anything else is none.
        if let number = try? c.decodeIfPresent(Int.self, forKey: .revertsId) {
            revertsID = String(number)
        } else if let text = try? c.decodeIfPresent(String.self, forKey: .revertsId), !text.isEmpty {
            revertsID = text
        } else {
            revertsID = nil
        }
    }
}

/// One kind of change the log has entries of, for the filter (`actions` of the audit answer).
public struct AuditActionCount: Decodable, Sendable, Hashable, Identifiable {
    public let action: String
    public let count: Int

    public var id: String { action }

    public init(action: String, count: Int) {
        self.action = action
        self.count = count
    }

    private enum CodingKeys: String, CodingKey { case action, count }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = try c.decode(String.self, forKey: .action)
        count = c.lenientCount(.count)
    }
}

/// The answer of `GET /api/v2/guilds/:id/audit`: the newest entries first.
public struct AuditLogPage: Decodable, Sendable, Equatable {
    /// How many entries the server keeps per server; older ones are dropped.
    public let kept: Int
    public let entries: [AuditEntry]
    /// There are older entries than these (Sylo 5.2 shows 50 at a time); false from an older server.
    public let hasMore: Bool
    /// The kinds of change recorded, for the filter; empty from an older server.
    public let actions: [AuditActionCount]

    public init(kept: Int = 500, entries: [AuditEntry], hasMore: Bool = false, actions: [AuditActionCount] = []) {
        self.kept = kept
        self.entries = entries
        self.hasMore = hasMore
        self.actions = actions
    }

    private enum CodingKeys: String, CodingKey { case kept, entries, hasMore, actions }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kept = c.lenientCount(.kept)
        entries = try c.decodeLossyArray(of: AuditEntry.self, forKey: .entries)
        hasMore = (try? c.decodeIfPresent(Bool.self, forKey: .hasMore)) ?? false
        actions = try c.decodeLossyArray(of: AuditActionCount.self, forKey: .actions)
    }

    /// This page with an older page's entries added after its own (a "show more").
    public func appending(_ older: AuditLogPage) -> AuditLogPage {
        let known = Set(entries.map(\.id))
        return AuditLogPage(kept: kept, entries: entries + older.entries.filter { !known.contains($0.id) },
                            hasMore: older.hasMore, actions: actions)
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
    /// `GET /api/v2/guilds/:id/audit`: the newest configuration changes of a server. A Sylo 5.2 sends 50
    /// at a time: `before` (the id of the last entry shown) asks for the next ones, and `action` for one
    /// kind of change. Neither is sent unless set, so an older server gets the plain call it knows.
    public struct AuditLog: APIEndpoint {
        public typealias Response = AuditLogPage
        public let server: ServerID
        public let before: String?
        public let action: String?

        public init(server: ServerID, before: String? = nil, action: String? = nil) {
            self.server = server
            self.before = before
            self.action = (action?.isEmpty ?? true) ? nil : action
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/audit" }
        public var query: [URLQueryItem] {
            var items: [URLQueryItem] = []
            if let before, !before.isEmpty { items.append(URLQueryItem(name: "before", value: before)) }
            if let action { items.append(URLQueryItem(name: "action", value: action)) }
            return items
        }
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
    /// One kind of change to show ("module:starboard"); "" shows all.
    public var filter = ""
    public private(set) var isLoadingMore = false
    /// Why "show more" did not work.
    public var moreError: String?

    private let session: AppSession
    /// Goes up with every first-page read, so a slow answer for an old filter is dropped.
    private var newest = 0

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var days: [AuditDay] { page?.days() ?? [] }

    public func title(for entry: AuditEntry) -> String {
        AuditAction.title(for: entry.action, moduleNames: moduleNames)
    }

    /// The kinds of change to filter by, from the server's own list (plus the one picked).
    public var filterChoices: [AuditActionCount] {
        var choices = page?.actions ?? []
        if !filter.isEmpty, !choices.contains(where: { $0.action == filter }) {
            choices.append(AuditActionCount(action: filter, count: 0))
        }
        return choices
    }

    /// Reads the first page (for the filter, if one is picked).
    public func load() async {
        newest += 1
        let mine = newest
        isLoading = true
        defer { if mine == newest { isLoading = false } }
        async let names = loadModuleNames()
        do {
            let loaded = try await session.send(Endpoints.AuditLog(server: server, action: filter))
            if mine == newest {
                page = loaded
                moreError = nil
                errorMessage = nil
            }
        } catch {
            let error = NetworkError(error)
            if mine == newest, error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
        let known = await names
        if !known.isEmpty { moduleNames = known }
    }

    /// Adds the next older entries ("Show 50 more").
    public func loadMore() async {
        guard let current = page, current.hasMore, let last = current.entries.last, !isLoadingMore else { return }
        let mine = newest
        isLoadingMore = true
        moreError = nil
        defer { isLoadingMore = false }
        do {
            let older = try await session.send(Endpoints.AuditLog(server: server, before: last.id, action: filter))
            // The filter changed or the list was read again while this ran.
            guard mine == newest else { return }
            page = current.appending(older)
        } catch {
            let error = NetworkError(error)
            if mine == newest, error != .cancelled, error != .unauthorized { moreError = error.userMessage }
        }
    }

    /// The module names, best effort: the audit log itself does not depend on them.
    private func loadModuleNames() async -> [String: String] {
        guard let overview = try? await session.send(Endpoints.Overview(server: server)) else { return [:] }
        var names: [String: String] = [:]
        for card in overview.groups.flatMap(\.cards) { names[card.id] = card.name }
        return names
    }
}
