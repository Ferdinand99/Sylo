import Foundation
import Testing
@testable import SyloKit

@Suite("Module limits")
struct ModuleLimitsTests {
    static let payload = #"""
    {
      "_embed": {
        "title": {"maxLength": 256}, "description": {"maxLength": 4096}, "authorName": {"maxLength": 256},
        "footerText": {"maxLength": 2048}, "fields": {"maxItems": 25},
        "fields[].name": {"maxLength": 256}, "fields[].value": {"maxLength": 1024}
      },
      "sticky": {
        "stickies": {"maxItems": 50}, "stickies[].content": {"maxLength": 2000},
        "stickies[].cooldownSeconds": {"min": 0, "max": 3600}
      },
      "polls": {"title": {"maxLength": 100}, "footerText": {"maxLength": 80}},
      "future-module": "not an object",
      "odd-values": {"x": {"maxLength": "many", "max": 7}}
    }
    """#

    static func decode(_ json: String = ModuleLimitsTests.payload) throws -> AllModuleLimits {
        try JSONDecoder().decode(AllModuleLimits.self, from: Data(json.utf8))
    }

    @Test("The server's answer is read by module and field path")
    func decodes() throws {
        let all = try Self.decode()
        let sticky = all["sticky"]
        #expect(sticky["stickies"].maxItems == 50)
        #expect(sticky["stickies[].content"].maxLength == 2000)
        #expect(sticky["stickies[].cooldownSeconds"].min == 0)
        #expect(sticky["stickies[].cooldownSeconds"].max == 3600)
        // What the server did not send is no limit.
        #expect(sticky["nothing"] == FieldLimit())
        #expect(all["no-such-module"] == .unlimited)
    }

    @Test("A module that is not an object is skipped; an odd value loses only itself")
    func lossy() throws {
        let all = try Self.decode()
        #expect(all.modules["future-module"] == nil)
        #expect(all["odd-values"]["x"] == FieldLimit(max: 7))
        #expect(all["sticky"]["stickies"].maxItems == 50)
    }

    @Test("The embed limits are the server's when sent, the fixed ones when not")
    func embedLimits() throws {
        #expect(try Self.decode().embed == .standard)

        let narrower = try Self.decode(#"{"_embed":{"title":{"maxLength":100},"fields":{"maxItems":5}}}"#)
        #expect(narrower.embed.title == 100)
        #expect(narrower.embed.maxFields == 5)
        #expect(narrower.embed.description == EmbedLimits.standard.description)

        #expect(AllModuleLimits.empty.embed == .standard)
        #expect(try Self.decode("{}").embed == .standard)
        #expect(EmbedLimits.standard.title == 256)
        #expect(EmbedLimits.standard.description == 4096)
        #expect(EmbedLimits.standard.footerText == 2048)
        #expect(EmbedLimits.standard.maxFields == 25)
        #expect(EmbedLimits.standard.fieldName == 256)
        #expect(EmbedLimits.standard.fieldValue == 1024)
        #expect(EmbedLimits.standard.content == 2000)
    }

    @Test("A module with a narrower embed overrides only the paths it names")
    func overriding() throws {
        let all = try Self.decode()
        let poll = all.embed.overriding(all["polls"])
        #expect(poll.title == 100)
        #expect(poll.footerText == 80)
        #expect(poll.description == 4096)
        #expect(poll.maxFields == 25)

        let withContent = all.embed.overriding(ModuleFieldLimits(["content": FieldLimit(maxLength: 500)]))
        #expect(withContent.content == 500)
    }

    @Test("The limits call is a plain GET")
    func endpoint() {
        let call = Endpoints.LoadModuleLimits()
        #expect(call.path == "/api/v2/modules/limits")
        #expect(call.method == .get)
        #expect(call.requiresAuth)
    }
}

@MainActor
@Suite("Module limits in the session")
struct SessionLimitsTests {
    private func loadedCount(_ clients: StubClients) -> Int {
        clients.calls.filter { $0.endpoint is Endpoints.LoadModuleLimits }.count
    }

    @Test("Limits are loaded once and kept")
    func cached() async throws {
        let all = try ModuleLimitsTests.decode()
        let clients = StubClients { _ in all }
        let session = makeSignedInSession(clients: clients)
        #expect(await session.moduleLimits() == all)
        #expect(await session.moduleLimits() == all)
        #expect(loadedCount(clients) == 1)
    }

    @Test("A server without the endpoint gives none, and is not asked again this sign-in")
    func missing() async {
        let clients = StubClients { _ in throw NetworkError.notFound }
        let session = makeSignedInSession(clients: clients)
        #expect(await session.moduleLimits() == .empty)
        #expect(await session.moduleLimits().embed == .standard)
        #expect(loadedCount(clients) == 1)
    }

    @Test("A failure that may pass gives none now, and is asked again next time")
    func transient() async throws {
        let clients = StubClients { _ in throw NetworkError.offline }
        let session = makeSignedInSession(clients: clients)
        #expect(await session.moduleLimits() == .empty)
        #expect(await session.moduleLimits() == .empty)
        #expect(loadedCount(clients) == 2)

        let all = try ModuleLimitsTests.decode()
        clients.setHandler { _ in all }
        #expect(await session.moduleLimits() == all)
    }

    @Test("A 401 while loading limits signs out and gives none")
    func unauthorized() async {
        let clients = StubClients { _ in throw NetworkError.unauthorized }
        let session = makeSignedInSession(clients: clients)
        #expect(await session.moduleLimits() == .empty)
        #expect(session.notice == NetworkError.unauthorized.userMessage)
    }
}

extension APIClientTests {
    @Test("The limits call reads the server's JSON on the wire")
    func limitsOnTheWire() async throws {
        let mock = MockURLProtocol.state
        mock.reset([.json(200, ModuleLimitsTests.payload)])
        let client = URLSessionAPIClient(
            server: try ServerURL("https://example.com"), session: MockURLProtocol.session(), decoder: JSONDecoder(),
            retryDelays: [.zero, .zero], token: { "sylo_secret" })
        let all = try await client.send(Endpoints.LoadModuleLimits())
        #expect(all["sticky"]["stickies"].maxItems == 50)
        let request = try #require(mock.requests.first)
        #expect(request.url.absoluteString == "https://example.com/api/v2/modules/limits")
        #expect(request.method == "GET")
        #expect(request.header("Authorization") == "Bearer sylo_secret")
    }
}
