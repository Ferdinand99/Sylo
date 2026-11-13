import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the Sylo 5.2 settings put on the wire, through the real client and the mock URL protocol: the
// new keys go out only when the server sent them, so a 5.1 server (or a self-hosted one) never receives
// a key it does not know. They extend `APIClientTests` so they run one after another: the mock's state
// is shared.
extension APIClientTests {
    private func client52() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func postedKeys(_ mock: MockState) throws -> [String: Any] {
        let body = try #require(mock.requests.first?.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test("Saving a Welcome page from a 5.2 server posts the trigger and its roles")
    func saveWelcome52OnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"trigger":"role","triggerRoleIds":["111111111111111111"]},"warning":"No usable role is picked, so no welcome is sent until you pick one."}"#)])
        var settings = try WelcomeTriggerTests.decode52().settings
        settings.triggerRoleIds = ["111111111111111111"]
        let saved = try await client52().send(Endpoints.SaveModuleSettings<WelcomePage>(server: "1", settings: settings))
        // The answer carries a `warning` the app does not read; it must not fail the save.
        #expect(saved.settings.trigger == .role)
        #expect(saved.settings.triggerRoleIds == ["111111111111111111"])

        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/welcome/config")
        #expect(request.method == "POST")
        let json = try postedKeys(mock)
        #expect(Set(json.keys) == WelcomeTriggerTests.keys51.union(["trigger", "triggerRoleIds"]))
        #expect(json["trigger"] as? String == "role")
        #expect(json["triggerRoleIds"] as? [String] == ["111111111111111111"])
    }

    @Test("Saving a Welcome page from a 5.1 server posts none of the 5.2 keys, and reads a 5.1 answer")
    func saveWelcome51OnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"joinEnabled":true,"joinMessage":"Hi"}}"#)])
        var settings = try WelcomeTriggerTests.decode51().settings
        settings.joinEnabled = true
        settings.joinMessage = "Hi"
        let saved = try await client52().send(Endpoints.SaveModuleSettings<WelcomePage>(server: "1", settings: settings))
        #expect(saved.settings.joinMessage == "Hi")
        #expect(saved.settings.trigger == nil)
        let json = try postedKeys(mock)
        #expect(Set(json.keys) == WelcomeTriggerTests.keys51)
        #expect(json["trigger"] == nil)
        #expect(json["triggerRoleIds"] == nil)
    }

    @Test("Loading Welcome from a 5.2 and from a 5.1 server")
    func loadWelcomeOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([
            .json(200, WelcomeTriggerTests.page52JSON),
            .json(200, WelcomeSettingsTests.pageJSON),
        ])
        let client = try client52()
        let new = try await client.send(Endpoints.LoadModuleSettings<WelcomePage>(server: "1"))
        let old = try await client.send(Endpoints.LoadModuleSettings<WelcomePage>(server: "1"))
        #expect(new.settings.supportsTrigger)
        #expect(!old.settings.supportsTrigger)
        #expect(mock.requests.first?.url.absoluteString
            == "https://example.com/sylo/api/v2/guilds/1/modules/welcome/config")
    }

    @Test("Saving Economy from a 5.2 server posts the collectible keys")
    func saveEconomy52OnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, EconomyCollectibleSettingsTests.page52JSON)])
        var settings = try EconomyCollectibleSettingsTests.decode52().settings
        settings.collectionPublic = false
        _ = try await client52().send(Endpoints.SaveModuleSettings<EconomyPage>(server: "1", settings: settings))
        let json = try postedKeys(mock)
        #expect(Set(json.keys) == EconomySettingsTests.serverKeys.union(["collectibleChannelId", "collectionPublic"]))
        #expect(json["collectionPublic"] as? Bool == false)
        #expect(json["collectibleChannelId"] as? String == "333333333333333333")
    }

    @Test("Saving Economy from a 5.1 server posts none of the collectible keys")
    func saveEconomy51OnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{}}"#)])
        let settings = try EconomySettingsTests.decodePage().settings
        let saved = try await client52().send(Endpoints.SaveModuleSettings<EconomyPage>(server: "1", settings: settings))
        #expect(saved.settings.collectionPublic == nil)
        let json = try postedKeys(mock)
        #expect(Set(json.keys) == EconomySettingsTests.serverKeys)
        #expect(json["collectibleChannelId"] == nil)
        #expect(json["collectionPublic"] == nil)
    }

    @Test("A member's detail with collectible purchases reads through the real client")
    func economyMemberWithCollectiblesOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, CollectibleLedgerTests.detailJSON)])
        let detail = try await client52().send(Endpoints.EconomyMember(server: "1", userID: "810000000000000001"))
        #expect(detail.transactions.count == 3)
        #expect(detail.transactions[1].kindLabel == "Shop purchase")
    }
}
