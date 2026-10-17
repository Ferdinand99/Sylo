import Foundation
import Testing
@testable import SyloKit

@Suite("ServerStats settings")
struct ServerStatsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/server-stats/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "refreshMinutes": 15,
        "channels": [
          {"channelId": "222222222222222222", "type": "boosts", "template": "Boosts: {count}"}
        ]
      },
      "voiceChannels": [{"id": "222222222222222222", "name": "Stats"}],
      "statTypes": [["members", "Members (total)"], ["humans", "Humans (non-bots)"], ["bots", "Bots"],
                    ["roles", "Roles"], ["channels", "Channels"], ["boosts", "Server boosts"]]
    }
    """#

    @Test("the page decodes settings and the voice channels")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(ServerStatsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(ServerStatsPage.moduleID == "server-stats")
        #expect(page.settings.refreshMinutes == 15)
        let stat = try #require(page.settings.channels.first)
        #expect(stat.channelId == "222222222222222222")
        #expect(stat.type == .boosts)
        #expect(stat.template == "Boosts: {count}")
        #expect(page.voiceChannels.map(\.name) == ["Stats"])
    }

    @Test("missing fields and an unknown stat fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"channels":[{"channelId":"1","type":"planets"}]}}"#.utf8)
        let page = try JSONDecoder().decode(ServerStatsPage.self, from: json)
        #expect(page.settings.refreshMinutes == 10)
        let stat = try #require(page.settings.channels.first)
        #expect(stat.type == .members)
        #expect(stat.template == "{count}")
        #expect(page.voiceChannels.isEmpty)

        let empty = try JSONDecoder().decode(ServerStatsPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.channels.isEmpty)
        #expect(empty.settings.refreshMinutes == 10)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(ServerStatsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["refreshMinutes", "channels"])
        #expect(body["refreshMinutes"] as? Int == 15)
        let stat = try #require((body["channels"] as? [[String: Any]])?.first)
        #expect(Set(stat.keys) == ["channelId", "type", "template"])
        #expect(stat["type"] as? String == "boosts")
    }

    @Test("new stat channels start like the web form's new rows")
    func newStat() {
        let stat = ServerStatsSettings.StatChannel()
        #expect(stat.channelId.isEmpty)
        #expect(stat.type == .members)
        #expect(stat.template == "Members: {count}")
    }
}
