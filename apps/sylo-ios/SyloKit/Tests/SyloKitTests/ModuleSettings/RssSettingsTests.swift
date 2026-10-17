import Foundation
import Testing
@testable import SyloKit

@Suite("Rss settings")
struct RssSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/rss/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "feeds": [
          {"id": "a1b2c3d4", "type": "reddit", "ref": "r/programming",
           "url": "https://www.reddit.com/r/programming/new/.rss", "channelId": "222222222222222222",
           "roleId": "111111111111111111", "template": "{title} {link}"}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "news"}],
      "roles": [{"id": "111111111111111111", "name": "Readers"}],
      "feedTypes": ["url", "reddit", "mastodon", "bluesky"],
      "defaultTemplate": "📰 **{title}**\n{link}"
    }
    """#

    @Test("the page decodes settings, options and the default template")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(RssPage.self, from: Data(Self.pageJSON.utf8))
        #expect(RssPage.moduleID == "rss")
        let feed = try #require(page.settings.feeds.first)
        #expect(feed.feedId == "a1b2c3d4")
        #expect(feed.type == .reddit)
        #expect(feed.ref == "r/programming")
        #expect(feed.channelId == "222222222222222222")
        #expect(feed.roleId == "111111111111111111")
        #expect(feed.template == "{title} {link}")
        #expect(page.channels.map(\.name) == ["news"])
        #expect(page.roles.map(\.name) == ["Readers"])
        #expect(page.defaultTemplate == "📰 **{title}**\n{link}")
    }

    @Test("missing fields and an unknown source fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"feeds":[{"type":"gopher","ref":"x"}]}}"#.utf8)
        let page = try JSONDecoder().decode(RssPage.self, from: json)
        let feed = try #require(page.settings.feeds.first)
        #expect(feed.type == .url)
        #expect(feed.feedId.isEmpty)
        #expect(feed.channelId.isEmpty)
        #expect(feed.roleId.isEmpty)
        #expect(feed.template.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.defaultTemplate.isEmpty)

        let empty = try JSONDecoder().decode(RssPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.feeds.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, never the derived feed URL")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(RssPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["feeds"])
        let feed = try #require((body["feeds"] as? [[String: Any]])?.first)
        #expect(Set(feed.keys) == ["id", "type", "ref", "channelId", "roleId", "template"])
        #expect(feed["id"] as? String == "a1b2c3d4")
        #expect(feed["type"] as? String == "reddit")
    }

    @Test("new feeds start like the web form's new rows")
    func newFeed() {
        let feed = RssSettings.Feed()
        #expect(feed.feedId.isEmpty)
        #expect(feed.type == .url)
        #expect(feed.ref.isEmpty)
        #expect(feed.channelId.isEmpty)
        #expect(feed.roleId.isEmpty)
        #expect(feed.template.isEmpty)
    }
}
