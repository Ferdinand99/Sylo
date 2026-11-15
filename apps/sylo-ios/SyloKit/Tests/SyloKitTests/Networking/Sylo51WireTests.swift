import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What the Sylo 5.1 calls put on the wire, through the real client and the mock URL protocol. They
// are part of `APIClientTests` so they run one after another: the mock's state is shared.
extension APIClientTests {
    private func wireClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    @Test("Saving Introductions posts the form's fields as JSON, with the lists and without the prompt's ids")
    func saveIntroductionsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"channelId":"222222222222222222","footer":"Hi"}}"#)])
        let page = try IntroductionsSettingsTests.decodePage()
        var settings = page.settings
        settings.footer = "Hi"
        let saved = try await wireClient().send(
            Endpoints.SaveModuleSettings<IntroductionsPage>(server: "1", settings: settings))
        #expect(saved.settings.footer == "Hi")

        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/introductions/config")
        #expect(request.method == "POST")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
        #expect(request.header("Content-Type")?.hasPrefix("application/json") == true)
        let body = try #require(request.body)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["footer"] as? String == "Hi")
        #expect((json["questions"] as? [Any])?.count == 2)
        #expect((json["roleGroups"] as? [Any])?.count == 1)
        #expect(json["promptMessageId"] == nil)
        #expect(json["promptChannelId"] == nil)
    }

    @Test("Saving Economy posts every setting")
    func saveEconomyOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{}}"#)])
        let settings = try EconomySettingsTests.decodePage().settings
        _ = try await wireClient().send(Endpoints.SaveModuleSettings<EconomyPage>(server: "1", settings: settings))
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/economy/config")
        #expect(request.method == "POST")
        let body = try #require(request.body)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == EconomySettingsTests.serverKeys)
    }

    @Test("Saving Applications posts only the retention and the panel text")
    func saveApplicationsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"retentionDays":30}}"#)])
        let settings = try ApplicationsSettingsTests.decodePage().settings
        _ = try await wireClient().send(Endpoints.SaveModuleSettings<ApplicationsPage>(server: "1", settings: settings))
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/modules/applications/config")
        let body = try #require(request.body)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["retentionDays", "panelText"])
    }

    @Test("Suggestions saves the log mode on the wire")
    func saveSuggestionsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"config":{"logMode":"move"}}"#)])
        let settings = SuggestionsSettings(logChannel: "333333333333333333", logMode: .move)
        let saved = try await wireClient().send(
            Endpoints.SaveModuleSettings<SuggestionsPage>(server: "1", settings: settings))
        #expect(saved.settings.logMode == .move)
        let body = try #require(mock.requests.first?.body)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["logMode"] as? String == "move")
    }

    @Test("The member lookup is a GET with its query string")
    func economyMembersOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, EconomyMembersDecodingTests.searchJSON)])
        let list = try await wireClient().send(Endpoints.EconomyMembers(server: "1", search: "alex"))
        #expect(list.isSearch)
        let request = try #require(mock.requests.first)
        #expect(request.method == "GET")
        let components = try #require(URLComponents(url: request.url, resolvingAgainstBaseURL: false))
        #expect(components.path == "/sylo/api/v2/guilds/1/modules/economy/members")
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(items == ["sort": "total", "dir": "desc", "q": "alex"])
    }

    @Test("Deciding an application posts the action and reason, and reads the application back")
    func decideOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true,"warnings":[],"dm":true,"submission":{"id":12,"status":"denied","reason":"No"}}"#)])
        let decision = try await wireClient().send(
            Endpoints.DecideApplication(server: "1", id: 12, action: .deny, reason: "No"))
        #expect(decision.submission.status == .denied)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/applications/submissions/12/decide")
        #expect(request.method == "POST")
        let body = try #require(request.body)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(json == ["action": "deny", "reason": "No"])
    }

    @Test("A decision that was already made is a 409 the app can tell apart")
    func decideConflictOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(409, #"{"error":"Application #12 was already denied."}"#)])
        let client = try wireClient()
        await #expect(throws: NetworkError.http(status: 409)) {
            _ = try await client.send(Endpoints.DecideApplication(server: "1", id: 12, action: .accept))
        }
    }
}
