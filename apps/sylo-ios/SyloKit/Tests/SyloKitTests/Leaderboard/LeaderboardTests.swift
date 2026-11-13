import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Leaderboard")
struct LeaderboardDecodingTests {
    static let pageJSON = #"""
        {"guild":{"id":"1","name":"Alpha","icon":null},"levelingEnabled":true,"publicLeaderboard":true,
         "period":"all","vanitySlug":"alpha","total":42,
         "rows":[{"rank":1,"name":"Alice","level":12,"xp":14200,"voiceMinutes":30,"messages":3100},
                 {"rank":2,"name":"Bob","level":null,"xp":900,"voiceMinutes":0,"messages":40}]}
        """#

    @Test("A page reads its settings and rows")
    func page() throws {
        let page = try decode(LeaderboardPage.self, Self.pageJSON)
        #expect(page.levelingEnabled)
        #expect(page.isPublic)
        #expect(page.period == .allTime)
        #expect(page.vanitySlug == "alpha")
        #expect(page.total == 42)
        #expect(page.rows.map(\.name) == ["Alice", "Bob"])
        #expect(page.rows[0].level == 12)
        #expect(page.rows[0].xp == 14_200)
        #expect(page.rows[1].level == nil)
    }

    @Test("A week or month board has no levels, an empty slug is none, and odd values fall back")
    func fallbacks() throws {
        let page = try decode(
            LeaderboardPage.self,
            #"{"period":"week","vanitySlug":"","rows":[{"rank":1,"name":"Alice","xp":5}]}"#)
        #expect(page.period == .week)
        #expect(page.vanitySlug == nil)
        #expect(page.levelingEnabled)
        #expect(!page.isPublic)
        #expect(page.rows[0].level == nil)
        #expect(try decode(LeaderboardPage.self, #"{"period":"forever"}"#).period == .allTime)
        #expect(try decode(LeaderboardPage.self, "{}").rows.isEmpty)
    }

    @Test("The calls go where the server expects")
    func endpoints() throws {
        let board = Endpoints.Leaderboard(server: "1", period: .month)
        #expect(board.path == "/api/v2/guilds/1/leaderboard")
        #expect(board.query == [URLQueryItem(name: "period", value: "month")])
        #expect(Endpoints.Leaderboard(server: "1", period: .allTime).query == [URLQueryItem(name: "period", value: "all")])

        let toggle = Endpoints.SetLeaderboardPublic(server: "1", isPublic: true)
        #expect(toggle.path == "/api/v2/guilds/1/leaderboard/public")
        #expect(toggle.method == .post)
        let vanity = Endpoints.SetLeaderboardVanity(server: "1", slug: "alpha")
        #expect(vanity.path == "/api/v2/guilds/1/leaderboard/vanity")
        #expect(vanity.method == .post)
    }
}

@MainActor
@Suite("Leaderboard model")
struct LeaderboardModelTests {
    nonisolated static let page = try! decode(LeaderboardPage.self, LeaderboardDecodingTests.pageJSON)

    static func clients(
        vanity: @escaping @Sendable (Endpoints.SetLeaderboardVanity) throws -> LeaderboardVanityResult = {
            LeaderboardVanityResult(slug: $0.slug.isEmpty ? nil : $0.slug)
        },
        setPublic: @escaping @Sendable (Endpoints.SetLeaderboardPublic) throws -> LeaderboardPublicResult = {
            LeaderboardPublicResult(isPublic: $0.isPublic)
        }
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case let vanityCall as Endpoints.SetLeaderboardVanity: return try vanity(vanityCall)
            case let publicCall as Endpoints.SetLeaderboardPublic: return try setPublic(publicCall)
            default: return Self.page
            }
        }
    }

    func loadedModel(_ clients: StubClients) async -> LeaderboardModel {
        let model = LeaderboardModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        return model
    }

    @Test("The public page is the short link when there is one, else the server's own page")
    func publicURL() async throws {
        let base = try ServerURL("https://sylo.example.com/sylo")
        let withSlug = await loadedModel(Self.clients())
        #expect(withSlug.publicURL(on: base)?.absoluteString == "https://sylo.example.com/sylo/lb/alpha")

        var withoutSlug = Self.page
        withoutSlug.vanitySlug = nil
        let noSlugPage = withoutSlug
        let plain = LeaderboardModel(
            server: "fluxer:3", session: makeSignedInSession(clients: StubClients { _ in noSlugPage }))
        await plain.load()
        #expect(plain.publicURL(on: base)?.absoluteString == "https://sylo.example.com/sylo/leaderboard/fluxer%3A3")

        var private_ = Self.page
        private_.isPublic = false
        let privatePage = private_
        let hidden = LeaderboardModel(
            server: "1", session: makeSignedInSession(clients: StubClients { _ in privatePage }))
        await hidden.load()
        #expect(hidden.publicURL(on: base) == nil)
    }

    @Test("Loading asks for the period that is shown")
    func loadsThePeriod() async throws {
        let clients = Self.clients()
        let model = LeaderboardModel(server: "1", session: makeSignedInSession(clients: clients))
        model.period = .week
        await model.load()
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.Leaderboard)
        #expect(sent.period == .week)
        #expect(model.page == Self.page)
    }

    @Test("Turning the public page off shows the server's answer")
    func switchesPublic() async throws {
        let clients = Self.clients()
        let model = await loadedModel(clients)
        await model.setPublic(false)
        #expect(model.page?.isPublic == false)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SetLeaderboardPublic)
        #expect(!sent.isPublic)
        #expect(model.publicError == nil)
    }

    @Test("A switch that fails stays where it was and explains")
    func failedSwitch() async {
        let model = await loadedModel(Self.clients(setPublic: { _ in throw NetworkError.offline }))
        await model.setPublic(false)
        #expect(model.page?.isPublic == true)
        #expect(model.publicError == NetworkError.offline.userMessage)
    }

    @Test("Saving a short link keeps what the server cleaned it to")
    func savesVanity() async throws {
        let clients = Self.clients(vanity: { LeaderboardVanityResult(slug: $0.slug.lowercased()) })
        let model = await loadedModel(clients)
        let saved = await model.saveVanity("  My-Server ")
        #expect(saved)
        #expect(model.page?.vanitySlug == "my-server")
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SetLeaderboardVanity)
        #expect(sent.slug == "My-Server")
        #expect(model.vanityError == nil)
    }

    @Test("An empty short link clears it")
    func clearsVanity() async {
        let model = await loadedModel(Self.clients())
        let saved = await model.saveVanity("   ")
        #expect(saved)
        #expect(model.page?.vanitySlug == nil)
    }

    @Test("A refused short link says why in words, and the old link stays")
    func vanityErrors() async {
        let taken = await loadedModel(Self.clients(vanity: { _ in throw NetworkError.badRequest(message: "taken") }))
        #expect(await taken.saveVanity("busy") == false)
        #expect(taken.vanityError == "That link is already used by another server. Pick another one.")
        #expect(taken.page?.vanitySlug == "alpha")

        let invalid = await loadedModel(Self.clients(vanity: { _ in throw NetworkError.badRequest(message: "invalid") }))
        #expect(await invalid.saveVanity("a") == false)
        #expect(invalid.vanityError == "Use 3 to 32 letters, numbers or hyphens. It can't start or end with a hyphen.")

        let offline = await loadedModel(Self.clients(vanity: { _ in throw NetworkError.offline }))
        #expect(await offline.saveVanity("fine-name") == false)
        #expect(offline.vanityError == NetworkError.offline.userMessage)
    }

    @Test("The old error goes away when the next save starts")
    func vanityErrorClears() async {
        let clients = Self.clients(vanity: { _ in throw NetworkError.badRequest(message: "taken") })
        let model = await loadedModel(clients)
        await model.saveVanity("busy")
        #expect(model.vanityError != nil)
        clients.setHandler { endpoint in
            if let vanity = endpoint as? Endpoints.SetLeaderboardVanity { return LeaderboardVanityResult(slug: vanity.slug) }
            return Self.page
        }
        await model.saveVanity("free")
        #expect(model.vanityError == nil)
        #expect(model.page?.vanitySlug == "free")
    }
}
