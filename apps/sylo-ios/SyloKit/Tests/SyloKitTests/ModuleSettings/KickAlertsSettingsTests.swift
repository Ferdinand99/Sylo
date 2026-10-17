import Foundation
import Testing
@testable import SyloKit

@Suite("KickAlerts settings")
struct KickAlertsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/kick-alerts/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "alerts": [
          {"id": "0", "slug": "xqc", "channelId": "222222222222222222", "roleId": "111111111111111111",
           "message": "{name} is live", "plainText": true, "onEnd": "edit"}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "streams"}],
      "roles": [{"id": "111111111111111111", "name": "Live pings"}],
      "kickEnabled": false,
      "defaultMessage": "🟢 **{name}** is live on Kick!"
    }
    """#

    @Test("the page decodes settings, options and the default message")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(KickAlertsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(KickAlertsPage.moduleID == "kick-alerts")
        let alert = try #require(page.settings.alerts.first)
        #expect(alert.slug == "xqc")
        #expect(alert.channelId == "222222222222222222")
        #expect(alert.roleId == "111111111111111111")
        #expect(alert.message == "{name} is live")
        #expect(alert.plainText)
        #expect(alert.onEnd == .edit)
        #expect(page.channels.map(\.name) == ["streams"])
        #expect(page.roles.map(\.name) == ["Live pings"])
        #expect(!page.kickEnabled)
        #expect(page.defaultMessage == "🟢 **{name}** is live on Kick!")
    }

    @Test("missing fields and an unknown end mode fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"alerts":[{"slug":"xqc","onEnd":"explode"}]}}"#.utf8)
        let page = try JSONDecoder().decode(KickAlertsPage.self, from: json)
        let alert = try #require(page.settings.alerts.first)
        #expect(alert.onEnd == .delete)
        #expect(alert.channelId.isEmpty)
        #expect(alert.roleId.isEmpty)
        #expect(alert.message.isEmpty)
        #expect(!alert.plainText)
        #expect(page.channels.isEmpty)
        #expect(page.kickEnabled)
        #expect(page.defaultMessage.isEmpty)

        let empty = try JSONDecoder().decode(KickAlertsPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.alerts.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(KickAlertsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["alerts"])
        let alert = try #require((body["alerts"] as? [[String: Any]])?.first)
        #expect(Set(alert.keys) == ["slug", "channelId", "roleId", "message", "plainText", "onEnd"])
        #expect(alert["onEnd"] as? String == "edit")
        #expect(alert["plainText"] as? Bool == true)
    }

    @Test("new streamers start like the web form's new rows")
    func newAlert() {
        let alert = KickAlertsSettings.Alert()
        #expect(alert.slug.isEmpty)
        #expect(alert.channelId.isEmpty)
        #expect(alert.roleId.isEmpty)
        #expect(alert.message.isEmpty)
        #expect(!alert.plainText)
        #expect(alert.onEnd == .delete)
    }
}
