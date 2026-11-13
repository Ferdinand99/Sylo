import Foundation
import Testing
@testable import SyloKit

@MainActor
@Suite("Shop items model")
struct ShopItemsModelTests {
    nonisolated static func item(_ id: Int, type: ShopItemType = .custom, imagePath: String? = nil) -> ShopItem {
        ShopItem(id: id, name: "Item \(id)", type: type, price: 10, imagePath: imagePath)
    }

    nonisolated static let picture = PreparedPicture(
        data: Data([0xFF, 0xD8, 0xFF, 0xE0]), mimeType: "image/jpeg", filename: "picture.jpg", width: 4, height: 4)

    /// A client for a 5.2 server (it announces collectibles) with three items.
    nonisolated static func clients52(
        features: [ServerFeature] = [.appLogin, .collectibles], rarities: [ShopRarity]? = ShopRarity.standard,
        items: [ShopItem] = [item(1), item(2), item(3)]
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return ServerInfo(features: features)
            case is Endpoints.LoadShopItems:
                return ShopItemList(items: items, roles: [RoleOption(id: "r1", name: "VIP")], maxItems: 5, rarities: rarities)
            default: throw NetworkError.notFound
            }
        }
    }

    @Test("loading reads the items, the roles and the limit, and a server that announces collectibles has them")
    func loads() async {
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: Self.clients52()))
        #expect(!model.hasLoaded)
        await model.load()
        #expect(model.hasLoaded)
        #expect(model.items.map(\.id) == [1, 2, 3])
        #expect(model.roles.map(\.id) == ["r1"])
        #expect(model.maxItems == 5)
        #expect(model.supportsCollectibles)
        #expect(model.rarities.count == 5)
        #expect(model.canAddItem)
    }

    @Test("a server that announces nothing and sends a 5.1 list has no collectibles")
    func olderServer() async {
        let model = ShopItemsModel(
            server: "9", session: makeSignedInSession(clients: Self.clients52(features: [.appLogin], rarities: nil)))
        await model.load()
        #expect(model.hasLoaded)
        #expect(!model.supportsCollectibles)
        // The five standard tiers are still there, for an item that carries one.
        #expect(model.rarities == ShopRarity.standard)
    }

    @Test("a server that does not announce the feature but shows collectibles in its list still has them")
    func inferredFromPayload() async {
        let withTiers = ShopItemsModel(
            server: "9", session: makeSignedInSession(clients: Self.clients52(features: [.appLogin])))
        await withTiers.load()
        #expect(withTiers.supportsCollectibles)

        let withCollectible = ShopItemsModel(
            server: "9",
            session: makeSignedInSession(clients: Self.clients52(
                features: [.appLogin], rarities: nil, items: [Self.item(1, type: .collectible)])))
        await withCollectible.load()
        #expect(withCollectible.supportsCollectibles)
    }

    @Test("when the info cannot be read, the list decides")
    func infoFails() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LoadShopItems { return ShopItemList(items: [Self.item(1)], rarities: nil) }
            throw NetworkError.timeout
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.hasLoaded)
        #expect(!model.supportsCollectibles)
    }

    @Test("a failed load explains itself and shows no items")
    func failedLoad() async {
        let clients = StubClients { _ in throw NetworkError.forbidden }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.hasLoaded)
        #expect(model.errorMessage == NetworkError.forbidden.userMessage)
    }

    @Test("a full shop cannot take another item")
    func full() async {
        let model = ShopItemsModel(
            server: "9",
            session: makeSignedInSession(clients: Self.clients52(items: (1...5).map { Self.item($0) })))
        await model.load()
        #expect(!model.canAddItem)
    }

    @Test("saving a new item sends the body without collectible keys to an older server, and returns the new id")
    func createOnOlderServer() async throws {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return ServerInfo(features: [.appLogin])
            case is Endpoints.LoadShopItems: return ShopItemList(items: [], rarities: nil)
            case is Endpoints.CreateShopItem: return ShopItemsAnswer(items: [Self.item(11)], id: 11)
            default: throw NetworkError.notFound
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        var draft = ShopItemDraft()
        draft.name = "Shoutout"
        let id = await model.save(draft)
        #expect(id == 11)
        #expect(model.items.map(\.id) == [11])
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.CreateShopItem)
        #expect(sent.item.rarity == nil)
        #expect(sent.item.announce == nil)
    }

    @Test("saving an existing item posts to its path and returns its id")
    func update() async throws {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ServerInfo: return ServerInfo(features: [.appLogin, .collectibles])
            case is Endpoints.LoadShopItems: return ShopItemList(items: [Self.item(4)], rarities: ShopRarity.standard)
            case is Endpoints.UpdateShopItem: return ShopItemsAnswer(items: [Self.item(4)])
            default: throw NetworkError.notFound
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        var draft = ShopItemDraft(item: Self.item(4))
        draft.type = .collectible
        draft.rarity = "rare"
        let id = await model.save(draft)
        #expect(id == 4)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.UpdateShopItem)
        #expect(sent.id == 4)
        #expect(sent.item.rarity == "rare")
        #expect(sent.item.announce == false)
    }

    @Test("an item with a problem is not sent")
    func problemNotSent() async {
        let clients = Self.clients52()
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        let before = clients.calls.count
        let id = await model.save(ShopItemDraft())
        #expect(id == nil)
        #expect(model.actionError == "Give the item a name.")
        #expect(clients.calls.count == before)
    }

    @Test("the server's refusal of a save is shown in its words")
    func saveRefused() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.CreateShopItem { throw NetworkError.badRequest(message: "Pick a role from the list.") }
            if endpoint is Endpoints.LoadShopItems { return ShopItemList(rarities: nil) }
            throw NetworkError.notFound
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        var draft = ShopItemDraft()
        draft.name = "VIP"
        let id = await model.save(draft)
        #expect(id == nil)
        #expect(model.actionError == "Pick a role from the list.")
    }

    @Test("pausing and deleting replace the items with the server's answer")
    func pauseAndDelete() async throws {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadShopItems: return ShopItemList(items: [Self.item(1), Self.item(2)], rarities: nil)
            case let call as Endpoints.SetShopItemEnabled:
                return ShopItemsAnswer(items: [ShopItem(id: 1, name: "Item 1", enabled: call.enabled), Self.item(2)])
            case is Endpoints.DeleteShopItem: return ShopItemsAnswer(items: [Self.item(2)], held: 2)
            default: throw NetworkError.notFound
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        let first = try #require(model.items.first)
        #expect(await model.setEnabled(first, false))
        #expect(model.items[0].enabled == false)
        #expect(await model.delete(first))
        #expect(model.items.map(\.id) == [2])
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.DeleteShopItem)
        #expect(sent.id == 1)
    }

    @Test("a move changes the list at once and posts the new order; a refusal brings the old order back")
    func reorder() async throws {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadShopItems: return ShopItemList(items: [Self.item(1), Self.item(2), Self.item(3)], rarities: nil)
            case let call as Endpoints.ReorderShopItems: return ShopItemsAnswer(items: call.ids.map { Self.item($0) })
            default: throw NetworkError.notFound
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        await model.move(from: IndexSet(integer: 2), to: 0)
        #expect(model.items.map(\.id) == [3, 1, 2])
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.ReorderShopItems)
        #expect(sent.ids == [3, 1, 2])

        clients.setHandler { _ in throw NetworkError.server(status: 500) }
        await model.move(from: IndexSet(integer: 0), to: 3)
        #expect(model.items.map(\.id) == [3, 1, 2])
        #expect(model.actionError != nil)
    }

    @Test("the move helper follows SwiftUI's onMove: the destination is an index before the move")
    func moveHelper() {
        let items = [1, 2, 3, 4]
        #expect(ShopItemsModel.moved(items, from: IndexSet(integer: 0), to: 3) == [2, 3, 1, 4])
        #expect(ShopItemsModel.moved(items, from: IndexSet(integer: 3), to: 0) == [4, 1, 2, 3])
        #expect(ShopItemsModel.moved(items, from: IndexSet(integer: 1), to: 2) == [1, 2, 3, 4])
        #expect(ShopItemsModel.moved(items, from: IndexSet(integer: 1), to: 4) == [1, 3, 4, 2])
        #expect(ShopItemsModel.moved(items, from: IndexSet([0, 1]), to: 4) == [3, 4, 1, 2])
    }

    @Test("a picture goes up as a multipart post and the items come back with its path")
    func uploadsPicture() async throws {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadShopItems: return ShopItemList(items: [Self.item(2, type: .collectible)], rarities: ShopRarity.standard)
            case is Endpoints.UploadShopItemPicture:
                return ShopItemsAnswer(items: [Self.item(2, type: .collectible, imagePath: "/c/abc.webp")])
            default: throw NetworkError.notFound
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.items[0].needsPicture)
        #expect(await model.uploadPicture(Self.picture, for: 2))
        #expect(model.items[0].imagePath == "/c/abc.webp")
        #expect(model.pictureProblem == nil)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.UploadShopItemPicture)
        #expect(sent.id == 2)
        #expect(sent.rawBody?.contentType.hasPrefix("multipart/form-data; boundary=") == true)
    }

    @Test("the refusals of an upload read as words, and nothing retries by itself", arguments: [
        (NetworkError.tooLarge(message: "The image is larger than 2 MB."), ShopPictureProblem.tooLarge),
        (NetworkError.http(status: HTTPStatus(415, message: "Send the image as a multipart upload.")), ShopPictureProblem.badUpload("Send the image as a multipart upload.")),
        (NetworkError.rateLimited, ShopPictureProblem.rateLimited),
        (NetworkError.notFound, ShopPictureProblem.notAvailable),
    ])
    func uploadRefused(error: NetworkError, expected: ShopPictureProblem) async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.LoadShopItems { return ShopItemList(items: [Self.item(2, type: .collectible)]) }
            throw error
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.uploadPicture(Self.picture, for: 2) == false)
        #expect(model.pictureProblem == expected)
        let uploads = clients.calls.filter { $0.endpoint is Endpoints.UploadShopItemPicture }
        #expect(uploads.count == 1)
    }

    @Test("removing a picture replaces the items with the server's answer")
    func removesPicture() async throws {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadShopItems:
                return ShopItemList(items: [Self.item(2, type: .collectible, imagePath: "/c/abc.webp")])
            case is Endpoints.RemoveShopItemPicture: return ShopItemsAnswer(items: [Self.item(2, type: .collectible)])
            default: throw NetworkError.notFound
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.removePicture(from: 2))
        #expect(model.items[0].imagePath == nil)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.RemoveShopItemPicture)
        #expect(sent.id == 2)
    }

    @Test("a refused removal keeps the picture and says why in the form's error, not as a picture problem")
    func removeFails() async {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadShopItems:
                return ShopItemList(items: [Self.item(2, type: .collectible, imagePath: "/c/abc.webp")])
            default: throw NetworkError.notFound(message: "Unknown item.")
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(await model.removePicture(from: 2) == false)
        #expect(model.items[0].imagePath == "/c/abc.webp")
        #expect(model.actionError == "That item is gone. Refresh the shop.")
        #expect(model.pictureProblem == nil)
    }

    @Test("a create whose answer does not name the item finds it among the new ones")
    func createWithoutIDFindsIt() async {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadShopItems: return ShopItemList(items: [Self.item(1)], rarities: nil)
            case is Endpoints.CreateShopItem: return ShopItemsAnswer(items: [Self.item(1), Self.item(2)])
            default: throw NetworkError.notFound
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        var draft = ShopItemDraft()
        draft.name = "New"
        #expect(await model.save(draft) == 2)
        #expect(!model.savedWithoutID)
    }

    @Test("a create whose answer cannot be told from the list says so and blocks a second save")
    func createWithoutIDIsAnError() async {
        let clients = StubClients { endpoint in
            switch endpoint {
            case is Endpoints.LoadShopItems: return ShopItemList(items: [Self.item(1)], rarities: nil)
            case is Endpoints.CreateShopItem: return ShopItemsAnswer(items: [Self.item(1)])
            default: throw NetworkError.notFound
            }
        }
        let model = ShopItemsModel(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        var draft = ShopItemDraft()
        draft.name = "New"
        #expect(await model.save(draft) == nil)
        #expect(model.savedWithoutID)
        #expect(model.actionError?.contains("did not say which one") == true)
        #expect(model.changeCount == 1)
        // A later save starts clean.
        #expect(await model.save(ShopItemDraft()) == nil)
        #expect(!model.savedWithoutID)
    }
}

@Suite("Shop picture problems")
struct ShopPictureProblemTests {
    @Test("the server's own sentences are told apart")
    func fromServerText() {
        func problem(_ error: NetworkError) -> ShopPictureProblem { ShopPictureProblem(error) }
        let quota = "This server already stores 200 pictures (25 MB). The most is 200 pictures and 25 MB: remove pictures or items nobody owns to make room."
        #expect(problem(.badRequest(message: quota)) == .quota(quota))
        #expect(problem(.badRequest(message: "Use a PNG, JPEG or WebP image.")) == .unsupportedType)
        #expect(problem(.badRequest(message: "That image is too large in pixels (at most 16 megapixels), or it is not a valid image.")) == .tooManyPixels)
        #expect(problem(.badRequest(message: "That file is not a valid image.")) == .notAnImage)
        #expect(problem(.badRequest(message: "Only a collectible has a picture.")) == .itemGone)
        #expect(problem(.notFound(message: "Unknown item.")) == .itemGone)
        #expect(problem(.notFound) == .notAvailable)
        #expect(problem(.server(status: HTTPStatus(503, message: "The server is busy processing pictures. Try again in a moment."))) == .busy("The server is busy processing pictures. Try again in a moment."))
        #expect(problem(.server(status: 503)) == .busy(nil))
        #expect(problem(.http(status: HTTPStatus(415, message: "Send the image as a multipart upload."))) == .badUpload("Send the image as a multipart upload."))
        #expect(problem(.http(status: 415)) == .badUpload(nil))
        let cannot = "This server cannot process images right now."
        #expect(problem(.server(status: HTTPStatus(503, message: cannot))) == .cannotProcess(cannot))
        let slow = "Processing that picture took too long. Try a smaller image."
        #expect(problem(.server(status: HTTPStatus(503, message: slow))) == .busy(slow))
        #expect(problem(.badRequest(message: "Something new.")) == .other("Something new."))
        #expect(problem(.offline) == .other(NetworkError.offline.userMessage))
    }

    @Test("every problem says what to do, the quota names the numbers, and only busy and rate limits are worth a retry")
    func messages() {
        #expect(ShopPictureProblem.quota(nil).message.contains("200 pictures"))
        #expect(ShopPictureProblem.quota(nil).message.contains("25 MB"))
        #expect(ShopPictureProblem.quota("The server's sentence").message == "The server's sentence")
        #expect(ShopPictureProblem.tooLarge.message.contains("2 MB"))
        #expect(ShopPictureProblem.unsupportedType.message.contains("PNG, JPEG or WebP"))
        #expect(ShopPictureProblem.busy(nil).message.contains("busy"))
        // The server's busy sentence already says to try again: nothing is added to it.
        let busy = "The server is busy processing pictures. Try again in a moment."
        #expect(ShopPictureProblem.busy(busy).message == busy)
        #expect(ShopPictureProblem.busy(nil).message.components(separatedBy: "ry again").count == 2)
        #expect(ShopPictureProblem.cannotProcess(nil).message.contains("cannot process"))
        // A 415 is about the upload, not about the picture's format.
        let upload = ShopPictureProblem.badUpload(nil).message
        #expect(upload.contains("app") && !upload.contains("PNG"))
        #expect(ShopPictureProblem.notAvailable.message.contains("5.2"))
        #expect(ShopPictureProblem.busy(nil).isWorthRetrying)
        #expect(ShopPictureProblem.rateLimited.isWorthRetrying)
        #expect(!ShopPictureProblem.tooLarge.isWorthRetrying)
        #expect(!ShopPictureProblem.quota(nil).isWorthRetrying)
        // Try Again is offered where a second try can work, and not for a picture or a server that never will.
        for problem in [ShopPictureProblem.busy(nil), .rateLimited, .quota(nil), .other("Offline")] { #expect(problem.offersRetry) }
        for problem in [ShopPictureProblem.tooLarge, .tooManyPixels, .unsupportedType, .notAnImage, .cannotProcess(nil),
                        .badUpload(nil), .notAvailable, .itemGone] { #expect(!problem.offersRetry) }
        #expect(CollectiblePictureLimits.maxUploadBytes == 2 * 1024 * 1024)
        #expect(CollectiblePictureLimits.targetBytes < CollectiblePictureLimits.maxUploadBytes)
    }
}
