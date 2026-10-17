import Foundation

// Polls (src/modules/polls.js, normalisePollsConfig; web form web-v2/src/moduleForms/Polls.jsx):
// who may vote on `/poll` polls, and how the live poll and its results message look.

/// The Polls settings page.
public struct PollsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "polls"

    public let settings: PollsSettings
    public let roles: [RoleOption]
    /// Placeholders the poll message can use (`{question}`, …).
    public let pollPlaceholders: [String]
    /// Placeholders the results message can use.
    public let resultsPlaceholders: [String]

    public init(settings: PollsSettings, roles: [RoleOption] = [], pollPlaceholders: [String] = [],
                resultsPlaceholders: [String] = []) {
        self.settings = settings
        self.roles = roles
        self.pollPlaceholders = pollPlaceholders
        self.resultsPlaceholders = resultsPlaceholders
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case roles, pollPlaceholders, resultsPlaceholders
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: PollsSettings())
        roles = try c.decode(forKey: .roles, or: [])
        pollPlaceholders = try c.decode(forKey: .pollPlaceholders, or: [])
        resultsPlaceholders = try c.decode(forKey: .resultsPlaceholders, or: [])
    }
}

/// How `voteRoles` is read.
public enum PollsVoteRoleMode: String, Codable, Sendable, CaseIterable {
    /// Everyone except members with one of the roles.
    case allow
    /// Only members with one of the roles.
    case deny

    public init(from decoder: any Decoder) throws {
        self = PollsVoteRoleMode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .allow
    }
}

/// A poll or results message: an embed whose body Sylo fills in (the choices or the results), with
/// an optional plain-text line above it.
public struct PollsMessage: Codable, Sendable, Equatable {
    /// Plain text above the embed (at most 1500 characters).
    public var content: String
    /// At most 200 characters, on one line.
    public var title: String
    /// `#rrggbb`.
    public var color: String
    /// At most 300 characters, on one line.
    public var footer: String
    /// An http(s) image URL, or "" for none. The server drops anything else.
    public var image: String

    public init(content: String = "", title: String = "", color: String = PollsMessage.defaultColor,
                footer: String = "", image: String = "") {
        self.content = content
        self.title = title
        self.color = color
        self.footer = footer
        self.image = image
    }

    public static let defaultColor = "#5b7cfa"
    public static let maxContentLength = 1500
    public static let maxTitleLength = 200
    public static let maxFooterLength = 300

    /// The colour as 0...1 sRGB components, for a colour picker. An unreadable colour reads as the
    /// default one.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let value = Self.hexValue(color) ?? Self.hexValue(Self.defaultColor) ?? 0
        return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
    }

    /// Sets the colour from 0...1 sRGB components (clamped, since wide-gamut colours can go past
    /// them).
    public mutating func setRGB(red: Double, green: Double, blue: Double) {
        func hexByte(_ component: Double) -> String {
            let text = String(Int((min(max(component, 0), 1) * 255).rounded()), radix: 16)
            return text.count == 1 ? "0" + text : text
        }
        color = "#" + hexByte(red) + hexByte(green) + hexByte(blue)
    }

    private static func hexValue(_ color: String) -> Int? {
        let hex = color.hasPrefix("#") ? color.dropFirst() : Substring(color)
        guard hex.count == 6, hex.allSatisfy(\.isHexDigit) else { return nil }
        return Int(hex, radix: 16)
    }

    private enum CodingKeys: String, CodingKey { case content, title, color, footer, image }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        content = try c.decode(forKey: .content, or: "")
        title = try c.decode(forKey: .title, or: "")
        color = try c.decode(forKey: .color, or: Self.defaultColor)
        footer = try c.decode(forKey: .footer, or: "")
        image = try c.decode(forKey: .image, or: "")
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(content, forKey: .content)
        try c.encode(title, forKey: .title)
        try c.encode(color, forKey: .color)
        try c.encode(footer, forKey: .footer)
        try c.encode(image, forKey: .image)
    }
}

public struct PollsSettings: Codable, Sendable, Equatable {
    public var voteRoleMode: PollsVoteRoleMode
    /// The roles `voteRoleMode` refers to; empty lets everyone vote.
    public var voteRoles: [String]
    /// How a live poll looks.
    public var pollMessage: PollsMessage
    /// Posted when a poll closes.
    public var resultsMessage: PollsMessage

    public init(voteRoleMode: PollsVoteRoleMode = .allow, voteRoles: [String] = [],
                pollMessage: PollsMessage = PollsMessage(), resultsMessage: PollsMessage = PollsMessage()) {
        self.voteRoleMode = voteRoleMode
        self.voteRoles = voteRoles
        self.pollMessage = pollMessage
        self.resultsMessage = resultsMessage
    }

    /// The server keeps at most this many vote roles.
    public static let maxVoteRoles = 25

    private enum CodingKeys: String, CodingKey { case voteRoleMode, voteRoles, pollMessage, resultsMessage }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        voteRoleMode = try c.decode(forKey: .voteRoleMode, or: .allow)
        voteRoles = try c.decode(forKey: .voteRoles, or: [])
        pollMessage = try c.decode(forKey: .pollMessage, or: PollsMessage())
        resultsMessage = try c.decode(forKey: .resultsMessage, or: PollsMessage())
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(voteRoleMode, forKey: .voteRoleMode)
        try c.encode(voteRoles, forKey: .voteRoles)
        try c.encode(pollMessage, forKey: .pollMessage)
        try c.encode(resultsMessage, forKey: .resultsMessage)
    }
}
