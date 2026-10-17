import Foundation

// Birthdays (src/modules/birthdays.js, normaliseBirthdaysConfig; web form
// web-v2/src/moduleForms/Birthdays.jsx): members save their date with `/birthday set`, Sylo posts
// a message on the day and can grant a role for it.

/// The Birthdays settings page.
public struct BirthdaysPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "birthdays"

    public let settings: BirthdaysSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(settings: BirthdaysSettings, channels: [ChannelOption] = [], roles: [RoleOption] = []) {
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
        settings = try c.decode(forKey: .settings, or: BirthdaysSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

public struct BirthdaysSettings: Codable, Sendable, Equatable {
    /// Where the birthday message goes; "" for no message.
    public var channel: String
    /// The announcement. Placeholders: `{user}`, `{age}` (blank unless a year was given). The
    /// server trims it and uses `defaultMessage` when it is empty.
    public var message: String
    /// A role granted for the day and removed after; "" for none.
    public var roleId: String
    /// Mention the birthday role in the announcement.
    public var pingRole: Bool

    public init(channel: String = "", message: String = BirthdaysSettings.defaultMessage, roleId: String = "",
                pingRole: Bool = false) {
        self.channel = channel
        self.message = message
        self.roleId = roleId
        self.pingRole = pingRole
    }

    public static let defaultMessage = "🎂 Happy birthday {user}! 🎉"
    public static let maxMessageLength = 1000

    private enum CodingKeys: String, CodingKey { case channel, message, roleId, pingRole }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channel = try c.decode(forKey: .channel, or: "")
        message = try c.decode(forKey: .message, or: Self.defaultMessage)
        roleId = try c.decode(forKey: .roleId, or: "")
        pingRole = try c.decode(forKey: .pingRole, or: false)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(channel, forKey: .channel)
        try c.encode(message, forKey: .message)
        try c.encode(roleId, forKey: .roleId)
        try c.encode(pingRole, forKey: .pingRole)
    }
}
