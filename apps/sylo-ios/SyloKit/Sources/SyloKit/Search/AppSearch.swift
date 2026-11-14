import Foundation
import Observation

// Search across a server, the app's version of the dashboard's command palette (src/web/routes/v2Search.js,
// web-v2/src/paletteModel.js): modules and pages by name, members through the member search, and an inbox
// item by its number ("ticket 12", "suggestion #5", "#12"). The palette's inbox lookup,
// `GET .../search/inbox?q=`, is Sylo 5.2; it has no feature string, so the app tries it for a query that
// looks like a number and a 404 means the server has no lookup (the number is then not offered).

/// The kinds of inbox item that have a number.
public enum InboxItemKind: Hashable, Sendable, RawRepresentable, Decodable {
    case ticket
    case suggestion
    case appeal
    case application
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "ticket": self = .ticket
        case "suggestion": self = .suggestion
        case "appeal": self = .appeal
        case "application": self = .application
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .ticket: "ticket"
        case .suggestion: "suggestion"
        case .appeal: "appeal"
        case .application: "application"
        case .other(let raw): raw
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    /// "Ticket", "Suggestion", ...
    public var title: String {
        switch self {
        case .ticket: "Ticket"
        case .suggestion: "Suggestion"
        case .appeal: "Ban appeal"
        case .application: "Application"
        case .other(let raw): raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }
}

/// An inbox item the lookup found. The answer holds no text and no member data.
public struct InboxHit: Decodable, Sendable, Hashable, Identifiable {
    public let kind: InboxItemKind
    public let number: Int
    public let status: String

    public var id: String { "\(kind.rawValue)-\(number)" }

    public init(kind: InboxItemKind, number: Int, status: String = "") {
        self.kind = kind
        self.number = number
        self.status = status
    }

    private enum CodingKeys: String, CodingKey { case kind, number, status }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(InboxItemKind.self, forKey: .kind)
        number = c.lenientCount(.number)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
    }
}

public struct InboxSearchAnswer: Decodable, Sendable, Equatable {
    public let items: [InboxHit]

    public init(items: [InboxHit] = []) { self.items = items }

    private enum CodingKeys: String, CodingKey { case items }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeLossyArray(of: InboxHit.self, forKey: .items)
    }
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/search/inbox?q=`: an inbox item of this server by number. View level; 60 a
    /// minute. A query that is not a number answers an empty list.
    public struct SearchInbox: APIEndpoint {
        public typealias Response = InboxSearchAnswer
        public let server: ServerID
        public let text: String

        public init(server: ServerID, text: String) {
            self.server = server
            self.text = text
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/search/inbox" }
        public var query: [URLQueryItem] { [URLQueryItem(name: "q", value: String(text.prefix(40)))] }
    }
}

/// How a typed text names an inbox item: an optional kind, then a number.
public enum InboxQuery {
    public struct Parsed: Equatable, Sendable {
        /// nil when only a number was typed: every kind is tried.
        public let kind: InboxItemKind?
        public let number: Int
    }

    private static let kinds: [(word: String, kind: InboxItemKind)] = [
        ("ticket", .ticket), ("suggestion", .suggestion), ("appeal", .appeal), ("application", .application),
    ]

    /// "12", "#12", "ticket 12", "suggestions #5": the same shapes the server reads. Anything else is nil.
    public static func parse(_ raw: String) -> Parsed? {
        var text = Substring(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40).lowercased())
        var kind: InboxItemKind?
        for entry in kinds where text.hasPrefix(entry.word) {
            kind = entry.kind
            text = text.dropFirst(entry.word.count)
            if text.hasPrefix("s") { text = text.dropFirst() }
            break
        }
        text = Substring(text.trimmingCharacters(in: .whitespaces))
        if text.hasPrefix("#") { text = text.dropFirst() }
        text = Substring(text.trimmingCharacters(in: .whitespaces))
        guard (1...9).contains(text.count), text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let number = Int(text), number >= 1 else { return nil }
        return Parsed(kind: kind, number: number)
    }
}

// MARK: - Places

/// A page of the app a server's search can open.
public enum SearchPage: String, Sendable, Hashable, CaseIterable {
    case tickets, appeals, moderation, settings, auditLog, memberData, insights, leaderboard, commands
    case messages, setupWizard, importConfig

    public var title: String {
        switch self {
        case .tickets: "Tickets"
        case .appeals: "Ban appeals"
        case .moderation: "Moderation"
        case .settings: "Server settings"
        case .auditLog: "Audit log"
        case .memberData: "Member data"
        case .insights: "Insights"
        case .leaderboard: "Leaderboard"
        case .commands: "Commands"
        case .messages: "Embed messages"
        case .setupWizard: "Setup wizard"
        case .importConfig: "Import configuration"
        }
    }

    public var symbol: String {
        switch self {
        case .tickets: "bubble.left.and.bubble.right"
        case .appeals: "hand.raised"
        case .moderation: "shield"
        case .settings: "gearshape"
        case .auditLog: "list.bullet.clipboard"
        case .memberData: "person.text.rectangle"
        case .insights: "chart.bar.xaxis"
        case .leaderboard: "trophy"
        case .commands: "slash.circle"
        case .messages: "text.bubble"
        case .setupWizard: "wand.and.stars"
        case .importConfig: "square.and.arrow.down"
        }
    }

    /// Words people use for it that its title does not say (Tickets used to be called "modmail").
    public var keywords: String {
        switch self {
        case .tickets: "modmail support inbox"
        case .appeals: "unban inbox"
        case .moderation: "warn ban kick mute timeout cases lockdown"
        case .settings: "dashboard access roles bot master colour mod log"
        case .auditLog: "history changes undo"
        case .memberData: "privacy forget erase gdpr"
        case .insights: "activity statistics stats"
        case .leaderboard: "xp ranking levels"
        case .commands: "slash"
        case .messages: "embeds builder"
        case .setupWizard: "setup start guide"
        case .importConfig: "import restore"
        }
    }
}

/// Where a search result leads.
public enum SearchTarget: Hashable, Sendable {
    case module(String)
    case page(SearchPage)
    case member(id: String, name: String)
    case inbox(kind: InboxItemKind, number: Int)
}

public enum SearchGroup: Int, Hashable, Sendable, Comparable {
    case inboxItems, members, pages, modules

    public static func < (a: SearchGroup, b: SearchGroup) -> Bool { a.rawValue < b.rawValue }

    public var title: String {
        switch self {
        case .inboxItems: "Inbox items"
        case .members: "Members"
        case .pages: "Pages"
        case .modules: "Modules"
        }
    }
}

public struct SearchItem: Hashable, Sendable, Identifiable {
    public let id: String
    public let group: SearchGroup
    public let title: String
    public let hint: String
    public let symbol: String
    public let keywords: String
    public let target: SearchTarget

    public init(id: String, group: SearchGroup, title: String, hint: String = "", symbol: String,
                keywords: String = "", target: SearchTarget) {
        self.id = id
        self.group = group
        self.title = title
        self.hint = hint
        self.symbol = symbol
        self.keywords = keywords
        self.target = target
    }
}

/// The places a search can open and how a typed text ranks them (the palette's `paletteItems` and
/// `scoreItem`). Pure functions.
public enum SearchIndex {
    /// Every page and module of a server the person can open: the pages of the app, and every module card
    /// (also one that is switched off: the person may be looking for where to switch it on). `pages` is
    /// what the screen has (a page the server lacks, such as the wizard, is left out by the caller).
    public static func items(overview: ServerOverview?, pages: [SearchPage]) -> [SearchItem] {
        var items: [SearchItem] = pages.map { page in
            SearchItem(id: "page:\(page.rawValue)", group: .pages, title: page.title, symbol: page.symbol,
                       keywords: page.keywords, target: .page(page))
        }
        for group in overview?.groups ?? [] {
            for card in group.cards where card.id != "general" {
                // The link cards that are pages of their own (Commands, Embed messages) are listed above.
                if card.kind == .link { continue }
                let state: String
                switch card.status {
                case .on: state = "On"
                case .off: state = "Off"
                case .blocked: state = "Blocked"
                default: state = ""
                }
                items.append(SearchItem(
                    id: "module:\(card.id)", group: .modules, title: card.name,
                    hint: [group.title, state].filter { !$0.isEmpty }.joined(separator: " \u{00B7} "),
                    symbol: ModuleSymbol.name(forIcon: card.icon), keywords: group.title,
                    target: .module(card.id)))
            }
        }
        return items
    }

    private static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    /// How well an item matches the typed words: 0 for no match, higher is better. Every word must be found
    /// (in the title, or the words kept with it); a title that starts with the word, or has a word that
    /// does, ranks over one that only contains it.
    public static func score(_ item: SearchItem, query: String) -> Int {
        let words = fold(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !words.isEmpty else { return 1 }
        let title = fold(item.title)
        let titleWords = title.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        let extra = fold("\(item.keywords) \(item.hint)")
        var total = 0
        for word in words {
            var score = 0
            if title.hasPrefix(word) {
                score = 100
            } else if titleWords.contains(where: { $0.hasPrefix(word) }) {
                score = 70
            } else if title.contains(word) {
                score = 40
            } else if extra.contains(word) {
                score = 15
            }
            if score == 0 { return 0 }
            total += score
        }
        return total
    }

    /// The most results a typed text shows.
    public static let maxShown = 30

    private struct Match {
        let index: Int
        let score: Int
        let item: SearchItem
    }

    /// The list to show: with nothing typed, the pages; with a text, the items that match, best first. The
    /// `found` items (members, inbox items by number) come first, because the person typed their name or number.
    public static func ranked(_ items: [SearchItem], query: String, found: [SearchItem] = []) -> [SearchItem] {
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty { return items.filter { $0.group == .pages } }
        var matches: [Match] = []
        for (index, item) in items.enumerated() {
            let value = score(item, query: typed)
            if value > 0 { matches.append(Match(index: index, score: value, item: item)) }
        }
        matches.sort { left, right in
            if left.score != right.score { return left.score > right.score }
            return left.index < right.index
        }
        var scored: [SearchItem] = []
        for match in matches.prefix(maxShown) { scored.append(match.item) }
        return found + scored
    }
}

// MARK: - The search

/// The search on a server screen. Pages and modules match as the person types; members go through the
/// member search and an inbox number through the lookup, each after a short pause (the view's
/// `.task(id:)` calls ``search()``).
@MainActor
@Observable
public final class ServerSearchModel {
    public let server: ServerID

    /// What the person typed.
    public var query = ""
    public private(set) var members: [MemberMatch] = []
    public private(set) var inboxHits: [InboxHit] = []
    public private(set) var isSearching = false
    public private(set) var errorMessage: String?
    /// False once this server is known to have no inbox lookup (a 404).
    public private(set) var hasInboxLookup = true

    private let memberSearch: MemberSearchModel
    private let session: AppSession
    private var newest = 0

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
        memberSearch = MemberSearchModel(server: server, session: session)
    }

    /// Looks up members and, for a number, inbox items. Newer queries replace older ones.
    public func search() async {
        newest += 1
        let mine = newest
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else {
            members = []
            inboxHits = []
            errorMessage = nil
            isSearching = false
            return
        }
        isSearching = true
        defer { if mine == newest { isSearching = false } }
        memberSearch.query = typed
        async let memberWork: Void = memberSearch.search()
        async let inboxWork: [InboxHit]? = lookUpInbox(typed)
        _ = await memberWork
        let hits = await inboxWork
        guard mine == newest else { return }
        // Members only when the member search ran for this text (it can be unavailable on an old server).
        members = memberSearch.searchedText == typed ? memberSearch.results : []
        inboxHits = hits ?? []
        errorMessage = memberSearch.errorMessage
    }

    /// Asks the server for an item with this number; only for a text that reads as one.
    private func lookUpInbox(_ typed: String) async -> [InboxHit]? {
        guard hasInboxLookup, InboxQuery.parse(typed) != nil else { return nil }
        do {
            return try await session.send(Endpoints.SearchInbox(server: server, text: typed)).items
        } catch {
            let error = NetworkError(error)
            if error.isMissingRoute { hasInboxLookup = false }
            return nil
        }
    }

    /// The items the lookups found, as search results.
    public var foundItems: [SearchItem] {
        let hits = inboxHits.map { hit in
            SearchItem(
                id: "inbox:\(hit.id)", group: .inboxItems, title: "\(hit.kind.title) #\(hit.number)",
                hint: hit.status, symbol: "number", target: .inbox(kind: hit.kind, number: hit.number))
        }
        let people = members.map { member in
            SearchItem(
                id: "member:\(member.id)", group: .members, title: member.name,
                hint: "Open member data", symbol: "person", target: .member(id: member.id, name: member.name))
        }
        return hits + people
    }
}
