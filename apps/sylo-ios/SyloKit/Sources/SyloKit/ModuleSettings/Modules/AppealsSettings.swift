import Foundation

// Ban appeals (src/modules/appeals.js, normaliseAppealsConfig; web form
// web-v2/src/moduleForms/Appeals.jsx): banned members get a private link to an appeal form;
// staff decide on the dashboard's Appeals tab.

/// The Appeals settings page.
public struct AppealsPage: ModuleSettingsPage {
    public static let moduleID: ModuleID = "appeals"

    public let settings: AppealsSettings
    public let channels: [ChannelOption]
    /// Whether the Sylo server has a public dashboard URL; without it no appeal link can be built.
    public let dashboardUrlSet: Bool

    public init(settings: AppealsSettings, channels: [ChannelOption] = [], dashboardUrlSet: Bool = true) {
        self.settings = settings
        self.channels = channels
        self.dashboardUrlSet = dashboardUrlSet
    }

    private enum CodingKeys: String, CodingKey {
        case settings = "config"
        case channels, dashboardUrlSet
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decode(forKey: .settings, or: AppealsSettings())
        channels = try c.decode(forKey: .channels, or: [])
        dashboardUrlSet = try c.decode(forKey: .dashboardUrlSet, or: false)
    }
}

public struct AppealsSettings: Codable, Sendable, Equatable {
    /// The appeal form's questions, always `questionSlots` long like the web form; blank slots
    /// are dropped by the server, and the first one should be filled in.
    public var questions: [String]
    /// Lift the ban automatically when an appeal is accepted.
    public var autoUnbanOnAccept: Bool
    /// Gets new-appeal and decision notices, or "".
    public var reviewChannelId: String
    /// Days to wait after a denied appeal before another is allowed; 0 allows one at once.
    public var cooldownDays: Int
    /// An extra line in the ban DM.
    public var appealMessage: String
    /// A permanent invite (`https://discord.gg/…`) to another server Sylo is in, or "". The server
    /// drops anything else.
    public var appealServerInvite: String

    /// What the server uses when no questions are set.
    public static let defaultQuestions = [
        "Why were you banned?",
        "Why should your ban be lifted?",
        "What will you do differently if your appeal is accepted?",
    ]
    public static let questionSlots = 5
    public static let maxQuestionLength = 200
    public static let maxMessageLength = 1000
    public static let maxInviteLength = 100
    public static let cooldownRange = 0...90

    public init(questions: [String] = AppealsSettings.defaultQuestions, autoUnbanOnAccept: Bool = true,
                reviewChannelId: String = "", cooldownDays: Int = 7, appealMessage: String = "",
                appealServerInvite: String = "") {
        self.questions = AppealsSettings.padded(questions)
        self.autoUnbanOnAccept = autoUnbanOnAccept
        self.reviewChannelId = reviewChannelId
        self.cooldownDays = cooldownDays
        self.appealMessage = appealMessage
        self.appealServerInvite = appealServerInvite
    }

    /// Exactly `questionSlots` entries, blank ones at the end, like the web form's slots.
    private static func padded(_ questions: [String]) -> [String] {
        let kept = Array(questions.prefix(questionSlots))
        return kept + Array(repeating: "", count: questionSlots - kept.count)
    }

    private enum CodingKeys: String, CodingKey {
        case questions, autoUnbanOnAccept, reviewChannelId, cooldownDays, appealMessage, appealServerInvite
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let questions: [String] = try c.decode(forKey: .questions, or: [])
        self.init(
            questions: questions.contains { !$0.isEmpty } ? questions : AppealsSettings.defaultQuestions,
            autoUnbanOnAccept: try c.decode(forKey: .autoUnbanOnAccept, or: true),
            reviewChannelId: try c.decode(forKey: .reviewChannelId, or: ""),
            cooldownDays: try c.decode(forKey: .cooldownDays, or: 7),
            appealMessage: try c.decode(forKey: .appealMessage, or: ""),
            appealServerInvite: try c.decode(forKey: .appealServerInvite, or: ""))
    }
}
