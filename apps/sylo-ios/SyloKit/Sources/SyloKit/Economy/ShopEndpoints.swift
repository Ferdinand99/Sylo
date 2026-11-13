import Foundation
import Observation

// The calls behind the shop screens (src/web/routes/v2Shop.js) and the model that holds the items.

extension ServerFeature {
    /// The server has Sylo 5.2's collectibles: items with a picture and a rarity, and the picture
    /// upload (`collectibles` in `GET /api/mobile/info`). Older servers do not say, so the screens
    /// also look at what the item list shows (``ShopItemList/showsCollectibles``).
    public static let collectibles = ServerFeature(rawValue: "collectibles")
}

extension Endpoints {
    private static func shopPath(_ server: ServerID, _ rest: String = "") -> String {
        "/api/v2/guilds/\(server.pathComponent)/modules/economy/shop/items" + rest
    }

    /// `GET .../economy/shop/items`.
    public struct LoadShopItems: APIEndpoint {
        public typealias Response = ShopItemList
        public let server: ServerID

        public init(server: ServerID) { self.server = server }

        public var path: String { Endpoints.shopPath(server) }
    }

    /// `POST .../economy/shop/items`: adds an item. The answer has the new item's `id`.
    public struct CreateShopItem: APIEndpoint {
        public typealias Response = ShopItemsAnswer
        public let server: ServerID
        public let item: ShopItemBody

        public init(server: ServerID, item: ShopItemBody) {
            self.server = server
            self.item = item
        }

        public var path: String { Endpoints.shopPath(server) }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { item }
    }

    /// `POST .../economy/shop/items/:id`: saves an item. 404 when it is gone.
    public struct UpdateShopItem: APIEndpoint {
        public typealias Response = ShopItemsAnswer
        public let server: ServerID
        public let id: Int
        public let item: ShopItemBody

        public init(server: ServerID, id: Int, item: ShopItemBody) {
            self.server = server
            self.id = id
            self.item = item
        }

        public var path: String { Endpoints.shopPath(server, "/\(id)") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { item }
    }

    /// `POST .../economy/shop/items/:id/enabled`: pauses or resumes an item.
    public struct SetShopItemEnabled: APIEndpoint {
        public typealias Response = ShopItemsAnswer
        public let server: ServerID
        public let id: Int
        public let enabled: Bool

        public init(server: ServerID, id: Int, enabled: Bool) {
            self.server = server
            self.id = id
            self.enabled = enabled
        }

        public var path: String { Endpoints.shopPath(server, "/\(id)/enabled") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(enabled: enabled) }

        private struct Body: Encodable, Sendable { let enabled: Bool }
    }

    /// `POST .../economy/shop/items/:id/delete`: removes an item. What members own is kept; the
    /// answer's `held` says how many still hold it.
    public struct DeleteShopItem: APIEndpoint {
        public typealias Response = ShopItemsAnswer
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { Endpoints.shopPath(server, "/\(id)/delete") }
        public var method: HTTPMethod { .post }
    }

    /// `POST .../economy/shop/items/order`: the items in the order members see them.
    public struct ReorderShopItems: APIEndpoint {
        public typealias Response = ShopItemsAnswer
        public let server: ServerID
        public let ids: [Int]

        public init(server: ServerID, ids: [Int]) {
            self.server = server
            self.ids = ids
        }

        public var path: String { Endpoints.shopPath(server, "/order") }
        public var method: HTTPMethod { .post }
        public var body: (any Encodable & Sendable)? { Body(ids: ids) }

        private struct Body: Encodable, Sendable { let ids: [Int] }
    }

    /// `POST .../economy/shop/items/:id/image`: a multipart upload (the field `file`, at most 2 MB, PNG,
    /// JPEG or WebP). Never retried. Failures read through ``ShopPictureProblem``.
    public struct UploadShopItemPicture: APIEndpoint {
        public typealias Response = ShopItemsAnswer
        public let server: ServerID
        public let id: Int
        public let form: MultipartForm

        public init(server: ServerID, id: Int, picture: PreparedPicture, boundary: String? = nil) {
            self.server = server
            self.id = id
            var form = boundary.map { MultipartForm(boundary: $0) } ?? MultipartForm()
            form.addFile(name: "file", filename: picture.filename, mimeType: picture.mimeType, data: picture.data)
            self.form = form
        }

        public var path: String { Endpoints.shopPath(server, "/\(id)/image") }
        public var method: HTTPMethod { .post }
        public var rawBody: RawBody? { form.rawBody }
    }

    /// `POST .../economy/shop/items/:id/image/delete`: takes the picture off the item.
    public struct RemoveShopItemPicture: APIEndpoint {
        public typealias Response = ShopItemsAnswer
        public let server: ServerID
        public let id: Int

        public init(server: ServerID, id: Int) {
            self.server = server
            self.id = id
        }

        public var path: String { Endpoints.shopPath(server, "/\(id)/image/delete") }
        public var method: HTTPMethod { .post }
    }
}

/// The shop's items: loading, saving, pausing, reordering, deleting and the picture of a collectible.
@MainActor
@Observable
public final class ShopItemsModel {
    public let server: ServerID
    public private(set) var items: [ShopItem] = []
    public private(set) var roles: [RoleOption] = []
    /// The rarity tiers the server names, or the five standard ones.
    public private(set) var rarities: [ShopRarity] = ShopRarity.standard
    public private(set) var maxItems: Int?
    public private(set) var isLoading = false
    public private(set) var hasLoaded = false
    /// A save, delete, reorder or picture call is running.
    public private(set) var isBusy = false
    /// Why the shop could not be loaded.
    public var errorMessage: String?
    /// Why a change did not go through.
    public var actionError: String?
    /// Why a picture could not go up or come off; kept apart so the form can offer Try Again.
    public private(set) var pictureProblem: ShopPictureProblem?
    /// Goes up with every change that went through, for a haptic.
    public private(set) var changeCount = 0
    /// The last create went through but its answer did not name the new item (see ``save(_:)``).
    public private(set) var savedWithoutID = false

    /// What the server's info said about collectibles; nil when it could not be asked.
    private var announcedCollectibles: Bool?
    private var listShowsCollectibles = false
    private let session: AppSession

    public init(server: ServerID, session: AppSession) {
        self.server = server
        self.session = session
    }

    /// Whether to offer collectibles, rarities and pictures: the server announced `collectibles`, or the
    /// item list shows the 5.2 fields. A server that does neither never sees them offered.
    public var supportsCollectibles: Bool { announcedCollectibles == true || listShowsCollectibles }

    public func item(id: Int) -> ShopItem? { items.first { $0.id == id } }

    /// Loads the items, and what the server says it supports.
    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let list = try await session.send(Endpoints.LoadShopItems(server: server))
            items = list.items
            roles = list.roles
            maxItems = list.maxItems
            if let tiers = list.rarities, !tiers.isEmpty { rarities = tiers } else { rarities = ShopRarity.standard }
            listShowsCollectibles = list.showsCollectibles
            hasLoaded = true
            errorMessage = nil
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { errorMessage = error.userMessage }
        }
        await loadFeatures()
    }

    private func loadFeatures() async {
        if let info = try? await session.send(Endpoints.ServerInfo()) {
            announcedCollectibles = info.supports(.collectibles)
        } else if let info = session.serverInfo {
            announcedCollectibles = info.supports(.collectibles)
        }
    }

    /// Whether another item can be added (the server keeps at most `maxItems`).
    public var canAddItem: Bool { maxItems.map { items.count < $0 } ?? true }

    /// Creates or saves an item. For a new item the answer's id is the result.
    ///
    /// A create whose answer has no `id` (no known server does that) is looked up by what is new in the
    /// answer's list. When even that finds nothing, the item exists but the app cannot tell which one:
    /// ``savedWithoutID`` is set and ``actionError`` says so, and the form must not save again, or it
    /// would add the item a second time.
    /// - Returns: The item's id, or nil when it did not go through (``actionError`` says why).
    public func save(_ draft: ShopItemDraft) async -> Int? {
        guard !isBusy else { return nil }
        actionError = nil
        savedWithoutID = false
        if let problem = draft.problem {
            actionError = problem
            return nil
        }
        let body = draft.body(supportsCollectibles: supportsCollectibles)
        isBusy = true
        defer { isBusy = false }
        do {
            if let existing = draft.id {
                items = try await session.send(Endpoints.UpdateShopItem(server: server, id: existing, item: body)).items
                changeCount += 1
                return existing
            }
            let before = Set(items.map(\.id))
            let answer = try await session.send(Endpoints.CreateShopItem(server: server, item: body))
            items = answer.items
            changeCount += 1
            if let id = answer.id { return id }
            let added = answer.items.map(\.id).filter { !before.contains($0) }
            if added.count == 1 { return added[0] }
            savedWithoutID = true
            actionError = "The item was added, but the server did not say which one it is. Close this form and check the shop list; saving again would add it a second time."
            return nil
        } catch {
            show(error)
            return nil
        }
    }

    /// Pauses or resumes an item.
    @discardableResult
    public func setEnabled(_ item: ShopItem, _ enabled: Bool) async -> Bool {
        await run { try await self.session.send(Endpoints.SetShopItemEnabled(server: self.server, id: item.id, enabled: enabled)) }
    }

    /// Deletes an item. What members already own is kept.
    @discardableResult
    public func delete(_ item: ShopItem) async -> Bool {
        await run { try await self.session.send(Endpoints.DeleteShopItem(server: self.server, id: item.id)) }
    }

    /// Moves items in the list, then tells the server the new order. The list changes at once; when
    /// the server refuses, the server's order comes back.
    public func move(from source: IndexSet, to destination: Int) async {
        guard !isBusy else { return }
        let reordered = Self.moved(items, from: source, to: destination)
        guard reordered.map(\.id) != items.map(\.id) else { return }
        let before = items
        items = reordered
        let ok = await run { try await self.session.send(Endpoints.ReorderShopItems(server: self.server, ids: reordered.map(\.id))) }
        if !ok, items == reordered { items = before }
    }

    /// `items` with the entries at `source` moved to `destination` (an index before the move, as a
    /// SwiftUI `onMove` gives it).
    static func moved<Element>(_ items: [Element], from source: IndexSet, to destination: Int) -> [Element] {
        let moving = source.sorted().map { items[$0] }
        var rest: [Element] = []
        for (index, item) in items.enumerated() where !source.contains(index) { rest.append(item) }
        let insertAt = destination - source.filter { $0 < destination }.count
        rest.insert(contentsOf: moving, at: min(max(insertAt, 0), rest.count))
        return rest
    }

    /// Puts a picture on a collectible, replacing the one it has. A picture is only tried again
    /// when the person taps (the busy and rate-limit answers say so; nothing here retries by itself).
    @discardableResult
    public func uploadPicture(_ picture: PreparedPicture, for id: Int) async -> Bool {
        guard !isBusy else { return false }
        pictureProblem = nil
        isBusy = true
        defer { isBusy = false }
        do {
            let answer = try await session.upload(Endpoints.UploadShopItemPicture(server: server, id: id, picture: picture))
            items = answer.items
            changeCount += 1
            return true
        } catch {
            let error = NetworkError(error)
            if error != .cancelled, error != .unauthorized { pictureProblem = ShopPictureProblem(error) }
            return false
        }
    }

    /// Takes the picture off a collectible. Members who own it keep the picture their copy shows.
    @discardableResult
    public func removePicture(from id: Int) async -> Bool {
        guard !isBusy else { return false }
        pictureProblem = nil
        let ok = await run { try await self.session.send(Endpoints.RemoveShopItemPicture(server: self.server, id: id)) }
        return ok
    }

    public func clearPictureProblem() { pictureProblem = nil }

    private func run(_ call: () async throws -> ShopItemsAnswer) async -> Bool {
        guard !isBusy else { return false }
        actionError = nil
        isBusy = true
        defer { isBusy = false }
        do {
            items = try await call().items
            changeCount += 1
            return true
        } catch {
            show(error)
            return false
        }
    }

    private func show(_ error: any Error) {
        let error = NetworkError(error)
        if error == .notFound {
            actionError = "That item is gone. Refresh the shop."
        } else if error != .cancelled, error != .unauthorized {
            actionError = error.userMessage
        }
    }
}
