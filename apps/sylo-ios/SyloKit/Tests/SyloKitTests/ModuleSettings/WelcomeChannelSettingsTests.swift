import Foundation
import Testing
@testable import SyloKit

@Suite("WelcomeChannel settings")
struct WelcomeChannelSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/welcome-channel/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "channelId": "111111111111111111",
        "messageId": "222222222222222222",
        "spec": {
          "content": "Welcome to {server}!",
          "embeds": [
            {"kind": "embed", "title": "Rules", "description": "Be nice.", "color": "#ff0000",
             "image": "", "thumbnail": "https://example.com/t.png", "authorName": "Staff",
             "authorIcon": "", "footerText": "Thanks", "footerIcon": "", "timestamp": true,
             "fields": [{"name": "1", "value": "No spam", "inline": true}]},
            {"kind": "banner", "title": "", "description": "Hi", "color": "", "image": "https://example.com/b.png",
             "thumbnail": "", "authorName": "", "authorIcon": "", "footerText": "", "footerIcon": "",
             "timestamp": false, "fields": []}
          ]
        }
      },
      "channels": [{"id": "111111111111111111", "name": "welcome"}],
      "presets": [
        {"id": "welcome-embed", "label": "Welcome embed", "kind": "embed",
         "defaults": {"kind": "embed", "color": "#5865f2", "title": "Welcome to {server}!", "description": "Hello"}},
        {"id": "welcome-banner", "label": "Welcome banner", "kind": "banner",
         "defaults": {"kind": "banner", "image": ""}}
      ]
    }
    """#

    @Test("the page decodes the channel, the message, its elements and the presets")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(Self.pageJSON.utf8))
        #expect(WelcomeChannelPage.moduleID == "welcome-channel")
        let s = page.settings
        #expect(s.channelId == "111111111111111111")
        #expect(s.messageId == "222222222222222222")
        #expect(s.isPublished)
        #expect(s.content == "Welcome to {server}!")
        #expect(s.embeds.count == 2)
        let embed = try #require(s.embeds.first)
        #expect(embed.kind == .embed)
        #expect(embed.title == "Rules")
        #expect(embed.color == "#ff0000")
        #expect(embed.thumbnail == "https://example.com/t.png")
        #expect(embed.authorName == "Staff")
        #expect(embed.footerText == "Thanks")
        let field = try #require(embed.fields.first)
        #expect(field.name == "1")
        #expect(field.value == "No spam")
        #expect(field.inline)
        let banner = s.embeds[1]
        #expect(banner.kind == .banner)
        #expect(banner.image == "https://example.com/b.png")
        // No colour stored: the web form shows (and saves) Discord's blurple.
        #expect(banner.color == WelcomeChannelSettings.Embed.defaultColor)
        #expect(page.channels.map(\.name) == ["welcome"])
        #expect(page.presets.map(\.id) == ["welcome-embed", "welcome-banner"])
        #expect(page.presets.first?.label == "Welcome embed")
    }

    @Test("missing fields and an unknown kind fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"spec":{"embeds":[{"kind":"poster","color":"red"}]}}}"#.utf8)
        let page = try JSONDecoder().decode(WelcomeChannelPage.self, from: json)
        let s = page.settings
        #expect(s.channelId.isEmpty)
        #expect(s.messageId.isEmpty)
        #expect(!s.isPublished)
        #expect(s.content.isEmpty)
        let embed = try #require(s.embeds.first)
        #expect(embed.kind == .embed)
        #expect(embed.color == "#5865f2")
        #expect(embed.title.isEmpty)
        #expect(embed.fields.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.presets.isEmpty)

        let empty = try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.embeds.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, never the published message id")
    func encodesBody() throws {
        var settings = try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(Self.pageJSON.utf8)).settings
        // An empty field row is left out, as the web form does.
        settings.embeds[0].fields.append(WelcomeChannelSettings.Field())
        let data = try JSONEncoder().encode(settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["channelId", "spec"])
        let spec = try #require(body["spec"] as? [String: Any])
        #expect(Set(spec.keys) == ["content", "embeds"])
        let embed = try #require((spec["embeds"] as? [[String: Any]])?.first)
        #expect(Set(embed.keys) == [
            "kind", "color", "authorName", "authorIcon", "title", "description", "image", "thumbnail",
            "footerText", "footerIcon", "fields",
        ])
        let fields = try #require(embed["fields"] as? [[String: Any]])
        #expect(fields.count == 1)
        #expect(Set(fields[0].keys) == ["name", "value", "inline"])
    }

    @Test("new elements and fields start like the web form's new ones")
    func newRows() throws {
        let page = try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(Self.pageJSON.utf8))
        let preset = try #require(page.presets.first)
        let embed = preset.makeEmbed()
        #expect(embed.kind == .embed)
        #expect(embed.title == "Welcome to {server}!")
        #expect(embed.description == "Hello")
        #expect(embed.color == "#5865f2")
        #expect(embed.image.isEmpty)
        #expect(embed.fields.isEmpty)
        #expect(preset.makeEmbed().id != embed.id)
        let banner = try #require(page.presets.last).makeEmbed()
        #expect(banner.kind == .banner)
        #expect(banner.color == "#5865f2")
        let field = WelcomeChannelSettings.Field()
        #expect(field.name.isEmpty)
        #expect(field.value.isEmpty)
        #expect(!field.inline)
    }
}
