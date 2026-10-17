import Foundation
import Testing
@testable import SyloKit

@Suite("InviteTracker settings")
struct InviteTrackerSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/invite-tracker/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {"joinLogChannelId": "222222222222222222", "graceHours": 48},
      "channels": [{"id": "222222222222222222", "name": "joins"}],
      "board": {
        "total": 3,
        "canReadInvites": false,
        "rows": [
          {"rank": 1, "userId": "333333333333333333", "name": "ada", "net": 7, "regular": 9, "leaves": 3, "bonus": 1}
        ]
      }
    }
    """#

    @Test("the page decodes settings, channels and the leaderboard")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(InviteTrackerPage.self, from: Data(Self.pageJSON.utf8))
        #expect(InviteTrackerPage.moduleID == "invite-tracker")
        #expect(page.settings.joinLogChannelId == "222222222222222222")
        #expect(page.settings.graceHours == 48)
        #expect(page.channels.map(\.name) == ["joins"])
        #expect(page.board.total == 3)
        #expect(!page.board.canReadInvites)
        let row = try #require(page.board.rows.first)
        #expect(row.rank == 1)
        #expect(row.userId == "333333333333333333")
        #expect(row.name == "ada")
        #expect(row.net == 7)
        #expect(row.regular == 9)
        #expect(row.leaves == 3)
        #expect(row.bonus == 1)
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(InviteTrackerPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings.joinLogChannelId.isEmpty)
        #expect(page.settings.graceHours == 24)
        #expect(page.channels.isEmpty)
        #expect(page.board.total == 0)
        #expect(page.board.canReadInvites)
        #expect(page.board.rows.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, never the leaderboard")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(InviteTrackerPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["joinLogChannelId", "graceHours"])
        #expect(body["graceHours"] as? Int == 48)
    }

    @Test("new settings start like the server's defaults")
    func defaults() {
        let settings = InviteTrackerSettings()
        #expect(settings.joinLogChannelId.isEmpty)
        #expect(settings.graceHours == 24)
    }
}
