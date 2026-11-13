import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the economy admin screens put on the wire, through the real client and the mock URL protocol:
// the shop items for a 5.1 and a 5.2 server, the multipart picture and the words its refusals become,
// the member changes and the reset. They extend `APIClientTests` so they run one after another: the
// mock's state is shared.
extension APIClientTests {
    private func economyClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func postedJSON(_ mock: MockState) throws -> [String: Any] {
        let body = try #require(mock.requests.first?.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    private static let pictureBytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46])

    private func upload(_ client: URLSessionAPIClient) async throws -> ShopItemsAnswer {
        let picture = PreparedPicture(
            data: Self.pictureBytes, mimeType: "image/jpeg", filename: "picture.jpg", width: 8, height: 8)
        return try await client.send(
            Endpoints.UploadShopItemPicture(server: "1", id: 7, picture: picture, boundary: "WIREBOUNDARY"))
    }

    @Test("Loading the shop from a 5.2 and from a 5.1 server")
    func loadShopOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, ShopItemsDecodingTests.list52JSON), .json(200, ShopItemsDecodingTests.list51JSON)])
        let client = try economyClient()
        let new = try await client.send(Endpoints.LoadShopItems(server: "1"))
        let old = try await client.send(Endpoints.LoadShopItems(server: "1"))
        #expect(new.showsCollectibles)
        #expect(new.items.count == 4)
        #expect(!old.showsCollectibles)
        #expect(old.items.count == 2)
        #expect(mock.requests.first?.url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/economy/shop/items")
        #expect(mock.requests.first?.method == "GET")
    }

    @Test("Saving an item for a 5.1 server posts none of the collectible keys")
    func saveItem51() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"items":[{"id":9,"name":"Shoutout"}],"id":9}"#)])
        var draft = ShopItemDraft()
        draft.name = "Shoutout"
        draft.price = 50
        let answer = try await economyClient().send(
            Endpoints.CreateShopItem(server: "1", item: draft.body(supportsCollectibles: false)))
        #expect(answer.id == 9)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/economy/shop/items")
        #expect(request.method == "POST")
        #expect(request.header("Content-Type") == "application/json")
        let json = try postedJSON(mock)
        #expect(Set(json.keys) == ShopItemDraftTests.base51)
        #expect(json["stock"] is NSNull)
    }

    @Test("Saving a collectible for a 5.2 server posts its rarity and announce")
    func saveCollectible52() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"items":[]}"#)])
        var draft = ShopItemDraft()
        draft.name = "Badge"
        draft.type = .collectible
        draft.rarity = "epic"
        draft.announce = true
        _ = try await economyClient().send(
            Endpoints.UpdateShopItem(server: "1", id: 4, item: draft.body(supportsCollectibles: true)))
        #expect(mock.requests.first?.url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/economy/shop/items/4")
        let json = try postedJSON(mock)
        #expect(Set(json.keys) == ShopItemDraftTests.base51.union(["rarity", "announce"]))
        #expect(json["type"] as? String == "collectible")
        #expect(json["rarity"] as? String == "epic")
        #expect(json["announce"] as? Bool == true)
    }

    @Test("A picture goes up as multipart with the field `file`, the token and nothing else")
    func uploadPicture() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"items":[{"id":7,"name":"Badge","type":"collectible","imagePath":"/c/abc.webp"}]}"#)])
        let answer = try await upload(economyClient())
        #expect(answer.items.first?.imagePath == "/c/abc.webp")

        let request = try #require(mock.requests.first)
        #expect(request.method == "POST")
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/economy/shop/items/7/image")
        #expect(request.header("Content-Type") == "multipart/form-data; boundary=WIREBOUNDARY")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        let body = try #require(request.body)
        let text = String(decoding: body, as: UTF8.self)
        #expect(text.hasPrefix("--WIREBOUNDARY\r\nContent-Disposition: form-data; name=\"file\"; filename=\"picture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"))
        #expect(text.hasSuffix("\r\n--WIREBOUNDARY--\r\n"))
        #expect(body.range(of: Self.pictureBytes) != nil)
        // Exactly one part: the picture.
        #expect(text.components(separatedBy: "Content-Disposition").count == 2)
    }

    @Test("The refusals of an upload become the words staff read, and none is sent twice", arguments: [
        (413, #"{"error":"The image is larger than 2 MB."}"#, ShopPictureProblem.tooLarge),
        (415, #"{"error":"Send the image as a multipart upload."}"#, .unsupportedType),
        (400, #"{"error":"Use a PNG, JPEG or WebP image."}"#, .unsupportedType),
        (400, #"{"error":"That image is too large in pixels (at most 16 megapixels), or it is not a valid image."}"#, .tooManyPixels),
        (400, #"{"error":"That file is not a valid image."}"#, .notAnImage),
        (404, #"{"error":"Unknown item."}"#, .itemGone),
        (404, #"{"error":"Not found"}"#, .notAvailable),
        (429, #"{"error":"Too many uploads: wait a minute and try again."}"#, .rateLimited),
    ])
    func uploadRefusals(status: Int, body: String, expected: ShopPictureProblem) async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(status, body)])
        do {
            _ = try await upload(economyClient())
            Issue.record("the upload should have been refused")
        } catch {
            #expect(ShopPictureProblem(NetworkError(error)) == expected)
        }
        #expect(mock.requests.count == 1)
    }

    @Test("The quota and busy answers keep the server's sentences, and are never retried by the client")
    func quotaAndBusy() async throws {
        let mock = MockURLProtocol.state
        let quota = "This server already stores 200 pictures (25 MB). The most is 200 pictures and 25 MB: remove pictures or items nobody owns to make room."
        mock.reset([.json(400, #"{"error":"\#(quota)"}"#)])
        do {
            _ = try await upload(economyClient())
            Issue.record("expected the quota refusal")
        } catch {
            let problem = ShopPictureProblem(NetworkError(error))
            #expect(problem == .quota(quota))
            #expect(problem.message == quota)
        }

        let busy = "The server is busy processing pictures. Try again in a moment."
        mock.reset([.json(503, #"{"error":"\#(busy)"}"#)])
        do {
            _ = try await upload(economyClient())
            Issue.record("expected the busy refusal")
        } catch {
            let problem = ShopPictureProblem(NetworkError(error))
            #expect(problem == .busy(busy))
            #expect(problem.isWorthRetrying)
        }
        // A POST is never retried, a busy answer included.
        #expect(mock.requests.count == 1)
    }

    @Test("A member change posts the action, the amount and the reason, and reads the new state")
    func adjustOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, EconomyAdminDecodingTests.adjustJSON)])
        let result = try await economyClient().send(
            Endpoints.AdjustEconomyMember(server: "1", userID: "810000000000000001", action: .remove, amount: 50, reason: "Spam"))
        #expect(result.detail.account.cash == 900)
        #expect(result.summary.hasPrefix("Now"))
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/economy/members/810000000000000001/adjust")
        #expect(request.method == "POST")
        let json = try postedJSON(mock)
        #expect(Set(json.keys) == ["action", "amount", "reason"])
        #expect(json["action"] as? String == "remove")
        #expect(json["amount"] as? Int == 50)
    }

    @Test("A refusal of a member change reaches the screen in the server's words")
    func adjustRefusal() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(400, #"{"error":"That member does not have that much."}"#)])
        do {
            _ = try await economyClient().send(
                Endpoints.AdjustEconomyMember(server: "1", userID: "7", action: .remove, amount: 5_000))
            Issue.record("expected a refusal")
        } catch {
            #expect(NetworkError(error).userMessage == "That member does not have that much.")
        }
    }

    @Test("The reset of the economy posts only the confirmation word")
    func resetOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true,"accounts":61}"#)])
        let result = try await economyClient().send(Endpoints.ResetEconomy(server: "1"))
        #expect(result.accounts == 61)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/economy/reset")
        #expect(request.method == "POST")
        let json = try postedJSON(mock)
        #expect(json as NSDictionary == ["confirm": "RESET"] as NSDictionary)
    }

    @Test("A grant, a refund and a fulfil post to the right paths with the right bodies")
    func inventoryOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, InventoryDecodingTests.inventory52JSON)])
        let client = try economyClient()
        let granted = try await client.send(Endpoints.GrantShopItem(server: "1", userID: "7", itemID: 3, reason: "Prize"))
        #expect(granted.inventory.count == 4)
        let refunded = try await client.send(
            Endpoints.EndInventoryRow(server: "1", userID: "7", rowID: 5, ending: .refund, reason: "Mistake"))
        #expect(refunded.refunded == true)
        _ = try await client.send(Endpoints.FulfilInventoryRow(server: "1", userID: "7", rowID: 7, fulfilled: true, note: "Sent"))

        let paths = mock.requests.map { $0.url.path }
        #expect(paths == [
            "/sylo/api/v2/guilds/1/modules/economy/members/7/inventory/grant",
            "/sylo/api/v2/guilds/1/modules/economy/members/7/inventory/5/refund",
            "/sylo/api/v2/guilds/1/modules/economy/members/7/inventory/7/fulfil",
        ])
        #expect(mock.requests.allSatisfy { $0.method == "POST" })
        var bodies: [[String: Any]] = []
        for request in mock.requests {
            let data = try #require(request.body)
            bodies.append(try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any]))
        }
        #expect(bodies[0]["itemId"] as? Int == 3)
        #expect(bodies[0]["reason"] as? String == "Prize")
        #expect(bodies[1]["reason"] as? String == "Mistake")
        #expect(bodies[2]["fulfilled"] as? Bool == true)
        #expect(bodies[2]["note"] as? String == "Sent")
    }

    @Test("The shop activity asks with its filters in the query")
    func activityOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, ShopActivityTests.pageJSON)])
        let page = try await economyClient().send(
            Endpoints.LoadShopActivity(server: "1", userID: "810000000000000001", itemID: 4, page: 2))
        #expect(page.total == 61)
        #expect(mock.requests.first?.url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/economy/shop/activity?userId=810000000000000001&itemId=4&page=2")
    }
}
