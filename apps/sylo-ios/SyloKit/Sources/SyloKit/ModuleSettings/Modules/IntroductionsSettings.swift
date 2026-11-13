import Foundation

// Introductions (src/modules/introductions.js, normaliseIntroductionsConfig; page route
// src/web/routes/v2Intro.js; web form web-v2/src/moduleForms/Introductions.jsx): members answer a
// few questions in DMs and Sylo posts a membership card in the introductions channel.
//
// The app edits the channel, the card's look, the questions, the role groups and the prompt text.
// The server builds the whole config from what it is sent, so the lists travel with every save; the
// questions only when the server sent them, so a server that sent none keeps its default ones.
// Publishing and removing the prompt message is in Introductions/IntroPrompt.swift.

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
    /// What members are asked, in order. nil when the server sent none, so the save leaves the
    /// field out and the server keeps its default questions.
    public var questions: [IntroductionsQuestion]?
    /// Role groups shown on the card.
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
    /// How many questions and role groups the server sent that this version of the app cannot read (read
    /// only, never sent). A save replaces both lists, so with any of these the settings are not saved
    /// from the app (see ``problem``): it would delete them.
    public let unreadableEntries: Int

    /// Two settings are the same when what a save would send is the same. That leaves out only where
    /// the prompt is published, which is the server's to track, so publishing it is not an unsaved
    /// change. Comparing the encoded body, not a list of fields, means a field added later counts as an
    /// edit without anyone having to remember this.
    public static func == (lhs: IntroductionsSettings, rhs: IntroductionsSettings) -> Bool {
        lhs.sentBody == rhs.sentBody
    }

    private var sentBody: Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(self)
    }

    public init(channelId: String = "", questions: [IntroductionsQuestion]? = [],
                roleGroups: [IntroductionsRoleGroup] = [], showRoles: Bool = false,
                colorMode: IntroductionsColorMode = .fixed, color: String = "", description: String = "",
                footer: String = "", deleteOnLeave: Bool = true, promptText: String = "",
                promptChannelId: String = "", promptMessageId: String = "", unreadableEntries: Int = 0) {
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
        self.unreadableEntries = unreadableEntries
    }

    /// The limits the server enforces (src/modules/introductions.js, LIMITS).
    public static let maxDescriptionLength = 1000
    public static let maxFooterLength = 200
    public static let maxPromptTextLength = 500
    public static let maxQuestions = 8
    public static let maxRoleGroups = 10
    /// The most roles one group holds.
    public static let maxRolesPerGroup = 25

    /// The colour the form starts a custom colour from.
    public static let fallbackColor = "#7aa2f7"

    /// Whether the prompt message is out in a channel.
    public var isPromptPublished: Bool { !promptMessageId.isEmpty }

    // MARK: Editing the lists

    /// Moves questions the way `onMove` reports it.
    public mutating func moveQuestions(fromOffsets source: IndexSet, toOffset destination: Int) {
        guard var moved = questions else { return }
        FormListOrder.move(&moved, fromOffsets: source, toOffset: destination)
        questions = moved
    }

    /// Adds an empty question (up to ``maxQuestions``).
    /// - Returns: Whether there was room.
    @discardableResult
    public mutating func addQuestion() -> Bool {
        let current = questions ?? []
        guard current.count < Self.maxQuestions else { return false }
        questions = current + [IntroductionsQuestion.blank()]
        return true
    }

    /// Adds an empty role group (up to ``maxRoleGroups``).
    /// - Returns: Whether there was room.
    @discardableResult
    public mutating func addRoleGroup() -> Bool {
        guard roleGroups.count < Self.maxRoleGroups else { return false }
        roleGroups.append(IntroductionsRoleGroup())
        return true
    }

    /// Why the settings cannot be saved yet; nil when they can. The server drops a question without a
    /// label, a role group without a name and a second group with the same name without a word, so the
    /// app refuses to save them instead of losing what was typed.
    public var problem: String? {
        if unreadableEntries > 0 {
            return unreadableEntries == 1
                ? "The server sent a question or role group this version of the app cannot read, so saving here would delete it. Update the app to edit these settings."
                : "The server sent \(unreadableEntries) questions or role groups this version of the app cannot read, so saving here would delete them. Update the app to edit these settings."
        }
        if (questions ?? []).contains(where: { $0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            return "Give every question a label."
        }
        let names = roleGroups.map { $0.cleanName.lowercased() }
        if names.contains("") { return "Give every role group a name." }
        if Set(names).count != names.count { return "Two role groups have the same name." }
        return nil
    }

    /// The placeholders for the role groups that have a name, as the description and footer take them.
    public var roleGroupPlaceholders: [String] {
        roleGroups.map(\.cleanName).filter { !$0.isEmpty }.map { "{rolegroup:\($0)}" }
    }

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

    /// One entry of a list, read on its own so one that fails is counted instead of silently dropped.
    private struct EntrySlot<Entry: Decodable>: Decodable {
        let value: Entry?
        init(from decoder: any Decoder) throws { value = try? Entry(from: decoder) }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channelId = try c.decode(forKey: .channelId, or: "")
        let questionSlots = try c.decodeIfPresent([EntrySlot<IntroductionsQuestion>].self, forKey: .questions)
        let groupSlots = try c.decodeIfPresent([EntrySlot<IntroductionsRoleGroup>].self, forKey: .roleGroups) ?? []
        questions = questionSlots?.compactMap { $0.value }
        roleGroups = groupSlots.compactMap { $0.value }
        unreadableEntries = (questionSlots ?? []).filter { $0.value == nil }.count + groupSlots.filter { $0.value == nil }.count
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
    /// Fields of the question this version of the app does not model, sent back as they came.
    public var extras: [String: JSONValue]

    /// The limits the server enforces.
    public static let maxLabelLength = 45
    public static let maxPromptLength = 300
    public static let answerLengthRange = 1...1024

    /// An empty question for the editor. Its id is made here; the server keeps it.
    public static func blank() -> IntroductionsQuestion {
        IntroductionsQuestion(id: "q" + UUID().uuidString.prefix(8).lowercased(), label: "", maxLength: 300)
    }

    public init(id: String, label: String, prompt: String = "", required: Bool = false, maxLength: Int = 500,
                inline: Bool = false, extras: [String: JSONValue] = [:]) {
        self.id = id
        self.label = label
        self.prompt = prompt
        self.required = required
        self.maxLength = maxLength
        self.inline = inline
        self.extras = extras
    }

    private enum CodingKeys: String, CodingKey, CaseIterable { case id, label, prompt, required, maxLength, inline }
    private static let knownKeys = Set(CodingKeys.allCases.map(\.rawValue))

    public func encode(to encoder: any Encoder) throws {
        var extra = encoder.container(keyedBy: PassthroughKey.self)
        try Passthrough.write(extras, excluding: Self.knownKeys, to: &extra)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(label, forKey: .label)
        try c.encode(prompt, forKey: .prompt)
        try c.encode(required, forKey: .required)
        try c.encode(maxLength, forKey: .maxLength)
        try c.encode(inline, forKey: .inline)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(String.self, forKey: .id),
            label: try c.decode(String.self, forKey: .label),
            prompt: try c.decode(forKey: .prompt, or: ""),
            required: try c.decode(forKey: .required, or: false),
            maxLength: try c.decode(forKey: .maxLength, or: 500),
            inline: try c.decode(forKey: .inline, or: false),
            extras: try Passthrough.read(decoder, excluding: Self.knownKeys))
    }
}

/// A group of roles listed on the card under one name (for example Country).
public struct IntroductionsRoleGroup: Codable, Sendable, Equatable, Identifiable {
    public var name: String
    public var roleIds: [String]
    /// Leave the group out of a card that has none of its roles.
    public var hideWhenEmpty: Bool
    /// Tells groups apart while a name is being typed (the name is the group's identity on the
    /// server, but changes with every key). Never sent, never part of what makes two groups equal.
    public let key: String
    /// Fields of the group this version of the app does not model, sent back as they came.
    public var extras: [String: JSONValue]

    public var id: String { key }

    public init(name: String = "", roleIds: [String] = [], hideWhenEmpty: Bool = false,
                key: String = UUID().uuidString, extras: [String: JSONValue] = [:]) {
        self.name = name
        self.roleIds = roleIds
        self.hideWhenEmpty = hideWhenEmpty
        self.key = key
        self.extras = extras
    }

    /// Equal when what is sent is equal, so the local key never matters.
    public static func == (lhs: IntroductionsRoleGroup, rhs: IntroductionsRoleGroup) -> Bool {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (try? encoder.encode(lhs)) == (try? encoder.encode(rhs))
    }

    public static let maxNameLength = 45

    /// The name as the server stores it: no braces (it sits inside `{rolegroup:<name>}`), spaces
    /// collapsed and trimmed.
    public var cleanName: String {
        name.replacingOccurrences(of: "{", with: "").replacingOccurrences(of: "}", with: "")
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private enum CodingKeys: String, CodingKey, CaseIterable { case name, roleIds, hideWhenEmpty }
    private static let knownKeys = Set(CodingKeys.allCases.map(\.rawValue))

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: try c.decode(String.self, forKey: .name),
            roleIds: try c.decode(forKey: .roleIds, or: []),
            hideWhenEmpty: try c.decode(forKey: .hideWhenEmpty, or: false),
            extras: try Passthrough.read(decoder, excluding: Self.knownKeys))
    }

    public func encode(to encoder: any Encoder) throws {
        var extra = encoder.container(keyedBy: PassthroughKey.self)
        try Passthrough.write(extras, excluding: Self.knownKeys, to: &extra)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(roleIds, forKey: .roleIds)
        try c.encode(hideWhenEmpty, forKey: .hideWhenEmpty)
    }
}
