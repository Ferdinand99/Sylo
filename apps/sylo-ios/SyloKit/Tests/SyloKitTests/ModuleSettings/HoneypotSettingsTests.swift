import Foundation
import Testing
@testable import SyloKit

@Suite("Honeypot settings")
struct HoneypotSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/honeypot/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "exemptRoles": ["111111111111111111"],
        "channels": [
          {"channelId": "222222222222222222", "action": "timeout", "timeoutMinutes": 30,
           "deleteMessage": false, "triggerCount": 4}
        ],
        "messages": [
          {"channelId": "333333333333333333", "messageId": "444444444444444444", "bait": "Click here",
           "action": "ban", "timeoutMinutes": 10, "triggerCount": 2}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "trap"}],
      "roles": [{"id": "111111111111111111", "name": "Mods"}],
      "actions": ["kick", "timeout", "ban"],
      "catches": [{"userTag": "spam#0001", "kind": "channel", "channelName": "trap", "action": "kick", "ago": "2h ago"}]
    }
    """#

    @Test("the page decodes settings, options and recent catches")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(HoneypotPage.self, from: Data(Self.pageJSON.utf8))
        #expect(HoneypotPage.moduleID == "honeypot")
        #expect(page.settings.exemptRoles == ["111111111111111111"])
        let trap = try #require(page.settings.channels.first)
        #expect(trap.channelId == "222222222222222222")
        #expect(trap.action == .timeout)
        #expect(trap.timeoutMinutes == 30)
        #expect(!trap.deleteMessage)
        #expect(trap.triggerCount == 4)
        let bait = try #require(page.settings.messages.first)
        #expect(bait.bait == "Click here")
        #expect(bait.action == .ban)
        #expect(bait.triggerCount == 2)
        #expect(page.channels.map(\.name) == ["trap"])
        #expect(page.roles.map(\.name) == ["Mods"])
        #expect(page.catches.first?.userTag == "spam#0001")
    }

    @Test("missing fields and an unknown action fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"channels":[{"channelId":"1","action":"explode"}]}}"#.utf8)
        let page = try JSONDecoder().decode(HoneypotPage.self, from: json)
        let trap = try #require(page.settings.channels.first)
        #expect(trap.action == .kick)
        #expect(trap.timeoutMinutes == 10)
        #expect(trap.deleteMessage)
        #expect(page.settings.exemptRoles.isEmpty)
        #expect(page.settings.messages.isEmpty)
        #expect(page.channels.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, never the bot-managed counters")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(HoneypotPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["exemptRoles", "channels", "messages"])
        let channel = try #require((body["channels"] as? [[String: Any]])?.first)
        #expect(Set(channel.keys) == ["channelId", "action", "timeoutMinutes", "deleteMessage"])
        #expect(channel["action"] as? String == "timeout")
        let message = try #require((body["messages"] as? [[String: Any]])?.first)
        #expect(Set(message.keys) == ["channelId", "bait", "action", "timeoutMinutes"])
    }

    @Test("new traps start like the web form's new rows")
    func newTraps() {
        let trap = HoneypotSettings.ChannelTrap()
        #expect(trap.channelId.isEmpty)
        #expect(trap.action == .kick)
        #expect(trap.timeoutMinutes == 10)
        #expect(trap.deleteMessage)
        let bait = HoneypotSettings.MessageTrap()
        #expect(bait.bait.isEmpty)
        #expect(bait.action == .kick)
    }
}
