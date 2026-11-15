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
        // A new embed sends Discord's blurple until a colour is picked, like the web form.
        let embed = EmbedDraft()
        #expect(embed.title.isEmpty)
        #expect(embed.color.isEmpty)
        #expect(embed.resolvedColor() == "#5865f2")
        #expect(embed.fields.isEmpty)
        let field = EmbedDraft.Field()
        #expect(field.name.isEmpty)
        #expect(!field.inline)
    }

    @Test("opening a sticky and saving it changes nothing, and the embed keeps keys the editor does not know")
    func roundTrip() throws {
        let json = #"""
        {"config":{"stickies":[{"channelId":"1","content":"x","repostOnBots":false,"cooldownSeconds":0,
         "embed":{"kind":"embed","color":"","title":"T","futureKey":{"a":[1,2]},"fields":[]}}]}}
        """#
        let page = try JSONDecoder().decode(StickyPage.self, from: Data(json.utf8))
        let embed = try #require(page.settings.stickies.first?.embed)
        // A stored "default colour" stays empty in the editor's state, so nothing looks edited.
        #expect(embed.color.isEmpty)
        #expect(embed.extra["futureKey"] != nil)

        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let sent = try #require(((body["stickies"] as? [[String: Any]])?.first?["embed"]) as? [String: Any])
        #expect(sent["futureKey"] != nil)
        // What goes out is the colour the embed shows.
        #expect(sent["color"] as? String == "#5865f2")
        let again = try JSONDecoder().decode(StickySettings.self, from: data)
        #expect(again.stickies.first?.embed?.title == "T")
    }

    @Test("a sticky without an embed sends null, and one with an embed edited in the shared editor sends it")
    func nullAndEmbed() throws {
        var sticky = StickySettings.Sticky(channelId: "1", content: "x")
        var object = try #require(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(sticky)) as? [String: Any])
        #expect(object["embed"] is NSNull)
        sticky.embed = EmbedDraft(title: "Hi")
        object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(sticky)) as? [String: Any])
        #expect((object["embed"] as? [String: Any])?["title"] as? String == "Hi")
    }
}
