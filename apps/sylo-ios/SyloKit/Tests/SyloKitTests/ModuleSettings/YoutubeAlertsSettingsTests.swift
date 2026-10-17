import Foundation
import Testing
@testable import SyloKit

@Suite("YoutubeAlerts settings")
struct YoutubeAlertsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/youtube-alerts/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "alerts": [
          {"id": "0", "ytChannelId": "UCX6OQ3DkcsbYNE6H8uQQuVA", "name": "MrBeast",
           "discordChannelId": "222222222222222222", "roleId": "111111111111111111",
           "onVideo": true, "onLive": true, "onEnd": "keep",
           "videoMessage": "New: {title}", "liveMessage": ""},
          {"id": "1", "ytChannelId": "UCBR8-60-B28hp2BmDPdntcQ", "name": "",
           "discordChannelId": "222222222222222222", "roleId": "",
           "onVideo": false, "onLive": true, "onEnd": "delete", "videoMessage": "", "liveMessage": ""}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "videos"}],
      "roles": [{"id": "111111111111111111", "name": "Uploads"}],
      "defaultVideoMessage": "📺 **{name}** posted a new video: **{title}**\n{url}",
      "defaultLiveMessage": "🔴 **{name}** is live on YouTube: **{title}**\n{url}"
    }
    """#

    @Test("the page decodes settings, options and the default messages")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(YoutubeAlertsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(YoutubeAlertsPage.moduleID == "youtube-alerts")
        #expect(page.settings.alerts.count == 2)
        let alert = try #require(page.settings.alerts.first)
        #expect(alert.ytChannelId == "UCX6OQ3DkcsbYNE6H8uQQuVA")
        #expect(alert.name == "MrBeast")
        #expect(alert.input == "@MrBeast")
        #expect(alert.discordChannelId == "222222222222222222")
        #expect(alert.roleId == "111111111111111111")
        #expect(alert.notify == .both)
        #expect(alert.onEnd == .keep)
        #expect(alert.videoMessage == "New: {title}")
        #expect(alert.liveMessage.isEmpty)
        // No name yet: the web form pre-fills the field with the channel id.
        let second = page.settings.alerts[1]
        #expect(second.input == "@UCBR8-60-B28hp2BmDPdntcQ")
        #expect(second.notify == .live)
        #expect(page.channels.map(\.name) == ["videos"])
        #expect(page.roles.map(\.name) == ["Uploads"])
        #expect(page.defaultVideoMessage.hasPrefix("📺"))
        #expect(page.defaultLiveMessage.hasPrefix("🔴"))
    }

    @Test("missing fields and an unknown end mode fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"alerts":[{"ytChannelId":"UCX6OQ3DkcsbYNE6H8uQQuVA","onEnd":"explode"}]}}"#.utf8)
        let page = try JSONDecoder().decode(YoutubeAlertsPage.self, from: json)
        let alert = try #require(page.settings.alerts.first)
        #expect(alert.onEnd == .delete)
        // onVideo defaults to true and onLive to false.
        #expect(alert.notify == .video)
        #expect(alert.name.isEmpty)
        #expect(alert.discordChannelId.isEmpty)
        #expect(alert.videoMessage.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.defaultVideoMessage.isEmpty)

        let empty = try JSONDecoder().decode(YoutubeAlertsPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.alerts.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(YoutubeAlertsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["alerts"])
        let alerts = try #require(body["alerts"] as? [[String: Any]])
        let alert = try #require(alerts.first)
        #expect(Set(alert.keys) == ["input", "ytChannelId", "name", "discordChannelId", "roleId", "notify",
                                    "onEnd", "videoMessage", "liveMessage"])
        #expect(alert["input"] as? String == "@MrBeast")
        #expect(alert["notify"] as? String == "both")
        #expect(alert["onEnd"] as? String == "keep")
        #expect(alerts[1]["notify"] as? String == "live")
    }

    @Test("new channels start like the web form's new rows")
    func newAlert() {
        let alert = YoutubeAlertsSettings.Alert()
        #expect(alert.input.isEmpty)
        #expect(alert.ytChannelId.isEmpty)
        #expect(alert.name.isEmpty)
        #expect(alert.discordChannelId.isEmpty)
        #expect(alert.roleId.isEmpty)
        #expect(alert.notify == .video)
        #expect(alert.onEnd == .delete)
        #expect(alert.videoMessage.isEmpty)
        #expect(alert.liveMessage.isEmpty)
    }
}
