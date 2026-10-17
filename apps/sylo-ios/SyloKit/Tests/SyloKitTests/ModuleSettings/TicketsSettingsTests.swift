import Foundation
import Testing
@testable import SyloKit

@Suite("Tickets settings")
struct TicketsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/tickets/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "greeting": "Thanks for contacting {server}.",
        "closeMessage": "Closed.",
        "notifyChannel": "222222222222222222",
        "staffRoles": ["111111111111111111"],
        "transcriptRetentionDays": 30,
        "showMessageInAlert": true
      },
      "channels": [{"id": "222222222222222222", "name": "staff"}],
      "roles": [{"id": "111111111111111111", "name": "Support"}]
    }
    """#

    @Test("the page decodes settings and options")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(TicketsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(TicketsPage.moduleID == "tickets")
        let s = page.settings
        #expect(s.greeting == "Thanks for contacting {server}.")
        #expect(s.closeMessage == "Closed.")
        #expect(s.notifyChannel == "222222222222222222")
        #expect(s.staffRoles == ["111111111111111111"])
        #expect(s.transcriptRetentionDays == 30)
        #expect(s.showMessageInAlert)
        #expect(page.channels.map(\.name) == ["staff"])
        #expect(page.roles.map(\.name) == ["Support"])
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(TicketsPage.self, from: Data(#"{"config":{"greeting":"Hi"}}"#.utf8))
        let s = page.settings
        #expect(s.greeting == "Hi")
        #expect(s.closeMessage.isEmpty)
        #expect(s.notifyChannel.isEmpty)
        #expect(s.staffRoles.isEmpty)
        #expect(s.transcriptRetentionDays == 0)
        #expect(!s.showMessageInAlert)
        #expect(page.channels.isEmpty)
        #expect(page.roles.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(TicketsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == [
            "greeting", "closeMessage", "notifyChannel", "staffRoles", "transcriptRetentionDays",
            "showMessageInAlert",
        ])
        #expect(body["staffRoles"] as? [String] == ["111111111111111111"])
    }

    @Test("new settings start empty, like the server's defaults")
    func newSettings() {
        let s = TicketsSettings()
        #expect(s.greeting.isEmpty && s.closeMessage.isEmpty && s.notifyChannel.isEmpty)
        #expect(s.transcriptRetentionDays == 0)
        #expect(!s.showMessageInAlert)
        #expect(TicketsSettings.retentionRange == 0...3650)
    }
}
