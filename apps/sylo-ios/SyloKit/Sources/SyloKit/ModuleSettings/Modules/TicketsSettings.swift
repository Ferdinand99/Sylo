import Foundation

// Tickets / modmail (src/modules/tickets.js; GET/POST in src/web/routes/v2Api.js; web form
// web-v2/src/moduleForms/Tickets.jsx): members open a ticket by DMing the bot; staff reply from
// the dashboard. These are the messages, who counts as staff, and how long closed tickets stay.

/// The Tickets settings page.
public struct TicketsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "tickets"

    public let settings: TicketsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(settings: TicketsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = []) {
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
        settings = try c.decode(forKey: .settings, or: TicketsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

public struct TicketsSettings: Codable, Sendable, Equatable {
    /// Sent when a ticket opens; `{server}` is replaced. "" uses the bot's built-in text.
    public var greeting: String
    /// Sent when a ticket is closed. "" uses the bot's built-in text.
    public var closeMessage: String
    /// Pinged on new tickets and replies, or "".
    public var notifyChannel: String
    /// May read and reply to tickets even without Manage Server.
    public var staffRoles: [String]
    /// Delete closed tickets after this many days; 0 keeps them forever.
    public var transcriptRetentionDays: Int
    /// Include the ticket's opening message in the staff notification.
    public var showMessageInAlert: Bool

    public init(greeting: String = "", closeMessage: String = "", notifyChannel: String = "",
                staffRoles: [String] = [], transcriptRetentionDays: Int = 0, showMessageInAlert: Bool = false) {
        self.greeting = greeting
        self.closeMessage = closeMessage
        self.notifyChannel = notifyChannel
        self.staffRoles = staffRoles
        self.transcriptRetentionDays = transcriptRetentionDays
        self.showMessageInAlert = showMessageInAlert
    }

    /// The server keeps at most this many characters of each message.
    public static let maxMessageLength = 1500
    public static let retentionRange = 0...3650

    private enum CodingKeys: String, CodingKey {
        case greeting, closeMessage, notifyChannel, staffRoles, transcriptRetentionDays, showMessageInAlert
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        greeting = try c.decode(forKey: .greeting, or: "")
        closeMessage = try c.decode(forKey: .closeMessage, or: "")
        notifyChannel = try c.decode(forKey: .notifyChannel, or: "")
        staffRoles = try c.decode(forKey: .staffRoles, or: [])
        transcriptRetentionDays = try c.decode(forKey: .transcriptRetentionDays, or: 0)
        showMessageInAlert = try c.decode(forKey: .showMessageInAlert, or: false)
    }
}
