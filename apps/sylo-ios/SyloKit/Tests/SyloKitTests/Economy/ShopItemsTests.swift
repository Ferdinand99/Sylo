import Foundation
import Testing
@testable import SyloKit

@Suite("Shop items")
struct ShopItemsDecodingTests {
    /// `GET .../economy/shop/items` as a Sylo 5.2 server sends it (v2Shop.js, itemView).
    static let list52JSON = #"""
    {
      "items": [
        {"id": 1, "name": "VIP", "description": "A role", "emoji": "⭐", "type": "temp_role", "roleId": "910000000000000001",
         "durationHours": 24, "price": 500, "stock": 10, "sold": 3, "left": 7, "requiredRoles": ["910000000000000009"],
         "perMemberLimit": 1, "enabled": true, "sortOrder": 0, "rarity": null, "announce": false, "imagePath": null,
         "purchases": 3, "revenue": 1500},
        {"id": 2, "name": "Founder badge", "description": "", "emoji": "🎖️", "type": "collectible", "roleId": null,
         "durationHours": null, "price": 900, "stock": null, "sold": 0, "left": null, "requiredRoles": [],
         "perMemberLimit": null, "enabled": true, "sortOrder": 1, "rarity": "epic", "announce": true,
         "imagePath": "/c/0123456789abcdef0123456789abcdef.webp", "purchases": 0, "revenue": 0},
        {"id": 3, "name": "No picture yet", "type": "collectible", "price": 10, "rarity": "", "imagePath": null},
        {"id": 4, "name": "From the future", "type": "hologram", "price": 1, "rarity": "mythic"},
        {"name": "broken, no id"}
      ],
      "roles": [{"id": "910000000000000001", "name": "VIP"}, {"id": "910000000000000009", "name": "Member"}],
      "channels": [{"id": "1", "name": "general"}],
      "maxItems": 100,
      "rarities": [{"key": "common", "label": "Common"}, {"key": "uncommon", "label": "Uncommon"},
                   {"key": "rare", "label": "Rare"}, {"key": "epic", "label": "Epic"},
                   {"key": "legendary", "label": "Legendary"}]
    }
    """#

    /// The same answer from a Sylo 5.1 server: no rarity, no announce, no picture, no `rarities`.
    static let list51JSON = #"""
    {
      "items": [
        {"id": 1, "name": "VIP", "description": "", "emoji": "", "type": "role", "roleId": "910000000000000001",
         "durationHours": null, "price": 500, "stock": null, "sold": 0, "left": null, "requiredRoles": [],
         "perMemberLimit": null, "enabled": false, "sortOrder": 0, "purchases": 0, "revenue": 0},
        {"id": 2, "name": "Shoutout", "type": "custom", "price": 50}
      ],
      "roles": [{"id": "910000000000000001", "name": "VIP"}],
      "maxItems": 50
    }
    """#

    static func decode(_ json: String) throws -> ShopItemList {
        try JSONDecoder().decode(ShopItemList.self, from: Data(json.utf8))
    }

    @Test("a 5.2 answer has collectibles with their rarity and picture, and the five tiers")
    func decodes52() throws {
        let list = try Self.decode(Self.list52JSON)
        #expect(list.items.map(\.id) == [1, 2, 3, 4])
        #expect(list.maxItems == 100)
        #expect(list.roles.map(\.name) == ["VIP", "Member"])
        #expect(list.rarities?.map(\.key) == ["common", "uncommon", "rare", "epic", "legendary"])
        #expect(list.showsCollectibles)

        let vip = list.items[0]
        #expect(vip.type == .tempRole)
        #expect(vip.durationHours == 24)
        #expect(vip.stock == 10)
        #expect(vip.left == 7)
        #expect(vip.requiredRoles == ["910000000000000009"])
        #expect(vip.perMemberLimit == 1)
        #expect(vip.rarity == nil)
        #expect(!vip.needsPicture)

        let badge = list.items[1]
        #expect(badge.type == .collectible)
        #expect(badge.rarity == "epic")
        #expect(badge.announce)
        #expect(badge.imagePath == "/c/0123456789abcdef0123456789abcdef.webp")
        #expect(badge.stock == nil)
        #expect(!badge.needsPicture)
    }

    @Test("a collectible without a picture needs one, and an empty rarity is none")
    func needsPicture() throws {
        let item = try Self.decode(Self.list52JSON).items[2]
        #expect(item.needsPicture)
        #expect(item.rarity == nil)
        #expect(item.enabled)
        #expect(item.description.isEmpty)
    }

    @Test("an unknown item type and an unknown rarity are kept as the server sent them")
    func unknownKept() throws {
        let item = try Self.decode(Self.list52JSON).items[3]
        #expect(item.type == .other("hologram"))
        #expect(item.type.rawValue == "hologram")
        #expect(!item.type.isKnown)
        #expect(item.type.title == "hologram")
        #expect(item.rarity == "mythic")
        #expect(ShopRarity.label(for: "mythic") == "Mythic")
        #expect(!item.needsPicture)
    }

    @Test("a 5.1 answer decodes with no collectible fields and does not show collectibles")
    func decodes51() throws {
        let list = try Self.decode(Self.list51JSON)
        #expect(list.items.map(\.id) == [1, 2])
        #expect(list.rarities == nil)
        #expect(!list.showsCollectibles)
        #expect(list.items[0].type == .role)
        #expect(!list.items[0].enabled)
        #expect(list.items.allSatisfy { $0.rarity == nil && !$0.announce && $0.imagePath == nil })
        #expect(list.items[1].price == 50)
        #expect(list.items[1].stock == nil)
    }

    @Test("an answer with nothing in it is an empty shop")
    func empty() throws {
        let list = try Self.decode("{}")
        #expect(list.items.isEmpty)
        #expect(list.roles.isEmpty)
        #expect(!list.showsCollectibles)
    }

    @Test("a 5.1 server with a collectible in the list still counts as having them")
    func inferredFromItems() throws {
        let list = try Self.decode(#"{"items":[{"id":1,"name":"x","type":"collectible"}]}"#)
        #expect(list.showsCollectibles)
    }

    @Test("the tiers have their words, from the server or from the app")
    func rarityLabels() {
        #expect(ShopRarity.standard.map(\.label) == ["Common", "Uncommon", "Rare", "Epic", "Legendary"])
        #expect(ShopRarity.label(for: "epic") == "Epic")
        #expect(ShopRarity.label(for: "epic", in: [ShopRarity(key: "epic", label: "Heroic")]) == "Heroic")
        #expect(ShopRarity.label(for: "") == "")
    }

    @Test("a change answer carries the items, the new id, and how many still hold a deleted item")
    func answer() throws {
        let created = try JSONDecoder().decode(ShopItemsAnswer.self, from: Data(#"{"items":[{"id":9,"name":"n"}],"id":9}"#.utf8))
        #expect(created.id == 9)
        #expect(created.items.map(\.id) == [9])
        let deleted = try JSONDecoder().decode(ShopItemsAnswer.self, from: Data(#"{"items":[],"held":4}"#.utf8))
        #expect(deleted.held == 4)
        #expect(deleted.id == nil)
    }

    @Test("every item kind has its words and a way back from the raw value")
    func types() {
        for type in ShopItemType.editable {
            #expect(ShopItemType(rawValue: type.rawValue) == type)
            #expect(type.isKnown)
            #expect(!type.title.isEmpty)
            #expect(!type.summary.isEmpty)
        }
        #expect(ShopItemType.editable.map(\.rawValue) == ["temp_role", "role", "custom", "collectible"])
        #expect(ShopItemType.tempRole.isRole && ShopItemType.role.isRole)
        #expect(!ShopItemType.custom.isRole && !ShopItemType.collectible.isRole)
    }
}

@Suite("Shop item draft")
struct ShopItemDraftTests {
    private func keys(_ body: ShopItemBody) throws -> [String: Any] {
        let data = try JSONEncoder().encode(body)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    static let base51: Set<String> = [
        "name", "description", "emoji", "type", "roleId", "durationHours", "price", "stock", "perMemberLimit",
        "requiredRoles", "enabled",
    ]

    @Test("a custom item sends the dashboard's keys, with null for unlimited, and no collectible keys on a 5.1 server")
    func customOn51() throws {
        var draft = ShopItemDraft()
        draft.name = "  Shoutout "
        draft.price = 50
        let json = try keys(draft.body(supportsCollectibles: false))
        #expect(Set(json.keys) == Self.base51)
        #expect(json["name"] as? String == "Shoutout")
        #expect(json["type"] as? String == "custom")
        #expect(json["roleId"] as? String == "")
        #expect(json["price"] as? Int == 50)
        #expect(json["stock"] is NSNull)
        #expect(json["perMemberLimit"] is NSNull)
        #expect(json["enabled"] as? Bool == true)
        #expect(json["requiredRoles"] as? [String] == [])
    }

    @Test("a custom item on a 5.2 server sends an empty rarity and no announce, like the dashboard")
    func customOn52() throws {
        var draft = ShopItemDraft()
        draft.name = "Shoutout"
        draft.rarity = "epic"
        draft.announce = true
        let json = try keys(draft.body(supportsCollectibles: true))
        #expect(Set(json.keys) == Self.base51.union(["rarity", "announce"]))
        #expect(json["rarity"] as? String == "")
        #expect(json["announce"] as? Bool == false)
    }

    @Test("a temporary role sends its role and its hours")
    func tempRole() throws {
        var draft = ShopItemDraft()
        draft.name = "VIP"
        draft.type = .tempRole
        draft.roleId = "910000000000000001"
        draft.durationHours = 48
        draft.stock = 5
        draft.perMemberLimit = 2
        draft.requiredRoles = ["910000000000000009"]
        let json = try keys(draft.body(supportsCollectibles: false))
        #expect(json["type"] as? String == "temp_role")
        #expect(json["roleId"] as? String == "910000000000000001")
        #expect(json["durationHours"] as? Int == 48)
        #expect(json["stock"] as? Int == 5)
        #expect(json["perMemberLimit"] as? Int == 2)
        #expect(json["requiredRoles"] as? [String] == ["910000000000000009"])
    }

    @Test("a permanent role sends its role")
    func role() throws {
        var draft = ShopItemDraft()
        draft.name = "Booster"
        draft.type = .role
        draft.roleId = "910000000000000002"
        let json = try keys(draft.body(supportsCollectibles: false))
        #expect(json["type"] as? String == "role")
        #expect(json["roleId"] as? String == "910000000000000002")
    }

    @Test("a custom item never sends a role it once had")
    func roleDropped() throws {
        var draft = ShopItemDraft()
        draft.name = "Shoutout"
        draft.type = .custom
        draft.roleId = "910000000000000002"
        #expect(try keys(draft.body(supportsCollectibles: false))["roleId"] as? String == "")
    }

    @Test("a collectible sends its rarity and announce on a 5.2 server")
    func collectibleOn52() throws {
        var draft = ShopItemDraft()
        draft.name = "Badge"
        draft.type = .collectible
        draft.rarity = "legendary"
        draft.announce = true
        draft.price = 900
        let json = try keys(draft.body(supportsCollectibles: true))
        #expect(Set(json.keys) == Self.base51.union(["rarity", "announce"]))
        #expect(json["type"] as? String == "collectible")
        #expect(json["rarity"] as? String == "legendary")
        #expect(json["announce"] as? Bool == true)
        #expect(json["roleId"] as? String == "")
    }

    @Test("a collectible with no rarity sends an empty one")
    func collectibleNoRarity() throws {
        var draft = ShopItemDraft()
        draft.name = "Badge"
        draft.type = .collectible
        #expect(try keys(draft.body(supportsCollectibles: true))["rarity"] as? String == "")
    }

    @Test("numbers are clamped to the server's limits, text is cut to them")
    func clamped() throws {
        var draft = ShopItemDraft()
        draft.name = String(repeating: "n", count: 80)
        draft.description = String(repeating: "d", count: 400)
        draft.emoji = String(repeating: "e", count: 100)
        draft.price = 0
        draft.stock = -4
        draft.perMemberLimit = 5000
        draft.durationHours = 99_999
        draft.type = .tempRole
        draft.roleId = "1"
        draft.requiredRoles = (1...15).map { "\($0)" }
        let json = try keys(draft.body(supportsCollectibles: false))
        #expect((json["name"] as? String)?.count == 60)
        #expect((json["description"] as? String)?.count == 300)
        #expect((json["emoji"] as? String)?.count == 64)
        #expect(json["price"] as? Int == 1)
        #expect(json["stock"] as? Int == 0)
        #expect(json["perMemberLimit"] as? Int == 1000)
        #expect(json["durationHours"] as? Int == 8760)
        #expect((json["requiredRoles"] as? [String])?.count == 10)
        draft.price = 5_000_000_000
        #expect(try keys(draft.body(supportsCollectibles: false))["price"] as? Int == 1_000_000_000)
    }

    @Test("an item without a name, or a role item without a role, has a problem in the server's words")
    func problems() {
        var draft = ShopItemDraft()
        #expect(draft.problem == "Give the item a name.")
        draft.name = "  "
        #expect(draft.problem == "Give the item a name.")
        draft.name = "VIP"
        #expect(draft.problem == nil)
        draft.type = .role
        #expect(draft.problem == "Pick the role this item gives.")
        draft.roleId = "1"
        #expect(draft.problem == nil)
        draft.type = .tempRole
        #expect(draft.problem == nil)
        draft.type = .collectible
        #expect(draft.problem == nil)
    }

    @Test("an item of a kind the app does not know cannot be saved from the app")
    func unknownKindBlocked() throws {
        let item = try #require(try ShopItemsDecodingTests.decode(ShopItemsDecodingTests.list52JSON).items.last)
        let draft = ShopItemDraft(item: item)
        #expect(draft.type == .other("hologram"))
        #expect(draft.problem != nil)
    }

    @Test("editing an item starts from what it has")
    func fromItem() throws {
        let list = try ShopItemsDecodingTests.decode(ShopItemsDecodingTests.list52JSON)
        let draft = ShopItemDraft(item: list.items[1])
        #expect(draft.id == 2)
        #expect(draft.type == .collectible)
        #expect(draft.rarity == "epic")
        #expect(draft.announce)
        #expect(draft.stock == nil)
        #expect(draft.imagePath == "/c/0123456789abcdef0123456789abcdef.webp")
        let vip = ShopItemDraft(item: list.items[0])
        #expect(vip.durationHours == 24)
        #expect(vip.stock == 10)
        #expect(vip.roleId == "910000000000000001")
        #expect(vip.requiredRoles == ["910000000000000009"])
        #expect(ShopItemDraft().id == nil)
    }
}

@Suite("Shop endpoints")
struct ShopEndpointTests {
    let fluxer: ServerID = "fluxer:1"

    private func json(_ body: (any Encodable & Sendable)?) throws -> [String: Any] {
        let data = try JSONEncoder().encode(try #require(body))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("the list is a GET below the shop path")
    func list() {
        let e = Endpoints.LoadShopItems(server: fluxer)
        #expect(e.path == "/api/v2/guilds/fluxer%3A1/modules/economy/shop/items")
        #expect(e.method == .get)
        #expect(e.body == nil)
        #expect(e.requiresAuth)
    }

    @Test("create posts the item to the list path, save to the item's path")
    func createAndUpdate() throws {
        var draft = ShopItemDraft()
        draft.name = "Shoutout"
        let body = draft.body(supportsCollectibles: false)
        let create = Endpoints.CreateShopItem(server: "1", item: body)
        #expect(create.path == "/api/v2/guilds/1/modules/economy/shop/items")
        #expect(create.method == .post)
        #expect(try json(create.body)["name"] as? String == "Shoutout")

        let update = Endpoints.UpdateShopItem(server: "1", id: 7, item: body)
        #expect(update.path == "/api/v2/guilds/1/modules/economy/shop/items/7")
        #expect(update.method == .post)
    }

    @Test("pause and resume post the flag, delete posts nothing")
    func enabledAndDelete() throws {
        let pause = Endpoints.SetShopItemEnabled(server: "1", id: 7, enabled: false)
        #expect(pause.path.hasSuffix("/shop/items/7/enabled"))
        #expect(pause.method == .post)
        #expect(try json(pause.body) as NSDictionary == ["enabled": false] as NSDictionary)

        let delete = Endpoints.DeleteShopItem(server: "1", id: 7)
        #expect(delete.path.hasSuffix("/shop/items/7/delete"))
        #expect(delete.method == .post)
        #expect(delete.body == nil)
    }

    @Test("the order is the list of ids")
    func order() throws {
        let e = Endpoints.ReorderShopItems(server: "1", ids: [3, 1, 2])
        #expect(e.path.hasSuffix("/shop/items/order"))
        #expect(e.method == .post)
        #expect(try json(e.body)["ids"] as? [Int] == [3, 1, 2])
    }

    @Test("the picture is a multipart POST with the file part and no JSON body")
    func upload() throws {
        let picture = PreparedPicture(data: Data([0xFF, 0xD8, 0xFF, 0xE0]), mimeType: "image/jpeg", filename: "picture.jpg",
                                      width: 10, height: 10)
        let e = Endpoints.UploadShopItemPicture(server: "1", id: 7, picture: picture, boundary: "BOUND")
        #expect(e.path == "/api/v2/guilds/1/modules/economy/shop/items/7/image")
        #expect(e.method == .post)
        #expect(e.body == nil)
        let raw = try #require(e.rawBody)
        #expect(raw.contentType == "multipart/form-data; boundary=BOUND")
        let text = String(decoding: raw.data, as: UTF8.self)
        #expect(text.contains(#"Content-Disposition: form-data; name="file"; filename="picture.jpg""#))
        #expect(text.contains("Content-Type: image/jpeg"))
        #expect(text.hasSuffix("\r\n--BOUND--\r\n"))
        #expect(raw.data.range(of: picture.data) != nil)
    }

    @Test("removing the picture posts to the image delete path")
    func removePicture() {
        let e = Endpoints.RemoveShopItemPicture(server: "1", id: 7)
        #expect(e.path == "/api/v2/guilds/1/modules/economy/shop/items/7/image/delete")
        #expect(e.method == .post)
        #expect(e.body == nil)
        #expect(e.rawBody == nil)
    }

    @Test("the activity is a GET with the member, the item and the page when they are set")
    func activityQuery() {
        let plain = Endpoints.LoadShopActivity(server: "1")
        #expect(plain.path == "/api/v2/guilds/1/modules/economy/shop/activity")
        #expect(plain.query.isEmpty)
        let filtered = Endpoints.LoadShopActivity(server: "1", userID: "810000000000000001", itemID: 4, page: 3)
        #expect(filtered.query == [
            URLQueryItem(name: "userId", value: "810000000000000001"), URLQueryItem(name: "itemId", value: "4"),
            URLQueryItem(name: "page", value: "3"),
        ])
        #expect(Endpoints.LoadShopActivity(server: "1", userID: "").query.isEmpty)
    }

    @Test("the collectibles feature is announced as `collectibles`")
    func feature() throws {
        #expect(ServerFeature.collectibles.rawValue == "collectibles")
        let info = try JSONDecoder().decode(
            ServerInfo.self, from: Data(#"{"name":"Sylo","features":["app-login","collectibles","something-new"]}"#.utf8))
        #expect(info.supports(.collectibles))
        let old = try JSONDecoder().decode(ServerInfo.self, from: Data(#"{"name":"Sylo","features":["app-login"]}"#.utf8))
        #expect(!old.supports(.collectibles))
    }
}
