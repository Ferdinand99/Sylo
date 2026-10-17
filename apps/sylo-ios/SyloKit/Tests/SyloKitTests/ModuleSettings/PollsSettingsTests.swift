import Foundation
import Testing
@testable import SyloKit

@Suite("Polls settings")
struct PollsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/polls/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "voteRoleMode": "deny",
        "voteRoles": ["111111111111111111"],
        "pollMessage": {"content": "New poll!", "title": "📊 {question}", "color": "#ff0000",
                        "footer": "{ends} · {mode}", "image": ""},
        "resultsMessage": {"content": "", "title": "Results — {question}", "color": "#5b7cfa",
                           "footer": "Winner: {winner}", "image": "https://example.com/a.png"}
      },
      "roles": [{"id": "111111111111111111", "name": "Members"}],
      "pollPlaceholders": ["{question}", "{choices}", "{ends}", "{mode}"],
      "resultsPlaceholders": ["{question}", "{results}", "{total}", "{winner}", "{mode}"]
    }
    """#

    @Test("the page decodes settings, roles and placeholders")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(PollsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(PollsPage.moduleID == "polls")
        #expect(page.settings.voteRoleMode == .deny)
        #expect(page.settings.voteRoles == ["111111111111111111"])
        #expect(page.settings.pollMessage.content == "New poll!")
        #expect(page.settings.pollMessage.title == "📊 {question}")
        #expect(page.settings.pollMessage.color == "#ff0000")
        #expect(page.settings.pollMessage.footer == "{ends} · {mode}")
        #expect(page.settings.resultsMessage.image == "https://example.com/a.png")
        #expect(page.roles.map(\.name) == ["Members"])
        #expect(page.pollPlaceholders == ["{question}", "{choices}", "{ends}", "{mode}"])
        #expect(page.resultsPlaceholders.count == 5)
    }

    @Test("missing fields and an unknown mode fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"voteRoleMode":"sometimes","pollMessage":{}}}"#.utf8)
        let page = try JSONDecoder().decode(PollsPage.self, from: json)
        #expect(page.settings.voteRoleMode == .allow)
        #expect(page.settings.voteRoles.isEmpty)
        #expect(page.settings.pollMessage == PollsMessage())
        #expect(page.settings.pollMessage.color == "#5b7cfa")
        #expect(page.settings.resultsMessage == PollsMessage())
        #expect(page.roles.isEmpty)
        #expect(page.pollPlaceholders.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(PollsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["voteRoleMode", "voteRoles", "pollMessage", "resultsMessage"])
        #expect(body["voteRoleMode"] as? String == "deny")
        for key in ["pollMessage", "resultsMessage"] {
            let message = try #require(body[key] as? [String: Any])
            #expect(Set(message.keys) == ["content", "title", "color", "footer", "image"])
        }
    }

    @Test("the embed colour converts between hex and RGB")
    func colour() {
        var message = PollsMessage(color: "#ff8000")
        let rgb = message.rgb
        #expect(rgb.red == 1)
        #expect(abs(rgb.green - 128.0 / 255) < 0.0001)
        #expect(rgb.blue == 0)
        message.setRGB(red: 0, green: 0.5, blue: 1.2)
        #expect(message.color == "#0080ff")
        #expect(PollsMessage(color: "nonsense").rgb == PollsMessage().rgb)
    }
}
