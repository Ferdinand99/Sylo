import Foundation
import Testing
@testable import SyloKit

@Suite("Welcome settings")
struct WelcomeSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/welcome/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "joinEnabled": true,
        "joinChannel": "222222222222222222",
        "joinMessage": "Welcome {user} to {server}!",
        "useEmbed": true,
        "card": true,
        "cardBackground": "https://example.com/banner.png",
        "dmEnabled": true,
        "dmMessage": "Hi {user.name}",
        "leaveEnabled": true,
        "leaveChannel": "333333333333333333",
        "leaveMessage": "{user.tag} left the server.",
        "autoroleEnabled": true,
        "autoroles": ["111111111111111111"]
      },
      "channels": [{"id": "222222222222222222", "name": "welcome"}],
      "roles": [{"id": "111111111111111111", "name": "Member"}],
      "verificationEnabled": true,
      "placeholders": ["{user}", "{user.tag}", "{server}"]
    }
    """#

    @Test("the page decodes settings, options and placeholders")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(WelcomePage.self, from: Data(Self.pageJSON.utf8))
        #expect(WelcomePage.moduleID == "welcome")
        let s = page.settings
        #expect(s.joinEnabled)
        #expect(s.joinChannel == "222222222222222222")
        #expect(s.joinMessage == "Welcome {user} to {server}!")
        #expect(s.useEmbed)
        #expect(s.card)
        #expect(s.cardBackground == "https://example.com/banner.png")
        #expect(s.dmEnabled)
        #expect(s.dmMessage == "Hi {user.name}")
        #expect(s.leaveEnabled)
        #expect(s.leaveChannel == "333333333333333333")
        #expect(s.leaveMessage == "{user.tag} left the server.")
        #expect(s.autoroleEnabled)
        #expect(s.autoroles == ["111111111111111111"])
        #expect(page.channels.map(\.name) == ["welcome"])
        #expect(page.roles.map(\.name) == ["Member"])
        #expect(page.verificationEnabled)
        #expect(page.placeholders == ["{user}", "{user.tag}", "{server}"])
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(WelcomePage.self, from: Data(#"{"config":{"joinEnabled":true}}"#.utf8))
        let s = page.settings
        #expect(s.joinEnabled)
        #expect(s.joinChannel.isEmpty)
        #expect(s.joinMessage.isEmpty)
        #expect(!s.useEmbed)
        #expect(!s.card)
        #expect(!s.dmEnabled)
        #expect(!s.leaveEnabled)
        #expect(!s.autoroleEnabled)
        #expect(s.autoroles.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(!page.verificationEnabled)
        #expect(page.placeholders.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(WelcomePage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == [
            "joinEnabled", "joinChannel", "joinMessage", "useEmbed", "card", "cardBackground",
            "dmEnabled", "dmMessage", "leaveEnabled", "leaveChannel", "leaveMessage",
            "autoroleEnabled", "autoroles",
        ])
        #expect(body["autoroles"] as? [String] == ["111111111111111111"])
    }

    @Test("empty settings start with everything off")
    func newSettings() {
        let s = WelcomeSettings()
        #expect(!s.joinEnabled && !s.dmEnabled && !s.leaveEnabled && !s.autoroleEnabled && !s.card)
        #expect(s.joinMessage.isEmpty)
        #expect(WelcomeSettings.maxMessageLength == 1500)
    }
}
