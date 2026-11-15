import Foundation
import Testing
@testable import SyloKit

@Suite("Inventory")
struct InventoryDecodingTests {
    /// `GET .../economy/members/:userId/inventory` as a Sylo 5.2 server sends it (v2Shop.js, rowView).
    static let inventory52JSON = #"""
    {
      "inventory": [
        {"id": 5, "userId": "810000000000000001", "member": {"id": "810000000000000001", "name": "Alex", "inServer": true},
         "itemId": 2, "itemName": "Founder badge", "itemType": "collectible", "itemRemoved": false, "roleId": null,
         "imagePath": "/c/abc.webp", "rarity": "epic", "pricePaid": 500, "source": "purchase", "status": "active",
         "expiresAt": null, "fulfilledAt": null, "fulfilledBy": null, "note": "", "createdAt": 1794000200000},
        {"id": 6, "userId": "810000000000000001", "itemId": 1, "itemName": "VIP", "itemType": "temp_role",
         "itemRemoved": false, "roleId": "910000000000000001", "imagePath": null, "rarity": null, "pricePaid": 0,
         "source": "grant", "status": "pending", "expiresAt": 1794100000000, "note": "Contest", "createdAt": 1794000100000},
        {"id": 7, "userId": "810000000000000001", "itemId": 3, "itemName": "Shoutout", "itemType": "custom",
         "itemRemoved": true, "pricePaid": 50, "source": "purchase", "status": "active",
         "fulfilledAt": 1794000300000, "fulfilledBy": {"id": "820000000000000001", "name": "Mod", "inServer": true},
         "note": "Done", "createdAt": 1794000000000},
        {"id": 8, "itemId": 4, "itemName": "From the future", "itemType": "hologram", "rarity": "mythic",
         "status": "vaporised", "pricePaid": 9, "source": "gift"},
        {"itemName": "no id"}
      ],
      "refunded": true,
      "warning": "The role could not be taken off: missing permission."
    }
    """#

    /// A 5.1 row has no picture and no rarity.
    static let row51JSON = #"""
    {"inventory": [{"id": 1, "userId": "7", "member": {"id": "7", "name": "Alex", "inServer": true}, "itemId": 1,
      "itemName": "VIP", "itemType": "role", "itemRemoved": false, "roleId": "9", "pricePaid": 100,
      "source": "purchase", "status": "active", "expiresAt": null, "fulfilledAt": null, "fulfilledBy": null,
      "note": "", "createdAt": 1}]}
    """#

    static func decode(_ json: String) throws -> InventoryAnswer {
        try JSONDecoder().decode(InventoryAnswer.self, from: Data(json.utf8))
    }

    @Test("a 5.2 inventory has pictures and rarities, and the answer says how a refund ended")
    func decodes52() throws {
        let answer = try Self.decode(Self.inventory52JSON)
        #expect(answer.inventory.map(\.id) == [5, 6, 7, 8])
        #expect(answer.refunded == true)
        #expect(answer.warning == "The role could not be taken off: missing permission.")

        let badge = answer.inventory[0]
        #expect(badge.itemType == .collectible)
        #expect(badge.imagePath == "/c/abc.webp")
        #expect(badge.rarity == "epic")
        #expect(badge.member?.name == "Alex")
        #expect(badge.pricePaid == 500)
        #expect(badge.createdDate == Date(timeIntervalSince1970: 1_794_000_200))

        let role = answer.inventory[1]
        #expect(role.itemType == .tempRole)
        #expect(role.status == .pending)
        #expect(role.isGrant)
        #expect(role.expiresDate == Date(timeIntervalSince1970: 1_794_100_000))
        #expect(role.note == "Contest")
        #expect(role.imagePath == nil)

        let custom = answer.inventory[2]
        #expect(custom.itemRemoved)
        #expect(custom.isFulfilled)
        #expect(custom.fulfilledBy?.name == "Mod")
    }

    @Test("a row of a kind, status or source the app does not know is kept as it came")
    func unknownKept() throws {
        let odd = try Self.decode(Self.inventory52JSON).inventory[3]
        #expect(odd.itemType == .other("hologram"))
        #expect(odd.status == .other("vaporised"))
        #expect(odd.status.title == "vaporised")
        #expect(odd.rarity == "mythic")
        #expect(odd.source == "gift")
        #expect(!odd.isLive)
        #expect(!odd.canRevoke && !odd.canRefund && !odd.canFulfil)
    }

    @Test("a 5.1 row decodes with no picture and no rarity, and without a warning or a refund flag")
    func decodes51() throws {
        let answer = try Self.decode(Self.row51JSON)
        let row = try #require(answer.inventory.first)
        #expect(row.itemType == .role)
        #expect(row.imagePath == nil)
        #expect(row.rarity == nil)
        #expect(answer.refunded == nil)
        #expect(answer.warning == nil)
    }

    @Test("an empty or missing inventory is nothing, and an empty warning is none")
    func lenient() throws {
        #expect(try Self.decode("{}").inventory.isEmpty)
        #expect(try Self.decode(#"{"inventory":[],"warning":""}"#).warning == nil)
    }

    @Test("what staff can do depends on where the entry stands")
    func capabilities() {
        func row(_ type: ShopItemType = .custom, status: InventoryStatus = .active, source: String = "purchase",
                 paid: Int = 100, fulfilled: Double? = nil) -> InventoryRow {
            InventoryRow(id: 1, itemType: type, pricePaid: paid, source: source, status: status, fulfilledAt: fulfilled)
        }
        // A purchase that is held can be revoked and refunded.
        #expect(row().canRevoke && row().canRefund)
        #expect(row(status: .pending).canRevoke)
        // A gift cannot be refunded, nor can a free purchase.
        #expect(!row(source: "grant").canRefund)
        #expect(row(source: "grant").canRevoke)
        #expect(!row(paid: 0).canRefund)
        // An ended entry has no actions.
        for status in [InventoryStatus.revoked, .refunded, .expired] {
            #expect(!row(status: status).canRevoke)
            #expect(!row(status: status).canRefund)
            #expect(!row(.custom, status: status).canFulfil)
        }
        // Only an active custom item is fulfilled, and reopened once it was.
        #expect(row(.custom).canFulfil)
        #expect(row(.custom, fulfilled: 5).canFulfil)
        #expect(row(.custom, fulfilled: 5).isFulfilled)
        #expect(!row(.role).canFulfil)
        #expect(!row(.collectible).canFulfil)
        #expect(!row(.custom, status: .pending).canFulfil)
    }

    @Test("the member detail carries the inventory, and a 5.1 detail or an odd entry does not break it")
    func detailInventory() throws {
        let json = #"{"member":{"id":"1","name":"A","inServer":true},"account":{"cash":1},"transactions":[],"inventory":[{"id":1,"itemName":"x","itemType":"collectible","imagePath":"/c/a.webp","rarity":"rare"},{"x":1}]}"#
        let detail = try JSONDecoder().decode(EconomyMemberDetail.self, from: Data(json.utf8))
        #expect(detail.inventory.map(\.id) == [1])
        #expect(detail.inventory[0].rarity == "rare")
        let none = try JSONDecoder().decode(EconomyMemberDetail.self, from: Data(#"{"account":{}}"#.utf8))
        #expect(none.inventory.isEmpty)
    }

    @Test("every status has the dashboard's word")
    func statusWords() {
        #expect(InventoryStatus.allWords == ["Being set up", "Active", "Revoked", "Refunded", "Expired"])
    }
}

extension InventoryStatus {
    fileprivate static var allWords: [String] {
        [InventoryStatus.pending, .active, .revoked, .refunded, .expired].map(\.title)
    }
}

@Suite("Inventory endpoints")
struct InventoryEndpointTests {
    private func json(_ body: (any Encodable & Sendable)?) throws -> [String: Any] {
        guard let body else {
            Issue.record("the call has no body")
            return [:]
        }
        let data = try JSONEncoder().encode(body)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("the inventory is a GET below the member, the id encoded")
    func load() {
        let e = Endpoints.LoadMemberInventory(server: "fluxer:1", userID: "810000000000000001")
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/economy/members/810000000000000001/inventory")
        #expect(e.method == .get)
        #expect(Endpoints.LoadMemberInventory(server: "1", userID: "a/b").path.hasSuffix("/members/a%2Fb/inventory"))
    }

    @Test("a grant posts the item id and the reason")
    func grant() throws {
        let e = Endpoints.GrantShopItem(server: "1", userID: "7", itemID: 12, reason: "Contest")
        #expect(e.path == "/api/v2/guilds/1/modules/economy/members/7/inventory/grant")
        #expect(e.method == .post)
        let body = try json(e.body)
        #expect(Set(body.keys) == ["itemId", "reason"])
        #expect(body["itemId"] as? Int == 12)
        #expect(body["reason"] as? String == "Contest")
    }

    @Test("revoke and refund post to their own paths with the reason")
    func revokeAndRefund() throws {
        let revoke = Endpoints.EndInventoryRow(server: "1", userID: "7", rowID: 5, ending: .revoke, reason: "Spam")
        #expect(revoke.path == "/api/v2/guilds/1/modules/economy/members/7/inventory/5/revoke")
        #expect(revoke.method == .post)
        #expect(try json(revoke.body) as NSDictionary == ["reason": "Spam"] as NSDictionary)

        let refund = Endpoints.EndInventoryRow(server: "1", userID: "7", rowID: 5, ending: .refund)
        #expect(refund.path.hasSuffix("/inventory/5/refund"))
        #expect(try json(refund.body) as NSDictionary == ["reason": ""] as NSDictionary)
    }

    @Test("fulfil posts the flag and the note, to reopen as well")
    func fulfil() throws {
        let done = Endpoints.FulfilInventoryRow(server: "1", userID: "7", rowID: 5, fulfilled: true, note: "Sent")
        #expect(done.path == "/api/v2/guilds/1/modules/economy/members/7/inventory/5/fulfil")
        #expect(done.method == .post)
        let body = try json(done.body)
        #expect(Set(body.keys) == ["fulfilled", "note"])
        #expect(body["fulfilled"] as? Bool == true)
        let reopen = try json(Endpoints.FulfilInventoryRow(server: "1", userID: "7", rowID: 5, fulfilled: false).body)
        #expect(reopen["fulfilled"] as? Bool == false)
    }
}

@MainActor
@Suite("Inventory model")
struct InventoryModelTests {
    nonisolated static func row(_ id: Int, name: String = "Badge", status: InventoryStatus = .active) -> InventoryRow {
        InventoryRow(id: id, userId: "7", itemId: 1, itemName: name, itemType: .collectible, pricePaid: 500, status: status)
    }

    nonisolated static let shop = ShopItemList(
        items: [ShopItem(id: 1, name: "Badge", type: .collectible, price: 500), ShopItem(id: 2, name: "VIP", type: .role)])

    @Test("loading reads the inventory and the items to give")
    func loads() async {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadMemberInventory: return InventoryAnswer(inventory: [Self.row(1), Self.row(2)])
            case is Endpoints.LoadShopItems: return Self.shop
            default: throw NetworkError.notFound
            }
        }
        let model = MemberInventoryModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.rows.map(\.id) == [1, 2])
        #expect(model.items.map(\.id) == [1, 2])
    }

    @Test("a shop that cannot be read still shows the inventory; one that cannot be read at all explains")
    func loadFailures() async {
        let partial = StubClients { endpoint in
            if endpoint is Endpoints.LoadMemberInventory { return InventoryAnswer(inventory: [Self.row(1)]) }
            throw NetworkError.notFound
        }
        let model = MemberInventoryModel(server: "9", userID: "7", session: makeSignedInSession(clients: partial))
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.items.isEmpty)
        #expect(model.errorMessage == nil)

        let none = StubClients { _ in throw NetworkError.forbidden }
        let failed = MemberInventoryModel(server: "9", userID: "7", session: makeSignedInSession(clients: none))
        await failed.load()
        #expect(!failed.hasLoaded)
        #expect(failed.errorMessage == NetworkError.forbidden.userMessage)
    }

    @Test("a grant sends the item and a trimmed reason, and the inventory comes back")
    func grant() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.GrantShopItem { return InventoryAnswer(inventory: [Self.row(9)]) }
            throw NetworkError.notFound
        }
        let model = MemberInventoryModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        let ok = await model.grant(ShopItem(id: 1, name: "Badge"), reason: "  Contest winner \n")
        #expect(ok)
        #expect(model.rows.map(\.id) == [9])
        #expect(model.notice == "Badge was given.")
        #expect(model.changeCount == 1)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.GrantShopItem)
        #expect(sent.itemID == 1)
        #expect(sent.reason == "Contest winner")
    }

    @Test("a refund says the money went back; a refund that revoked only, and a warning, are said too")
    func refund() async throws {
        let clients = StubClients { _ in InventoryAnswer(inventory: [Self.row(1, status: .refunded)], refunded: true) }
        let model = MemberInventoryModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        #expect(await model.end(Self.row(1), as: .refund, reason: "Mistake"))
        #expect(model.notice == "Badge was refunded and taken away.")
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.EndInventoryRow)
        #expect(sent.ending == .refund)
        #expect(sent.rowID == 1)
        #expect(sent.reason == "Mistake")

        clients.setHandler { _ in InventoryAnswer(inventory: [], refunded: false) }
        #expect(await model.end(Self.row(1), as: .refund, reason: ""))
        #expect(model.notice == "Badge was taken away, but nothing was refunded.")

        clients.setHandler { _ in InventoryAnswer(inventory: [], refunded: false, warning: "The role could not be taken off.") }
        #expect(await model.end(Self.row(1), as: .revoke, reason: ""))
        #expect(model.notice == "Badge was taken away. No money moved. The role could not be taken off.")
    }

    @Test("a reason is cut to the server's 200 characters")
    func reasonCut() async throws {
        let clients = StubClients { _ in InventoryAnswer(inventory: []) }
        let model = MemberInventoryModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        await model.end(Self.row(1), as: .revoke, reason: String(repeating: "x", count: 250))
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.EndInventoryRow)
        #expect(sent.reason.count == 200)
    }

    @Test("fulfilling and reopening post the flag and the note")
    func fulfil() async throws {
        let clients = StubClients { _ in InventoryAnswer(inventory: [Self.row(1)]) }
        let model = MemberInventoryModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        #expect(await model.setFulfilled(Self.row(1), true, note: "Sent by post"))
        #expect(model.notice == "Marked as fulfilled.")
        var sent = try #require(clients.calls.last?.endpoint as? Endpoints.FulfilInventoryRow)
        #expect(sent.fulfilled)
        #expect(sent.note == "Sent by post")
        #expect(await model.setFulfilled(Self.row(1), false, note: ""))
        #expect(model.notice == "Reopened.")
        sent = try #require(clients.calls.last?.endpoint as? Endpoints.FulfilInventoryRow)
        #expect(!sent.fulfilled)
    }

    @Test("the server's refusal is shown in its words and the inventory stays")
    func refused() async {
        let clients = StubClients { _ in throw NetworkError.badRequest(message: "That item is no longer active.") }
        let model = MemberInventoryModel(server: "9", userID: "7", session: makeSignedInSession(clients: clients))
        let ok = await model.end(Self.row(1), as: .revoke, reason: "")
        #expect(!ok)
        #expect(model.actionError == "That item is no longer active.")
        #expect(model.notice == nil)
        #expect(model.changeCount == 0)
    }
}

@MainActor
@Suite("Shop activity")
struct ShopActivityTests {
    nonisolated static let pageJSON = #"""
    {"page": 1, "pages": 3, "total": 61, "rows": [
      {"id": 9, "userId": "7", "member": {"id": "7", "name": "Alex", "inServer": true}, "itemId": 1, "itemName": "Badge",
       "itemType": "collectible", "itemRemoved": false, "imagePath": "/c/a.webp", "rarity": "rare", "pricePaid": 500,
       "source": "purchase", "status": "active", "createdAt": 1794000000000},
      {"id": 8, "userId": "8", "itemId": 3, "itemName": "Shoutout", "itemType": "custom", "pricePaid": 50,
       "source": "purchase", "status": "refunded"},
      {"note": "no id"}
    ]}
    """#

    @Test("a page of purchases decodes with its paging")
    func decodes() throws {
        let page = try JSONDecoder().decode(ShopActivityPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.page == 1)
        #expect(page.pages == 3)
        #expect(page.total == 61)
        #expect(page.rows.map(\.id) == [9, 8])
        #expect(page.rows[0].member?.name == "Alex")
        #expect(page.rows[1].status == .refunded)
        let empty = try JSONDecoder().decode(ShopActivityPage.self, from: Data("{}".utf8))
        #expect(empty.rows.isEmpty)
        #expect(empty.pages == 1)
    }

    nonisolated static func page(_ ids: ClosedRange<Int>, page: Int, pages: Int) -> ShopActivityPage {
        ShopActivityPage(page: page, pages: pages, total: 5, rows: ids.map { InventoryRow(id: $0) })
    }

    @Test("pages are added without repeating a purchase, and the filter follows along")
    func paging() async throws {
        let clients = StubClients { endpoint in
            guard let call = endpoint as? Endpoints.LoadShopActivity else { throw NetworkError.notFound }
            return call.page == 1 ? Self.page(1...3, page: 1, pages: 2) : Self.page(3...5, page: 2, pages: 2)
        }
        let model = ShopActivityModel(server: "9", session: makeSignedInSession(clients: clients))
        model.userID = "7"
        model.itemID = 4
        await model.load()
        #expect(model.rows.map(\.id) == [1, 2, 3])
        #expect(model.canLoadMore)
        await model.loadMore()
        #expect(model.rows.map(\.id) == [1, 2, 3, 4, 5])
        #expect(!model.canLoadMore)
        let last = try #require(clients.calls.last?.endpoint as? Endpoints.LoadShopActivity)
        #expect(last.page == 2)
        #expect(last.userID == "7")
        #expect(last.itemID == 4)
    }

    @Test("a filter change on screen does not alter the pages of the list already shown")
    func filterChangeMidPaging() async throws {
        let clients = StubClients { endpoint in
            guard let call = endpoint as? Endpoints.LoadShopActivity else { throw NetworkError.notFound }
            return call.page == 1 ? Self.page(1...3, page: 1, pages: 2) : Self.page(3...5, page: 2, pages: 2)
        }
        let model = ShopActivityModel(server: "9", session: makeSignedInSession(clients: clients))
        model.userID = "7"
        await model.load()
        model.userID = "8"
        await model.loadMore()
        let last = try #require(clients.calls.last?.endpoint as? Endpoints.LoadShopActivity)
        #expect(last.userID == "7")
    }

    @Test("a failed load explains and keeps the rows")
    func failed() async {
        let clients = StubClients { _ in Self.page(1...2, page: 1, pages: 1) }
        let model = ShopActivityModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        clients.setHandler { _ in throw NetworkError.forbidden }
        await model.load()
        #expect(model.rows.count == 2)
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)
    }

    @Test("the item filter lists the shop's items, or nothing when they cannot be read")
    func items() async {
        let clients = StubClients { _ in ShopItemList(items: [ShopItem(id: 1, name: "Badge")]) }
        let model = ShopActivityModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.loadItems()
        #expect(model.items.map(\.id) == [1])
        clients.setHandler { _ in throw NetworkError.notFound }
        let failing = ShopActivityModel(server: "9", session: makeSignedInSession(clients: clients))
        await failing.loadItems()
        #expect(failing.items.isEmpty)
    }
}
