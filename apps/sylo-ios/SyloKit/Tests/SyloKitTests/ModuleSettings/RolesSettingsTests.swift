import Foundation
import Testing
@testable import SyloKit

@Suite("Reaction roles and autoroles")
struct RolesSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/roles/list`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "reactionMessages": [
        {"id": "1794000000001", "channelId": "222222222222222222", "messageId": "555555555555555555",
         "style": "buttons", "message": "Pick your roles!",
         "embed": {"kind": "embed", "title": "Roles", "description": "Choose", "color": "#5865f2", "image": "",
                   "authorName": "", "authorIcon": "", "thumbnail": "", "footerText": "", "footerIcon": "",
                   "fields": []},
         "exclusive": true, "mode": "reverse", "placeholder": "", "selMin": 0, "selMax": 0,
         "pairs": [
           {"key": "1", "display": "<:gamer:111111111111111111>", "react": "gamer:111111111111111111",
            "roleId": "333333333333333333", "label": "Gamer", "btnStyle": "primary"},
           {"key": "🎨", "display": "🎨", "react": "🎨", "roleId": "444444444444444444", "label": "", "btnStyle": "secondary"}
         ]},
        {"id": "1794000000002", "channelId": "222222222222222222", "messageId": "",
         "style": "select", "message": "", "embed": {}, "exclusive": false, "mode": "default",
         "placeholder": "Pick one", "selMin": 1, "selMax": 2, "pairs": []}
      ],
      "autoroles": ["333333333333333333"],
      "channels": [{"id": "222222222222222222", "name": "roles"}],
      "roles": [{"id": "333333333333333333", "name": "Gamer"}, {"id": "444444444444444444", "name": "Artist"}]
    }
    """#

    private func keys(_ value: some Encodable) throws -> Set<String> {
        let data = try JSONEncoder().encode(value)
        return Set(try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any]).keys)
    }

    private func bodyKeys(_ body: (any Encodable & Sendable)?) throws -> Set<String> {
        let body = try #require(body)
        let data = try JSONEncoder().encode(body)
        return Set(try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any]).keys)
    }

    private func object(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Emoji

    @Test("A custom emoji reads as <:name:id>, an animated one as <a:name:id>")
    func customEmoji() {
        #expect(EmojiToken.parse("<:gamer:111111111111111111>") == .custom(name: "gamer", id: "111111111111111111", animated: false))
        #expect(EmojiToken.parse(" <a:party:222> ") == .custom(name: "party", id: "222", animated: true))
        #expect(EmojiToken.customText(name: "gamer", id: "1") == "<:gamer:1>")
        #expect(EmojiToken.customText(name: "party", id: "2", animated: true) == "<a:party:2>")
    }

    @Test("Anything else is a unicode emoji, a :shortcode: is looked up, empty is nothing")
    func unicodeAndShortcodes() {
        #expect(EmojiToken.parse("🎮") == .unicode("🎮"))
        #expect(EmojiToken.parse("👍🏽") == .unicode("👍🏽"))
        #expect(EmojiToken.parse(":gamer:") == .shortcode("gamer"))
        #expect(EmojiToken.parse("   ") == .empty)
        // Not a well-formed custom emoji: the server would call it a unicode emoji too.
        #expect(EmojiToken.parse("<:bad name:1>") == .unicode("<:bad name:1>"))
        #expect(EmojiToken.parse("<:x:abc>") == .unicode("<:x:abc>"))
    }

    @Test("A shortcode is usable only when the server has that emoji, and becomes its <:name:id> text")
    func shortcodeResolution() {
        let custom = [GuildEmoji(name: "gamer", display: "<:gamer:111>")]
        #expect(EmojiToken.parse(":gamer:").isUsable(among: custom))
        #expect(!EmojiToken.parse(":other:").isUsable(among: custom))
        #expect(EmojiToken.parse("🎮").isUsable(among: []))
        #expect(!EmojiToken.parse("").isUsable(among: custom))
        #expect(EmojiToken.parse(":gamer:").resolvedText(among: custom) == "<:gamer:111>")
        #expect(EmojiToken.parse(":other:").resolvedText(among: custom) == nil)
        #expect(EmojiToken.parse("🎮").resolvedText(among: custom) == "🎮")
    }

    @Test("The emoji list reads {custom: [...]} and drops an entry that has no text")
    func emojiList() throws {
        let json = #"""
        {"custom": [{"name": "gamer", "display": "<:gamer:111>", "url": "https://cdn.example.com/e/111.webp"},
                    {"name": "nothing", "display": ""}, 5]}
        """#
        let emojis = try JSONDecoder().decode(GuildEmojis.self, from: Data(json.utf8))
        #expect(emojis.custom.map(\.name) == ["gamer"])
        #expect(emojis.custom[0].url == "https://cdn.example.com/e/111.webp")
        #expect(try JSONDecoder().decode(GuildEmojis.self, from: Data("{}".utf8)).custom.isEmpty)
    }

    // MARK: - Decoding

    @Test("The page decodes the sets, the autoroles, the channels and the roles")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(Self.pageJSON.utf8))
        #expect(page.reactionMessages.count == 2)
        #expect(page.autoroles == ["333333333333333333"])
        #expect(page.channels.map(\.name) == ["roles"])
        #expect(page.roles.map(\.name) == ["Gamer", "Artist"])

        let buttons = page.reactionMessages[0]
        #expect(buttons.id == "1794000000001")
        #expect(buttons.isPublished)
        #expect(buttons.style == "buttons")
        #expect(buttons.message == "Pick your roles!")
        #expect(buttons.embed.draft.title == "Roles")
        #expect(buttons.exclusive)
        #expect(buttons.mode == "reverse")
        #expect(buttons.pairs.count == 2)
        #expect(buttons.pairs[0].emoji == "<:gamer:111111111111111111>")
        #expect(buttons.pairs[0].label == "Gamer")
        #expect(buttons.pairs[0].roleId == "333333333333333333")
        #expect(buttons.pairs[0].buttonStyle == "primary")
        #expect(buttons.pairs[1].emoji == "🎨")

        let menu = page.reactionMessages[1]
        #expect(!menu.isPublished)
        #expect(menu.style == "select")
        #expect(menu.placeholder == "Pick one")
        #expect(menu.selMin == 1)
        #expect(menu.selMax == 2)
        #expect(!menu.hasMode)
        #expect(menu.pairs.isEmpty)
        #expect(menu.rowsOrBlank.count == 1)
    }

    @Test("A server that sends less, or other types, still loads")
    func lenientDecoding() throws {
        let json = #"""
        {"reactionMessages": [{"id": 17, "channelId": "1", "style": "future", "mode": 3, "selMin": 2.0,
                               "embed": null, "pairs": [{"roleId": "9"}, "junk"], "newKey": true}, "junk"]}
        """#
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(json.utf8))
        #expect(page.autoroles.isEmpty)
        #expect(page.channels.isEmpty)
        let set = try #require(page.reactionMessages.first)
        #expect(page.reactionMessages.count == 1)
        #expect(set.id == "17")
        #expect(set.style == "future")
        #expect(set.mode == "default")
        #expect(set.selMin == 2)
        #expect(set.messageId.isEmpty)
        #expect(set.pairs.count == 1)
        #expect(set.pairs[0].roleId == "9")
        #expect(set.pairs[0].buttonStyle == "secondary")
    }

    // MARK: - Encoding

    @Test("The save body has exactly the keys the dashboard sends, and never the posted message's id")
    func saveKeys() throws {
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(Self.pageJSON.utf8))
        let body = try object(page.reactionMessages[0])
        #expect(Set(body.keys) == [
            "id", "channelId", "style", "message", "embed", "exclusive", "mode", "placeholder", "selMin", "selMax",
            "pairs",
        ])
        #expect(body["id"] as? String == "1794000000001")
        #expect(body["style"] as? String == "buttons")
        #expect(body["mode"] as? String == "reverse")
        let pairs = try #require(body["pairs"] as? [[String: Any]])
        #expect(pairs.count == 2)
        for pair in pairs { #expect(Set(pair.keys) == ["emoji", "label", "roleId", "btnStyle"]) }
        #expect(pairs[0]["emoji"] as? String == "<:gamer:111111111111111111>")
        #expect(pairs[0]["btnStyle"] as? String == "primary")
        let embed = try #require(body["embed"] as? [String: Any])
        #expect(embed["title"] as? String == "Roles")
        #expect(embed["kind"] as? String == "embed")
    }

    @Test("An untouched embed goes out as {} so the server's own look stays; a coloured one does not")
    func plainEmbed() throws {
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(Self.pageJSON.utf8))
        var menu = page.reactionMessages[1]
        let untouched = try #require(try object(menu)["embed"] as? [String: Any])
        #expect(untouched.isEmpty)
        menu.embed.draft.color = "#ff0000"
        let coloured = try #require(try object(menu)["embed"] as? [String: Any])
        #expect(coloured["color"] as? String == "#ff0000")
        menu.embed.draft.color = ""
        menu.embed.draft.description = "Text"
        let described = try #require(try object(menu)["embed"] as? [String: Any])
        #expect(described["description"] as? String == "Text")
    }

    @Test("An embed the editor cannot read is sent back as it was, and unknown embed keys survive")
    func embedKept() throws {
        let json = #"""
        {"reactionMessages": [
          {"id": "1", "channelId": "1", "embed": {"title": 5, "weird": true}},
          {"id": "2", "channelId": "1", "embed": {"title": "T", "titleUrl": "https://e.com", "timestamp": true}}]}
        """#
        let page = try JSONDecoder().decode(RolesPage.self, from: Data(json.utf8))
        let opaque = try object(page.reactionMessages[0])
        #expect(page.reactionMessages[0].embed.isOpaque)
        #expect(opaque["embed"] as? [String: Any] != nil)
        #expect((opaque["embed"] as? [String: Any])?["weird"] as? Bool == true)
        let known = try object(page.reactionMessages[1])
        let embed = try #require(known["embed"] as? [String: Any])
        #expect(embed["titleUrl"] as? String == "https://e.com")
        #expect(embed["timestamp"] as? Bool == true)
    }

    // MARK: - The checks of the server

    @Test("The rows are checked in the dashboard's words")
    func problems() {
        let custom = [GuildEmoji(name: "gamer", display: "<:gamer:111>")]
        var set = ReactionRoleMessage(channelId: "1", style: "reaction", pairs: [
            ReactionRolePair(emoji: "🎮", roleId: "5"),
            ReactionRolePair(emoji: "", roleId: "6"),
            ReactionRolePair(emoji: "🎨", roleId: ""),
            ReactionRolePair(),
        ])
        #expect(set.problems(customEmojis: custom) == [
            "Row 2: enter a valid emoji (required for the Reactions style).",
            "Row 3: select a role.",
        ])
        // Buttons and menus need no emoji.
        set.style = "buttons"
        #expect(set.problems(customEmojis: custom) == ["Row 3: select a role."])
        set.pairs.remove(at: 2)
        #expect(set.problems(customEmojis: custom).isEmpty)
    }

    @Test("A set needs a channel and at least one role; a blank form says so")
    func emptySet() {
        let set = ReactionRoleMessage()
        #expect(set.problems() == ["Pick a channel.", "Add at least one role."])
        #expect(ReactionRoleMessage(channelId: "1", pairs: [ReactionRolePair(emoji: "🎮", roleId: "5")]).problems().isEmpty)
    }

    @Test("A :shortcode: in a reaction row counts only when the server has that emoji")
    func shortcodeRow() {
        let set = ReactionRoleMessage(channelId: "1", pairs: [ReactionRolePair(emoji: ":gamer:", roleId: "5")])
        #expect(set.problems(customEmojis: []).count == 1)
        let custom = [GuildEmoji(name: "gamer", display: "<:gamer:111>")]
        #expect(set.problems(customEmojis: custom).isEmpty)
        #expect(set.resolvingShortcodes(among: custom).pairs[0].emoji == "<:gamer:111>")
        #expect(set.resolvingShortcodes(among: []).pairs[0].emoji == ":gamer:")
    }

    @Test("Too many rows are refused, and the cap depends on the style")
    func rowLimits() {
        #expect(ReactionRoleMessage.maxRows(style: "reaction", pairsLimit: nil) == 20)
        #expect(ReactionRoleMessage.maxRows(style: "buttons", pairsLimit: nil) == 25)
        #expect(ReactionRoleMessage.maxRows(style: "select", pairsLimit: 10) == 10)
        let rows = (0..<3).map { _ in ReactionRolePair(emoji: "🎮", roleId: "5") }
        let set = ReactionRoleMessage(channelId: "1", pairs: rows)
        #expect(set.problems(pairsLimit: 2).contains("Use at most 2 roles per message."))
    }

    // MARK: - Endpoints

    @Test("Endpoint paths and methods")
    func endpoints() throws {
        let list = Endpoints.LoadRoles(server: "9")
        #expect(list.path == "/api/v2/guilds/9/modules/roles/list")
        #expect(list.method == .get)

        let autoroles = Endpoints.SaveAutoroles(server: "9", autoroles: ["1", "2"])
        #expect(autoroles.path == "/api/v2/guilds/9/modules/roles/autoroles")
        #expect(autoroles.method == .post)
        #expect(try bodyKeys(autoroles.body) == ["autoroles"])

        let save = Endpoints.SaveReactionRole(server: "9", message: ReactionRoleMessage())
        #expect(save.path == "/api/v2/guilds/9/modules/roles/rr")
        #expect(save.method == .post)

        let delete = Endpoints.DeleteReactionRole(server: "9", id: "1794000000001")
        #expect(delete.path == "/api/v2/guilds/9/modules/roles/rr/1794000000001/delete")
        #expect(delete.method == .post)

        let emojis = Endpoints.LoadGuildEmojis(server: "9")
        #expect(emojis.path == "/api/v2/guilds/9/emojis")
    }

    @Test("The save answer carries the set and a post error; a blank error is none")
    func saveAnswer() throws {
        let posted = try JSONDecoder().decode(
            ReactionRoleSaved.self,
            from: Data(#"{"reactionMessage":{"id":"5","channelId":"1","messageId":"9"},"error":null}"#.utf8))
        #expect(posted.reactionMessage?.isPublished == true)
        #expect(posted.error == nil)
        let failed = try JSONDecoder().decode(
            ReactionRoleSaved.self,
            from: Data(#"{"reactionMessage":{"id":"5","channelId":"1","messageId":""},"error":" Missing Permissions "}"#.utf8))
        #expect(failed.reactionMessage?.isPublished == false)
        #expect(failed.error == "Missing Permissions")
        let blank = try JSONDecoder().decode(ReactionRoleSaved.self, from: Data(#"{"error":""}"#.utf8))
        #expect(blank.error == nil)
    }
}
