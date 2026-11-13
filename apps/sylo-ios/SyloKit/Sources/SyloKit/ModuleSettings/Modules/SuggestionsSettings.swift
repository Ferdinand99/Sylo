import Foundation

// Suggestions (src/modules/suggestions.js, normaliseSuggestionsConfig; page route
// src/web/routes/v2Suggestions.js; web form web-v2/src/moduleForms/Suggestions.jsx): members post
// ideas, everyone votes, staff approve, deny or mark them implemented. The app edits the settings,
// lists the suggestions and decides on, moves back and deletes them (Suggestions/SuggestionActions.swift).

/// The Suggestions settings page.
public struct SuggestionsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "suggestions"

    public let settings: SuggestionsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The newest suggestions first (at most 100).
    public let suggestions: [SuggestionSummary]
    /// How many suggestions in the whole server sit outside the suggestions channel (after an
    /// earlier move to the log channel) and can be moved back; 0 from a server that does not
    /// offer moving back.
    public let outside: Int

    public init(settings: SuggestionsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                suggestions: [SuggestionSummary] = [], outside: Int = 0) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.suggestions = suggestions
        self.outside = outside
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, suggestions, outside
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: SuggestionsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        suggestions = try c.decodeLossyArray(of: SuggestionSummary.self, forKey: .suggestions)
        outside = try c.decode(forKey: .outside, or: 0)
    }
}

/// What happens to a decided suggestion when there is a log channel.
public enum SuggestionsLogMode: String, Codable, Sendable, CaseIterable {
    /// The original stays in the suggestions channel and a copy goes to the log channel.
    case copy
    /// The post moves to the log channel and the original is deleted.
    case move
}

public struct SuggestionsSettings: Codable, Sendable, Equatable {
    /// Where suggestions are posted; "" = the channel the command is used in.
    public var channel: String
    /// A decided suggestion goes here (see ``logMode``); "" = it stays where it is.
    public var logChannel: String
    /// Copy or move to the log channel. Always sent when saving: the server keeps what it has
    /// stored when it is left out, but the app says it outright.
    public var logMode: SuggestionsLogMode
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

    /// - Parameter logMode: nil picks what the server picks for settings saved without one: move
    ///   when there is a log channel (so nothing changes silently), else copy.
    public init(channel: String = "", logChannel: String = "", logMode: SuggestionsLogMode? = nil,
                anonymous: Bool = false, dmAuthor: Bool = true, messagesToSuggestions: Bool = false,
                cooldownSeconds: Int = 60, staffRoles: [String] = []) {
        self.channel = channel
        self.logChannel = logChannel
        self.logMode = logMode ?? Self.defaultLogMode(logChannel: logChannel)
        self.anonymous = anonymous
        self.dmAuthor = dmAuthor
        self.messagesToSuggestions = messagesToSuggestions
        self.cooldownSeconds = cooldownSeconds
        self.staffRoles = staffRoles
    }

    /// The server keeps the cooldown in this range (one hour at most).
    public static let cooldownRange = 0...3600
    public static let maxStaffRoles = 25

    private static func defaultLogMode(logChannel: String) -> SuggestionsLogMode {
        logChannel.isEmpty ? .copy : .move
    }

    private enum CodingKeys: String, CodingKey {
        case channel, logChannel, logMode, anonymous, dmAuthor, messagesToSuggestions, cooldownSeconds, staffRoles
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channel = try c.decode(forKey: .channel, or: "")
        logChannel = try c.decode(forKey: .logChannel, or: "")
        // A server from before 5.1 sends none, and an unknown value is not an error either: both
        // read the way the server reads them.
        let storedMode = try? c.decodeIfPresent(String.self, forKey: .logMode)
        logMode = storedMode.flatMap(SuggestionsLogMode.init(rawValue:)) ?? Self.defaultLogMode(logChannel: logChannel)
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

/// One suggestion in the list under the settings.
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
    /// The post sits outside the suggestions channel (an earlier move to the log channel), so it
    /// can be posted there again. False from a server that does not offer moving back.
    public let canMoveBack: Bool

    public init(id: Int, number: Int, title: String = "", text: String, status: SuggestionStatus = .open,
                reason: String = "", up: Int = 0, down: Int = 0, author: String? = nil,
                isAnonymous: Bool = false, createdAt: Double? = nil, canMoveBack: Bool = false) {
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
        self.canMoveBack = canMoveBack
    }

    private enum CodingKeys: String, CodingKey {
        case id, number, title, text, status, reason, up, down, author, anonymous, createdAt, canMoveBack
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
            createdAt: try c.decodeIfPresent(Double.self, forKey: .createdAt),
            canMoveBack: try c.decode(forKey: .canMoveBack, or: false))
    }

    /// When it was posted.
    public var createdDate: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}
