import Foundation
import Testing
@testable import SyloKit

@Suite("Counting settings")
struct CountingSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/counting/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "channelId": "222222222222222222", "react": false, "allowSameUser": true, "resetOnFail": false,
        "penaltyRoleId": "111111111111111111", "penaltyMinutes": 60
      },
      "channels": [{"id": "222222222222222222", "name": "counting"}],
      "roles": [{"id": "111111111111111111", "name": "Counter"}],
      "state": {"current": 41, "record": 120, "lastUserId": "333333333333333333"},
      "penalties": [
        {"userId": "444444444444444444", "label": "oops#0001", "roleName": "Counter", "restoreAt": 1760000000000}
      ]
    }
    """#

    @Test("the page decodes settings, options, the game state and benched members")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(CountingPage.self, from: Data(Self.pageJSON.utf8))
        #expect(CountingPage.moduleID == "counting")
        #expect(page.settings.channelId == "222222222222222222")
        #expect(!page.settings.react)
        #expect(page.settings.allowSameUser)
        #expect(!page.settings.resetOnFail)
        #expect(page.settings.penaltyRoleId == "111111111111111111")
        #expect(page.settings.penaltyMinutes == 60)
        #expect(page.channels.map(\.name) == ["counting"])
        #expect(page.roles.map(\.name) == ["Counter"])
        #expect(page.state.current == 41)
        #expect(page.state.record == 120)
        #expect(page.state.lastUserId == "333333333333333333")
        let benched = try #require(page.penalties.first)
        #expect(benched.label == "oops#0001")
        #expect(benched.roleName == "Counter")
        #expect(benched.restoreAt == Date(timeIntervalSince1970: 1_760_000_000))
    }

    @Test("a near-empty answer falls back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{},"state":{"current":0,"record":0,"lastUserId":null},"penalties":[{"userId":"1","restoreAt":null}]}"#.utf8)
        let page = try JSONDecoder().decode(CountingPage.self, from: json)
        #expect(page.settings.channelId.isEmpty)
        #expect(page.settings.react)
        #expect(!page.settings.allowSameUser)
        #expect(page.settings.resetOnFail)
        #expect(page.settings.penaltyRoleId.isEmpty)
        #expect(page.settings.penaltyMinutes == 15)
        #expect(page.state.lastUserId == nil)
        #expect(page.penalties.first?.restoreAt == nil)
        #expect(page.channels.isEmpty)

        let bare = try JSONDecoder().decode(CountingPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(bare.state.current == 0)
        #expect(bare.penalties.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, never the game state")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(CountingPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["channelId", "react", "allowSameUser", "resetOnFail", "penaltyRoleId",
                                   "penaltyMinutes"])
        #expect(body["penaltyMinutes"] as? Int == 60)
    }

    @Test("new settings start like the server's defaults")
    func defaults() {
        let settings = CountingSettings()
        #expect(settings.channelId.isEmpty)
        #expect(settings.react)
        #expect(!settings.allowSameUser)
        #expect(settings.resetOnFail)
        #expect(settings.penaltyMinutes == 15)
    }
}
