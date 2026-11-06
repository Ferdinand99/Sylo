import Foundation
import Observation

// The server tools the web dashboard has next to the modules: per command limits (the Commands tab
// of the moderation page, src/web/routes/v2Staff.js `/commands`), the audit log, member data
// (src/web/routes/v2GuildData.js), the leaderboard admin bits (v2Api.js `/leaderboard`) and the
// configuration export.

// MARK: - Commands

/// One slash command and what this server does with it.
public struct CommandLimit: Decodable, Sendable, Hashable, Identifiable {
    public let name: String
    public let description: String
    public var isEnabled: Bool
    /// Only these channels may run it; empty means every channel.
    public var allowedChannels: [String]
    /// Only these roles may run it; empty means everyone.
    public var allowedRoles: [String]

    public var id: String { name }

    public init(
        name: String, description: String = "", isEnabled: Bool = true, allowedChannels: [String] = [],
        allowedRoles: [String] = []
    ) {
        self.name = name
        self.description = description
        self.isEnabled = isEnabled
        self.allowedChannels = allowedChannels
        self.allowedRoles = allowedRoles
    }

    private enum CodingKeys: String, CodingKey { case name, description, enabled, allowedChannels, allowedRoles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(String.self, forKey: .name),
            description: try c.decodeIfPresent(String.self, forKey: .description) ?? "",
            isEnabled: try c.decode(forKey: .enabled, or: true),
            allowedChannels: try c.decode(forKey: .allowedChannels, or: []),
            allowedRoles: try c.decode(forKey: .allowedRoles, or: []))
    }

    /// Whether anything limits who may use it where.
    public var isLimited: Bool { !allowedChannels.isEmpty || !allowedRoles.isEmpty }
}

/// `GET /api/v2/guilds/:id/commands`.
public struct CommandsPage: Decodable, Sendable, Equatable {
    public let commands: [CommandLimit]
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(commands: [CommandLimit] = [], channels: [ChannelOption] = [], roles: [RoleOption] = []) {
        self.commands = commands
        self.channels = channels
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey { case commands, channels, roles }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            commands: try c.decodeLossyArray(of: CommandLimit.self, forKey: .commands),
            channels: try c.decode(forKey: .channels, or: []),
            roles: try c.decode(forKey: .roles, or: []))
    }

    /// The commands whose name or description contains the text (ignoring case); all for no text.
    public func commands(matching query: String) -> [CommandLimit] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return commands }
        return commands.filter {
            $0.name.localizedCaseInsensitiveContains(text) || $0.description.localizedCaseInsensitiveContains(text)
        }
    }
}

// MARK: - Audit log

/// One entry of the configuration change history.
public struct AuditEntry: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let actor: String
    /// The action key (`module:starboard`, `settings:server`, `appeal:accepted` ...).
    public let action: String
    public let detail: String
    public let at: Date?

    public init(id: Int, actor: String, action: String, detail: String = "", at: Date? = nil) {
        self.id = id
        self.actor = actor
        self.action = action
        self.detail = detail
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case id, actor, action, detail, at }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            actor: try c.decode(forKey: .actor, or: ""),
            action: try c.decode(forKey: .action, or: ""),
            detail: try c.decodeIfPresent(String.self, forKey: .detail) ?? "",
            at: try c.decodeEpochMillisecondsIfPresent(forKey: .at))
    }

    /// A readable name for the action key, like the dashboard's `auditActionLabel`:
    /// `module:starboard` is the module's name, `settings:server` is "Server settings".
    public func label(moduleNames: [String: String] = [:]) -> String {
        Self.label(for: action, moduleNames: moduleNames)
    }

    public static func label(for action: String, moduleNames: [String: String] = [:]) -> String {
        if let known = known[action] { return known }
        if action.hasPrefix("module:") {
            let id = String(action.dropFirst("module:".count))
            if id == "bulk" { return "Several modules" }
            return moduleNames[id] ?? words(id)
        }
        if action.hasPrefix("appeal:") { return "Appeal \(action.dropFirst("appeal:".count))" }
        if action.hasPrefix("moderation:case-") { return "Case \(action.dropFirst("moderation:case-".count))" }
        if action.hasPrefix("command:") { return "Command \(action.dropFirst("command:".count))" }
        let text = words(action)
        return text.isEmpty ? action : text
    }

    private static let known: [String: String] = [
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

    /// "temp-roles" becomes "Temp roles".
    private static func words(_ text: String) -> String {
        let spaced = text.map { ":_-".contains($0) ? " " : $0 }
        let trimmed = String(spaced).trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return "" }
        return first.uppercased() + trimmed.dropFirst()
    }
}

/// `GET /api/v2/guilds/:id/audit`: the newest 150 entries of the 500 kept per server.
public struct AuditPage: Decodable, Sendable, Equatable {
    public let kept: Int
    public let entries: [AuditEntry]

    public init(kept: Int = 500, entries: [AuditEntry] = []) {
        self.kept = kept
        self.entries = entries
    }

    private enum CodingKeys: String, CodingKey { case kept, entries }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            kept: try c.decode(forKey: .kept, or: 500),
            entries: try c.decodeLossyArray(of: AuditEntry.self, forKey: .entries))
    }
}

// MARK: - Member data

/// The member a lookup found.
public struct MemberProfile: Decodable, Sendable, Hashable {
    public let id: String
    /// nil when the platform could not name them.
    public let tag: String?
    public let avatarURL: URL?

    public init(id: String, tag: String? = nil, avatarURL: URL? = nil) {
        self.id = id
        self.tag = tag
        self.avatarURL = avatarURL
    }

    private enum CodingKeys: String, CodingKey { case id, tag, avatar }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tag = try c.decodeIfPresent(String.self, forKey: .tag)
        avatarURL = try c.decodeURLIfPresent(forKey: .avatar)
    }

    public var displayName: String { tag ?? id }
}

/// One kind of data Sylo stores about a member, and how much of it.
public struct MemberDataItem: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let label: String
    public let count: Int
    /// Safety records the deletion keeps.
    public let isKept: Bool

    public var id: String { key }

    public init(key: String, label: String, count: Int, isKept: Bool = false) {
        self.key = key
        self.label = label
        self.count = count
        self.isKept = isKept
    }

    private enum CodingKeys: String, CodingKey { case key, label, count, kept }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decode(forKey: .label, or: key)
        count = try c.decode(forKey: .count, or: 0)
        isKept = try c.decode(forKey: .kept, or: false)
    }
}

/// What a lookup found: the member and the counts per source.
public struct MemberLookup: Decodable, Sendable, Equatable {
    public let profile: MemberProfile
    public let items: [MemberDataItem]
    public let total: Int
    /// How much of it deleting removes or anonymises (the rest is kept).
    public let erasable: Int

    public init(profile: MemberProfile, items: [MemberDataItem] = [], total: Int? = nil, erasable: Int? = nil) {
        self.profile = profile
        self.items = items
        self.total = total ?? items.reduce(0) { $0 + $1.count }
        self.erasable = erasable ?? items.filter { !$0.isKept }.reduce(0) { $0 + $1.count }
    }

    private enum CodingKeys: String, CodingKey { case profile, data }
    private enum DataKeys: String, CodingKey { case items, total, erasable }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let data = try c.nestedContainer(keyedBy: DataKeys.self, forKey: .data)
        self.init(
            profile: try c.decode(MemberProfile.self, forKey: .profile),
            items: try data.decodeLossyArray(of: MemberDataItem.self, forKey: .items),
            total: try data.decodeIfPresent(Int.self, forKey: .total),
            erasable: try data.decodeIfPresent(Int.self, forKey: .erasable))
    }

    /// The rows with something stored.
    public var shownItems: [MemberDataItem] { items.filter { $0.count > 0 } }
}

/// `GET /api/v2/guilds/:id/member-data?user=`: no lookup without a user.
public struct MemberDataPage: Decodable, Sendable, Equatable {
    public let lookup: MemberLookup?
    /// What deleting leaves alone, in the server's words.
    public let unaffected: String

    public init(lookup: MemberLookup? = nil, unaffected: String = "") {
        self.lookup = lookup
        self.unaffected = unaffected
    }

    private enum CodingKeys: String, CodingKey { case lookup, unaffected }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lookup = try c.decodeIfPresent(MemberLookup.self, forKey: .lookup)
        unaffected = try c.decode(forKey: .unaffected, or: "")
    }
}

/// The answer to deleting a member's data.
public struct ForgetResult: Decodable, Sendable, Equatable {
    public let dmDelivered: Bool

    public init(dmDelivered: Bool) { self.dmDelivered = dmDelivered }

    private enum CodingKeys: String, CodingKey { case dmDelivered }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dmDelivered = try c.decode(forKey: .dmDelivered, or: false)
    }

    public var summary: String {
        dmDelivered
            ? "Member data deleted. Sylo DM'd the member a confirmation of what was removed."
            : "Member data deleted, but Sylo could not DM the member (no shared server or their DMs are closed). Let them know directly."
    }
}

// MARK: - Leaderboard

/// One ranked member.
public struct LeaderboardRow: Decodable, Sendable, Hashable, Identifiable {
    public let rank: Int
    public let name: String
    /// nil for the weekly and monthly boards.
    public let level: Int?
    public let xp: Int
    public let messages: Int

    public var id: Int { rank }

    public init(rank: Int, name: String, level: Int? = nil, xp: Int = 0, messages: Int = 0) {
        self.rank = rank
        self.name = name
        self.level = level
        self.xp = xp
        self.messages = messages
    }

    private enum CodingKeys: String, CodingKey { case rank, name, level, xp, messages }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            rank: try c.decode(Int.self, forKey: .rank),
            name: try c.decode(forKey: .name, or: ""),
            level: try c.decodeIfPresent(Int.self, forKey: .level),
            xp: try c.decode(forKey: .xp, or: 0),
            messages: try c.decode(forKey: .messages, or: 0))
    }
}

/// Which time span the leaderboard covers.
public enum LeaderboardPeriod: String, Sendable, CaseIterable, Identifiable {
    case all
    case week
    case month

    public var id: String { rawValue }
}

/// `GET /api/v2/guilds/:id/leaderboard?period=`: the top ten.
public struct LeaderboardPage: Decodable, Sendable, Equatable {
    public let levelingEnabled: Bool
    public var isPublic: Bool
    public var vanitySlug: String?
    public let period: LeaderboardPeriod
    /// How many members are ranked in all.
    public let total: Int
    public let rows: [LeaderboardRow]
    /// The server's own id for the server, which the public page's address is built from.
    public let guildID: String

    public init(
        levelingEnabled: Bool = true, isPublic: Bool = false, vanitySlug: String? = nil,
        period: LeaderboardPeriod = .all, total: Int = 0, rows: [LeaderboardRow] = [], guildID: String = ""
    ) {
        self.levelingEnabled = levelingEnabled
        self.isPublic = isPublic
        self.vanitySlug = vanitySlug
        self.period = period
        self.total = total
        self.rows = rows
        self.guildID = guildID
    }

    private enum CodingKeys: String, CodingKey {
        case guild, levelingEnabled, publicLeaderboard, period, vanitySlug, total, rows
    }
    private struct GuildKeys: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var guildID = ""
        if let guild = try? c.nestedContainer(keyedBy: GuildKeys.self, forKey: .guild),
           let key = GuildKeys(stringValue: "id") {
            guildID = (try? guild.decodeIfPresent(String.self, forKey: key)) ?? ""
        }
        let raw = try c.decodeIfPresent(String.self, forKey: .period) ?? "all"
        self.init(
            levelingEnabled: try c.decode(forKey: .levelingEnabled, or: true),
            isPublic: try c.decode(forKey: .publicLeaderboard, or: false),
            vanitySlug: try c.decodeIfPresent(String.self, forKey: .vanitySlug),
            period: LeaderboardPeriod(rawValue: raw) ?? .all,
            total: try c.decode(forKey: .total, or: 0),
            rows: try c.decodeLossyArray(of: LeaderboardRow.self, forKey: .rows),
            guildID: guildID)
    }

    /// The path of the public page: the vanity link when set, else the server's id.
    public var publicPath: String? {
        guard isPublic else { return nil }
        if let slug = vanitySlug, !slug.isEmpty { return "lb/\(slug.encodedPathSegment)" }
        return guildID.isEmpty ? nil : "leaderboard/\(guildID.encodedPathSegment)"
    }
}

// MARK: - Endpoints

extension Endpoints {
    /// `GET /api/v2/guilds/:id/commands`.
    public struct Commands: APIEndpoint {
        public typealias Response = CommandsPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/commands" }
    }

    /// `POST /api/v2/guilds/:id/commands/:command` with `{enabled, channels, roles}`: replaces the
    /// command's limits (empty lists mean no limit). 404 for an unknown command.
    public struct SaveCommand: APIEndpoint {
        public typealias Response = SavedCommand
        public let server: ServerID
        public let command: CommandLimit
        public init(server: ServerID, command: CommandLimit) {
            self.server = server
            self.command = command
        }
        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/commands/\(command.name.encodedPathSegment)"
        }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(enabled: command.isEnabled, channels: command.allowedChannels, roles: command.allowedRoles)
        }
        private struct Body: Encodable, Sendable {
            let enabled: Bool
            let channels: [String]
            let roles: [String]
        }
    }

    /// `GET /api/v2/guilds/:id/audit`.
    public struct Audit: APIEndpoint {
        public typealias Response = AuditPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/audit" }
    }

    /// `GET /api/v2/guilds/:id/member-data?user=`: no `user` looks nothing up; a bad one is a 400.
    public struct MemberData: APIEndpoint {
        public typealias Response = MemberDataPage
        public let server: ServerID
        public let user: String
        public init(server: ServerID, user: String) {
            self.server = server
            self.user = user
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/member-data" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "user", value: user)] }
    }

    /// `POST /api/v2/guilds/:id/member-data/forget` with `{userId, reason, confirm: true}`: deletes
    /// what Sylo stores about the member (cases and other safety records stay) and DMs them.
    public struct ForgetMember: APIEndpoint {
        public typealias Response = ForgetResult
        public static let maxReasonLength = 500
        public let server: ServerID
        public let userId: String
        public let reason: String
        public init(server: ServerID, userId: String, reason: String) {
            self.server = server
            self.userId = userId
            self.reason = reason
        }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/member-data/forget" }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? {
            Body(userId: userId, reason: String(reason.prefix(Self.maxReasonLength)))
        }
        private struct Body: Encodable, Sendable {
            let userId: String
            let reason: String
            let confirm = true
        }
    }

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

    /// `POST …/leaderboard/public` with `{publicLeaderboard}`; answers the new value.
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

    /// `POST …/leaderboard/vanity` with `{slug}`; an empty slug clears the link, a taken or invalid
    /// one is a 400 with the reason. Answers `{vanitySlug}`.
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

    /// `GET /api/v2/guilds/:id/export`: the module configuration as JSON (a download on the web).
    public struct ExportConfig: APIEndpoint {
        public typealias Response = JSONValue
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { "/api/v2/guilds/\(server.pathComponent)/export" }
    }
}

/// The answer to saving a command's limits.
public struct SavedCommand: Decodable, Sendable, Equatable {
    public let command: CommandLimit
}

public struct LeaderboardPublicResult: Decodable, Sendable, Equatable {
    public let publicLeaderboard: Bool
}

public struct LeaderboardVanityResult: Decodable, Sendable, Equatable {
    public let vanitySlug: String?
}

// MARK: - Models

extension RecordListModel where Page == CommandsPage {
    public convenience init(commands server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.Commands(server: server))
        }
    }

    public func save(_ command: CommandLimit) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SaveCommand(server: server, command: command))
            return true
        }
        return done != nil
    }
}

extension RecordListModel where Page == AuditPage {
    public convenience init(audit server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.Audit(server: server))
        }
    }
}

/// The leaderboard of one server: the top ten of a period, and the public link settings.
@MainActor
@Observable
public final class LeaderboardModel {
    public let server: ServerID
    public private(set) var page: LeaderboardPage?
    /// The span the list shows; change it with ``select(_:)``.
    public private(set) var period = LeaderboardPeriod.all
    public private(set) var isLoading = false
    public private(set) var isWorking = false
    /// Why the page could not be loaded.
    public var errorMessage: String?
    /// Why the last change was refused ("That link is taken.").
    public var actionError: String?
    public private(set) var changeCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        let wanted = period
        do {
            let loaded = try await session.send(Endpoints.Leaderboard(server: server, period: wanted))
            // A newer pick of the period replaced this one while it was on its way.
            guard wanted == period else { return }
            page = loaded
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized, wanted == period { errorMessage = error.detailMessage }
        }
    }

    /// Shows another period.
    public func select(_ period: LeaderboardPeriod) async {
        guard period != self.period else { return }
        self.period = period
        await load()
    }

    /// Makes the leaderboard public or private.
    public func setPublic(_ isPublic: Bool) async -> Bool {
        await change {
            _ = try await self.session.send(Endpoints.SetLeaderboardPublic(server: self.server, isPublic: isPublic))
        }
    }

    /// Sets the vanity link; an empty text clears it.
    public func setVanity(_ slug: String) async -> Bool {
        let trimmed = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        return await change {
            _ = try await self.session.send(Endpoints.SetLeaderboardVanity(server: self.server, slug: trimmed))
        }
    }

    private func change(_ work: @MainActor () async throws -> Void) async -> Bool {
        guard !isWorking else {
            actionError = "Another change is still saving."
            return false
        }
        isWorking = true
        actionError = nil
        defer { isWorking = false }
        do {
            try await work()
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.detailMessage }
            return false
        }
        changeCount += 1
        session.noteModulesChanged()
        await load()
        return true
    }
}

/// Looks a member up by id or mention and deletes their data on request.
@MainActor
@Observable
public final class MemberDataModel {
    public let server: ServerID
    public private(set) var lookup: MemberLookup?
    public private(set) var unaffected = ""
    public private(set) var isWorking = false
    /// Why the lookup or the deletion failed.
    public var errorMessage: String?
    /// What to tell staff after a deletion.
    public var deletionNotice: String?
    public private(set) var deleteCount = 0

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Looks the member up; an empty or malformed reference is refused before it is sent.
    public func look(up reference: String) async {
        let text = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard ModerationInput.isUserReference(text) else {
            errorMessage = "That is not a user ID or mention."
            return
        }
        await run {
            let page = try await self.session.send(Endpoints.MemberData(server: self.server, user: text))
            self.lookup = page.lookup
            self.unaffected = page.unaffected
        }
    }

    /// Deletes the member's data, then reads it again.
    public func forget(note: String) async {
        guard let lookup else { return }
        let id = lookup.profile.id
        await run {
            let result = try await self.session.send(
                Endpoints.ForgetMember(server: self.server, userId: id, reason: note.trimmingCharacters(in: .whitespacesAndNewlines)))
            self.deletionNotice = result.summary
            self.deleteCount += 1
            let page = try await self.session.send(Endpoints.MemberData(server: self.server, user: id))
            self.lookup = page.lookup
            self.unaffected = page.unaffected
        }
    }

    private func run(_ work: @MainActor () async throws -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        do {
            try await work()
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
        }
    }
}

/// Fetches the server's configuration and writes it as a JSON file to share.
@MainActor
@Observable
public final class ConfigExportModel {
    public let server: ServerID
    public private(set) var fileURL: URL?
    public private(set) var isWorking = false
    public var errorMessage: String?

    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public func export() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        do {
            let value = try await session.send(Endpoints.ExportConfig(server: server))
            fileURL = try Self.write(value, server: server)
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.detailMessage }
        }
    }

    /// Pretty printed JSON in a temporary file named like the dashboard's download.
    static func write(_ value: JSONValue, server: ServerID) throws -> URL {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(value)
        let safe = String(server.rawValue.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? $0 : "-" })
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sylo-\(safe)-config.json")
        try data.write(to: url, options: .atomic)
        return url
    }
}
