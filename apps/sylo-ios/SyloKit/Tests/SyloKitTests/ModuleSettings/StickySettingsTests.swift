import Foundation
import Testing
@testable import SyloKit

@Suite("Sticky settings")
struct StickySettingsTests {
    /// `GET /api/v2/guilds/:id/modules/sticky/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "stickies": [
          {"channelId": "222222222222222222", "content": "Read the rules", "embed": null,
           "lastMessageId": "555555555555555555", "repostOnBots": true, "cooldownSeconds": 30},
          {"channelId": "333333333333333333", "content": "",
           "embed": {"kind": "embed", "title": "Welcome", "description": "Be nice", "color": "#ff0000",
                     "image": "", "thumbnail": "https://example.com/t.png", "authorName": "Mods", "authorIcon": "",
                     "footerText": "Thanks", "footerIcon": "", "timestamp": false,
                     "fields": [{"name": "Rule 1", "value": "No spam", "inline": true}]},
           "lastMessageId": null, "repostOnBots": false, "cooldownSeconds": 0}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "general"}, {"id": "333333333333333333", "name": "rules"}]
    }
    """#

    @Test("the page decodes stickies, their embeds and the channels")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(StickyPage.self, from: Data(Self.pageJSON.utf8))
        #expect(StickyPage.moduleID == "sticky")
        #expect(page.settings.stickies.count == 2)
        let text = page.settings.stickies[0]
        #expect(text.channelId == "222222222222222222")
        #expect(text.content == "Read the rules")
        #expect(text.embed == nil)
        #expect(text.repostOnBots)
        #expect(text.cooldownSeconds == 30)
        let embed = try #require(page.settings.stickies[1].embed)
        #expect(embed.title == "Welcome")
        #expect(embed.description == "Be nice")
        #expect(embed.color == "#ff0000")
        #expect(embed.thumbnail == "https://example.com/t.png")
        #expect(embed.authorName == "Mods")
        #expect(embed.footerText == "Thanks")
        let field = try #require(embed.fields.first)
        #expect(field.name == "Rule 1")
        #expect(field.value == "No spam")
        #expect(field.inline)
        #expect(page.channels.map(\.name) == ["general", "rules"])
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"stickies":[{"channelId":"1","embed":{"fields":[{}]}}]}}"#.utf8)
        let page = try JSONDecoder().decode(StickyPage.self, from: json)
        let sticky = try #require(page.settings.stickies.first)
        #expect(sticky.content.isEmpty)
        #expect(!sticky.repostOnBots)
        #expect(sticky.cooldownSeconds == 0)
        let embed = try #require(sticky.embed)
        #expect(embed.title.isEmpty)
        #expect(embed.color.isEmpty)
        #expect(embed.fields.first?.name.isEmpty == true)
        #expect(embed.fields.first?.inline == false)
        #expect(page.channels.isEmpty)
        let empty = try JSONDecoder().decode(StickyPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.stickies.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, never the posted message's id")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(StickyPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["stickies"])
        let rows = try #require(body["stickies"] as? [[String: Any]])
        #expect(rows.count == 2)
        #expect(Set(rows[0].keys) == ["channelId", "content", "embed", "repostOnBots", "cooldownSeconds"])
        #expect(rows[0]["embed"] is NSNull)
        let embed = try #require(rows[1]["embed"] as? [String: Any])
        #expect(Set(embed.keys) == ["kind", "color", "title", "image", "authorName", "authorIcon", "description",
                                    "thumbnail", "footerText", "footerIcon", "fields"])
        #expect(embed["kind"] as? String == "embed")
        let field = try #require((embed["fields"] as? [[String: Any]])?.first)
        #expect(Set(field.keys) == ["name", "value", "inline"])
    }

    @Test("new stickies, embeds and fields start like the web form's")
    func newRows() {
        let sticky = StickySettings.Sticky()
        #expect(sticky.channelId.isEmpty)
        #expect(sticky.content.isEmpty)
        #expect(sticky.embed == nil)
        #expect(!sticky.repostOnBots)
        #expect(sticky.cooldownSeconds == 0)
        let embed = StickyEmbed()
        #expect(embed.title.isEmpty)
        #expect(embed.color == "#5865f2")
        #expect(embed.fields.isEmpty)
        let field = StickyEmbed.Field()
        #expect(field.name.isEmpty)
        #expect(!field.inline)
    }

    @Test("the embed colour converts between hex and RGB, an empty one reading as the default")
    func colour() {
        var embed = StickyEmbed(color: "")
        #expect(embed.rgb == StickyEmbed(color: "#5865f2").rgb)
        embed.setRGB(red: 1, green: 0, blue: 0.5)
        #expect(embed.color == "#ff0080")
    }
}
