import Foundation

// Autoresponder (src/modules/autoresponder.js, normaliseAutoresponder; web form
// web-v2/src/moduleForms/Autoresponder.jsx): replies automatically when a message matches a
// trigger, with no prefix. The first matching responder wins.

/// The Autoresponder settings page.
public struct AutoresponderPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "autoresponder"

    public let settings: AutoresponderSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// What a reply can contain, such as `{user}`.
    public let placeholders: [String]

    public init(settings: AutoresponderSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                placeholders: [String] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.placeholders = placeholders
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, placeholders
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: AutoresponderSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        placeholders = try c.decode(forKey: .placeholders, or: [])
    }
}

/// How a message is compared with a trigger (case-insensitively).
public enum AutoresponderMatch: String, Codable, Sendable, CaseIterable {
    case contains, exact, startswith, wholeword

    public init(from decoder: any Decoder) throws {
        self = AutoresponderMatch(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .contains
    }
}

public struct AutoresponderSettings: Codable, Sendable, Equatable {
    /// Per channel, against spam.
    public var cooldownSeconds: Int
    public var ignoreChannels: [String]
    public var ignoreRoles: [String]
    public var responders: [Responder]

    public init(cooldownSeconds: Int = 2, ignoreChannels: [String] = [], ignoreRoles: [String] = [],
                responders: [Responder] = []) {
        self.cooldownSeconds = cooldownSeconds
        self.ignoreChannels = ignoreChannels
        self.ignoreRoles = ignoreRoles
        self.responders = responders
    }

    public static let cooldownRange = 0...300
    /// The server keeps at most this many responders.
    public static let maxResponders = 100

    public struct Responder: Codable, Sendable, Equatable, Identifiable {
        /// For lists only; not sent.
        public let id: UUID
        /// At most 200 characters.
        public var trigger: String
        public var match: AutoresponderMatch
        /// At most 2000 characters.
        public var response: String
        public var embed: Bool
        /// Needs the Manage Messages permission.
        public var deleteTrigger: Bool

        public init(trigger: String = "", match: AutoresponderMatch = .contains, response: String = "",
                    embed: Bool = false, deleteTrigger: Bool = false) {
            id = UUID()
            self.trigger = trigger
            self.match = match
            self.response = response
            self.embed = embed
            self.deleteTrigger = deleteTrigger
        }

        public static let maxTriggerLength = 200
        public static let maxResponseLength = 2000

        // `embedColor` is stored but the form never sends it, so it is not read either.
        private enum CodingKeys: String, CodingKey { case trigger, match, response, embed, deleteTrigger }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                trigger: try c.decode(forKey: .trigger, or: ""),
                match: try c.decode(forKey: .match, or: .contains),
                response: try c.decode(forKey: .response, or: ""),
                embed: try c.decode(forKey: .embed, or: false),
                deleteTrigger: try c.decode(forKey: .deleteTrigger, or: false))
        }

        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(trigger, forKey: .trigger)
            try c.encode(match, forKey: .match)
            try c.encode(response, forKey: .response)
            try c.encode(embed, forKey: .embed)
            try c.encode(deleteTrigger, forKey: .deleteTrigger)
        }
    }

    private enum CodingKeys: String, CodingKey { case cooldownSeconds, ignoreChannels, ignoreRoles, responders }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cooldownSeconds = try c.decode(forKey: .cooldownSeconds, or: 2)
        ignoreChannels = try c.decode(forKey: .ignoreChannels, or: [])
        ignoreRoles = try c.decode(forKey: .ignoreRoles, or: [])
        responders = try c.decode(forKey: .responders, or: [])
    }
}
