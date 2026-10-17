import Foundation
import Testing
@testable import SyloKit

@Suite("Afk settings")
struct AfkSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/afk/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {"setNickname": false, "mentionReply": true, "ignoreChannels": ["222222222222222222"]},
      "channels": [{"id": "222222222222222222", "name": "spam"}]
    }
    """#

    @Test("the page decodes settings and channels")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(AfkPage.self, from: Data(Self.pageJSON.utf8))
        #expect(AfkPage.moduleID == "afk")
        #expect(!page.settings.setNickname)
        #expect(page.settings.mentionReply)
        #expect(page.settings.ignoreChannels == ["222222222222222222"])
        #expect(page.channels.map(\.name) == ["spam"])
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(AfkPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings.setNickname)
        #expect(page.settings.mentionReply)
        #expect(page.settings.ignoreChannels.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(AfkSettings() == page.settings)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(AfkPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["setNickname", "mentionReply", "ignoreChannels"])
        #expect(body["setNickname"] as? Bool == false)
        #expect(body["ignoreChannels"] as? [String] == ["222222222222222222"])
    }
}
