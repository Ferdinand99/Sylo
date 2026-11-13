import Foundation

// Applications (src/modules/lib/applicationsForm.js, normaliseApplicationsConfig; page route
// src/web/routes/v2Applications.js; web form web-v2/src/moduleForms/Applications.jsx): Appy-style
// forms that members answer in DMs or on the web, which staff accept or deny.
//
// Two layers of settings: the module's own (how long decided applications are kept, the panel
// message's text), which the app edits, and the forms. A form is a big nested object (questions with
// options, role rules, messages) that the dashboard saves one at a time, so the app only lists them
// and leaves editing to the web dashboard. Submissions are in Applications/ApplicationSubmissions.swift.

/// The Applications settings page.
public struct ApplicationsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "applications"

    public let settings: ApplicationsSettings
    /// The forms in the dashboard's order (read only here).
    public let forms: [ApplicationFormSummary]
    public let channels: [ChannelOption]
    public let roles: [RoleOption]
    /// How many applications wait for a decision.
    public let pending: Int
    /// The most forms a server can have.
    public let maxForms: Int
    /// The retention the server uses when nothing is set, in days.
    public let defaultRetentionDays: Int
    /// The panel text the server posts when ``ApplicationsSettings/panelText`` is empty.
    public let defaultPanelText: String

    public init(settings: ApplicationsSettings, forms: [ApplicationFormSummary] = [], channels: [ChannelOption] = [],
                roles: [RoleOption] = [], pending: Int = 0, maxForms: Int = 10, defaultRetentionDays: Int = 180,
                defaultPanelText: String = "") {
        self.settings = settings
        self.forms = forms
        self.channels = channels
        self.roles = roles
        self.pending = pending
        self.maxForms = maxForms
        self.defaultRetentionDays = defaultRetentionDays
        self.defaultPanelText = defaultPanelText
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case forms, channels, roles, pending, maxForms, defaultRetentionDays, defaultPanelText
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: ApplicationsSettings())
        forms = try c.decodeLossyArray(of: ApplicationFormSummary.self, forKey: .forms)
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        pending = try c.decode(forKey: .pending, or: 0)
        maxForms = try c.decode(forKey: .maxForms, or: 10)
        defaultRetentionDays = try c.decode(forKey: .defaultRetentionDays, or: 180)
        defaultPanelText = try c.decode(forKey: .defaultPanelText, or: "")
    }
}

public struct ApplicationsSettings: Codable, Sendable, Equatable {
    /// Decided applications (and their answers) are deleted after this many days.
    public var retentionDays: Int
    /// The text of the panel message with the Apply buttons; "" = the server's default text.
    public var panelText: String
    /// Where the panel is published (bot-managed, read only, not sent); "" = not published.
    public let panelChannelId: String
    /// The panel message's id (bot-managed, read only, not sent).
    public let panelMessageId: String

    public init(retentionDays: Int = 180, panelText: String = "", panelChannelId: String = "",
                panelMessageId: String = "") {
        self.retentionDays = retentionDays
        self.panelText = panelText
        self.panelChannelId = panelChannelId
        self.panelMessageId = panelMessageId
    }

    /// The server keeps the retention in this range (up to ten years).
    public static let retentionRange = 7...3650
    public static let maxPanelTextLength = 500

    /// Whether the panel message is out in a channel.
    public var isPanelPublished: Bool { !panelMessageId.isEmpty }

    private enum CodingKeys: String, CodingKey { case retentionDays, panelText, panelChannelId, panelMessageId }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        retentionDays = try c.decode(forKey: .retentionDays, or: 180)
        panelText = try c.decode(forKey: .panelText, or: "")
        panelChannelId = try c.decode(forKey: .panelChannelId, or: "")
        panelMessageId = try c.decode(forKey: .panelMessageId, or: "")
    }

    /// What the web dashboard sends: the retention and the panel text. Which message the panel is
    /// published as is the server's to track, so it is never sent.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(retentionDays, forKey: .retentionDays)
        try c.encode(panelText, forKey: .panelText)
    }
}

/// Where members can fill a form in.
public enum ApplicationFillMode: Hashable, Sendable, RawRepresentable {
    case discord
    case web
    case both
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "discord": self = .discord
        case "web": self = .web
        case "both": self = .both
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .discord: "discord"
        case .web: "web"
        case .both: "both"
        case .other(let raw): raw
        }
    }
}

/// One form in the list under the settings (read only; forms are edited in the web dashboard).
public struct ApplicationFormSummary: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let name: String
    /// Whether members can apply with it now.
    public let isEnabled: Bool
    public let fillMode: ApplicationFillMode
    public let questionCount: Int
    /// What still stops the form from taking applications (no questions, no channel); nil when ready.
    public let setupProblem: String?
    /// What is wrong with the roles the form hands out (Sylo cannot manage one); nil when fine.
    public let rolesProblem: String?

    public init(id: Int, name: String, isEnabled: Bool = true, fillMode: ApplicationFillMode = .both,
                questionCount: Int = 0, setupProblem: String? = nil, rolesProblem: String? = nil) {
        self.id = id
        self.name = name
        self.isEnabled = isEnabled
        self.fillMode = fillMode
        self.questionCount = questionCount
        self.setupProblem = setupProblem
        self.rolesProblem = rolesProblem
    }

    private enum CodingKeys: String, CodingKey { case id, name, enabled, fillMode, questions, problems }
    private enum ProblemKeys: String, CodingKey { case setup, roles }

    /// One question, of which the list only counts them.
    private struct QuestionStub: Decodable {}

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var setup: String?
        var roles: String?
        if c.contains(.problems), let problems = try? c.nestedContainer(keyedBy: ProblemKeys.self, forKey: .problems) {
            setup = try? problems.decodeIfPresent(String.self, forKey: .setup)
            roles = try? problems.decodeIfPresent(String.self, forKey: .roles)
        }
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            name: try c.decode(forKey: .name, or: ""),
            isEnabled: try c.decode(forKey: .enabled, or: false),
            fillMode: ApplicationFillMode(rawValue: try c.decode(forKey: .fillMode, or: "both")),
            questionCount: try c.decodeLossyArray(of: QuestionStub.self, forKey: .questions).count,
            setupProblem: setup?.isEmpty == false ? setup : nil,
            rolesProblem: roles?.isEmpty == false ? roles : nil)
    }
}
