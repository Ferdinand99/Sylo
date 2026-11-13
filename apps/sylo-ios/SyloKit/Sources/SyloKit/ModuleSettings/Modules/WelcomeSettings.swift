import Foundation

// Welcome & leave (src/modules/welcome.js; GET/POST in src/web/routes/v2Api.js; web form
// web-v2/src/moduleForms/Welcome.jsx): join, leave and DM messages, the welcome image, and the
// roles new members get (stored in the Roles module's `autoroles`, saved through this page).
// Sylo 5.2 adds `trigger` (`join` or `role`) and `triggerRoleIds` (1 to 10 roles) to the config: the
// welcome can wait for a role. An older server sends neither, so both are optional here and are only
// sent back when the server sent them.

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

/// When Welcome sends its welcome (Sylo 5.2): when the member joins, or when they get a role.
public enum WelcomeTrigger: String, Sendable, Equatable {
    case join
    case role

    /// The server treats anything but `role` as `join`, so an unknown value reads the same way.
    init(serverValue: String) {
        self = serverValue == "role" ? .role : .join
    }
}

public struct WelcomeSettings: Codable, Sendable, Equatable {
    /// When the welcome goes out. nil when the server does not send it (Sylo before 5.2): the
    /// "when to welcome" controls are then hidden and the key is never sent back.
    public var trigger: WelcomeTrigger?
    /// The roles that start a welcome in role mode (at most ``maxTriggerRoles``). nil when the
    /// server does not send them; never sent back then.
    public var triggerRoleIds: [String]?
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
                autoroleEnabled: Bool = false, autoroles: [String] = [],
                trigger: WelcomeTrigger? = nil, triggerRoleIds: [String]? = nil) {
        self.trigger = trigger
        self.triggerRoleIds = triggerRoleIds
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
    /// The server keeps at most this many trigger roles (`triggerRoleIds` in modules/limits.js).
    public static let maxTriggerRoles = 10

    /// Whether the server knows the "when to welcome" setting (Sylo 5.2 and later).
    public var supportsTrigger: Bool { trigger != nil }

    /// The trigger roles as the screen shows them. A server that sent `trigger` but no
    /// `triggerRoleIds` has no roles picked yet.
    public var triggerRoleSelection: [String] { triggerRoleIds ?? [] }

    /// Sets the trigger roles from the picker. When the server did not send `triggerRoleIds` and
    /// nothing is picked, the key stays absent, so it is only sent once the person picked a role
    /// (or when the server sent it).
    public mutating func setTriggerRoleSelection(_ ids: [String]) {
        if ids.isEmpty, triggerRoleIds == nil { return }
        triggerRoleIds = ids
    }

    /// Role mode with no role picked: the settings save, but no welcome is ever sent. Same warning
    /// as the dashboard. A missing `triggerRoleIds` counts as no role picked.
    public var hasNoTriggerRole: Bool {
        trigger == .role && triggerRoleSelection.isEmpty
    }

    private enum CodingKeys: String, CodingKey {
        case trigger, triggerRoleIds
        case joinEnabled, joinChannel, joinMessage, useEmbed, card, cardBackground
        case dmEnabled, dmMessage, leaveEnabled, leaveChannel, leaveMessage
        case autoroleEnabled, autoroles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Sylo 5.2 fields: left nil when missing (or not the shape expected), so an older server
        // never gets them back. `try?` keeps an odd value from failing the whole page.
        trigger = (try? c.decodeIfPresent(String.self, forKey: .trigger)).map(WelcomeTrigger.init(serverValue:))
        triggerRoleIds = try? c.decodeIfPresent([String].self, forKey: .triggerRoleIds)
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

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // Only what the server sent: a 5.1 server never receives the 5.2 keys.
        try c.encodeIfPresent(trigger?.rawValue, forKey: .trigger)
        try c.encodeIfPresent(triggerRoleIds, forKey: .triggerRoleIds)
        try c.encode(joinEnabled, forKey: .joinEnabled)
        try c.encode(joinChannel, forKey: .joinChannel)
        try c.encode(joinMessage, forKey: .joinMessage)
        try c.encode(useEmbed, forKey: .useEmbed)
        try c.encode(card, forKey: .card)
        try c.encode(cardBackground, forKey: .cardBackground)
        try c.encode(dmEnabled, forKey: .dmEnabled)
        try c.encode(dmMessage, forKey: .dmMessage)
        try c.encode(leaveEnabled, forKey: .leaveEnabled)
        try c.encode(leaveChannel, forKey: .leaveChannel)
        try c.encode(leaveMessage, forKey: .leaveMessage)
        try c.encode(autoroleEnabled, forKey: .autoroleEnabled)
        try c.encode(autoroles, forKey: .autoroles)
    }
}
