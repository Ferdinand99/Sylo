import Foundation
import Observation

// The shop's activity (src/web/routes/v2Shop.js `/modules/economy/shop/activity`; the dashboard's
// Activity tab is web-v2/src/components/EconomyActivity.jsx): the purchases, newest first, which
// staff can narrow to one member or one item.

/// `GET .../economy/shop/activity`: one page of purchases.
public struct ShopActivityPage: Decodable, Sendable, Equatable {
    public let page: Int
    public let pages: Int
    /// How many purchases match the filter in all.
    public let total: Int
    public let rows: [InventoryRow]

    public init(page: Int = 1, pages: Int = 1, total: Int? = nil, rows: [InventoryRow] = []) {
        self.page = page
        self.pages = pages
        self.total = total ?? rows.count
        self.rows = rows
    }

    private enum CodingKeys: String, CodingKey { case page, pages, total, rows }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rows = try c.decodeLossyArray(of: InventoryRow.self, forKey: .rows)
        self.init(
            page: try c.decode(forKey: .page, or: 1),
            pages: try c.decode(forKey: .pages, or: 1),
            total: try c.decodeIfPresent(Int.self, forKey: .total),
            rows: rows)
    }
}

extension Endpoints {
    /// `GET .../economy/shop/activity?userId&itemId&page`: 25 purchases to a page.
    public struct LoadShopActivity: APIEndpoint {
        public typealias Response = ShopActivityPage
        public let server: ServerID
        public let userID: String?
        public let itemID: Int?
        public let page: Int

        public init(server: ServerID, userID: String? = nil, itemID: Int? = nil, page: Int = 1) {
            self.server = server
            self.userID = userID
            self.itemID = itemID
            self.page = page
        }

        public var path: String { "/api/v2/guilds/\(server.pathComponent)/modules/economy/shop/activity" }
        public var query: [URLQueryItem] {
            var items: [URLQueryItem] = []
            if let userID, !userID.isEmpty { items.append(URLQueryItem(name: "userId", value: userID)) }
            if let itemID { items.append(URLQueryItem(name: "itemId", value: String(itemID))) }
            if page > 1 { items.append(URLQueryItem(name: "page", value: String(page))) }
            return items
        }
    }
}

/// The shop's purchases, a page at a time, with a member and an item filter.
@MainActor
@Observable
public final class ShopActivityModel {
    public let server: ServerID
    /// Only this member's purchases; nil for everybody.
    public var userID: String?
    /// Only this item's purchases; nil for every item.
    public var itemID: Int?
    public private(set) var rows: [InventoryRow] = []
    public private(set) var total = 0
    /// The shop's items, for the filter; empty when they could not be loaded.
    public private(set) var items: [ShopItem] = []
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    public var errorMessage: String?

    private var page = 0
    private var pages = 0
    /// The filter the shown rows are for, so more pages continue the same list.
    private var loadedUser: String?
    private var loadedItem: Int?
    /// Goes up with every new list, so a slow answer for an old filter is dropped.
    private var generation = 0
    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    public var canLoadMore: Bool { page < pages }

    /// The items for the filter menu. Optional: without them the filter is hidden.
    public func loadItems() async {
        if let list = try? await session.send(Endpoints.LoadShopItems(server: server)) { items = list.items }
    }

    /// Loads the first page for the current filter.
    public func load() async {
        generation += 1
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        let user = userID
        let item = itemID
        do {
            let result = try await session.send(Endpoints.LoadShopActivity(server: server, userID: user, itemID: item))
            guard mine == generation else { return }
            loadedUser = user
            loadedItem = item
            rows = result.rows
            total = result.total
            page = result.page
            pages = result.pages
            hasLoaded = true
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }

    /// Adds the next page.
    public func loadMore() async {
        guard canLoadMore, !isLoading else { return }
        let mine = generation
        isLoading = true
        defer { if mine == generation { isLoading = false } }
        do {
            let result = try await session.send(
                Endpoints.LoadShopActivity(server: server, userID: loadedUser, itemID: loadedItem, page: page + 1))
            guard mine == generation else { return }
            var seen = Set(rows.map(\.id))
            rows += result.rows.filter { seen.insert($0.id).inserted }
            total = result.total
            page = result.page
            pages = result.pages
            errorMessage = nil
        } catch {
            guard mine == generation else { return }
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
    }
}
