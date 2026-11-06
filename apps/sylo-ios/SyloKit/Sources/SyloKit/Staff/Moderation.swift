import Foundation

// The moderation hub's infractions part (src/web/routes/v2Staff.js, `staffRouter` under
// /api/v2/guilds/:guildId/moderation; web-v2/src/pages/ModerationHub.jsx): cases, bans, temporary
// bans, channel locks and lockdown, warnings. The hub's other tabs (auto-moderation, warning
// actions, server logging) are module settings the app already has.

/// One moderation case (a warning, kick, ban, timeout, unban ...).
public struct ModerationCase: Decodable, Sendable, Hashable, Identifiable {
    public let caseNumber: Int
    /// `warn`, `ban`, `kick` ... as the server names it.
    public let action: String
    /// False for a case staff deleted (it can be restored).
    public let isActive: Bool
    public let user: String
    public let userId: String
    public let moderator: String
    public let reason: String
    public let detail: String
    public let at: Date?

    public var id: Int { caseNumber }

    public init(
        caseNumber: Int, action: String, isActive: Bool = true, user: String, userId: String = "",
        moderator: String = "", reason: String = "", detail: String = "", at: Date? = nil
    ) {
        self.caseNumber = caseNumber
        self.action = action
        self.isActive = isActive
        self.user = user
        self.userId = userId
        self.moderator = moderator
        self.reason = reason
        self.detail = detail
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case caseNumber, action, active, user, userId, moderator, reason, detail, at
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            caseNumber: try c.decode(Int.self, forKey: .caseNumber),
            action: try c.decode(forKey: .action, or: ""),
            isActive: try c.decode(forKey: .active, or: true),
            user: try c.decode(forKey: .user, or: ""),
            userId: try c.decode(forKey: .userId, or: ""),
            moderator: try c.decode(forKey: .moderator, or: ""),
            reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "",
            detail: try c.decodeIfPresent(String.self, forKey: .detail) ?? "",
            at: try c.decodeEpochMillisecondsIfPresent(forKey: .at))
    }
}

/// A member banned from the server.
public struct BannedMember: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let tag: String
    public let reason: String

    public init(id: String, tag: String, reason: String = "") {
        self.id = id
        self.tag = tag
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case id, tag, reason }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tag = try c.decode(forKey: .tag, or: id)
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
    }
}

/// A ban that lifts by itself.
public struct TempBan: Decodable, Sendable, Hashable, Identifiable {
    public let userId: String
    public let tag: String
    public let reason: String
    /// "2h 5m" or "any moment now", as the server words it.
    public let remaining: String

    public var id: String { userId }

    public init(userId: String, tag: String, reason: String = "", remaining: String = "") {
        self.userId = userId
        self.tag = tag
        self.reason = reason
        self.remaining = remaining
    }

    private enum CodingKeys: String, CodingKey { case userId, tag, reason, remaining }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        tag = try c.decode(forKey: .tag, or: userId)
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
        remaining = try c.decode(forKey: .remaining, or: "")
    }
}

/// A channel members cannot write in.
public struct ChannelLock: Decodable, Sendable, Hashable, Identifiable {
    public let channelId: String
    /// The channel's name; nil when the channel is gone.
    public let name: String?
    public let lockedBy: String
    /// Part of a server lockdown (ended with "End lockdown"), not locked on its own.
    public let isLockdown: Bool
    public let at: Date?

    public var id: String { channelId }

    public init(channelId: String, name: String?, lockedBy: String = "", isLockdown: Bool = false, at: Date? = nil) {
        self.channelId = channelId
        self.name = name
        self.lockedBy = lockedBy
        self.isLockdown = isLockdown
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case channelId, name, lockedBy, lockdown, at }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channelId = try c.decode(String.self, forKey: .channelId)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        lockedBy = try c.decode(forKey: .lockedBy, or: "")
        isLockdown = try c.decode(forKey: .lockdown, or: false)
        at = try c.decodeEpochMillisecondsIfPresent(forKey: .at)
    }
}

/// `GET /api/v2/guilds/:id/moderation`: the newest 200 cases, the bans (first 200), temporary bans
/// and the channel locks.
public struct ModerationPage: Decodable, Sendable, Equatable {
    public let cases: [ModerationCase]
    public let caseTotal: Int
    public let bans: [BannedMember]
    public let bansTotal: Int
    /// Why the ban list could not be read (the bot lacks Ban Members); nil when it could.
    public let bansError: String?
    public let banLimit: Int
    public let channelLocks: [ChannelLock]
    public let tempBans: [TempBan]
    public let lockdownActive: Bool

    public init(
        cases: [ModerationCase] = [], caseTotal: Int? = nil, bans: [BannedMember] = [], bansTotal: Int? = nil,
        bansError: String? = nil, banLimit: Int = 200, channelLocks: [ChannelLock] = [], tempBans: [TempBan] = [],
        lockdownActive: Bool? = nil
    ) {
        self.cases = cases
        self.caseTotal = caseTotal ?? cases.count
        self.bans = bans
        self.bansTotal = bansTotal ?? bans.count
        self.bansError = bansError
        self.banLimit = banLimit
        self.channelLocks = channelLocks
        self.tempBans = tempBans
        self.lockdownActive = lockdownActive ?? channelLocks.contains { $0.isLockdown }
    }

    private enum CodingKeys: String, CodingKey {
        case cases, caseTotal, bans, bansTotal, bansError, banLimit, channelLocks, tempBans, lockdownActive
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let locks = try c.decodeLossyArray(of: ChannelLock.self, forKey: .channelLocks)
        self.init(
            cases: try c.decodeLossyArray(of: ModerationCase.self, forKey: .cases),
            caseTotal: try c.decodeIfPresent(Int.self, forKey: .caseTotal),
            bans: try c.decodeLossyArray(of: BannedMember.self, forKey: .bans),
            bansTotal: try c.decodeIfPresent(Int.self, forKey: .bansTotal),
            bansError: try c.decodeIfPresent(String.self, forKey: .bansError),
            banLimit: try c.decode(forKey: .banLimit, or: 200),
            channelLocks: locks,
            tempBans: try c.decodeLossyArray(of: TempBan.self, forKey: .tempBans),
            lockdownActive: try c.decodeIfPresent(Bool.self, forKey: .lockdownActive))
    }
}

/// The answer to warning a member.
public struct WarnResult: Decodable, Sendable, Equatable {
    /// How many warnings the member has now.
    public let warnings: Int
    public let dmDelivered: Bool

    public init(warnings: Int, dmDelivered: Bool) {
        self.warnings = warnings
        self.dmDelivered = dmDelivered
    }

    private enum CodingKeys: String, CodingKey { case warnings, dmDelivered }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        warnings = try c.decode(forKey: .warnings, or: 0)
        dmDelivered = try c.decode(forKey: .dmDelivered, or: false)
    }

    public var summary: String {
        let count = warnings == 1 ? "1 warning" : "\(warnings) warnings"
        return "Warned. They now have \(count)." + (dmDelivered ? "" : " They could not be sent a DM.")
    }
}

/// `{removed}` after clearing warnings, `{locked}` after a lockdown, `{unlocked}` after ending one.
public struct CountResult: Decodable, Sendable, Equatable {
    public let count: Int

    public init(count: Int) { self.count = count }

    private enum CodingKeys: String, CodingKey { case removed, locked, unlocked }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = try c.decodeIfPresent(Int.self, forKey: .removed) ?? c.decodeIfPresent(Int.self, forKey: .locked)
            ?? c.decodeIfPresent(Int.self, forKey: .unlocked) ?? 0
    }
}

public enum ModerationInput {
    public static let maxWarnReason = 400
    public static let maxCaseReason = 1000

    /// Whether the text is a user id (17 to 20 digits) or a mention (`<@id>`, `<@!id>`), the way the
    /// server's parser reads it. The server has the last word.
    public static func isUserReference(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let id = userID(from: trimmed) else { return false }
        return (17...20).contains(id.count)
    }

    /// The digits of a user id or mention; nil when it is neither.
    public static func userID(from text: String) -> String? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("<@"), value.hasSuffix(">") {
            value = String(value.dropFirst(2).dropLast())
            if value.hasPrefix("!") { value.removeFirst() }
        }
        guard !value.isEmpty, value.allSatisfy({ $0 >= "0" && $0 <= "9" }) else { return nil }
        return value
    }
}

extension Endpoints {
    private static func moderation(_ server: ServerID, _ tail: String) -> String {
        "/api/v2/guilds/\(server.pathComponent)/moderation\(tail)"
    }

    /// `GET /api/v2/guilds/:id/moderation`.
    public struct Moderation: APIEndpoint {
        public typealias Response = ModerationPage
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.moderation(server, "") }
    }

    /// `POST …/moderation/unban` with `{userId}`: also drops a scheduled unban. 404 when not banned.
    public struct Unban: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let userId: String
        public init(server: ServerID, userId: String) {
            self.server = server
            self.userId = userId
        }
        public var path: String { Endpoints.moderation(server, "/unban") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId) }
        private struct Body: Encodable, Sendable { let userId: String }
    }

    /// `POST …/moderation/lock-all`: locks every text channel; answers `{locked}`.
    public struct LockAllChannels: APIEndpoint {
        public typealias Response = CountResult
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.moderation(server, "/lock-all") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/moderation/unlock-all`: ends the lockdown; answers `{unlocked}`.
    public struct UnlockAllChannels: APIEndpoint {
        public typealias Response = CountResult
        public let server: ServerID
        public init(server: ServerID) { self.server = server }
        public var path: String { Endpoints.moderation(server, "/unlock-all") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }

    /// `POST …/moderation/unlock-channel` with `{channelId}`.
    public struct UnlockChannel: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let channelId: String
        public init(server: ServerID, channelId: String) {
            self.server = server
            self.channelId = channelId
        }
        public var path: String { Endpoints.moderation(server, "/unlock-channel") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(channelId: channelId) }
        private struct Body: Encodable, Sendable { let channelId: String }
    }

    /// `POST …/moderation/warn` with `{userId, reason}`: the reason is cut at 400 and is sent to
    /// the member.
    public struct WarnMember: APIEndpoint {
        public typealias Response = WarnResult
        public let server: ServerID
        public let userId: String
        public let reason: String
        public init(server: ServerID, userId: String, reason: String) {
            self.server = server
            self.userId = userId
            self.reason = reason
        }
        public var path: String { Endpoints.moderation(server, "/warn") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId, reason: reason) }
        private struct Body: Encodable, Sendable {
            let userId: String
            let reason: String
        }
    }

    /// `POST …/moderation/warnings/clear` with `{userId}`; answers `{removed}`, 404 when none.
    public struct ClearWarnings: APIEndpoint {
        public typealias Response = CountResult
        public let server: ServerID
        public let userId: String
        public init(server: ServerID, userId: String) {
            self.server = server
            self.userId = userId
        }
        public var path: String { Endpoints.moderation(server, "/warnings/clear") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(userId: userId) }
        private struct Body: Encodable, Sendable { let userId: String }
    }

    /// `POST …/moderation/cases/:n/reason` with `{reason}`.
    public struct EditCaseReason: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let caseNumber: Int
        public let reason: String
        public init(server: ServerID, caseNumber: Int, reason: String) {
            self.server = server
            self.caseNumber = caseNumber
            self.reason = reason
        }
        public var path: String { Endpoints.moderation(server, "/cases/\(caseNumber)/reason") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(reason: reason) }
        private struct Body: Encodable, Sendable { let reason: String }
    }

    /// `POST …/moderation/cases/:n/delete` (soft delete) or `…/restore`.
    public struct SetCaseDeleted: APIEndpoint {
        public typealias Response = OKResponse
        public let server: ServerID
        public let caseNumber: Int
        public let isDeleted: Bool
        public init(server: ServerID, caseNumber: Int, isDeleted: Bool) {
            self.server = server
            self.caseNumber = caseNumber
            self.isDeleted = isDeleted
        }
        public var path: String { Endpoints.moderation(server, "/cases/\(caseNumber)/\(isDeleted ? "delete" : "restore")") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { EmptyBody() }
    }
}

extension RecordListModel where Page == ModerationPage {
    /// The moderation screen's model.
    public convenience init(moderation server: ServerID, session: AppSession) {
        self.init(server: server, session: session) { session, server in
            try await session.send(Endpoints.Moderation(server: server))
        }
    }

    /// Warns a member (the reason is sent to them). - Returns: What the server did, or nil.
    public func warn(userId: String, reason: String) async -> WarnResult? {
        let id = ModerationInput.userID(from: userId) ?? userId
        let trimmed = String(reason.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ModerationInput.maxWarnReason))
        return await perform { session, server in
            try await session.send(Endpoints.WarnMember(server: server, userId: id, reason: trimmed))
        }
    }

    /// Removes every warning a member has. - Returns: How many were removed, or nil.
    public func clearWarnings(userId: String) async -> Int? {
        let id = ModerationInput.userID(from: userId) ?? userId
        let result: CountResult? = await perform { session, server in
            try await session.send(Endpoints.ClearWarnings(server: server, userId: id))
        }
        return result?.count
    }

    public func unban(userId: String) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.Unban(server: server, userId: userId))
            return true
        }
        return done != nil
    }

    /// Locks every text channel. - Returns: How many were locked, or nil.
    public func lockAll() async -> Int? {
        let result: CountResult? = await perform { session, server in
            try await session.send(Endpoints.LockAllChannels(server: server))
        }
        return result?.count
    }

    /// Ends the lockdown. - Returns: How many were unlocked, or nil.
    public func unlockAll() async -> Int? {
        let result: CountResult? = await perform { session, server in
            try await session.send(Endpoints.UnlockAllChannels(server: server))
        }
        return result?.count
    }

    public func unlock(channelId: String) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.UnlockChannel(server: server, channelId: channelId))
            return true
        }
        return done != nil
    }

    public func editReason(of caseNumber: Int, to reason: String) async -> Bool {
        let trimmed = String(reason.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ModerationInput.maxCaseReason))
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.EditCaseReason(server: server, caseNumber: caseNumber, reason: trimmed))
            return true
        }
        return done != nil
    }

    public func setDeleted(_ isDeleted: Bool, caseNumber: Int) async -> Bool {
        let done: Bool? = await perform { session, server in
            _ = try await session.send(Endpoints.SetCaseDeleted(server: server, caseNumber: caseNumber, isDeleted: isDeleted))
            return true
        }
        return done != nil
    }
}
