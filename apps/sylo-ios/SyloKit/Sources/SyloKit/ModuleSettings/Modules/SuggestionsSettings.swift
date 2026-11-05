import Foundation

// Suggestions (src/modules/suggestions.js, normaliseSuggestionsConfig; page route
// src/web/routes/v2Suggestions.js; web form web-v2/src/moduleForms/Suggestions.jsx): members post
// ideas, everyone votes, staff approve, deny or mark them implemented. The app edits the settings
// and lists the suggestions; deciding on one or deleting it is left to the web dashboard.

/// The Suggestions settings page.
public struct SuggestionsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "suggestions"

    public let settings: SuggestionsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The newest suggestions first (at most 100).
    public let suggestions: [SuggestionSummary]

    public init(settings: SuggestionsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                suggestions: [SuggestionSummary] = []) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.suggestions = suggestions
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, suggestions
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: SuggestionsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        suggestions = try c.decodeLossyArray(of: SuggestionSummary.self, forKey: .suggestions)
    }
}

public struct SuggestionsSettings: Codable, Sendable, Equatable {
    /// Where suggestions are posted; "" = the channel the command is used in.
    public var channel: String
    /// A decided suggestion is reposted here and the original deleted; "" = it stays.
    public var logChannel: String
    /// New posts do not show who wrote them.
    public var anonymous: Bool
    /// DM the author when staff decide.
    public var dmAuthor: Bool
    /// Turn plain messages in the suggestions channel into suggestions.
    public var messagesToSuggestions: Bool
    /// Seconds a member waits between suggestions; 0 = off.
    public var cooldownSeconds: Int
    /// May decide without Manage Server.
    public var staffRoles: [String]

    public init(channel: String = "", logChannel: String = "", anonymous: Bool = false, dmAuthor: Bool = true,
                messagesToSuggestions: Bool = false, cooldownSeconds: Int = 60, staffRoles: [String] = []) {
        self.channel = channel
        self.logChannel = logChannel
        self.anonymous = anonymous
        self.dmAuthor = dmAuthor
        self.messagesToSuggestions = messagesToSuggestions
        self.cooldownSeconds = cooldownSeconds
        self.staffRoles = staffRoles
    }

    /// The server keeps the cooldown in this range (one hour at most).
    public static let cooldownRange = 0...3600
    public static let maxStaffRoles = 25

    private enum CodingKeys: String, CodingKey {
        case channel, logChannel, anonymous, dmAuthor, messagesToSuggestions, cooldownSeconds, staffRoles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channel = try c.decode(forKey: .channel, or: "")
        logChannel = try c.decode(forKey: .logChannel, or: "")
        anonymous = try c.decode(forKey: .anonymous, or: false)
        dmAuthor = try c.decode(forKey: .dmAuthor, or: true)
        messagesToSuggestions = try c.decode(forKey: .messagesToSuggestions, or: false)
        cooldownSeconds = try c.decode(forKey: .cooldownSeconds, or: 60)
        staffRoles = try c.decode(forKey: .staffRoles, or: [])
    }
}

/// Where a suggestion stands.
public enum SuggestionStatus: Hashable, Sendable, RawRepresentable, Decodable {
    case open
    case considering
    case approved
    case denied
    case implemented
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "open": self = .open
        case "considering": self = .considering
        case "approved": self = .approved
        case "denied": self = .denied
        case "implemented": self = .implemented
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .open: "open"
        case .considering: "considering"
        case .approved: "approved"
        case .denied: "denied"
        case .implemented: "implemented"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
}

/// One suggestion in the list under the settings (read only here).
public struct SuggestionSummary: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    /// The per-server number ("#12").
    public let number: Int
    /// "" when the author gave none.
    public let title: String
    public let text: String
    public let status: SuggestionStatus
    /// Staff's reason for a decision; "" when none.
    public let reason: String
    public let up: Int
    public let down: Int
    /// Who wrote it (staff see this even when the post hides it); nil when the author is gone.
    public let author: String?
    public let isAnonymous: Bool
    /// When it was posted, in milliseconds since 1970.
    public let createdAt: Double?

    public init(id: Int, number: Int, title: String = "", text: String, status: SuggestionStatus = .open,
                reason: String = "", up: Int = 0, down: Int = 0, author: String? = nil,
                isAnonymous: Bool = false, createdAt: Double? = nil) {
        self.id = id
        self.number = number
        self.title = title
        self.text = text
        self.status = status
        self.reason = reason
        self.up = up
        self.down = down
        self.author = author
        self.isAnonymous = isAnonymous
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, number, title, text, status, reason, up, down, author, anonymous, createdAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let number = try c.decode(Int.self, forKey: .number)
        self.init(
            id: try c.decode(forKey: .id, or: number),
            number: number,
            title: try c.decodeIfPresent(String.self, forKey: .title) ?? "",
            text: try c.decode(forKey: .text, or: ""),
            status: try c.decode(forKey: .status, or: .open),
            reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "",
            up: try c.decode(forKey: .up, or: 0),
            down: try c.decode(forKey: .down, or: 0),
            author: try c.decodeIfPresent(String.self, forKey: .author),
            isAnonymous: try c.decode(forKey: .anonymous, or: false),
            createdAt: try c.decodeIfPresent(Double.self, forKey: .createdAt))
    }

    /// When it was posted.
    public var createdDate: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}
