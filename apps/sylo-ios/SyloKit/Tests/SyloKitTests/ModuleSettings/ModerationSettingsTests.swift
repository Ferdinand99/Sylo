import Foundation
import Testing
@testable import SyloKit

@Suite("Moderation settings")
struct ModerationSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/moderation/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "dmOnPunish": false,
        "warnThresholds": [
          {"count": 3, "action": "timeout", "durationMinutes": 120},
          {"count": 5, "action": "ban", "durationMinutes": 60}
        ],
        "infractionRetentionDays": 90
      },
      "thresholdActions": ["timeout", "kick", "ban"]
    }
    """#

    @Test("the page decodes settings")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(ModerationPage.self, from: Data(Self.pageJSON.utf8))
        #expect(ModerationPage.moduleID == "moderation")
        #expect(!page.settings.dmOnPunish)
        #expect(page.settings.infractionRetentionDays == 90)
        #expect(page.settings.warnThresholds.count == 2)
        let first = try #require(page.settings.warnThresholds.first)
        #expect(first.count == 3)
        #expect(first.action == .timeout)
        #expect(first.durationMinutes == 120)
        #expect(page.settings.warnThresholds.last?.action == .ban)
    }

    @Test("missing fields and an unknown action fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"warnThresholds":[{"count":2,"action":"yeet"}]}}"#.utf8)
        let page = try JSONDecoder().decode(ModerationPage.self, from: json)
        #expect(page.settings.dmOnPunish)
        #expect(page.settings.infractionRetentionDays == 0)
        let rule = try #require(page.settings.warnThresholds.first)
        #expect(rule.count == 2)
        #expect(rule.action == .timeout)
        #expect(rule.durationMinutes == 60)

        let empty = try JSONDecoder().decode(ModerationPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.warnThresholds.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(ModerationPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["dmOnPunish", "infractionRetentionDays", "warnThresholds"])
        let rule = try #require((body["warnThresholds"] as? [[String: Any]])?.first)
        #expect(Set(rule.keys) == ["count", "action", "durationMinutes"])
        #expect(rule["action"] as? String == "timeout")
        #expect(rule["count"] as? Int == 3)
    }

    @Test("new rules start like the web form's new rows")
    func newRule() {
        let rule = ModerationSettings.WarnThreshold()
        #expect(rule.count == 3)
        #expect(rule.action == .timeout)
        #expect(rule.durationMinutes == 60)
        let settings = ModerationSettings()
        #expect(settings.dmOnPunish)
        #expect(settings.infractionRetentionDays == 0)
    }
}
