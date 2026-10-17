import Foundation
import Testing
@testable import SyloKit

@Suite("AutoReact settings")
struct AutoReactSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/auto-react/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "cooldownSeconds": 12,
        "logChannelId": "222222222222222222",
        "rules": [
          {"id": "0", "targetUsers": ["111111111111111111", "111111111111111112"],
           "targetRoles": ["333333333333333333"], "emojis": ["🧟", "444444444444444444"],
           "mode": "random", "chance": 25, "roleId": "555555555555555555", "roleAction": "remove",
           "channelId": "222222222222222222"}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "game"}],
      "roles": [{"id": "333333333333333333", "name": "Infected"}],
      "modes": ["always", "random"],
      "roleActions": ["add", "remove"]
    }
    """#

    @Test("the page decodes settings, channels and roles")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(AutoReactPage.self, from: Data(Self.pageJSON.utf8))
        #expect(AutoReactPage.moduleID == "auto-react")
        #expect(page.settings.cooldownSeconds == 12)
        #expect(page.settings.logChannelId == "222222222222222222")
        let rule = try #require(page.settings.rules.first)
        #expect(rule.targetUsersText == "111111111111111111 111111111111111112")
        #expect(rule.targetRoleId == "333333333333333333")
        #expect(rule.emojisText == "🧟 444444444444444444")
        #expect(rule.mode == .random)
        #expect(rule.chance == 25)
        #expect(rule.roleId == "555555555555555555")
        #expect(rule.roleAction == .remove)
        #expect(rule.channelId == "222222222222222222")
        #expect(page.channels.map(\.name) == ["game"])
        #expect(page.roles.map(\.name) == ["Infected"])
    }

    @Test("missing fields and unknown choices fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"rules":[{"mode":"sometimes","roleAction":"toggle"}]}}"#.utf8)
        let page = try JSONDecoder().decode(AutoReactPage.self, from: json)
        #expect(page.settings.cooldownSeconds == 5)
        #expect(page.settings.logChannelId.isEmpty)
        let rule = try #require(page.settings.rules.first)
        #expect(rule.mode == .always)
        #expect(rule.roleAction == .add)
        #expect(rule.chance == 50)
        #expect(rule.targetUsersText.isEmpty)
        #expect(rule.targetRoleId.isEmpty)
        #expect(rule.emojisText.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.roles.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(AutoReactPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["cooldownSeconds", "logChannelId", "rules"])
        let rule = try #require((body["rules"] as? [[String: Any]])?.first)
        #expect(Set(rule.keys) == ["targetUsersText", "targetRoleId", "channelId", "emojis", "mode", "chance",
                                   "roleId", "roleAction"])
        #expect(rule["targetUsersText"] as? String == "111111111111111111 111111111111111112")
        #expect(rule["emojis"] as? String == "🧟 444444444444444444")
        #expect(rule["mode"] as? String == "random")
        #expect(rule["roleAction"] as? String == "remove")
    }

    @Test("new rules start like the web form's new rules")
    func newRule() {
        let rule = AutoReactSettings.Rule()
        #expect(rule.targetUsersText.isEmpty)
        #expect(rule.targetRoleId.isEmpty)
        #expect(rule.channelId.isEmpty)
        #expect(rule.emojisText.isEmpty)
        #expect(rule.mode == .always)
        #expect(rule.chance == 50)
        #expect(rule.roleId.isEmpty)
        #expect(rule.roleAction == .add)
    }
}
