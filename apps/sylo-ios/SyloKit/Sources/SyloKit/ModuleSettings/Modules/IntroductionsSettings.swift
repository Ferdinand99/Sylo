import Foundation

// Introductions (src/modules/introductions.js, normaliseIntroductionsConfig; page route
// src/web/routes/v2Intro.js; web form web-v2/src/moduleForms/Introductions.jsx): members answer a
// few questions in DMs and Sylo posts a membership card in the introductions channel.
//
// The app edits the channel, the card's look and the prompt text. The questions and the role
// groups are lists a phone edits badly, so they are read only here (and left to the web
// dashboard), but they travel with every save: the server builds the whole config from what it is
// sent, so leaving them out would wipe them.

/// The Introductions settings page.
public struct IntroductionsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "introductions"

    public let settings: IntroductionsSettings
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// The placeholders the description and footer understand ("{user}", "{rolegroup:<name>}").
    public let placeholders: [String]
    /// How many member cards exist.
    public let introductions: Int

    public init(settings: IntroductionsSettings, channels: [ChannelOption] = [], roles: [RoleOption] = [],
                placeholders: [String] = [], introductions: Int = 0) {
        self.settings = settings
        self.channels = channels
        self.roles = roles
        self.placeholders = placeholders
        self.introductions = introductions
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, roles, placeholders, introductions
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: IntroductionsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        placeholders = try c.decode(forKey: .placeholders, or: [])
        introductions = try c.decode(forKey: .introductions, or: 0)
    }
}

/// Where the card's colour comes from.
public enum IntroductionsColorMode: String, Codable, Sendable, CaseIterable {
    /// One colour for every card: ``IntroductionsSettings/color``, or the server's own when empty.
    case fixed
    /// The colour of the member's highest role that has one.
    case role
}

/// The three ways the web form offers the colour, which the server stores as two fields.
public enum IntroductionsColorChoice: Hashable, Sendable, CaseIterable {
    case serverDefault
    case custom
    case memberRole
}

public struct IntroductionsSettings: Codable, Sendable, Equatable {
    /// Where the cards are posted; "" = nowhere yet.
    public var channelId: String
    /// What members are asked, in order. Read only in the app. nil when the server sent none, so
    /// the save leaves the field out and the server keeps its default questions.
    public var questions: [IntroductionsQuestion]?
    /// Role groups shown on the card. Read only in the app.
    public var roleGroups: [IntroductionsRoleGroup]
    /// List the member's other roles on the card.
    public var showRoles: Bool
    public var colorMode: IntroductionsColorMode
    /// `#rrggbb`, used with the fixed mode; "" = the server's own colour.
    public var color: String
    /// Text under the card's title (markdown, placeholders allowed).
    public var description: String
    /// Plain text at the bottom of the card (placeholders allowed).
    public var footer: String
    /// Remove a member's card when they leave.
    public var deleteOnLeave: Bool
    /// The text of the pinned "Introduce yourself" message; "" = the server's default text.
    public var promptText: String
    /// Where the prompt message is published (bot-managed, read only, not sent).
    public let promptChannelId: String
    /// The prompt message's id (bot-managed, read only, not sent); "" = not published.
    public let promptMessageId: String

    public init(channelId: String = "", questions: [IntroductionsQuestion]? = [],
                roleGroups: [IntroductionsRoleGroup] = [], showRoles: Bool = false,
                colorMode: IntroductionsColorMode = .fixed, color: String = "", description: String = "",
                footer: String = "", deleteOnLeave: Bool = true, promptText: String = "",
                promptChannelId: String = "", promptMessageId: String = "") {
        self.channelId = channelId
        self.questions = questions
        self.roleGroups = roleGroups
        self.showRoles = showRoles
        self.colorMode = colorMode
        self.color = color
        self.description = description
        self.footer = footer
        self.deleteOnLeave = deleteOnLeave
        self.promptText = promptText
        self.promptChannelId = promptChannelId
        self.promptMessageId = promptMessageId
    }

    /// The limits the server enforces (src/modules/introductions.js, LIMITS).
    public static let maxDescriptionLength = 1000
    public static let maxFooterLength = 200
    public static let maxPromptTextLength = 500
    public static let maxQuestions = 8
    public static let maxRoleGroups = 10

    /// The colour the form starts a custom colour from.
    public static let fallbackColor = "#7aa2f7"

    /// Whether the prompt message is out in a channel.
    public var isPromptPublished: Bool { !promptMessageId.isEmpty }

    /// The colour as the web form offers it.
    public var colorChoice: IntroductionsColorChoice {
        get {
            if colorMode == .role { return .memberRole }
            return color.isEmpty ? .serverDefault : .custom
        }
        set {
            switch newValue {
            case .serverDefault:
                colorMode = .fixed
                color = ""
            case .custom:
                colorMode = .fixed
                if Self.hexValue(color) == nil { color = Self.fallbackColor }
            case .memberRole:
                colorMode = .role
                color = ""
            }
        }
    }

    /// The custom colour as 0...1 sRGB components, for a colour picker. An unreadable colour reads
    /// as ``fallbackColor``.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let value = Self.hexValue(color) ?? Self.hexValue(Self.fallbackColor) ?? 0
        return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
    }

    /// Sets the custom colour from 0...1 sRGB components (clamped, since wide-gamut colours can go
    /// past them).
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

    private enum CodingKeys: String, CodingKey {
        case channelId, questions, roleGroups, showRoles, colorMode, color, description, footer, deleteOnLeave
        case promptText, promptChannelId, promptMessageId
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channelId = try c.decode(forKey: .channelId, or: "")
        questions = try c.decodeLossyArrayIfPresent(of: IntroductionsQuestion.self, forKey: .questions)
        roleGroups = try c.decodeLossyArray(of: IntroductionsRoleGroup.self, forKey: .roleGroups)
        showRoles = try c.decode(forKey: .showRoles, or: false)
        colorMode = (try? c.decodeIfPresent(IntroductionsColorMode.self, forKey: .colorMode)) ?? .fixed
        color = try c.decode(forKey: .color, or: "")
        description = try c.decode(forKey: .description, or: "")
        footer = try c.decode(forKey: .footer, or: "")
        deleteOnLeave = try c.decode(forKey: .deleteOnLeave, or: true)
        promptText = try c.decode(forKey: .promptText, or: "")
        promptChannelId = try c.decode(forKey: .promptChannelId, or: "")
        promptMessageId = try c.decode(forKey: .promptMessageId, or: "")
    }

    /// The fields the web dashboard's form sends. The prompt's channel and message ids are the
    /// server's to track and are never sent.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(channelId, forKey: .channelId)
        try c.encodeIfPresent(questions, forKey: .questions)
        try c.encode(roleGroups, forKey: .roleGroups)
        try c.encode(showRoles, forKey: .showRoles)
        try c.encode(colorMode, forKey: .colorMode)
        try c.encode(color, forKey: .color)
        try c.encode(description, forKey: .description)
        try c.encode(footer, forKey: .footer)
        try c.encode(deleteOnLeave, forKey: .deleteOnLeave)
        try c.encode(promptText, forKey: .promptText)
    }
}

/// One question of the DM questionnaire. Sent back exactly as it came.
public struct IntroductionsQuestion: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var prompt: String
    public var required: Bool
    /// The longest answer, in characters.
    public var maxLength: Int
    /// Shown side by side with the next one on the card.
    public var inline: Bool

    public init(id: String, label: String, prompt: String = "", required: Bool = false, maxLength: Int = 500,
                inline: Bool = false) {
        self.id = id
        self.label = label
        self.prompt = prompt
        self.required = required
        self.maxLength = maxLength
        self.inline = inline
    }

    private enum CodingKeys: String, CodingKey { case id, label, prompt, required, maxLength, inline }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            label: try c.decode(String.self, forKey: .label),
            prompt: try c.decode(forKey: .prompt, or: ""),
            required: try c.decode(forKey: .required, or: false),
            maxLength: try c.decode(forKey: .maxLength, or: 500),
            inline: try c.decode(forKey: .inline, or: false))
    }
}

/// A group of roles listed on the card under one name (for example Country). Sent back as it came.
public struct IntroductionsRoleGroup: Codable, Sendable, Equatable, Identifiable {
    public var name: String
    public var roleIds: [String]
    /// Leave the group out of a card that has none of its roles.
    public var hideWhenEmpty: Bool

    public var id: String { name }

    public init(name: String, roleIds: [String] = [], hideWhenEmpty: Bool = false) {
        self.name = name
        self.roleIds = roleIds
        self.hideWhenEmpty = hideWhenEmpty
    }

    private enum CodingKeys: String, CodingKey { case name, roleIds, hideWhenEmpty }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(String.self, forKey: .name),
            roleIds: try c.decode(forKey: .roleIds, or: []),
            hideWhenEmpty: try c.decode(forKey: .hideWhenEmpty, or: false))
    }
}
