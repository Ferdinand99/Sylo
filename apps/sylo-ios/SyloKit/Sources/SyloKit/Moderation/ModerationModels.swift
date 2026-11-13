import Foundation

// The moderation hub (src/web/routes/v2Staff.js: `GET /moderation` and the calls under it). Staff
// read cases, bans and channel locks, and act on them the way the dashboard's Infractions tab
// does. Every call is staff only on the server. The server's own words (`error`) are shown as they
// come; see `NetworkError.userMessage`.

/// One moderation case: a warning, mute, kick, ban or any other action Sylo logged.
public struct ModerationCase: Decodable, Sendable, Hashable, Identifiable {
    public let caseNumber: Int
    /// `warn`, `ban`, `mute` ... as Sylo logged it; kept as sent so an unknown one still shows.
    public let action: String
    /// False once a moderator deleted the case. It stays on record and can be restored.
    public let active: Bool
    /// The member, as a name or tag; empty when Sylo cannot name them.
    public let user: String
    public let userId: String
    /// Who did it: a moderator's name, `Dashboard`, `AutoMod`, `auto-threshold` or `system`.
    public let moderator: String
    /// "" when none.
    public let reason: String
    /// Extra detail such as a duration; "" when none.
    public let detail: String
    /// When, in milliseconds since 1970.
    public let at: Double?

    public var id: Int { caseNumber }
    public var date: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }

    public init(
        caseNumber: Int, action: String = "warn", active: Bool = true, user: String = "", userId: String = "",
        moderator: String = "", reason: String = "", detail: String = "", at: Double? = nil
    ) {
        self.caseNumber = caseNumber
        self.action = action
        self.active = active
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
            active: try c.decode(forKey: .active, or: true),
            user: try c.decodeIfPresent(String.self, forKey: .user) ?? "",
            userId: try c.decodeIfPresent(String.self, forKey: .userId) ?? "",
            moderator: try c.decodeIfPresent(String.self, forKey: .moderator) ?? "",
            reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "",
            detail: try c.decodeIfPresent(String.self, forKey: .detail) ?? "",
            at: try c.decodeIfPresent(Double.self, forKey: .at))
    }

    /// The member's name, or their id when the server could not name them.
    public var memberName: String { user.isEmpty ? userId : user }
}

/// A member who is banned on the platform.
public struct ModerationBan: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let tag: String
    /// "" when none; the server sends a dash for no reason, which is dropped here.
    public let reason: String

    public init(id: String, tag: String = "", reason: String = "") {
        self.id = id
        self.tag = tag
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey { case id, tag, reason }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
        self.init(
            id: try c.decode(String.self, forKey: .id),
            tag: try c.decodeIfPresent(String.self, forKey: .tag) ?? "",
            reason: reason == "\u{2014}" ? "" : reason)
    }

    public var name: String { tag.isEmpty ? id : tag }
}

/// A ban that lifts by itself.
public struct ModerationTempBan: Decodable, Sendable, Hashable, Identifiable {
    public let userId: String
    public let tag: String
    public let reason: String
    /// How long is left, worded by the server ("3 hours", "any moment now").
    public let remaining: String

    public var id: String { userId }
    public var name: String { tag.isEmpty ? userId : tag }

    public init(userId: String, tag: String = "", reason: String = "", remaining: String = "") {
        self.userId = userId
        self.tag = tag
        self.reason = reason
        self.remaining = remaining
    }

    private enum CodingKeys: String, CodingKey { case userId, tag, reason, remaining }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            userId: try c.decode(String.self, forKey: .userId),
            tag: try c.decodeIfPresent(String.self, forKey: .tag) ?? "",
            reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "",
            remaining: try c.decodeIfPresent(String.self, forKey: .remaining) ?? "")
    }
}

/// A locked channel.
public struct ChannelLock: Decodable, Sendable, Hashable, Identifiable {
    public let channelId: String
    /// nil when the channel no longer exists.
    public let name: String?
    public let lockedBy: String
    /// Part of a server lockdown, rather than locked on its own.
    public let lockdown: Bool
    /// When, in milliseconds since 1970.
    public let at: Double?

    public var id: String { channelId }
    public var date: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }

    public init(channelId: String, name: String? = nil, lockedBy: String = "", lockdown: Bool = false, at: Double? = nil) {
        self.channelId = channelId
        self.name = name
        self.lockedBy = lockedBy
        self.lockdown = lockdown
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case channelId, name, lockedBy, lockdown, at }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            channelId: try c.decode(String.self, forKey: .channelId),
            name: try c.decodeIfPresent(String.self, forKey: .name),
            lockedBy: try c.decodeIfPresent(String.self, forKey: .lockedBy) ?? "",
            lockdown: try c.decode(forKey: .lockdown, or: false),
            at: try c.decodeIfPresent(Double.self, forKey: .at))
    }
}

/// `GET /moderation`: the newest cases, the bans, the locks and the scheduled unbans.
public struct ModerationOverview: Decodable, Sendable, Equatable {
    /// Newest first, at most 200.
    public let cases: [ModerationCase]
    /// How many cases the server has in all.
    public let caseTotal: Int
    public let bans: [ModerationBan]
    public let bansTotal: Int
    /// Why the ban list could not be read (the bot lacks the permission), in the server's words.
    public let bansError: String?
    /// How many bans the list shows at most.
    public let banLimit: Int
    public let channelLocks: [ChannelLock]
    public let tempBans: [ModerationTempBan]
    public let lockdownActive: Bool

    public init(
        cases: [ModerationCase] = [], caseTotal: Int? = nil, bans: [ModerationBan] = [], bansTotal: Int? = nil,
        bansError: String? = nil, banLimit: Int = 200, channelLocks: [ChannelLock] = [],
        tempBans: [ModerationTempBan] = [], lockdownActive: Bool? = nil
    ) {
        self.cases = cases
        self.caseTotal = caseTotal ?? cases.count
        self.bans = bans
        self.bansTotal = bansTotal ?? bans.count
        self.bansError = bansError
        self.banLimit = banLimit
        self.channelLocks = channelLocks
        self.tempBans = tempBans
        self.lockdownActive = lockdownActive ?? channelLocks.contains { $0.lockdown }
    }

    private enum CodingKeys: String, CodingKey {
        case cases, caseTotal, bans, bansTotal, bansError, banLimit, channelLocks, tempBans, lockdownActive
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let error = try c.decodeIfPresent(String.self, forKey: .bansError)
        self.init(
            cases: try c.decodeLossyArray(of: ModerationCase.self, forKey: .cases),
            caseTotal: try c.decodeIfPresent(Int.self, forKey: .caseTotal),
            bans: try c.decodeLossyArray(of: ModerationBan.self, forKey: .bans),
            bansTotal: try c.decodeIfPresent(Int.self, forKey: .bansTotal),
            bansError: (error?.isEmpty ?? true) ? nil : error,
            banLimit: try c.decode(forKey: .banLimit, or: 200),
            channelLocks: try c.decodeLossyArray(of: ChannelLock.self, forKey: .channelLocks),
            tempBans: try c.decodeLossyArray(of: ModerationTempBan.self, forKey: .tempBans),
            lockdownActive: try c.decodeIfPresent(Bool.self, forKey: .lockdownActive))
    }
}

/// The answer to a warning: how many the member has now, and whether they were told by DM.
public struct WarnResult: Decodable, Sendable, Equatable {
    public let warnings: Int
    public let dmDelivered: Bool
    /// Whether the warning reached the mod log.
    public let logged: Bool

    public init(warnings: Int, dmDelivered: Bool = true, logged: Bool = true) {
        self.warnings = warnings
        self.dmDelivered = dmDelivered
        self.logged = logged
    }

    private enum CodingKeys: String, CodingKey { case warnings, dmDelivered, logged }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            warnings: try c.decode(forKey: .warnings, or: 0),
            dmDelivered: try c.decode(forKey: .dmDelivered, or: true),
            logged: try c.decode(forKey: .logged, or: true))
    }
}

/// The answer to clearing a member's warnings.
public struct ClearWarningsResult: Decodable, Sendable, Equatable {
    public let removed: Int

    public init(removed: Int) { self.removed = removed }

    private enum CodingKeys: String, CodingKey { case removed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        removed = try c.decode(forKey: .removed, or: 0)
    }
}

/// The answer to locking every channel.
public struct LockAllResult: Decodable, Sendable, Equatable {
    public let locked: Int

    public init(locked: Int) { self.locked = locked }

    private enum CodingKeys: String, CodingKey { case locked }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        locked = try c.decode(forKey: .locked, or: 0)
    }
}

/// The answer to ending a lockdown.
public struct UnlockAllResult: Decodable, Sendable, Equatable {
    public let unlocked: Int

    public init(unlocked: Int) { self.unlocked = unlocked }

    private enum CodingKeys: String, CodingKey { case unlocked }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        unlocked = try c.decode(forKey: .unlocked, or: 0)
    }
}

/// The answer to deleting or restoring a case: whether it counts now.
public struct CaseActiveResult: Decodable, Sendable, Equatable {
    public let active: Bool

    public init(active: Bool) { self.active = active }

    private enum CodingKeys: String, CodingKey { case active }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = try c.decode(forKey: .active, or: true)
    }
}
