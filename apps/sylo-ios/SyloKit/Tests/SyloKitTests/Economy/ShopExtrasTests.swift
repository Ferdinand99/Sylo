import Foundation
import Testing
@testable import SyloKit

@Suite("Shop item fields the app does not know")
struct ShopItemExtrasTests {
    /// An item as a future server might send it: two fields the app has no name for, one of them nested.
    static let futureJSON = #"""
    {"id": 5, "name": "Badge", "type": "collectible", "price": 10, "sold": 2, "left": 8, "stock": 10,
     "sortOrder": 3, "imagePath": "/c/a.webp", "purchases": 2, "revenue": 20, "rarity": "rare", "announce": false,
     "perMemberLimit": null, "enabled": true, "requiredRoles": [],
     "cooldownHours": 6, "tags": {"seasonal": true, "names": ["a", "b"]}}
    """#

    static func item() throws -> ShopItem {
        try JSONDecoder().decode(ShopItem.self, from: Data(futureJSON.utf8))
    }

    @Test("a field the app does not model is kept, the fields it does model are not")
    func kept() throws {
        let item = try Self.item()
        #expect(Set(item.extras.keys) == ["cooldownHours", "tags"])
        #expect(item.extras["cooldownHours"] == .int(6))
        #expect(item.extras["tags"] == .object(["seasonal": .bool(true), "names": .array([.string("a"), .string("b")])]))
        let plain = try ShopItemsDecodingTests.decode(ShopItemsDecodingTests.list51JSON)
        #expect(plain.items.allSatisfy { $0.extras.isEmpty })
    }

    @Test("a save sends them back unchanged, and never an output-only field of the item")
    func sentBack() throws {
        let draft = ShopItemDraft(item: try Self.item())
        let data = try JSONEncoder().encode(draft.body(supportsCollectibles: true))
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["cooldownHours"] as? Int == 6)
        let tags = try #require(json["tags"] as? [String: Any])
        #expect(tags["seasonal"] as? Bool == true)
        #expect(tags["names"] as? [String] == ["a", "b"])
        #expect(Set(json.keys) == ShopItemDraftTests.base51.union(["rarity", "announce", "cooldownHours", "tags"]))
        for key in ["id", "sold", "left", "sortOrder", "imagePath", "purchases", "revenue"] {
            #expect(json[key] == nil, "\(key)")
        }
    }

    @Test("a kept field never replaces one the app writes")
    func appFieldsWin() throws {
        var draft = ShopItemDraft()
        draft.name = "Real"
        draft.extras = ["name": .string("Kept"), "price": .int(999)]
        let data = try JSONEncoder().encode(draft.body(supportsCollectibles: false))
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["name"] as? String == "Real")
        #expect(json["price"] as? Int == 100)
    }

    @Test("items are told apart by their id when hashed")
    func hashing() throws {
        let a = try Self.item()
        let b = ShopItem(id: 6, name: "Other")
        #expect(a != b)
        #expect(Set([a, b]).count == 2)
    }
}

@Suite("UTF-16 limits")
struct UTF16LimitTests {
    @Test("text is cut to the server's count of UTF-16 units, between characters")
    func cuts() {
        #expect(UTF16Limit.truncated("abc", to: 5) == "abc")
        #expect(UTF16Limit.truncated("abcdef", to: 3) == "abc")
        // A flag is two scalars of two units each: four units.
        let flags = String(repeating: "\u{1F1F3}\u{1F1F4}", count: 70)
        #expect(flags.utf16.count == 280)
        let cut = UTF16Limit.truncated(flags, to: 64)
        #expect(cut.utf16.count == 64)
        #expect(cut.count == 16)
        // A character that does not fit is dropped whole, not split.
        #expect(UTF16Limit.truncated("a\u{1F600}", to: 2) == "a")
        #expect(UTF16Limit.truncated("a\u{1F600}", to: 3) == "a\u{1F600}")
    }

    @Test("an item's emoji, name and description are sent within the server's count")
    func body() {
        var draft = ShopItemDraft()
        draft.name = String(repeating: "\u{1F600}", count: 50)
        draft.emoji = String(repeating: "\u{1F1F3}\u{1F1F4}", count: 70)
        draft.description = String(repeating: "\u{1F600}", count: 200)
        let body = draft.body(supportsCollectibles: false)
        #expect(body.name.utf16.count == 60)
        #expect(body.emoji.utf16.count == 64)
        #expect(body.description.utf16.count == 300)
    }
}
