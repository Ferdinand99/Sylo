import Foundation
import Observation

// The Economy member lookup (src/web/routes/v2Economy.js: `/modules/economy/members` and
// `/modules/economy/members/:userId`). Staff can see who holds what, a member's latest transactions
// and their inventory, and change a member's money (see Economy/EconomyAdmin.swift).

/// Someone as the economy pages name them.
public struct EconomyPerson: Decodable, Sendable, Hashable {
    public let id: String
    /// The server nickname when Sylo knows it, else the account name, else the id.
    public let name: String
    /// False for someone who left but still has an account.
    public let inServer: Bool

    public init(id: String, name: String, inServer: Bool = true) {
        self.id = id
        self.name = name
        self.inServer = inServer
    }

    private enum CodingKeys: String, CodingKey { case id, name, inServer }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        self.init(
            id: id,
            name: try c.decode(forKey: .name, or: id),
            inServer: try c.decode(forKey: .inServer, or: true))
    }
}

/// A member's money: cash in hand and in the bank. A member without an account holds nothing.
public struct EconomyAccount: Decodable, Sendable, Hashable {
    public let cash: Int
    public let bank: Int
    public let total: Int
    /// How many days in a row they claimed /daily.
    public let dailyStreak: Int
    public let hasAccount: Bool

    public init(cash: Int = 0, bank: Int = 0, total: Int? = nil, dailyStreak: Int = 0, hasAccount: Bool = true) {
        self.cash = cash
        self.bank = bank
        self.total = total ?? cash + bank
        self.dailyStreak = dailyStreak
        self.hasAccount = hasAccount
    }

    private enum CodingKeys: String, CodingKey { case cash, bank, total, dailyStreak, hasAccount }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            cash: try c.decode(forKey: .cash, or: 0),
            bank: try c.decode(forKey: .bank, or: 0),
            total: try c.decodeIfPresent(Int.self, forKey: .total),
            dailyStreak: try c.decode(forKey: .dailyStreak, or: 0),
            hasAccount: try c.decode(forKey: .hasAccount, or: true))
    }
}

/// One row of the member list.
public struct EconomyMemberRow: Decodable, Sendable, Hashable, Identifiable {
    public let userId: String
    public let account: EconomyAccount
    /// nil when the server could not name them.
    public let member: EconomyPerson?

    public var id: String { userId }
    /// The name to show: their name, or the id when nobody could name them.
    public var displayName: String { member?.name ?? userId }

    public init(userId: String, account: EconomyAccount, member: EconomyPerson? = nil) {
        self.userId = userId
        self.account = account
        self.member = member
    }

    private enum CodingKeys: String, CodingKey { case userId, member }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The balances sit in the row itself, next to the id.
        self.init(
            userId: try c.decode(String.self, forKey: .userId),
            account: try EconomyAccount(from: decoder),
            member: try c.decodeIfPresent(EconomyPerson.self, forKey: .member))
    }
}

/// `GET .../economy/members`: a page of the members with an account, or the members a search found.
public struct EconomyMemberList: Decodable, Sendable, Equatable {
    /// True when the answer is the result of a name search (one page, at most 10 members, with
    /// zeros for members without an account).
    public let isSearch: Bool
    public let rows: [EconomyMemberRow]
    public let page: Int
    public let pages: Int
    /// How many members the list has in all.
    public let total: Int

    public init(isSearch: Bool = false, rows: [EconomyMemberRow] = [], page: Int = 1, pages: Int = 1,
                total: Int? = nil) {
        self.isSearch = isSearch
        self.rows = rows
        self.page = page
        self.pages = pages
        self.total = total ?? rows.count
    }

    private enum CodingKeys: String, CodingKey { case search, rows, page, pages, total }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rows = try c.decodeLossyArray(of: EconomyMemberRow.self, forKey: .rows)
        self.init(
            isSearch: try c.decode(forKey: .search, or: false),
            rows: rows,
            page: try c.decode(forKey: .page, or: 1),
            pages: try c.decode(forKey: .pages, or: 1),
            total: try c.decodeIfPresent(Int.self, forKey: .total))
    }
}

/// One line of a member's ledger: every change to their money, with who made it.
public struct EconomyTransaction: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    /// What happened (`daily`, `pay_in`, `staff_add` …); see ``kindLabel``.
    public let kind: String
    /// The change: positive for money in, negative for money out.
    public let amount: Int
    public let cashAfter: Int
    public let bankAfter: Int
    /// The other member in a payment or a robbery.
    public let counterparty: EconomyPerson?
    /// The staff member behind a staff change.
    public let actor: EconomyPerson?
    /// The reason staff gave; "" when none.
    public let reason: String
    /// When it happened, in milliseconds since 1970.
    public let createdAt: Double?

    public init(id: Int, kind: String, amount: Int, cashAfter: Int = 0, bankAfter: Int = 0,
                counterparty: EconomyPerson? = nil, actor: EconomyPerson? = nil, reason: String = "",
                createdAt: Double? = nil) {
        self.id = id
        self.kind = kind
        self.amount = amount
        self.cashAfter = cashAfter
        self.bankAfter = bankAfter
        self.counterparty = counterparty
        self.actor = actor
        self.reason = reason
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, amount, cashAfter, bankAfter, counterparty, actor, reason, createdAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(Int.self, forKey: .id),
            kind: try c.decode(forKey: .kind, or: ""),
            amount: try c.decode(forKey: .amount, or: 0),
            cashAfter: try c.decode(forKey: .cashAfter, or: 0),
            bankAfter: try c.decode(forKey: .bankAfter, or: 0),
            counterparty: try c.decodeIfPresent(EconomyPerson.self, forKey: .counterparty),
            actor: try c.decodeIfPresent(EconomyPerson.self, forKey: .actor),
            reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "",
            createdAt: try c.decodeIfPresent(Double.self, forKey: .createdAt))
    }

    public var date: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// The words the dashboard uses for each kind (web-v2/src/moduleForms/Economy.jsx,
    /// KIND_LABELS); a kind the app does not know shows as the server named it.
    public var kindLabel: String { Self.kindLabels[kind] ?? kind }

    private static let kindLabels: [String: String] = [
        "start": "Starting balance",
        "message": "Chat",
        "voice": "Voice",
        "daily": "Daily",
        "work": "Work",
        "pay_out": "Payment sent",
        "pay_in": "Payment received",
        "tax": "Payment tax",
        "rob_win": "Robbery (won)",
        "rob_loss": "Robbery (lost)",
        "rob_fine_out": "Fine for a failed robbery",
        "rob_fine_in": "Fine received",
        "deposit": "Deposit",
        "withdraw": "Withdrawal",
        "staff_add": "Staff added",
        "staff_remove": "Staff removed",
        "staff_set": "Staff set",
        "reset": "Reset",
        // The shop and giveaways (src/modules/lib/economy.js, KINDS). A collectible is bought,
        // given and refunded like any other item, so it uses these kinds; the row's `reason` holds
        // the item's name.
        "purchase": "Shop purchase",
        "refund": "Refund",
        "grant": "Item given",
        "revoke": "Item taken away",
        "giveaway_entry": "Giveaway entry",
        "giveaway_prize": "Giveaway prize",
    ]
}

/// `GET .../economy/members/:userId`: one member's balances and their latest transactions
/// (up to 50, newest first).
public struct EconomyMemberDetail: Decodable, Sendable, Equatable {
    public let member: EconomyPerson?
    public let account: EconomyAccount
    /// How many transactions the member has in all (the list shows the latest 50).
    public let transactionCount: Int
    public let transactions: [EconomyTransaction]
    /// What the member owns, newest first (up to 100).
    public let inventory: [InventoryRow]

    public init(member: EconomyPerson? = nil, account: EconomyAccount = EconomyAccount(), transactionCount: Int? = nil,
                transactions: [EconomyTransaction] = [], inventory: [InventoryRow] = []) {
        self.member = member
        self.account = account
        self.transactionCount = transactionCount ?? transactions.count
        self.transactions = transactions
        self.inventory = inventory
    }

    private enum CodingKeys: String, CodingKey { case member, account, transactionCount, transactions, inventory }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let transactions = try c.decodeLossyArray(of: EconomyTransaction.self, forKey: .transactions)
        self.init(
            member: try c.decodeIfPresent(EconomyPerson.self, forKey: .member),
            account: try c.decode(forKey: .account, or: EconomyAccount(hasAccount: false)),
            transactionCount: try c.decodeIfPresent(Int.self, forKey: .transactionCount),
            transactions: transactions,
            inventory: try c.decodeLossyArray(of: InventoryRow.self, forKey: .inventory))
    }
}

/// How an amount of money is written: "🪙 1,234 coins", with the server's currency.
public enum EconomyMoney {
    public static func format(_ amount: Int, emoji: String, name: String, locale: Locale = .current) -> String {
        let number = amount.formatted(.number.locale(locale))
        return [emoji, number, name].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// A change with its sign: "+50", "-1,200".
    public static func signed(_ amount: Int, locale: Locale = .current) -> String {
        let number = amount.formatted(.number.locale(locale))
        return amount > 0 ? "+" + number : number
    }
}

/// How the member list is ordered.
public enum EconomySort: String, Sendable, CaseIterable {
    case total, cash, bank
}

extension Endpoints {
    /// `GET /api/v2/guilds/:id/modules/economy/members`: a page of the members with an account
    /// (richest first by default), or, with `search`, the members whose name matches it (or one
    /// pasted id).
    public struct EconomyMembers: APIEndpoint {
        public typealias Response = EconomyMemberList
        public let server: ServerID
        public let search: String
        public let sort: EconomySort
        public let page: Int

        public init(server: ServerID, search: String = "", sort: EconomySort = .total, page: Int = 1) {
            self.server = server
            self.search = search
            self.sort = sort
            self.page = page
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/economy/members" }
        public var query: [URLQueryItem] {
            var items = [URLQueryItem(name: "sort", value: sort.rawValue), URLQueryItem(name: "dir", value: "desc")]
            let text = search.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { items.append(URLQueryItem(name: "q", value: text)) }
            if page > 1 { items.append(URLQueryItem(name: "page", value: String(page))) }
            return items
        }
    }

    /// `GET /api/v2/guilds/:id/modules/economy/members/:userId`.
    public struct EconomyMember: APIEndpoint {
        public typealias Response = EconomyMemberDetail
        public let server: ServerID
        public let userID: String

        public init(server: ServerID, userID: String) {
            self.server = server
            self.userID = userID
        }

        public var path: String {
            "/api/v2/guilds/\(server.pathComponent)/modules/economy/members/\(userID.encodedPathSegment)"
        }
    }
}

/// The member list: the members with the most money, or what a name search found.
@MainActor
@Observable
public final class EconomyMembersModel {
    public let server: ServerID
    /// What the person typed in the search box.
    public var query = ""
    public private(set) var rows: [EconomyMemberRow] = []
    /// How many members the list has in all.
    public private(set) var total = 0
    public private(set) var isSearch = false
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    /// Why the list could not be loaded (the last list, if any, stays).
    public var errorMessage: String?

    /// The search the shown list is for, so more pages continue the same list.
    private var loadedQuery = ""
    private var page = 0
    private var pages = 0
    /// Goes up with every new list, so a slow answer to an old search is dropped.
    private var generation = 0
    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// More pages follow (only the plain list pages; a search is one page).
    public var canLoadMore: Bool { !isSearch && page < pages }

    /// Loads the first page, or the search for ``query``.
    public func load() async {
        generation += 1
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let asked = query
            let list = try await session.send(Endpoints.EconomyMembers(server: server, search: asked))
            guard mine == generation else { return }
            loadedQuery = asked
            rows = list.rows
            total = list.total
            isSearch = list.isSearch
            page = list.page
            pages = list.pages
            hasLoaded = true
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Adds the next page of the plain list.
    public func loadMore() async {
        guard canLoadMore, !isLoading else { return }
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let list = try await session.send(Endpoints.EconomyMembers(server: server, search: loadedQuery, page: page + 1))
            guard mine == generation else { return }
            var seen = Set(rows.map(\.userId))
            rows += list.rows.filter { seen.insert($0.userId).inserted }
            page = list.page
            pages = list.pages
            total = list.total
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }
}

/// One member's balances and latest transactions, and the staff changes to their money.
@MainActor
@Observable
public final class EconomyMemberModel {
    /// The longest reason the server keeps, in characters.
    public static let maxReasonLength = 200

    public let server: ServerID
    public let userID: String
    public private(set) var detail: EconomyMemberDetail?
    public private(set) var isLoading = false
    public private(set) var isChanging = false
    public var errorMessage: String?
    /// Why a change did not go through.
    public var actionError: String?
    /// What the last change did, in the server's words ("Now 450 coins in cash ...").
    public private(set) var notice: String?
    /// Goes up with every change that went through, for a haptic.
    public private(set) var changeCount = 0

    private let session: AppSession

    public init(server: ServerID, userID: String, session: AppSession) {
        self.server = server
        self.userID = userID
        self.session = session
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await session.send(Endpoints.EconomyMember(server: server, userID: userID))
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// What is wrong with an amount for this action, in words, or nil when it can be sent.
    public nonisolated static func amountProblem(_ amount: Int, for action: EconomyAdjustAction) -> String? {
        guard action.needsAmount, !action.amountRange.contains(amount) else { return nil }
        let range = action.amountRange
        return "Enter a whole number from \(range.lowerBound.formatted()) to \(range.upperBound.formatted())."
    }

    /// Adds, removes or sets the member's money, or resets the member. The reason is trimmed and kept in
    /// the ledger; empty sends none. The member's detail is replaced with the server's answer.
    /// - Returns: Whether the change went through. On failure ``actionError`` says why.
    @discardableResult
    public func adjust(_ action: EconomyAdjustAction, amount: Int, reason: String) async -> Bool {
        guard !isChanging else { return false }
        actionError = nil
        if let problem = Self.amountProblem(amount, for: action) {
            actionError = problem
            return false
        }
        isChanging = true
        defer { isChanging = false }
        let text = UTF16Limit.truncated(reason.trimmingCharacters(in: .whitespacesAndNewlines), to: Self.maxReasonLength)
        do {
            let result = try await session.send(
                Endpoints.AdjustEconomyMember(server: server, userID: userID, action: action, amount: amount, reason: text))
            detail = result.detail
            var message = result.summary
            if result.clamped { message += " The most a member can hold was reached, so less than asked was added." }
            notice = message.isEmpty ? nil : message
            changeCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { actionError = error.userMessage }
            return false
        }
    }
}
