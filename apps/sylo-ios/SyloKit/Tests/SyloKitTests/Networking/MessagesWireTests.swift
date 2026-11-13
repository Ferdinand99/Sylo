import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the embed messages and the Welcome Channel actions put on the wire, through the real client
// and the mock URL protocol. They extend `APIClientTests` so they run one after another: the mock's
// state is shared.
extension APIClientTests {
    private func messagesClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func firstBody(_ mock: MockState) throws -> [String: Any] {
        let body = try #require(mock.requests.first?.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test("Posting a new message sends name, channel, action and the spec, and reads the sent status")
    func postsNewMessage() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"""
        {"rec":{"id":8,"name":"Rules","channelId":"111111111111111111","messageId":"222222222222222222","spec":{"content":"Hi","embeds":[],"rows":[]}},"status":"sent"}
        """#)])
        var spec = ComposedMessageSpec(content: "Hi")
        spec.embeds = [EmbedItem(EmbedDraft(title: "Rules"))]
        spec.links = [ComposedLinkButton(label: "Site", url: "https://example.com")]

        let result = try await messagesClient().send(Endpoints.SaveComposedMessage(
            server: "1", id: .new, name: "Rules", channelId: "111111111111111111", action: .publish, spec: spec))

        #expect(result.status == .sent)
        #expect(result.message.id == 8)
        #expect(result.message.isPublished)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/messages/new")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        let json = try firstBody(mock)
        #expect(Set(json.keys) == ["name", "channelId", "action", "spec"])
        #expect(json["action"] as? String == "publish")
        let sent = try #require(json["spec"] as? [String: Any])
        #expect(Set(sent.keys) == ["content", "embeds", "rows"])
        #expect((sent["embeds"] as? [[String: Any]])?.first?["kind"] as? String == "embed")
        #expect((sent["rows"] as? [[String: Any]])?.first?["type"] as? String == "buttons")
    }

    @Test("A post the server refuses comes back as an error with the server's words")
    func refusedPost() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(400, #"""
        {"error":"The bot lacks View Channel / Send Messages / Embed Links there.","rec":{"id":8,"name":"Rules","channelId":"111111111111111111","messageId":null,"spec":{}}}
        """#)])

        let error = await #expect(throws: NetworkError.self) {
            _ = try await messagesClient().send(Endpoints.SaveComposedMessage(
                server: "1", id: .saved(8), name: "Rules", channelId: "111111111111111111", action: .publish,
                spec: ComposedMessageSpec()))
        }

        #expect(error?.userMessage == "The bot lacks View Channel / Send Messages / Embed Links there.")
        #expect(mock.requests.count == 1)
    }

    @Test("Loading a saved message and the list are plain GETs")
    func loadsMessages() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, ComposedMessagesTests.detailJSON)])
        let detail = try await messagesClient().send(Endpoints.LoadComposedMessage(server: "1", id: .saved(3)))
        #expect(detail.message.spec.links.count == 2)
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/messages/3")
        #expect(mock.requests.first?.method == "GET")

        mock.reset([.json(200, #"{"items":[{"id":3,"name":"Rules","channel":"rules","published":true,"when":"now"}]}"#)])
        let list = try await messagesClient().send(Endpoints.ListComposedMessages(server: "1"))
        #expect(list.items.count == 1)
        #expect(mock.requests.first?.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/messages")
    }

    @Test("Unpublishing and deleting POST an empty object to their own paths")
    func unpublishAndDelete() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"rec":{"id":3,"name":"Rules","channelId":"1","messageId":null,"spec":{}}}"#)])
        let record = try await messagesClient().send(Endpoints.UnpublishComposedMessage(server: "1", id: 3))
        #expect(!record.message.isPublished)
        var request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/messages/3/unpublish")
        #expect(request.method == "POST")
        #expect(try firstBody(mock).isEmpty)

        mock.reset([.json(200, #"{"ok":true}"#)])
        _ = try await messagesClient().send(Endpoints.DeleteComposedMessage(server: "1", id: 3))
        request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/messages/3/delete")
        #expect(request.method == "POST")
        #expect(try firstBody(mock).isEmpty)
    }

    @Test("Publishing the Welcome Channel posts the draft to its publish path and reads the config")
    func publishesWelcome() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"channelId":"111111111111111111","messageId":"222222222222222222","spec":{"content":"Hi","embeds":[{"kind":"banner","image":"https://example.com/b.png"}]}}}"#)])
        let settings = try WelcomeChannelSettingsTests.page().settings

        let result = try await messagesClient().send(Endpoints.PublishWelcomeChannel(server: "1", settings: settings))

        #expect(result.settings.isPublished)
        #expect(result.settings.embeds.first?.isBanner == true)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/welcome-channel/publish")
        #expect(request.method == "POST")
        let json = try firstBody(mock)
        #expect(Set(json.keys) == ["channelId", "spec"])
        let embeds = try #require((json["spec"] as? [String: Any])?["embeds"] as? [[String: Any]])
        // The banner goes out as a banner.
        #expect(embeds.map { $0["kind"] as? String } == ["embed", "banner"])
    }

    @Test("Removing the published message and creating the channel are POSTs with an empty object")
    func welcomeActions() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"channelId":"1","messageId":"","spec":{"content":"","embeds":[]}}}"#)])
        let removed = try await messagesClient().send(Endpoints.UnpublishWelcomeChannel(server: "1"))
        #expect(!removed.settings.isPublished)
        #expect(mock.requests.first?.url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/welcome-channel/unpublish")
        #expect(try firstBody(mock).isEmpty)

        mock.reset([.json(200, #"{"config":{"channelId":"3","messageId":"","spec":{"content":"","embeds":[]}},"channels":[{"id":"3","name":"welcome"}]}"#)])
        let created = try await messagesClient().send(Endpoints.CreateWelcomeChannel(server: "1"))
        #expect(created.settings.channelId == "3")
        #expect(created.channels.map(\.name) == ["welcome"])
        #expect(mock.requests.first?.url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/welcome-channel/create-channel")
        #expect(mock.requests.first?.method == "POST")
    }
}
