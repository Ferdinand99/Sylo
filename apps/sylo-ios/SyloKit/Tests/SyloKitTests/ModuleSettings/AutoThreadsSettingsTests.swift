import Foundation
import Testing
@testable import SyloKit

@Suite("Auto threads settings")
struct AutoThreadsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/auto-threads/config`, shaped like normaliseAutoThreadsConfig.
    static let pageJSON = #"""
    {
      "config": {
        "rules": [
          {"id": "r1", "channelId": "222222222222222222", "nameTemplate": "{author}: {words}",
           "archiveMinutes": 4320, "onlyWithAttachments": true, "onlyWithLinks": false, "skipBots": true,
           "skipStaff": true, "staffRoleIds": ["111111111111111111"], "firstMessage": "Welcome {author}!",
           "slowmodeSeconds": 30},
          {"id": "r2", "channelId": "333333333333333333", "nameTemplate": "{words}", "archiveMinutes": 1440,
           "onlyWithAttachments": false, "onlyWithLinks": true, "skipBots": false, "skipStaff": false,
           "staffRoleIds": [], "firstMessage": "", "slowmodeSeconds": 0}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "screenshots"}, {"id": "333333333333333333", "name": "links"}],
      "roles": [{"id": "111111111111111111", "name": "Moderators"}]
    }
    """#

    @Test("the page decodes the rules, channels and roles")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(AutoThreadsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(AutoThreadsPage.moduleID == "auto-threads")
        #expect(page.settings.rules.count == 2)
        let rule = try #require(page.settings.rules.first)
        #expect(rule.ruleId == "r1")
        #expect(rule.channelId == "222222222222222222")
        #expect(rule.nameTemplate == "{author}: {words}")
        #expect(rule.archive == .threeDays)
        #expect(rule.onlyWithAttachments)
        #expect(!rule.onlyWithLinks)
        #expect(rule.skipBots)
        #expect(rule.skipStaff)
        #expect(rule.staffRoleIds == ["111111111111111111"])
        #expect(rule.firstMessage == "Welcome {author}!")
        #expect(rule.slowmodeSeconds == 30)
        #expect(page.settings.rules.last?.skipBots == false)
        #expect(page.channels.map(\.name) == ["screenshots", "links"])
        #expect(page.roles.count == 1)
    }

    @Test("a rule missing fields reads like the web form's blank rule; an odd archive time becomes 24 hours")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"rules":[{"channelId":"1","archiveMinutes":99}]}}"#.utf8)
        let page = try JSONDecoder().decode(AutoThreadsPage.self, from: json)
        let rule = try #require(page.settings.rules.first)
        #expect(rule.ruleId.isEmpty)
        #expect(rule.nameTemplate == "{words}")
        #expect(rule.archive == .day)
        #expect(rule.skipBots)
        #expect(!rule.skipStaff)
        #expect(rule.slowmodeSeconds == 0)
        #expect(try JSONDecoder().decode(AutoThreadsPage.self, from: Data(#"{}"#.utf8)).settings.rules.isEmpty)
    }

    @Test("saving sends the rules with the same fields as the web form, ids kept")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(AutoThreadsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["rules"])
        let rule = try #require((body["rules"] as? [[String: Any]])?.first)
        #expect(Set(rule.keys) == [
            "id", "channelId", "nameTemplate", "archiveMinutes", "onlyWithAttachments", "onlyWithLinks",
            "skipBots", "skipStaff", "staffRoleIds", "firstMessage", "slowmodeSeconds",
        ])
        #expect(rule["id"] as? String == "r1")
        #expect(rule["archiveMinutes"] as? Int == 4320)
        #expect(rule["slowmodeSeconds"] as? Int == 30)
        // Reading it back gives the same rules (the list-only identity aside).
        let again = try JSONDecoder().decode(AutoThreadsSettings.self, from: data)
        #expect(again.rules.map(\.ruleId) == ["r1", "r2"])
        #expect(again.rules.map(\.nameTemplate) == page.settings.rules.map(\.nameTemplate))
        #expect(again.rules.map(\.archive) == page.settings.rules.map(\.archive))
    }

    @Test("a new rule starts like the web form's")
    func newRule() {
        let rule = AutoThreadsSettings.Rule()
        #expect(rule.ruleId.isEmpty)
        #expect(rule.channelId.isEmpty)
        #expect(rule.nameTemplate == "{words}")
        #expect(rule.archive == .day)
        #expect(rule.skipBots)
        #expect(!rule.skipStaff)
        #expect(rule.slowmodeSeconds == 0)
    }

    @Test("the limits are the server's")
    func limits() {
        #expect(AutoThreadsSettings.maxRules == 25)
        #expect(AutoThreadsSettings.maxNameTemplateLength == 100)
        #expect(AutoThreadsSettings.maxFirstMessageLength == 2000)
        #expect(AutoThreadsSettings.slowmodeRange == 0...21600)
        #expect(AutoThreadsSettings.Archive.allCases.map(\.rawValue) == [60, 1440, 4320, 10080])
    }
}
