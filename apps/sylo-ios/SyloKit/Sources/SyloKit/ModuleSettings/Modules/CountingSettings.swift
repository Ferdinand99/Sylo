import Foundation

// Counting (src/modules/counting.js; the config is built in the GET and POST
// /modules/counting/config routes of src/web/routes/v2Api.js; web form
// web-v2/src/moduleForms/Counting.jsx): members count upward in one channel, one number per
// message, with an optional penalty role taken away for a while from whoever breaks the streak.

/// The Counting settings page.
public struct CountingPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "counting"

    public let settings: CountingSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The current game (bot-managed, read only).
    public let state: CountingState
    /// Members who broke the streak and are waiting to get the penalty role back.
    public let penalties: [CountingPenalty]

    public init(settings: CountingSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                state: CountingState = CountingState(), penalties: [CountingPenalty] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.state = state
        self.penalties = penalties
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, state, penalties
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: CountingSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        state = try c.decode(forKey: .state, or: CountingState())
        penalties = try c.decode(forKey: .penalties, or: [])
    }
}

public struct CountingSettings: Codable, Sendable, Equatable {
    /// The counting channel ("" for none).
    public var channelId: String
    /// React with ✅ on a correct count (🎉 on a new record).
    public var react: Bool
    /// Whether one person may count several times in a row.
    public var allowSameUser: Bool
    /// Whether a wrong number resets the count (otherwise it is only deleted).
    public var resetOnFail: Bool
    /// The role taken away from whoever breaks the streak ("" for no penalty).
    public var penaltyRoleId: String
    /// How long the penalty role stays away.
    public var penaltyMinutes: Int

    public init(channelId: String = "", react: Bool = true, allowSameUser: Bool = false, resetOnFail: Bool = true,
                penaltyRoleId: String = "", penaltyMinutes: Int = 15) {
        self.channelId = channelId
        self.react = react
        self.allowSameUser = allowSameUser
        self.resetOnFail = resetOnFail
        self.penaltyRoleId = penaltyRoleId
        self.penaltyMinutes = penaltyMinutes
    }

    /// Up to a week.
    public static let penaltyRange = 1...10080

    private enum CodingKeys: String, CodingKey {
        case channelId, react, allowSameUser, resetOnFail, penaltyRoleId, penaltyMinutes
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            channelId: try c.decode(forKey: .channelId, or: ""),
            react: try c.decode(forKey: .react, or: true),
            allowSameUser: try c.decode(forKey: .allowSameUser, or: false),
            resetOnFail: try c.decode(forKey: .resetOnFail, or: true),
            penaltyRoleId: try c.decode(forKey: .penaltyRoleId, or: ""),
            penaltyMinutes: try c.decode(forKey: .penaltyMinutes, or: 15))
    }
}

/// Where the count stands.
public struct CountingState: Decodable, Sendable, Hashable {
    public let current: Int
    /// The best streak.
    public let record: Int
    /// Who posted the last number, if anyone.
    public let lastUserId: String?

    public init(current: Int = 0, record: Int = 0, lastUserId: String? = nil) {
        self.current = current
        self.record = record
        self.lastUserId = lastUserId
    }

    private enum CodingKeys: String, CodingKey { case current, record, lastUserId }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        current = try c.decode(forKey: .current, or: 0)
        record = try c.decode(forKey: .record, or: 0)
        lastUserId = try c.decodeIfPresent(String.self, forKey: .lastUserId)
    }
}

/// A member without the penalty role until `restoreAt`.
public struct CountingPenalty: Decodable, Sendable, Hashable, Identifiable {
    public let userId: String
    /// Their tag, or their id when they are not cached.
    public let label: String
    public let roleName: String
    public let restoreAt: Date?

    public var id: String { userId }

    public init(userId: String, label: String, roleName: String, restoreAt: Date?) {
        self.userId = userId
        self.label = label
        self.roleName = roleName
        self.restoreAt = restoreAt
    }

    private enum CodingKeys: String, CodingKey { case userId, label, roleName, restoreAt }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(forKey: .userId, or: "")
        label = try c.decode(forKey: .label, or: userId)
        roleName = try c.decode(forKey: .roleName, or: "")
        // Milliseconds since 1970.
        restoreAt = try c.decodeIfPresent(Double.self, forKey: .restoreAt).map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}
