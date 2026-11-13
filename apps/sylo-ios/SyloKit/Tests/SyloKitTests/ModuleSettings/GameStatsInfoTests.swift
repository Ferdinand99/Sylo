import Foundation
import Testing
@testable import SyloKit

// Game stats: the read-only page (the command text, and for operators the cached lookups). There is
// no save call. The dashboard's page is web-v2/src/moduleForms/GameStats.jsx.

@Suite("Game stats: decoding")
struct GameStatsDecodingTests {
    static let operatorPage = #"""
    {
      "operator": true,
      "recent": [
        {"game": "bf4", "title": "Battlefield 4", "username": "player_one", "platform": "pc", "ago": "5m ago"},
        {"game": "osrs", "title": "", "username": "Zezima", "platform": "", "ago": "1h ago"}
      ]
    }
    """#

    @Test("an operator sees the cached lookups")
    func operatorPage() throws {
        let info = try JSONDecoder().decode(GameStatsInfo.self, from: Data(Self.operatorPage.utf8))

        #expect(info.isOperator)
        #expect(info.recent.count == 2)
        #expect(info.recent[0].game == "bf4")
        #expect(info.recent[0].heading == "Battlefield 4")
        #expect(info.recent[0].details == "player_one \u{00B7} PC \u{00B7} 5m ago")
        // Without a title the game stands in, and an empty platform is left out.
        #expect(info.recent[1].heading == "osrs")
        #expect(info.recent[1].details == "Zezima \u{00B7} 1h ago")
    }

    @Test("a member's page has no lookups, and a page that does not say is not an operator's")
    func memberPage() throws {
        let member = try JSONDecoder().decode(
            GameStatsInfo.self, from: Data(#"{"operator": false, "recent": []}"#.utf8))
        #expect(!member.isOperator)
        #expect(member.recent.isEmpty)

        let older = try JSONDecoder().decode(GameStatsInfo.self, from: Data("{}".utf8))
        #expect(!older.isOperator)
        #expect(older.recent.isEmpty)
    }

    @Test("a lookup that cannot be read is dropped and odd values are empty")
    func lossy() throws {
        let info = try JSONDecoder().decode(
            GameStatsInfo.self,
            from: Data(#"{"operator": true, "recent": ["bad", {"game": 5, "username": "x"}]}"#.utf8))

        #expect(info.recent.count == 1)
        #expect(info.recent[0].game == "")
        #expect(info.recent[0].username == "x")
    }

    @Test("a platform is named the way people write it")
    func platformLabels() {
        #expect(GamePlatform.label(for: "pc") == "PC")
        #expect(GamePlatform.label(for: "XBOXONE") == "Xbox One")
        #expect(GamePlatform.label(for: "xbsx") == "Xbox Series X|S")
        #expect(GamePlatform.label(for: "ps5") == "PlayStation 5")
        // An id the list does not know just gets a capital letter.
        #expect(GamePlatform.label(for: "switch") == "Switch")
        #expect(GamePlatform.label(for: "  ") == "")
        #expect(GamePlatform.label(for: "") == "")
    }

    @Test("the page is one GET and the module has no save call")
    func endpoint() {
        let load = Endpoints.LoadGameStats(server: "fluxer:1")
        #expect(load.path == "/api/v2/guilds/fluxer%3A1/modules/game-stats/config")
        #expect(load.method == .get)
        #expect(load.body == nil)
    }
}

@MainActor
@Suite("Game stats: the screen's model")
struct GameStatsModelTests {
    private func stub(
        info: @escaping @Sendable () throws -> GameStatsInfo,
        settings: @escaping @Sendable () throws -> GuildSettingsPage = {
            GuildSettingsPage(settings: GuildSettings(), platform: .discord)
        }
    ) -> StubClients {
        StubClients { endpoint in
            if endpoint is Endpoints.LoadGameStats { return try info() }
            if endpoint is Endpoints.LoadGuildSettings { return try settings() }
            throw NetworkError.notFound
        }
    }

    @Test("loading shows the page and the slash command on Discord")
    func loadsOnDiscord() async {
        let model = GameStatsModel(
            server: "9",
            session: makeSignedInSession(clients: stub(info: { GameStatsInfo(isOperator: true) })))
        await model.load()

        #expect(model.info?.isOperator == true)
        #expect(model.statsCommand == "/stats")
        #expect(model.errorMessage == nil)
    }

    @Test("a Fluxer server shows its own prefix, an unreadable one shows the bare name")
    func prefixes() async {
        let fluxer = GameStatsModel(
            server: "fluxer:9",
            session: makeSignedInSession(clients: stub(
                info: { GameStatsInfo() },
                settings: {
                    GuildSettingsPage(
                        settings: GuildSettings(commandPrefix: ""), platform: .fluxer, defaultCommandPrefix: "!",
                        effectiveCommandPrefix: "?")
                })))
        await fluxer.load()
        #expect(fluxer.statsCommand == "?stats")

        let broken = GameStatsModel(
            server: "9",
            session: makeSignedInSession(clients: stub(
                info: { GameStatsInfo() }, settings: { throw NetworkError.forbidden(message: "No.") })))
        await broken.load()
        // The page still loads; only the prefix is unknown.
        #expect(broken.info != nil)
        #expect(broken.statsCommand == "stats")
    }

    @Test("a page that cannot be loaded says why")
    func loadFails() async {
        let model = GameStatsModel(
            server: "9",
            session: makeSignedInSession(clients: stub(info: { throw NetworkError.forbidden(message: "Not yours.") })))
        await model.load()

        #expect(model.info == nil)
        #expect(model.errorMessage == "Not yours.")
    }
}
