import Foundation
import Testing
@testable import SyloKit

@Suite("Birthdays settings")
struct BirthdaysSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/birthdays/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {"channel": "222222222222222222", "message": "Happy birthday {user}, you're {age}!",
                 "roleId": "111111111111111111", "pingRole": true},
      "channels": [{"id": "222222222222222222", "name": "general"}],
      "roles": [{"id": "111111111111111111", "name": "Birthday"}]
    }
    """#

    @Test("the page decodes settings, channels and roles")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(BirthdaysPage.self, from: Data(Self.pageJSON.utf8))
        #expect(BirthdaysPage.moduleID == "birthdays")
        #expect(page.settings.channel == "222222222222222222")
        #expect(page.settings.message == "Happy birthday {user}, you're {age}!")
        #expect(page.settings.roleId == "111111111111111111")
        #expect(page.settings.pingRole)
        #expect(page.channels.map(\.name) == ["general"])
        #expect(page.roles.map(\.name) == ["Birthday"])
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(BirthdaysPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings.channel.isEmpty)
        #expect(page.settings.message == "🎂 Happy birthday {user}! 🎉")
        #expect(page.settings.roleId.isEmpty)
        #expect(!page.settings.pingRole)
        #expect(page.channels.isEmpty)
        #expect(page.roles.isEmpty)
        #expect(BirthdaysSettings() == page.settings)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(BirthdaysPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["channel", "message", "roleId", "pingRole"])
        #expect(body["pingRole"] as? Bool == true)
    }
}
