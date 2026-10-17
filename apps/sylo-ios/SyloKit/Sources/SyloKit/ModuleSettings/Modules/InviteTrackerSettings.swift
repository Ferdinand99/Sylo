import Foundation

// Invite tracker (src/modules/inviteTracker.js, normaliseInviteTrackerConfig; web form
// web-v2/src/moduleForms/InviteTracker.jsx): credits members for the people who join through
// their invites, with a join/leave log and a guard against invites that leave right away.

/// The invite tracker settings page.
public struct InviteTrackerPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "invite-tracker"

    public let settings: InviteTrackerSettings
    public let channels: [ChannelOption]
    /// The top inviters (read only).
    public let board: InviteTrackerBoard

    public init(settings: InviteTrackerSettings, channels: [ChannelOption] = [],
                board: InviteTrackerBoard = InviteTrackerBoard()) {
        self.settings = settings
        self.channels = channels
        self.board = board
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, board
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: InviteTrackerSettings())
        channels = try c.decode(forKey: .channels, or: [])
        board = try c.decode(forKey: .board, or: InviteTrackerBoard())
    }
}

public struct InviteTrackerSettings: Codable, Sendable, Equatable {
    /// Where Sylo posts a line for each join and leave, or "" for nowhere.
    public var joinLogChannelId: String
    /// A join that leaves within this many hours isn't counted.
    public var graceHours: Int

    public init(joinLogChannelId: String = "", graceHours: Int = 24) {
        self.joinLogChannelId = joinLogChannelId
        self.graceHours = graceHours
    }

    /// The range the web form allows (the server clamps to at most a week).
    public static let graceHoursRange = 0...168

    private enum CodingKeys: String, CodingKey { case joinLogChannelId, graceHours }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        joinLogChannelId = try c.decode(forKey: .joinLogChannelId, or: "")
        graceHours = try c.decode(forKey: .graceHours, or: 24)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(joinLogChannelId, forKey: .joinLogChannelId)
        try c.encode(graceHours, forKey: .graceHours)
    }
}

/// The invite leaderboard on the settings page.
public struct InviteTrackerBoard: Decodable, Sendable, Hashable {
    /// How many members have invited anyone.
    public let total: Int
    /// False when Sylo lacks Manage Server, so joins can't be credited to an inviter.
    public let canReadInvites: Bool
    /// The top inviters, best first.
    public let rows: [InviteTrackerInviter]

    public init(total: Int = 0, canReadInvites: Bool = true, rows: [InviteTrackerInviter] = []) {
        self.total = total
        self.canReadInvites = canReadInvites
        self.rows = rows
    }

    private enum CodingKeys: String, CodingKey { case total, canReadInvites, rows }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = try c.decode(forKey: .total, or: 0)
        canReadInvites = try c.decode(forKey: .canReadInvites, or: true)
        rows = try c.decode(forKey: .rows, or: [])
    }
}

/// One member on the invite leaderboard.
public struct InviteTrackerInviter: Decodable, Sendable, Hashable {
    public let rank: Int
    public let userId: String
    /// The member's tag, or their id when it can't be looked up.
    public let name: String
    /// Regular joins minus leaves plus bonus.
    public let net: Int
    public let regular: Int
    public let leaves: Int
    public let bonus: Int

    public init(rank: Int, userId: String, name: String, net: Int, regular: Int = 0, leaves: Int = 0,
                bonus: Int = 0) {
        self.rank = rank
        self.userId = userId
        self.name = name
        self.net = net
        self.regular = regular
        self.leaves = leaves
        self.bonus = bonus
    }
}
