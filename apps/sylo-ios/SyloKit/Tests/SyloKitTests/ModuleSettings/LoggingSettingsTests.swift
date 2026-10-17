import Foundation
import Testing
@testable import SyloKit

@Suite("Logging settings")
struct LoggingSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/logging/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "channel": "222222222222222222",
        "events": {"memberJoin": true, "memberLeave": false, "messageDelete": true}
      },
      "channels": [{"id": "222222222222222222", "name": "mod-log"}],
      "logEvents": [["memberJoin", "Member joined"], ["memberLeave", "Member left"], ["messageDelete", "Message deleted"]]
    }
    """#

    @Test("the page decodes settings, channels and the event list")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(LoggingPage.self, from: Data(Self.pageJSON.utf8))
        #expect(LoggingPage.moduleID == "logging")
        #expect(page.settings.channel == "222222222222222222")
        #expect(page.settings.events == ["memberJoin": true, "memberLeave": false, "messageDelete": true])
        #expect(page.channels.map(\.name) == ["mod-log"])
        #expect(page.logEvents.map(\.key) == ["memberJoin", "memberLeave", "messageDelete"])
        #expect(page.logEvents.first?.label == "Member joined")
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(LoggingPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings.channel.isEmpty)
        #expect(page.settings.events.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.logEvents.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(LoggingPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["channel", "events"])
        let events = try #require(body["events"] as? [String: Bool])
        #expect(events == ["memberJoin": true, "memberLeave": false, "messageDelete": true])
    }

    @Test("an event that isn't in the settings reads as off, and switching it on stores it")
    func eventToggle() {
        var settings = LoggingSettings()
        #expect(!settings.isLogging("memberBan"))
        settings.setLogging("memberBan", true)
        #expect(settings.isLogging("memberBan"))
        #expect(settings.events["memberBan"] == true)
    }
}
