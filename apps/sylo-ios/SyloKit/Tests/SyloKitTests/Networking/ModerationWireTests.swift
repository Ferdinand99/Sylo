import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import SyloKit

// What moderation, appeals and command limits put on the wire, through the real client and the mock
// URL protocol: method, path, body keys, and the server's own words coming back on a refusal. They
// extend `APIClientTests` so they run one after another: the mock's state is shared.
extension APIClientTests {
    private func moderationClient() throws -> URLSessionAPIClient {
        URLSessionAPIClient(
            server: try ServerURL("https://example.com/sylo"), session: MockURLProtocol.session(),
            decoder: JSONDecoder(), retryDelays: [.zero, .zero], token: { "sylo_secret" })
    }

    private func sentJSON(_ mock: MockState) throws -> [String: Any] {
        let body = try #require(mock.requests.first?.body)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test("Loading moderation reads the overview from the real answer shape")
    func moderationOverviewOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, ModerationDecodingTests.overviewJSON)])
        let overview = try await moderationClient().send(Endpoints.LoadModeration(server: "fluxer:1"))
        #expect(overview.cases.count == 2)
        #expect(overview.lockdownActive)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/fluxer%3A1/moderation")
        #expect(request.method == "GET")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
    }

    @Test("A warning posts exactly userId and reason as JSON")
    func warnOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true,"warnings":2,"dmDelivered":true,"logged":true}"#)])
        let result = try await moderationClient().send(
            Endpoints.WarnMember(server: "1", userId: "810000000000000001", reason: "Spam"))
        #expect(result.warnings == 2)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/moderation/warn")
        #expect(request.method == "POST")
        #expect(request.header("Content-Type")?.hasPrefix("application/json") == true)
        let json = try sentJSON(mock)
        #expect(Set(json.keys) == ["userId", "reason"])
        #expect(json["userId"] as? String == "810000000000000001")
        #expect(json["reason"] as? String == "Spam")
    }

    @Test("Lock all posts an empty JSON object")
    func lockAllOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true,"locked":7}"#)])
        let result = try await moderationClient().send(Endpoints.LockAllChannels(server: "1"))
        #expect(result.locked == 7)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/moderation/lock-all")
        #expect(request.method == "POST")
        #expect(try sentJSON(mock).isEmpty)
    }

    @Test("A refused warning keeps the server's words, and so does a refused unban")
    func moderationRefusals() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(403, #"{"error":"You can't warn someone with a higher role than yours."}"#)])
        do {
            _ = try await moderationClient().send(Endpoints.WarnMember(server: "1", userId: "1", reason: "x"))
            Issue.record("expected a failure")
        } catch {
            let failure = NetworkError(error)
            #expect(failure == .forbidden)
            #expect(failure.userMessage == "You can't warn someone with a higher role than yours.")
        }

        mock.reset([.json(404, #"{"error":"That user is not banned."}"#)])
        do {
            _ = try await moderationClient().send(Endpoints.UnbanMember(server: "1", userId: "1"))
            Issue.record("expected a failure")
        } catch {
            let failure = NetworkError(error)
            #expect(failure == .notFound)
            #expect(failure.userMessage == "That user is not banned.")
        }
    }

    @Test("An appeal decision posts `decision` and the note, and an already decided one comes back as a 409 with text")
    func appealOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true,"status":"accepted","dmDelivered":true,"unbanned":true}"#)])
        let result = try await moderationClient().send(
            Endpoints.DecideAppeal(server: "1", id: 7, decision: .accept, reason: "Welcome back"))
        #expect(result.status == .accepted)
        #expect(result.unbanned)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/1/appeals/7/decide")
        #expect(request.method == "POST")
        let json = try sentJSON(mock)
        #expect(Set(json.keys) == ["decision", "reason"])
        #expect(json["decision"] as? String == "accept")

        mock.reset([.json(409, #"{"error":"This appeal has already been decided."}"#)])
        do {
            _ = try await moderationClient().send(Endpoints.DecideAppeal(server: "1", id: 7, decision: .deny))
            Issue.record("expected a failure")
        } catch {
            let failure = NetworkError(error)
            #expect(failure == .http(status: 409))
            #expect(failure.userMessage == "This appeal has already been decided.")
        }
    }

    @Test("Saving a command posts enabled, channels and roles, and reads the stored command")
    func commandOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, #"{"ok":true,"command":{"name":"ban","enabled":false,"allowedChannels":["1"],"allowedRoles":[]}}"#)])
        let saved = try await moderationClient().send(
            Endpoints.SaveCommand(server: "fluxer:1", name: "ban", enabled: false, channels: ["1"], roles: []))
        #expect(saved.command.name == "ban")
        #expect(!saved.command.enabled)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/sylo/api/v2/guilds/fluxer%3A1/commands/ban")
        #expect(request.method == "POST")
        let json = try sentJSON(mock)
        #expect(Set(json.keys) == ["enabled", "channels", "roles"])
        #expect(json["enabled"] as? Bool == false)
        #expect(json["channels"] as? [String] == ["1"])
        #expect(json["roles"] as? [String] == [])
    }
}
