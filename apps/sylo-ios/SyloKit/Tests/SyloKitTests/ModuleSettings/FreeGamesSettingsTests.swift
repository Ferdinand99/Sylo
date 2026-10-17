import Foundation
import Testing
@testable import SyloKit

@Suite("FreeGames settings")
struct FreeGamesSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/free-games/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {"channelId": "222222222222222222", "roleId": "111111111111111111"},
      "channels": [{"id": "222222222222222222", "name": "free-games"}],
      "roles": [{"id": "111111111111111111", "name": "Gamers"}]
    }
    """#

    @Test("the page decodes settings, channels and roles")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(FreeGamesPage.self, from: Data(Self.pageJSON.utf8))
        #expect(FreeGamesPage.moduleID == "free-games")
        #expect(page.settings.channelId == "222222222222222222")
        #expect(page.settings.roleId == "111111111111111111")
        #expect(page.channels.map(\.name) == ["free-games"])
        #expect(page.roles.map(\.name) == ["Gamers"])
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(FreeGamesPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings.channelId.isEmpty)
        #expect(page.settings.roleId.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.roles.isEmpty)
        #expect(FreeGamesSettings() == page.settings)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(FreeGamesPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["channelId", "roleId"])
        #expect(body["channelId"] as? String == "222222222222222222")
    }
}
