import Foundation

// The focused moderator view (Sylo 5.3, `moderator-view` in `GET /api/mobile/info`). A person whose level in a
// server is Inbox lands on the inbox and sees only the moderation tools their level allows, instead of the full
// app with its settings locked. View keeps the full read-only app (observers need the whole picture) and Edit is
// unchanged. An Inbox person can choose "Show everything" to get the full, still locked, app back. Nothing changes
// on the server: the level is `access` of each server in `GET /api/v2/guilds`, and the server enforces it on every
// route. The rules here follow the web dashboard's (web-v2/src/overviewModel.js, `navModel` with `focused`):
// the inboxes whose module is on (Tickets, Appeals, Applications, Suggestions), the Moderation hub and Member
// data. The audit log, the leaderboard, the insights, the module settings and the server settings are not in it.
// A server that does not announce `moderator-view` (Sylo 5.2 and older, self-hosted ones) keeps the full app.

extension ServerFeature {
    /// The web dashboard's focused view for Inbox-level people; the app follows the same rules.
    public static let moderatorView = ServerFeature(rawValue: "moderator-view")
}

public enum ModeratorView {
    /// The device's choice to see everything instead of the focused view (one choice for the device, as the
    /// web keeps one for the browser).
    public static let showEverythingKey = "moderatorView.showEverything"

    /// What a server screen shows the signed-in person.
    public enum Mode: Equatable, Sendable {
        /// The whole app (Edit, View, an unknown level, Inbox who chose "Show everything", or a server that
        /// has no focused view).
        case full
        /// Only the moderation tools.
        case focused
        /// An Inbox person on a server whose features are not known yet: wait before drawing the app, so it
        /// does not show the full app and then narrow it.
        case undecided
    }

    /// - Parameters:
    ///   - access: The person's level in the server; nil from a server without levels (that is Edit).
    ///   - supports: Whether the server announces ``ServerFeature/moderatorView``; nil while that is not known.
    ///   - showEverything: The person's choice to see everything.
    public static func mode(access: DashboardAccess?, supports: Bool?, showEverything: Bool) -> Mode {
        guard access == DashboardAccess.inbox else { return .full }
        switch supports {
        case .some(true): return showEverything ? .full : .focused
        case .some(false): return .full
        case .none: return .undecided
        }
    }

    /// Whether the person may switch between the focused and the full app (an Inbox person on a server that
    /// has the focused view): the switch is shown only then.
    public static func canChoose(access: DashboardAccess?, supports: Bool?) -> Bool {
        access == DashboardAccess.inbox && supports == true
    }

    // MARK: - What the focused view lists

    /// The tabs of a server screen in the focused view, in the order they are shown.
    public enum Tab: Hashable, Sendable {
        /// The ticket conversations (when the Tickets module is on).
        case tickets
        /// The rest of the queues (applications, suggestions) and Member data.
        case tools
        /// The Moderation hub: infractions, and ban appeals when that module is on.
        case moderation
    }

    /// The pages the Tools tab lists.
    public enum Tool: Hashable, Sendable {
        case applications
        case suggestions
        case memberData
    }

    /// Where a server opens for an Inbox person: the first inbox that is switched on, in the order of the web
    /// dashboard (tickets, appeals, applications, suggestions), else the Moderation hub.
    public enum Landing: Hashable, Sendable {
        case tickets
        /// The Moderation tab, on its Appeals part.
        case appeals
        case applications
        case moderationHub

        /// The tab this lands on.
        public var tab: Tab {
            switch self {
            case .tickets: .tickets
            case .appeals, .moderationHub: .moderation
            case .applications: .tools
            }
        }
    }

    /// Whether a module is on. A card the overview does not list counts as on (as on the web), and so does every
    /// module while the overview is not known.
    public static func isModuleOn(_ id: String, in overview: ServerOverview?) -> Bool {
        guard let card = overview?.groups.lazy.flatMap(\.cards).first(where: { $0.id == id }) else { return true }
        return !(card.hasToggle && card.isEnabled != true)
    }

    public static func tabs(overview: ServerOverview?) -> [Tab] {
        var tabs: [Tab] = []
        if isModuleOn("tickets", in: overview) { tabs.append(.tickets) }
        tabs.append(.tools)
        tabs.append(.moderation)
        return tabs
    }

    public static func tools(overview: ServerOverview?) -> [Tool] {
        var tools: [Tool] = []
        if isModuleOn("applications", in: overview) { tools.append(.applications) }
        if isModuleOn("suggestions", in: overview) { tools.append(.suggestions) }
        tools.append(.memberData)
        return tools
    }

    /// Whether the Moderation tab offers the Appeals part.
    public static func showsAppeals(overview: ServerOverview?) -> Bool {
        isModuleOn("appeals", in: overview)
    }

    public static func landing(overview: ServerOverview?) -> Landing {
        if isModuleOn("tickets", in: overview) { return .tickets }
        if isModuleOn("appeals", in: overview) { return .appeals }
        if isModuleOn("applications", in: overview) || isModuleOn("suggestions", in: overview) {
            return .applications
        }
        return .moderationHub
    }

    /// The pages the search offers in the focused view (not the settings, the audit log or the insights).
    public static func searchPages(overview: ServerOverview?) -> [SearchPage] {
        var pages: [SearchPage] = []
        if isModuleOn("tickets", in: overview) { pages.append(.tickets) }
        if showsAppeals(overview: overview) { pages.append(.appeals) }
        pages.append(.moderation)
        pages.append(.memberData)
        return pages
    }

    /// The overview the search sees in the focused view: only the two queues that are modules (the
    /// applications and the suggestions), so module settings and the rest are not offered.
    public static func searchOverview(_ overview: ServerOverview?) -> ServerOverview? {
        guard let overview else { return nil }
        let queues: Set<String> = ["applications", "suggestions"]
        let groups = overview.groups.compactMap { group -> OverviewGroup? in
            let cards = group.cards.filter { queues.contains($0.id) }
            return cards.isEmpty ? nil : OverviewGroup(title: group.title, cards: cards)
        }
        return ServerOverview(
            server: overview.server, openTickets: overview.openTickets, openAppeals: overview.openAppeals,
            groups: groups, attention: nil)
    }
}
