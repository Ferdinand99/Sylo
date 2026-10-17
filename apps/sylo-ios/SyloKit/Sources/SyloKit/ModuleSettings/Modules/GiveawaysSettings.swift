import Foundation

// Giveaways (src/modules/giveaways.js, normaliseGiveawaysConfig; web form
// web-v2/src/moduleForms/Giveaways.jsx): who is pinged when winners are drawn and whether
// winners get a DM, plus the running and recently ended giveaways (started with
// `/giveaway start`, so read only here).

/// The Giveaways settings page.
public struct GiveawaysPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "giveaways"

    public let settings: GiveawaysSettings
    /// Running giveaways (soonest end first), then up to 8 recently ended ones (newest first).
    public let giveaways: [GiveawaysGiveaway]

    public init(settings: GiveawaysSettings, giveaways: [GiveawaysGiveaway] = []) {
        self.settings = settings
        self.giveaways = giveaways
    }

    public var activeGiveaways: [GiveawaysGiveaway] { giveaways.filter { $0.state == .active } }
    public var endedGiveaways: [GiveawaysGiveaway] { giveaways.filter { $0.state == .ended } }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case giveaways
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: GiveawaysSettings())
        giveaways = try c.decode(forKey: .giveaways, or: [])
    }
}

/// Who the winner message pings.
public enum GiveawaysPing: String, Codable, Sendable, CaseIterable {
    case none, here, everyone

    public init(from decoder: any Decoder) throws {
        self = GiveawaysPing(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .none
    }
}

public struct GiveawaysSettings: Codable, Sendable, Equatable {
    public var ping: GiveawaysPing
    /// Also DM each winner.
    public var dmWinners: Bool

    public init(ping: GiveawaysPing = .none, dmWinners: Bool = false) {
        self.ping = ping
        self.dmWinners = dmWinners
    }

    private enum CodingKeys: String, CodingKey { case ping, dmWinners }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ping = try c.decode(forKey: .ping, or: .none)
        dmWinners = try c.decode(forKey: .dmWinners, or: false)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ping, forKey: .ping)
        try c.encode(dmWinners, forKey: .dmWinners)
    }
}

/// One giveaway, for the lists under the settings (bot-managed, read only).
public struct GiveawaysGiveaway: Decodable, Sendable, Hashable, Identifiable {
    public enum State: String, Decodable, Sendable {
        case active, ended

        public init(from decoder: any Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .active
        }
    }

    public let id: Int
    public let prize: String
    public let state: State
    /// How many winners it draws.
    public let winners: Int
    public let endsAt: Date
    public let entries: Int
    /// The user ids that won (ended giveaways).
    public let wonIds: [String]
    /// The channel's name (or its id when the channel is gone).
    public let channel: String
    /// Only members with this role may enter.
    public let requiredRoleId: String?

    public init(id: Int, prize: String, state: State = .active, winners: Int = 1, endsAt: Date,
                entries: Int = 0, wonIds: [String] = [], channel: String = "", requiredRoleId: String? = nil) {
        self.id = id
        self.prize = prize
        self.state = state
        self.winners = winners
        self.endsAt = endsAt
        self.entries = entries
        self.wonIds = wonIds
        self.channel = channel
        self.requiredRoleId = requiredRoleId
    }

    public var isRoleGated: Bool { !(requiredRoleId ?? "").isEmpty }

    private enum CodingKeys: String, CodingKey {
        case id, prize, state, winners, endsAt, entries, wonIds, channel, requiredRoleId
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let endsAtMs = try c.decode(Double.self, forKey: .endsAt, or: 0)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            prize: try c.decode(forKey: .prize, or: ""),
            state: try c.decode(forKey: .state, or: .active),
            winners: try c.decode(forKey: .winners, or: 1),
            endsAt: Date(timeIntervalSince1970: endsAtMs / 1000),
            entries: try c.decode(forKey: .entries, or: 0),
            wonIds: try c.decode(forKey: .wonIds, or: []),
            channel: try c.decode(forKey: .channel, or: ""),
            requiredRoleId: try c.decodeIfPresent(String.self, forKey: .requiredRoleId))
    }
}
