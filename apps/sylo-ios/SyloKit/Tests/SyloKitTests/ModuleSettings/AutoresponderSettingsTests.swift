import Foundation
import Testing
@testable import SyloKit

@Suite("Autoresponder settings")
struct AutoresponderSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/autoresponder/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "cooldownSeconds": 7,
        "ignoreChannels": ["222222222222222222"],
        "ignoreRoles": ["111111111111111111"],
        "responders": [
          {"trigger": "hello", "match": "wholeword", "response": "Hi {user}!", "embed": true,
           "embedColor": "5b7cfa", "deleteTrigger": true}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "general"}],
      "roles": [{"id": "111111111111111111", "name": "Bots"}],
      "matchModes": ["contains", "exact", "startswith", "wholeword"],
      "placeholders": ["{user}", "{username}", "{server}", "{channel}"]
    }
    """#

    @Test("the page decodes settings, options and placeholders")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(AutoresponderPage.self, from: Data(Self.pageJSON.utf8))
        #expect(AutoresponderPage.moduleID == "autoresponder")
        #expect(page.settings.cooldownSeconds == 7)
        #expect(page.settings.ignoreChannels == ["222222222222222222"])
        #expect(page.settings.ignoreRoles == ["111111111111111111"])
        let responder = try #require(page.settings.responders.first)
        #expect(responder.trigger == "hello")
        #expect(responder.match == .wholeword)
        #expect(responder.response == "Hi {user}!")
        #expect(responder.embed)
        #expect(responder.deleteTrigger)
        #expect(page.channels.map(\.name) == ["general"])
        #expect(page.roles.map(\.name) == ["Bots"])
        #expect(page.placeholders == ["{user}", "{username}", "{server}", "{channel}"])
    }

    @Test("missing fields and an unknown match mode fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"responders":[{"trigger":"x","match":"regex"}]}}"#.utf8)
        let page = try JSONDecoder().decode(AutoresponderPage.self, from: json)
        #expect(page.settings.cooldownSeconds == 2)
        #expect(page.settings.ignoreChannels.isEmpty)
        #expect(page.settings.ignoreRoles.isEmpty)
        let responder = try #require(page.settings.responders.first)
        #expect(responder.match == .contains)
        #expect(responder.response.isEmpty)
        #expect(!responder.embed)
        #expect(!responder.deleteTrigger)
        #expect(page.placeholders.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, never the embed colour")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(AutoresponderPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["cooldownSeconds", "ignoreChannels", "ignoreRoles", "responders"])
        let responder = try #require((body["responders"] as? [[String: Any]])?.first)
        #expect(Set(responder.keys) == ["trigger", "match", "response", "embed", "deleteTrigger"])
        #expect(responder["match"] as? String == "wholeword")
    }

    @Test("new responders start like the web form's new rows")
    func newResponder() {
        let responder = AutoresponderSettings.Responder()
        #expect(responder.trigger.isEmpty)
        #expect(responder.match == .contains)
        #expect(responder.response.isEmpty)
        #expect(!responder.embed)
        #expect(!responder.deleteTrigger)
    }
}
