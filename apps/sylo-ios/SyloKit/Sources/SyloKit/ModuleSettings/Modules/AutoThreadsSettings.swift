import Foundation

// Auto threads (src/modules/autoThreads.js, normaliseAutoThreadsConfig; route in
// src/web/routes/v2Api.js; web form web-v2/src/moduleForms/AutoThreads.jsx): every new post in a
// chosen channel gets its own thread. Discord only: Fluxer has no threads yet, and the page says so.

/// The Auto threads settings page.
public struct AutoThreadsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "auto-threads"

    public let settings: AutoThreadsSettings
    /// Text and announcement channels (a forum already makes a thread for every post).
    public let channels: [ChannelOption]
    public let roles: [RoleOption]

    public init(settings: AutoThreadsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = []) {
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
        settings = try c.decode(forKey: .settings, or: AutoThreadsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
    }
}

public struct AutoThreadsSettings: Codable, Sendable, Equatable {
    /// The first rule for a channel that fits a post is the one used.
    public var rules: [Rule]

    public init(rules: [Rule] = []) { self.rules = rules }

    /// The server keeps at most this many rules.
    public static let maxRules = 25
    public static let maxNameTemplateLength = 100
    public static let maxFirstMessageLength = 2000
    public static let maxStaffRoles = 25
    /// Seconds of slowmode inside the thread; 0 = off.
    public static let slowmodeRange = 0...21600
    /// What a new rule names its threads: the first words of the post.
    public static let defaultNameTemplate = "{words}"

    /// How long a thread may sit quiet before Discord archives it (minutes).
    public enum Archive: Int, Codable, Sendable, CaseIterable {
        case hour = 60
        case day = 1440
        case threeDays = 4320
        case week = 10080

        public init(from decoder: any Decoder) throws {
            self = Archive(rawValue: try decoder.singleValueContainer().decode(Int.self)) ?? .day
        }
    }

    public struct Rule: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let uid: UUID
        /// The server's own id for the rule; "" for a new one (the server hands one out).
        public var ruleId: String
        public var channelId: String
        /// `{author}` `{date}` `{words}`; cut at 100 characters.
        public var nameTemplate: String
        public var archive: Archive
        public var onlyWithAttachments: Bool
        public var onlyWithLinks: Bool
        public var skipBots: Bool
        public var skipStaff: Bool
        /// Staff on top of Manage Server and Administrator.
        public var staffRoleIds: [String]
        /// Optional first message in the thread; `{author}` becomes a mention.
        public var firstMessage: String
        public var slowmodeSeconds: Int

        public var id: UUID { uid }

        public init(ruleId: String = "", channelId: String = "",
                    nameTemplate: String = AutoThreadsSettings.defaultNameTemplate,
                    archive: Archive = .day, onlyWithAttachments: Bool = false, onlyWithLinks: Bool = false,
                    skipBots: Bool = true, skipStaff: Bool = false, staffRoleIds: [String] = [],
                    firstMessage: String = "", slowmodeSeconds: Int = 0) {
            uid = UUID()
            self.ruleId = ruleId
            self.channelId = channelId
            self.nameTemplate = nameTemplate
            self.archive = archive
            self.onlyWithAttachments = onlyWithAttachments
            self.onlyWithLinks = onlyWithLinks
            self.skipBots = skipBots
            self.skipStaff = skipStaff
            self.staffRoleIds = staffRoleIds
            self.firstMessage = firstMessage
            self.slowmodeSeconds = slowmodeSeconds
        }

        private enum CodingKeys: String, CodingKey {
            case id, channelId, nameTemplate, archiveMinutes, onlyWithAttachments, onlyWithLinks, skipBots
            case skipStaff, staffRoleIds, firstMessage, slowmodeSeconds
        }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                ruleId: try c.decode(forKey: .id, or: ""),
                channelId: try c.decode(forKey: .channelId, or: ""),
                nameTemplate: try c.decode(forKey: .nameTemplate, or: AutoThreadsSettings.defaultNameTemplate),
                archive: try c.decode(forKey: .archiveMinutes, or: .day),
                onlyWithAttachments: try c.decode(forKey: .onlyWithAttachments, or: false),
                onlyWithLinks: try c.decode(forKey: .onlyWithLinks, or: false),
                skipBots: try c.decode(forKey: .skipBots, or: true),
                skipStaff: try c.decode(forKey: .skipStaff, or: false),
                staffRoleIds: try c.decode(forKey: .staffRoleIds, or: []),
                firstMessage: try c.decode(forKey: .firstMessage, or: ""),
                slowmodeSeconds: try c.decode(forKey: .slowmodeSeconds, or: 0))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(ruleId, forKey: .id)
            try c.encode(channelId, forKey: .channelId)
            try c.encode(nameTemplate, forKey: .nameTemplate)
            try c.encode(archive, forKey: .archiveMinutes)
            try c.encode(onlyWithAttachments, forKey: .onlyWithAttachments)
            try c.encode(onlyWithLinks, forKey: .onlyWithLinks)
            try c.encode(skipBots, forKey: .skipBots)
            try c.encode(skipStaff, forKey: .skipStaff)
            try c.encode(staffRoleIds, forKey: .staffRoleIds)
            try c.encode(firstMessage, forKey: .firstMessage)
            try c.encode(slowmodeSeconds, forKey: .slowmodeSeconds)
        }
    }

    private enum CodingKeys: String, CodingKey { case rules }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rules = try c.decode(forKey: .rules, or: [])
    }
}
