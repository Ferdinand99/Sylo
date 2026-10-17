import Foundation

// Free games (src/modules/freeGames.js; the config is built in the free-games routes of
// src/web/routes/v2Api.js; web form web-v2/src/moduleForms/FreeGames.jsx): Sylo checks hourly
// and announces games that just became free to claim.

/// The Free games settings page.
public struct FreeGamesPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "free-games"

    public let settings: FreeGamesSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(settings: FreeGamesSettings, channels: [ChannelOption] = [], roles: [RoleOption] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: FreeGamesSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

public struct FreeGamesSettings: Codable, Sendable, Equatable {
    /// Where free games are announced; "" until one is chosen (nothing is posted without it).
    public var channelId: String
    /// A role to mention with each announcement; "" for none.
    public var roleId: String

    public init(channelId: String = "", roleId: String = "") {
        self.channelId = channelId
        self.roleId = roleId
    }

    private enum CodingKeys: String, CodingKey { case channelId, roleId }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channelId = try c.decode(forKey: .channelId, or: "")
        roleId = try c.decode(forKey: .roleId, or: "")
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(channelId, forKey: .channelId)
        try c.encode(roleId, forKey: .roleId)
    }
}
