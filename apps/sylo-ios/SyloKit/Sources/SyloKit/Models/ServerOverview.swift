import Foundation

/// A server's overview page, from `GET /api/v2/guilds/:id/overview`: the header and the module
/// cards grouped the way the web overview groups them.
public struct ServerOverview: Decodable, Sendable, Equatable {
    public let server: OverviewServer
    public let openTickets: Int
    public let openAppeals: Int
    public let groups: [OverviewGroup]

    public init(server: OverviewServer, openTickets: Int = 0, openAppeals: Int = 0, groups: [OverviewGroup]) {
        self.server = server
        self.openTickets = openTickets
        self.openAppeals = openAppeals
        self.groups = groups
    }

    private enum CodingKeys: String, CodingKey { case guild, openTickets, openAppeals, groups }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        server = try c.decode(OverviewServer.self, forKey: .guild)
        openTickets = try c.decodeIfPresent(Int.self, forKey: .openTickets) ?? 0
        openAppeals = try c.decodeIfPresent(Int.self, forKey: .openAppeals) ?? 0
        groups = try c.decodeLossyArray(of: OverviewGroup.self, forKey: .groups)
    }
}

/// The overview's header. Its platform is not sent; take it from the ``ServerSummary``.
public struct OverviewServer: Decodable, Sendable, Hashable {
    public let id: ServerID
    public let name: String
    public let iconURL: URL?
    public let memberCount: Int

    public init(id: ServerID, name: String, iconURL: URL? = nil, memberCount: Int = 0) {
        self.id = id
        self.name = name
        self.iconURL = iconURL
        self.memberCount = memberCount
    }

    private enum CodingKeys: String, CodingKey { case id, name, icon, memberCount }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(ServerID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        iconURL = try c.decodeURLIfPresent(forKey: .icon)
        memberCount = try c.decodeIfPresent(Int.self, forKey: .memberCount) ?? 0
    }
}

/// One titled group of cards ("Core", "Engagement", …). A group can be empty.
public struct OverviewGroup: Decodable, Sendable, Hashable, Identifiable {
    public let title: String
    public let cards: [OverviewCard]

    public var id: String { title }

    public init(title: String, cards: [OverviewCard]) {
        self.title = title
        self.cards = cards
    }

    private enum CodingKeys: String, CodingKey { case title, cards }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        cards = try c.decodeLossyArray(of: OverviewCard.self, forKey: .cards)
    }
}

/// A card on the overview: a module (with a toggle) or a link card (Settings, Commands, Embed
/// messages, which have no toggle and `isEnabled == nil`).
public struct OverviewCard: Decodable, Sendable, Hashable, Identifiable {
    public let kind: OverviewCardKind
    /// The module id for a module card, else the link card's id (`general`, `commands`, `messages`).
    public let id: String
    public let name: String
    /// The server's icon name (Lucide-style, for example `shield`), to map to an SF Symbol.
    public let icon: String
    public let description: String?
    public let hasToggle: Bool
    /// Whether the module is on; nil for cards without a toggle.
    public let isEnabled: Bool?
    public let isBeta: Bool
    /// Privileged Discord intents the bot lacks for this module (why ``status`` is `.blocked`).
    public let missingIntents: [String]
    public let status: ModuleStatus
    /// The card's page in the web dashboard, relative to the server address.
    public let webPath: String?
    public let lines: [StatusLine]

    /// The id to toggle, for a module card.
    public var moduleID: ModuleID? { kind == .module ? ModuleID(id) : nil }

    public init(
        kind: OverviewCardKind, id: String, name: String, icon: String = "", description: String? = nil,
        hasToggle: Bool, isEnabled: Bool?, isBeta: Bool = false, missingIntents: [String] = [],
        status: ModuleStatus, webPath: String? = nil, lines: [StatusLine] = []
    ) {
        self.kind = kind
        self.id = id
        self.name = name
        self.icon = icon
        self.description = description
        self.hasToggle = hasToggle
        self.isEnabled = isEnabled
        self.isBeta = isBeta
        self.missingIntents = missingIntents
        self.status = status
        self.webPath = webPath
        self.lines = lines
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, name, icon, description, hasToggle, enabled, beta, missingIntents, status, href, lines
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(OverviewCardKind.self, forKey: .kind)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description)
        hasToggle = try c.decodeIfPresent(Bool.self, forKey: .hasToggle) ?? false
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .enabled)
        isBeta = try c.decodeIfPresent(Bool.self, forKey: .beta) ?? false
        missingIntents = try c.decodeIfPresent([String].self, forKey: .missingIntents) ?? []
        status = try c.decodeIfPresent(ModuleStatus.self, forKey: .status) ?? .other("")
        webPath = try c.decodeIfPresent(String.self, forKey: .href)
        lines = try c.decodeLossyArray(of: StatusLine.self, forKey: .lines)
    }
}

/// One line of a card's summary, for example "Log channel: #mod-log".
public struct StatusLine: Decodable, Sendable, Hashable {
    public let label: String
    public let value: String
    public let state: StatusLineState

    public init(label: String, value: String, state: StatusLineState) {
        self.label = label
        self.value = value
        self.state = state
    }

    private enum CodingKeys: String, CodingKey { case label, value, state }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        value = try c.decodeIfPresent(String.self, forKey: .value) ?? ""
        state = try c.decodeIfPresent(StatusLineState.self, forKey: .state) ?? .neutral
    }
}

/// The answer to switching a module on or off: its state now.
public struct ModuleToggleResult: Decodable, Sendable, Equatable {
    public let isEnabled: Bool

    public init(isEnabled: Bool) { self.isEnabled = isEnabled }

    private enum CodingKeys: String, CodingKey { case enabled }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isEnabled = try c.decode(Bool.self, forKey: .enabled)
    }
}
