import Foundation
import Testing
@testable import SyloKit

@Suite("Giveaways settings")
struct GiveawaysSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/giveaways/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {"ping": "everyone", "dmWinners": true},
      "giveaways": [
        {"id": 12, "prize": "Nitro", "state": "active", "winners": 2, "endsAt": 1800000000000,
         "entries": 5, "wonIds": [], "channel": "giveaways", "requiredRoleId": "111111111111111111"},
        {"id": 9, "prize": "Sticker pack", "state": "ended", "winners": 1, "endsAt": 1700000000000,
         "entries": 1, "wonIds": ["222222222222222222"], "channel": "giveaways", "requiredRoleId": null}
      ]
    }
    """#

    @Test("the page decodes settings and the active and recently ended giveaways")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(GiveawaysPage.self, from: Data(Self.pageJSON.utf8))
        #expect(GiveawaysPage.moduleID == "giveaways")
        #expect(page.settings.ping == .everyone)
        #expect(page.settings.dmWinners)
        #expect(page.giveaways.count == 2)
        let active = try #require(page.activeGiveaways.first)
        #expect(active.id == 12)
        #expect(active.prize == "Nitro")
        #expect(active.winners == 2)
        #expect(active.entries == 5)
        #expect(active.channel == "giveaways")
        #expect(active.isRoleGated)
        #expect(active.endsAt == Date(timeIntervalSince1970: 1_800_000_000))
        let ended = try #require(page.endedGiveaways.first)
        #expect(ended.state == .ended)
        #expect(ended.wonIds == ["222222222222222222"])
        #expect(!ended.isRoleGated)
    }

    @Test("missing fields and an unknown ping fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"ping":"admins"},"giveaways":[{"id":3}]}"#.utf8)
        let page = try JSONDecoder().decode(GiveawaysPage.self, from: json)
        #expect(page.settings.ping == GiveawaysPing.none)
        #expect(!page.settings.dmWinners)
        let giveaway = try #require(page.giveaways.first)
        #expect(giveaway.state == .active)
        #expect(giveaway.prize.isEmpty)
        #expect(giveaway.wonIds.isEmpty)

        let empty = try JSONDecoder().decode(GiveawaysPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings == GiveawaysSettings())
        #expect(empty.giveaways.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(GiveawaysPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["ping", "dmWinners"])
        #expect(body["ping"] as? String == "everyone")
        #expect(body["dmWinners"] as? Bool == true)
    }

    @Test("new settings start like the server's defaults")
    func defaults() {
        let settings = GiveawaysSettings()
        #expect(settings.ping == GiveawaysPing.none)
        #expect(!settings.dmWinners)
    }
}
