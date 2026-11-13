import Foundation

// Applications (src/modules/lib/applicationsForm.js, normaliseApplicationsConfig; page route
// src/web/routes/v2Applications.js; web form web-v2/src/moduleForms/Applications.jsx): Appy-style
// forms that members answer in DMs or on the web, which staff accept or deny.
//
// Two layers of settings: the module's own (how long decided applications are kept, the panel
// message's text), saved with the module, and the forms. A form is a big nested object (questions
// with options, role rules, messages) that the dashboard saves one at a time, so it has its own model
// and calls (Applications/ApplicationForms.swift). Publishing the panel and the rest of the staff
// actions are in Applications/ApplicationActions.swift, submissions in
// Applications/ApplicationSubmissions.swift.

/// The Applications settings page.
public struct ApplicationsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "applications"

    public let settings: ApplicationsSettings
    /// The forms in the dashboard's order, each with everything the editor changes.
    public let forms: [ApplicationForm]
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
    /// The longest short answer a text question can allow.
    public let shortTextMax: Int
    /// The texts a new form starts with.
    public let defaultMessages: ApplicationFormMessages
    /// The placeholders the messages understand ("{user}", "{server}", "{form}", "{reason}").
    public let placeholders: [String]
    /// Whether the platform has threads (the staff thread option). nil when the server did not say.
    public let supportsThreads: Bool?

    public init(settings: ApplicationsSettings, forms: [ApplicationForm] = [], channels: [ChannelOption] = [],
                roles: [RoleOption] = [], pending: Int = 0, maxForms: Int = 10, defaultRetentionDays: Int = 180,
                defaultPanelText: String = "", shortTextMax: Int = 1024,
                defaultMessages: ApplicationFormMessages = ApplicationFormMessages(), placeholders: [String] = [],
                supportsThreads: Bool? = nil) {
        self.settings = settings
        self.forms = forms
        self.channels = channels
        self.roles = roles
        self.pending = pending
        self.maxForms = maxForms
        self.defaultRetentionDays = defaultRetentionDays
        self.defaultPanelText = defaultPanelText
        self.shortTextMax = shortTextMax
        self.defaultMessages = defaultMessages
        self.placeholders = placeholders
        self.supportsThreads = supportsThreads
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case forms, channels, roles, pending, maxForms, defaultRetentionDays, defaultPanelText
        case shortTextMax, defaultMessages, placeholders
        case supportsThreads = "threads"
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: ApplicationsSettings())
        forms = try c.decodeLossyArray(of: ApplicationForm.self, forKey: .forms)
        channels = try c.decode(forKey: .channels, or: [])
        roles = try c.decode(forKey: .roles, or: [])
        pending = try c.decode(forKey: .pending, or: 0)
        maxForms = try c.decode(forKey: .maxForms, or: 10)
        defaultRetentionDays = try c.decode(forKey: .defaultRetentionDays, or: 180)
        defaultPanelText = try c.decode(forKey: .defaultPanelText, or: "")
        shortTextMax = try c.decode(forKey: .shortTextMax, or: ApplicationQuestion.defaultMaxShortText)
        defaultMessages = try c.decode(forKey: .defaultMessages, or: ApplicationFormMessages())
        placeholders = try c.decode(forKey: .placeholders, or: [])
        supportsThreads = try c.decodeIfPresent(Bool.self, forKey: .supportsThreads)
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

    /// Two settings are the same when the person's edits are: where the panel is published is the
    /// server's to track, so publishing it is not an unsaved change.
    public static func == (lhs: ApplicationsSettings, rhs: ApplicationsSettings) -> Bool {
        lhs.retentionDays == rhs.retentionDays && lhs.panelText == rhs.panelText
    }

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
