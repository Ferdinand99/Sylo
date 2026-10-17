import Foundation
import Testing
@testable import SyloKit

@Suite("Verification settings")
struct VerificationSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/verification/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "mode": "captcha",
        "verifiedRoleId": "111111111111111111",
        "channelId": "222222222222222222",
        "messageId": "444444444444444444",
        "title": "Gate",
        "message": "Press the button.",
        "successMessage": "Welcome in!",
        "logChannelId": "333333333333333333",
        "kickAfterMinutes": 60
      },
      "channels": [{"id": "222222222222222222", "name": "verify"}],
      "roles": [{"id": "111111111111111111", "name": "Verified"}],
      "modes": ["button", "captcha"],
      "turnstileEnabled": true
    }
    """#

    @Test("the page decodes settings and options")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(VerificationPage.self, from: Data(Self.pageJSON.utf8))
        #expect(VerificationPage.moduleID == "verification")
        let s = page.settings
        #expect(s.mode == .captcha)
        #expect(s.verifiedRoleId == "111111111111111111")
        #expect(s.channelId == "222222222222222222")
        #expect(s.title == "Gate")
        #expect(s.message == "Press the button.")
        #expect(s.successMessage == "Welcome in!")
        #expect(s.logChannelId == "333333333333333333")
        #expect(s.kickAfterMinutes == 60)
        #expect(page.channels.map(\.name) == ["verify"])
        #expect(page.roles.map(\.name) == ["Verified"])
        #expect(page.turnstileEnabled)
    }

    @Test("missing fields and an unknown mode fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"mode":"retina-scan"}}"#.utf8)
        let page = try JSONDecoder().decode(VerificationPage.self, from: json)
        let s = page.settings
        #expect(s.mode == .button)
        #expect(s.verifiedRoleId.isEmpty)
        #expect(s.channelId.isEmpty)
        #expect(s.title == "Verification")
        #expect(s.message == "Click the button below to verify and unlock the rest of the server.")
        #expect(s.successMessage == "You are verified — welcome!")
        #expect(s.logChannelId.isEmpty)
        #expect(s.kickAfterMinutes == 0)
        #expect(page.roles.isEmpty)
        #expect(!page.turnstileEnabled)
    }

    @Test("saving sends the web dashboard's fields, never the bot-managed message id")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(VerificationPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == [
            "mode", "verifiedRoleId", "channelId", "title", "message", "successMessage",
            "logChannelId", "kickAfterMinutes",
        ])
        #expect(body["mode"] as? String == "captcha")
        #expect(body["kickAfterMinutes"] as? Int == 60)
    }

    @Test("new settings start like the server's defaults")
    func newSettings() {
        let s = VerificationSettings()
        #expect(s.mode == .button)
        #expect(s.title == "Verification")
        #expect(s.kickAfterMinutes == 0)
        #expect(VerificationSettings.kickAfterRange == 0...10080)
    }
}
