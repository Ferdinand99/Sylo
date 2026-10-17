import Foundation

// Welcome & leave (src/modules/welcome.js; GET/POST in src/web/routes/v2Api.js; web form
// web-v2/src/moduleForms/Welcome.jsx): join, leave and DM messages, the welcome image, and the
// roles new members get (stored in the Roles module's `autoroles`, saved through this page).

/// The Welcome settings page.
public struct WelcomePage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "welcome"

    public let settings: WelcomeSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// Whether the Verification module is on (the web form links to it).
    public let verificationEnabled: Bool
    /// What the messages can contain, such as `{user}` and `{server}`.
    public let placeholders: [String]

    public init(settings: WelcomeSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                verificationEnabled: Bool = false, placeholders: [String] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.verificationEnabled = verificationEnabled
        self.placeholders = placeholders
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, verificationEnabled, placeholders
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: WelcomeSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        verificationEnabled = try c.decode(forKey: .verificationEnabled, or: false)
        placeholders = try c.decode(forKey: .placeholders, or: [])
    }
}

public struct WelcomeSettings: Codable, Sendable, Equatable {
    public var joinEnabled: Bool
    public var joinChannel: String
    public var joinMessage: String
    /// Send the join message as an embed.
    public var useEmbed: Bool
    /// Attach a generated welcome image to the join message.
    public var card: Bool
    /// An https image URL for the welcome image's background, or "".
    public var cardBackground: String
    public var dmEnabled: Bool
    public var dmMessage: String
    public var leaveEnabled: Bool
    public var leaveChannel: String
    public var leaveMessage: String
    public var autoroleEnabled: Bool
    /// Roles given to every new member.
    public var autoroles: [String]

    public init(joinEnabled: Bool = false, joinChannel: String = "", joinMessage: String = "",
                useEmbed: Bool = false, card: Bool = false, cardBackground: String = "",
                dmEnabled: Bool = false, dmMessage: String = "",
                leaveEnabled: Bool = false, leaveChannel: String = "", leaveMessage: String = "",
                autoroleEnabled: Bool = false, autoroles: [String] = []) {
        self.joinEnabled = joinEnabled
        self.joinChannel = joinChannel
        self.joinMessage = joinMessage
        self.useEmbed = useEmbed
        self.card = card
        self.cardBackground = cardBackground
        self.dmEnabled = dmEnabled
        self.dmMessage = dmMessage
        self.leaveEnabled = leaveEnabled
        self.leaveChannel = leaveChannel
        self.leaveMessage = leaveMessage
        self.autoroleEnabled = autoroleEnabled
        self.autoroles = autoroles
    }

    /// The server keeps at most this many characters of each message.
    public static let maxMessageLength = 1500
    /// The server keeps at most this many characters of the background URL.
    public static let maxBackgroundLength = 500

    private enum CodingKeys: String, CodingKey {
        case joinEnabled, joinChannel, joinMessage, useEmbed, card, cardBackground
        case dmEnabled, dmMessage, leaveEnabled, leaveChannel, leaveMessage
        case autoroleEnabled, autoroles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        joinEnabled = try c.decode(forKey: .joinEnabled, or: false)
        joinChannel = try c.decode(forKey: .joinChannel, or: "")
        joinMessage = try c.decode(forKey: .joinMessage, or: "")
        useEmbed = try c.decode(forKey: .useEmbed, or: false)
        card = try c.decode(forKey: .card, or: false)
        cardBackground = try c.decode(forKey: .cardBackground, or: "")
        dmEnabled = try c.decode(forKey: .dmEnabled, or: false)
        dmMessage = try c.decode(forKey: .dmMessage, or: "")
        leaveEnabled = try c.decode(forKey: .leaveEnabled, or: false)
        leaveChannel = try c.decode(forKey: .leaveChannel, or: "")
        leaveMessage = try c.decode(forKey: .leaveMessage, or: "")
        autoroleEnabled = try c.decode(forKey: .autoroleEnabled, or: false)
        autoroles = try c.decode(forKey: .autoroles, or: [])
    }
}
