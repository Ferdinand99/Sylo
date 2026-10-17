import Foundation
import Testing
@testable import SyloKit

@Suite("Appeals settings")
struct AppealsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/appeals/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "questions": ["Why were you banned?", "Why should we unban you?"],
        "autoUnbanOnAccept": false,
        "reviewChannelId": "222222222222222222",
        "cooldownDays": 14,
        "appealMessage": "Appeals are reviewed within 48 hours.",
        "appealServerInvite": "https://discord.gg/abc123"
      },
      "channels": [{"id": "222222222222222222", "name": "appeals"}],
      "dashboardUrlSet": true
    }
    """#

    @Test("the page decodes settings, padding the questions to five slots like the web form")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(AppealsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(AppealsPage.moduleID == "appeals")
        let s = page.settings
        #expect(s.questions == ["Why were you banned?", "Why should we unban you?", "", "", ""])
        #expect(!s.autoUnbanOnAccept)
        #expect(s.reviewChannelId == "222222222222222222")
        #expect(s.cooldownDays == 14)
        #expect(s.appealMessage == "Appeals are reviewed within 48 hours.")
        #expect(s.appealServerInvite == "https://discord.gg/abc123")
        #expect(page.channels.map(\.name) == ["appeals"])
        #expect(page.dashboardUrlSet)
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(AppealsPage.self, from: Data(#"{"config":{"cooldownDays":3}}"#.utf8))
        let s = page.settings
        #expect(s.questions == [
            "Why were you banned?",
            "Why should your ban be lifted?",
            "What will you do differently if your appeal is accepted?",
            "", "",
        ])
        #expect(s.autoUnbanOnAccept)
        #expect(s.reviewChannelId.isEmpty)
        #expect(s.cooldownDays == 3)
        #expect(s.appealMessage.isEmpty)
        #expect(s.appealServerInvite.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(!page.dashboardUrlSet)
    }

    @Test("saving sends exactly what the web dashboard sends, all five question slots")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(AppealsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == [
            "questions", "autoUnbanOnAccept", "reviewChannelId", "cooldownDays", "appealMessage",
            "appealServerInvite",
        ])
        #expect((body["questions"] as? [String])?.count == 5)
        #expect(body["cooldownDays"] as? Int == 14)
    }

    @Test("new settings start like the server's defaults, more than five questions are cut")
    func newSettings() {
        let s = AppealsSettings()
        #expect(s.questions.count == AppealsSettings.questionSlots)
        #expect(s.questions.first == "Why were you banned?")
        #expect(s.autoUnbanOnAccept)
        #expect(s.cooldownDays == 7)
        let long = AppealsSettings(questions: ["1", "2", "3", "4", "5", "6"])
        #expect(long.questions == ["1", "2", "3", "4", "5"])
    }
}
