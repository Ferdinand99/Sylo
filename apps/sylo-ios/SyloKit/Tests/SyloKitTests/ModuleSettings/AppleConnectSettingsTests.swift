import Foundation
import Testing
@testable import SyloKit

@Suite("AppleConnect settings")
struct AppleConnectSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/apple-connect/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "channelId": "111111111111111111",
        "roleId": "222222222222222222",
        "apps": ["1234567890", "987"],
        "events": {
          "versionState": {"enabled": true, "channelId": ""},
          "build": {"enabled": false, "channelId": "333333333333333333"},
          "betaReview": {"enabled": true, "channelId": ""},
          "reviews": {"enabled": true, "channelId": "", "maxStars": 3},
          "feedback": {"enabled": false, "channelId": ""},
          "expiry": {"enabled": true, "channelId": "", "days": 14},
          "sales": {"enabled": true, "channelId": "444444444444444444"}
        }
      },
      "channels": [{"id": "111111111111111111", "name": "app-store"}],
      "roles": [{"id": "222222222222222222", "name": "Dev"}],
      "appleEnabled": false
    }
    """#

    @Test("the page decodes settings, options and whether the bot has an Apple key")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(AppleConnectPage.self, from: Data(Self.pageJSON.utf8))
        #expect(AppleConnectPage.moduleID == "apple-connect")
        let s = page.settings
        #expect(s.channelId == "111111111111111111")
        #expect(s.roleId == "222222222222222222")
        #expect(s.apps == ["1234567890", "987"])
        #expect(s.appsText == "1234567890\n987")
        #expect(s.events.versionState.enabled)
        #expect(!s.events.build.enabled)
        #expect(s.events.build.channelId == "333333333333333333")
        #expect(s.events.reviews.maxStars == 3)
        #expect(!s.events.feedback.enabled)
        #expect(s.events.expiry.days == 14)
        #expect(s.events.sales.enabled)
        #expect(s.events.sales.channelId == "444444444444444444")
        #expect(page.channels.map(\.name) == ["app-store"])
        #expect(page.roles.map(\.name) == ["Dev"])
        #expect(!page.appleEnabled)
    }

    @Test("missing fields, and the older plain-boolean alert shape, fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"events":{"build":false,"reviews":{"enabled":false}}}}"#.utf8)
        let page = try JSONDecoder().decode(AppleConnectPage.self, from: json)
        let s = page.settings
        #expect(s.channelId.isEmpty)
        #expect(s.roleId.isEmpty)
        #expect(s.apps.isEmpty)
        #expect(s.events.versionState.enabled)
        #expect(!s.events.build.enabled)
        #expect(s.events.build.channelId.isEmpty)
        #expect(!s.events.reviews.enabled)
        #expect(s.events.reviews.maxStars == 5)
        #expect(s.events.expiry.enabled)
        #expect(s.events.expiry.days == 30)
        #expect(!s.events.sales.enabled)
        #expect(page.appleEnabled)
        #expect(page.channels.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        var settings = try JSONDecoder().decode(AppleConnectPage.self, from: Data(Self.pageJSON.utf8)).settings
        // Typed like the web form's text box: one per line, or separated by spaces or commas.
        settings.appsText = " 111\n\n222, 333 "
        let data = try JSONEncoder().encode(settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["channelId", "roleId", "apps", "events"])
        #expect(body["apps"] as? [String] == ["111", "222", "333"])
        let events = try #require(body["events"] as? [String: [String: Any]])
        #expect(Set(events.keys) == ["versionState", "build", "betaReview", "reviews", "feedback", "expiry", "sales"])
        #expect(Set(try #require(events["build"]).keys) == ["enabled", "channelId"])
        #expect(Set(try #require(events["reviews"]).keys) == ["enabled", "channelId", "maxStars"])
        #expect(Set(try #require(events["expiry"]).keys) == ["enabled", "channelId", "days"])
        #expect(events["sales"]?["channelId"] as? String == "444444444444444444")
    }

    @Test("new settings start like the server's defaults")
    func defaults() {
        let s = AppleConnectSettings()
        #expect(s.apps.isEmpty)
        #expect(s.events.versionState.enabled)
        #expect(s.events.reviews.maxStars == 5)
        #expect(s.events.expiry.days == 30)
        #expect(!s.events.sales.enabled)
    }
}
