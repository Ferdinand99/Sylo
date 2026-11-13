import Foundation
import Testing
@testable import SyloKit

@Suite("Embed items")
struct EmbedItemTests {
    private func items(_ titles: [String]) -> [EmbedItem] {
        titles.map { EmbedItem(EmbedDraft(title: $0)) }
    }

    @Test("moving an embed up or down swaps it with its neighbour and stops at the ends")
    func reorder() {
        var list = items(["a", "b", "c"])
        list.moveEmbed(at: 1, by: -1)
        #expect(list.map(\.draft.title) == ["b", "a", "c"])
        list.moveEmbed(at: 1, by: 1)
        #expect(list.map(\.draft.title) == ["b", "c", "a"])
        // At an end, nothing moves.
        list.moveEmbed(at: 0, by: -1)
        list.moveEmbed(at: 2, by: 1)
        list.moveEmbed(at: 7, by: -1)
        #expect(list.map(\.draft.title) == ["b", "c", "a"])
    }

    @Test("moving keeps each embed's identity")
    func reorderKeepsIDs() {
        var list = items(["a", "b"])
        let ids = list.map(\.id)
        list.moveEmbed(at: 0, by: 1)
        #expect(list.map(\.id) == [ids[1], ids[0]])
    }

    @Test("a copy goes right after the original, with its own ids, until the list is full")
    func duplicates() {
        var list = [
            EmbedItem(EmbedDraft(title: "a", fields: [EmbedDraft.Field(name: "n", value: "v")])),
            EmbedItem(EmbedDraft(title: "b")),
        ]
        let added = list.duplicateEmbed(at: 0, limit: 3)
        #expect(added)
        #expect(list.map(\.draft.title) == ["a", "a", "b"])
        #expect(list[0].id != list[1].id)
        #expect(list[0].draft.fields[0].id != list[1].draft.fields[0].id)
        #expect(list[0] == list[1])
        // Full: nothing is added. A bad index adds nothing either.
        let addedWhenFull = list.duplicateEmbed(at: 0, limit: 3)
        let addedAtBadIndex = list.duplicateEmbed(at: 9, limit: 10)
        #expect(!addedWhenFull)
        #expect(!addedAtBadIndex)
        #expect(list.count == 3)
    }

    @Test("an embed is a banner when its kind says so, and setting it writes the kind back")
    func banner() throws {
        var item = try JSONDecoder().decode(EmbedItem.self, from: Data(#"{"kind":"banner","image":"https://e.com/b.png"}"#.utf8))
        #expect(item.isBanner)
        #expect(!EmbedItem().isBanner)
        item.isBanner = false
        #expect(item.draft.kind == "embed")
    }

    private func object(_ item: EmbedItem) throws -> [String: Any] {
        let data = try JSONEncoder().encode(item)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("an embed list encodes the web editor's keys, keeping what it does not know")
    func encodes() throws {
        let item = try JSONDecoder().decode(EmbedItem.self, from: Data(#"{"title":"T","future":{"x":1}}"#.utf8))
        let sent = try object(item)
        #expect(sent["future"] != nil)
        #expect(sent["kind"] as? String == "embed")
        // No time stored: no key.
        #expect(sent["timestamp"] == nil)
        #expect(Set(sent.keys).isSuperset(of: ["kind", "color", "title", "image", "fields"]))
    }

    @Test("a stored timestamp goes back on save, and an embed without one gets no key")
    func keepsTimestamp() throws {
        let on = try JSONDecoder().decode(EmbedItem.self, from: Data(#"{"title":"T","timestamp":true}"#.utf8))
        #expect(on.draft.timestamp)
        #expect(try object(on)["timestamp"] as? Bool == true)

        let off = try JSONDecoder().decode(EmbedItem.self, from: Data(#"{"title":"T","timestamp":false}"#.utf8))
        #expect(try object(off)["timestamp"] == nil)

        // Switching it on in the editor sends it, and a copy keeps it.
        var edited = off
        edited.draft.timestamp = true
        #expect(try object(edited)["timestamp"] as? Bool == true)
        #expect(edited.duplicated().draft.timestamp)
        #expect(EmbedItem.options.timestamp)
    }

    @Test("an embed with values of the wrong type is kept as it came, shown as unsupported and sent back unchanged")
    func opaqueEmbeds() throws {
        let stored = [
            #"{"title":123,"color":5793266,"futureKey":[1,2]}"#,
            #"{"title":"T","timestamp":1}"#,
            #"{"title":"T","fields":"nope"}"#,
            #"{"title":"T","fields":[{"name":"a","value":"b"},{"name":7,"value":"x"}]}"#,
            #""just a string""#,
            #"[1,2]"#,
        ]
        for json in stored {
            let item = try JSONDecoder().decode(EmbedItem.self, from: Data(json.utf8))
            #expect(item.isOpaque, "\(json)")
            #expect(!item.isBanner)
            let back = try JSONEncoder().encode(item)
            let original = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
            #expect(try JSONDecoder().decode(JSONValue.self, from: back) == original, "\(json)")
        }
    }

    @Test("a readable embed is not opaque, and a copy of an opaque one stays as it came")
    func readableAndCopies() throws {
        let readable = try JSONDecoder().decode(
            EmbedItem.self, from: Data(##"{"title":"T","fields":[{"name":"a","value":"b"}],"color":"#ff0000"}"##.utf8))
        #expect(!readable.isOpaque)
        #expect(readable.raw == nil)
        let odd = try JSONDecoder().decode(EmbedItem.self, from: Data(#"{"title":5}"#.utf8))
        let copy = odd.duplicated()
        #expect(copy.isOpaque)
        #expect(copy.id != odd.id)
        #expect(copy == odd)
        var list = [odd]
        let added = list.duplicateEmbed(at: 0, limit: 10)
        #expect(added)
        #expect(list.count == 2)
    }

    @Test("an embed with odd values in a message is kept, in place, when the message is saved")
    func opaqueInMessage() throws {
        let json = #"""
        {"content":"c","rows":[],"embeds":[
          {"title":"Fine"},{"title":99,"color":123},{"title":"Also fine"}]}
        """#
        var spec = try JSONDecoder().decode(ComposedMessageSpec.self, from: Data(json.utf8))
        #expect(spec.embeds.map(\.isOpaque) == [false, true, false])
        spec.content = "edited"
        let data = try JSONEncoder().encode(spec)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let embeds = try #require(object["embeds"] as? [[String: Any]])
        #expect(embeds.count == 3)
        #expect(embeds[0]["title"] as? String == "Fine")
        #expect(embeds[1]["title"] as? Int == 99)
        #expect(embeds[1]["color"] as? Int == 123)
        #expect(Set(embeds[1].keys) == ["title", "color"])
        #expect(embeds[2]["title"] as? String == "Also fine")
    }
}

@Suite("Composed messages")
struct ComposedMessagesTests {
    /// `GET /guilds/:id/messages/:id`, shaped like the server sends it, with a role-button row, a role
    /// menu, an unknown row and a row of link buttons.
    static let detailJSON = #"""
    {
      "isNew": false,
      "rec": {
        "id": 3, "name": "Rules", "channelId": "111111111111111111", "messageId": "222222222222222222",
        "spec": {
          "content": "Read the rules.",
          "embeds": [
            {"kind": "embed", "color": "#5865f2", "title": "Rules", "description": "Be kind.", "image": "",
             "thumbnail": "", "authorName": "", "authorIcon": "", "footerText": "", "footerIcon": "",
             "fields": [{"name": "1", "value": "No spam", "inline": false}]}
          ],
          "rows": [
            {"type": "buttons", "buttons": [{"style": "primary", "label": "Member", "roleId": "333333333333333333"}]},
            {"type": "roleselect", "placeholder": "Pick", "options": [{"label": "A", "roleId": "444444444444444444"}]},
            {"type": "poll", "answers": [1, 2, 3]},
            {"type": "buttons", "buttons": [
              {"style": "link", "label": "Website", "emoji": "🌐", "url": "https://example.com"},
              {"style": "link", "label": "Docs", "url": "https://example.com/docs"}]}
          ]
        }
      },
      "channels": [{"id": "111111111111111111", "name": "rules"}],
      "roles": [{"id": "333333333333333333", "name": "Member"}]
    }
    """#

    static func detail() throws -> ComposedMessageDetail {
        try JSONDecoder().decode(ComposedMessageDetail.self, from: Data(detailJSON.utf8))
    }

    private static func sent(_ spec: ComposedMessageSpec) throws -> [String: Any] {
        let data = try JSONEncoder().encode(spec)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("the list decodes a row and drops one without an id")
    func decodesList() throws {
        let json = #"""
        {"items":[{"id":3,"name":"Rules","channel":"rules","published":true,"when":"5m ago"},
                  {"name":"broken"},
                  {"id":4,"name":"Draft","channel":"111111111111111111","published":false,"when":"2d ago"}]}
        """#
        let list = try JSONDecoder().decode(ComposedMessageList.self, from: Data(json.utf8))
        #expect(list.items.map(\.id) == [3, 4])
        #expect(list.items[0].published)
        #expect(list.items[0].channel == "rules")
        #expect(list.items[0].when == "5m ago")
        #expect(!list.items[1].published)
    }

    @Test("the detail decodes the message, its embeds and the channels")
    func decodesDetail() throws {
        let detail = try Self.detail()
        let message = detail.message
        #expect(message.id == 3)
        #expect(message.name == "Rules")
        #expect(message.channelId == "111111111111111111")
        #expect(message.messageId == "222222222222222222")
        #expect(message.isPublished)
        #expect(message.spec.content == "Read the rules.")
        #expect(message.spec.embeds.count == 1)
        #expect(message.spec.embeds[0].draft.title == "Rules")
        #expect(message.spec.embeds[0].draft.fields.count == 1)
        #expect(detail.channels.map(\.name) == ["rules"])
    }

    @Test("a new message comes with an empty id and no posted message")
    func decodesNew() throws {
        let json = #"""
        {"isNew":true,"rec":{"id":"","name":"","channelId":"","messageId":null,"spec":{"content":"","embeds":[],"rows":[]}},
         "channels":[{"id":"1","name":"general"}],"roles":[]}
        """#
        let detail = try JSONDecoder().decode(ComposedMessageDetail.self, from: Data(json.utf8))
        #expect(detail.message.id == nil)
        #expect(!detail.message.isPublished)
        #expect(detail.message.messageId == nil)
        #expect(detail.message.spec == ComposedMessageSpec())
        #expect(detail.channels.count == 1)
    }

    @Test("link buttons become editable and every other row is kept, in its place")
    func splitsRows() throws {
        let spec = try Self.detail().message.spec
        #expect(spec.links.map(\.label) == ["Website", "Docs"])
        #expect(spec.links[0].emoji == "🌐")
        #expect(spec.links[1].emoji.isEmpty)
        #expect(spec.links[1].url == "https://example.com/docs")
        #expect(spec.hasKeptRows)
        #expect(spec.canAddLink)
    }

    @Test("saving keeps role buttons, menus and rows of an unknown type untouched, and puts the link row last")
    func keepsUnknownRows() throws {
        var spec = try Self.detail().message.spec
        spec.content = "Changed"
        spec.links[0].label = "Site"
        let object = try Self.sent(spec)
        #expect(Set(object.keys) == ["content", "embeds", "rows"])
        #expect(object["content"] as? String == "Changed")

        let rows = try #require(object["rows"] as? [[String: Any]])
        #expect(rows.count == 4)
        // The three kept rows, as they were.
        #expect(rows[0]["type"] as? String == "buttons")
        let roleButton = try #require((rows[0]["buttons"] as? [[String: Any]])?.first)
        #expect(roleButton["style"] as? String == "primary")
        #expect(roleButton["roleId"] as? String == "333333333333333333")
        #expect(rows[1]["type"] as? String == "roleselect")
        #expect(rows[1]["placeholder"] as? String == "Pick")
        #expect(rows[2]["type"] as? String == "poll")
        #expect(rows[2]["answers"] as? [Int] == [1, 2, 3])
        // The link row comes from the editable buttons, written like the web page writes them.
        #expect(rows[3]["type"] as? String == "buttons")
        let links = try #require(rows[3]["buttons"] as? [[String: Any]])
        #expect(links.count == 2)
        #expect(Set(links[0].keys) == ["style", "label", "emoji", "url"])
        #expect(links[0]["style"] as? String == "link")
        #expect(links[0]["label"] as? String == "Site")
        #expect(links[0]["emoji"] as? String == "🌐")
    }

    @Test("a row that mixes link buttons with role buttons stays whole and is not copied into the link buttons")
    func mixedRow() throws {
        let json = #"""
        {"content":"","embeds":[],"rows":[{"type":"buttons","buttons":[
          {"style":"link","label":"Site","url":"https://example.com"},
          {"style":"success","label":"Role","roleId":"333333333333333333"}]}]}
        """#
        var spec = try JSONDecoder().decode(ComposedMessageSpec.self, from: Data(json.utf8))
        #expect(spec.links.isEmpty)
        #expect(spec.hasKeptRows)
        // Saving twice does not multiply it.
        var object = try Self.sent(spec)
        var rows = try #require(object["rows"] as? [[String: Any]])
        #expect(rows.count == 1)
        #expect((rows[0]["buttons"] as? [[String: Any]])?.count == 2)
        spec = try JSONDecoder().decode(ComposedMessageSpec.self, from: JSONEncoder().encode(spec))
        object = try Self.sent(spec)
        rows = try #require(object["rows"] as? [[String: Any]])
        #expect(rows.count == 1)
    }

    @Test("without link buttons no link row is sent, and an incomplete button is left out")
    func linkRow() throws {
        var spec = ComposedMessageSpec(content: "x")
        #expect(try (Self.sent(spec)["rows"] as? [Any])?.isEmpty == true)
        spec.links = [
            ComposedLinkButton(label: "No link", url: ""),
            ComposedLinkButton(label: "", emoji: "", url: "https://example.com"),
            ComposedLinkButton(label: "  Site  ", emoji: "", url: " https://example.com "),
        ]
        let rows = try #require(try Self.sent(spec)["rows"] as? [[String: Any]])
        #expect(rows.count == 1)
        let buttons = try #require(rows[0]["buttons"] as? [[String: Any]])
        #expect(buttons.count == 1)
        // Trimmed, as the web page does.
        #expect(buttons[0]["label"] as? String == "Site")
        #expect(buttons[0]["url"] as? String == "https://example.com")
        #expect(spec.hasLinks)
    }

    @Test("a message holds up to ten embeds, five link buttons and five rows in all")
    func limits() {
        var spec = ComposedMessageSpec()
        for _ in 0..<ComposedMessageSpec.maxEmbeds { spec.embeds.append(EmbedItem()) }
        #expect(!spec.canAddEmbed)
        spec.embeds.removeLast()
        #expect(spec.canAddEmbed)

        spec.links = (0..<ComposedMessageSpec.maxLinks).map { ComposedLinkButton(label: "\($0)", url: "https://e.com/\($0)") }
        #expect(!spec.canAddLink)

        // Five rows from elsewhere leave no room for a link row.
        let full = ComposedMessageSpec(keptRows: Array(repeating: .object(["type": .string("poll")]), count: 5))
        #expect(full.linkRowHasNoRoom)
        #expect(!full.canAddLink)
        #expect(!ComposedMessageSpec(keptRows: [.object(["type": .string("poll")])]).linkRowHasNoRoom)
    }

    @Test("embeds keep their kind and unknown keys when a message is saved")
    func embedsKeepKeys() throws {
        let json = #"""
        {"content":"","rows":[],"embeds":[{"kind":"embed","title":"T","url":"https://example.com/t","futureKey":[1]}]}
        """#
        let spec = try JSONDecoder().decode(ComposedMessageSpec.self, from: Data(json.utf8))
        let embed = try #require((try Self.sent(spec)["embeds"] as? [[String: Any]])?.first)
        #expect(embed["url"] as? String == "https://example.com/t")
        #expect(embed["futureKey"] != nil)
        #expect(embed["kind"] as? String == "embed")
        // The web message builder's keys.
        #expect(Set(embed.keys).isSuperset(of: [
            "kind", "color", "authorName", "authorIcon", "title", "description", "image", "thumbnail",
            "footerText", "footerIcon", "fields",
        ]))
    }

    @Test("a custom emoji reads as its name in the preview")
    func emojiText() {
        #expect(ComposedLinkButton(emoji: "🌐").emojiText == "🌐")
        #expect(ComposedLinkButton(emoji: "<:sylo:123456789012345678>").emojiText == ":sylo:")
        #expect(ComposedLinkButton(emoji: "<a:party:123456789012345678>").emojiText == ":party:")
        #expect(ComposedLinkButton(emoji: "  ").emojiText.isEmpty)
        #expect(ComposedLinkButton(emoji: "<broken>").emojiText == "<broken>")
    }

    @Test("the link row keeps its place, and a further link row stays a row of its own")
    func linkRowPlacement() throws {
        let json = #"""
        {"content":"","embeds":[],"rows":[
          {"type":"buttons","id":"first","buttons":[
            {"style":"link","label":"A","url":"https://a.example","disabled":true},
            {"style":"link","label":"B","url":"https://b.example"}]},
          {"type":"roleselect","placeholder":"Pick","options":[]},
          {"type":"buttons","buttons":[
            {"style":"link","label":"C","url":"https://c.example"},
            {"style":"link","label":"D","url":"https://d.example"},
            {"style":"link","label":"E","url":"https://e.example"},
            {"style":"link","label":"F","url":"https://f.example"}]}]}
        """#
        var spec = try JSONDecoder().decode(ComposedMessageSpec.self, from: Data(json.utf8))
        // Only the first link row is editable; the second one is kept whole, so it is not merged into
        // a row of more than five buttons.
        #expect(spec.links.map(\.label) == ["A", "B"])
        #expect(spec.hasKeptRows)
        #expect(spec.linkRowPosition == 0)
        spec.links[0].label = "Alpha"

        let rows = try #require(try Self.sent(spec)["rows"] as? [[String: Any]])
        #expect(rows.count == 3)
        // The link row is still first, with its unknown keys.
        #expect(rows[0]["id"] as? String == "first")
        let first = try #require(rows[0]["buttons"] as? [[String: Any]])
        #expect(first.map { $0["label"] as? String } == ["Alpha", "B"])
        #expect(first[0]["disabled"] as? Bool == true)
        #expect(rows[1]["type"] as? String == "roleselect")
        #expect((rows[2]["buttons"] as? [[String: Any]])?.count == 4)
    }

    @Test("a message without a link row gets one at the end, and one with five rows has no room")
    func newLinkRow() throws {
        var spec = ComposedMessageSpec(keptRows: [.object(["type": .string("roleselect")])])
        spec.links = [ComposedLinkButton(label: "A", url: "https://a.example")]
        let rows = try #require(try Self.sent(spec)["rows"] as? [[String: Any]])
        #expect(rows.map { $0["type"] as? String } == ["roleselect", "buttons"])

        // Adding a button to a row that exists needs no new row, so it fits even with four others.
        var withRow = ComposedMessageSpec(
            keptRows: Array(repeating: .object(["type": .string("poll")]), count: 4),
            linkRowPosition: 2)
        #expect(withRow.canAddLink)
        withRow.links = [ComposedLinkButton(label: "A", url: "https://a.example")]
        #expect(withRow.canAddLink)
        #expect(!withRow.linkRowHasNoRoom)
        let placed = try #require(try Self.sent(withRow)["rows"] as? [[String: Any]])
        #expect(placed.map { $0["type"] as? String } == ["poll", "poll", "buttons", "poll", "poll"])
    }

    @Test("a row of buttons that is empty, or holds a label that is not text, is kept as it came")
    func uneditableButtonRows() throws {
        let json = #"""
        {"content":"","embeds":[],"rows":[
          {"type":"buttons","buttons":[]},
          {"type":"buttons","buttons":[{"style":"link","label":42,"url":"https://a.example"}]}]}
        """#
        let spec = try JSONDecoder().decode(ComposedMessageSpec.self, from: Data(json.utf8))
        #expect(spec.links.isEmpty)
        let rows = try #require(try Self.sent(spec)["rows"] as? [[String: Any]])
        #expect(rows.count == 2)
        #expect((rows[1]["buttons"] as? [[String: Any]])?.first?["label"] as? Int == 42)
    }

    // MARK: Save answers

    @Test("a save answers with the stored message and what happened")
    func saveAnswers() throws {
        func result(_ json: String) throws -> ComposedSaveResult {
            try JSONDecoder().decode(ComposedSaveResult.self, from: Data(json.utf8))
        }
        let rec = #""rec":{"id":5,"name":"N","channelId":"111111111111111111","messageId":"222222222222222222","spec":{}}"#

        let saved = try result(#"{\#(rec),"status":"saved"}"#)
        #expect(saved.status == .saved)
        #expect(saved.message.id == 5)
        #expect(saved.error == nil)
        #expect(saved.status?.isInChannel == false)

        #expect(try result(#"{\#(rec),"status":"sent"}"#).status == .sent)
        #expect(try result(#"{\#(rec),"status":"sent"}"#).status?.isInChannel == true)
        #expect(try result(#"{\#(rec),"status":"updated"}"#).status == .updated)
        #expect(try result(#"{\#(rec),"status":"updated"}"#).status?.isInChannel == true)
        #expect(try result(#"{\#(rec),"status":"queued"}"#).status == .other("queued"))
        #expect(ComposedSaveStatus(rawValue: "sent").rawValue == "sent")

        // An `error` is kept even next to a rec, and an empty one is none.
        let failed = try result(#"{\#(rec),"error":"Pick a channel before publishing."}"#)
        #expect(failed.error == "Pick a channel before publishing.")
        #expect(failed.status == nil)
        #expect(try result(#"{\#(rec),"status":"saved","error":""}"#).error == nil)
    }

    // MARK: Endpoints

    @Test("the endpoints use the dashboard's paths and methods")
    func endpoints() {
        let list = Endpoints.ListComposedMessages(server: "fluxer:1")
        #expect(list.path == "/api/v2/guilds/fluxer%3A1/messages")
        #expect(list.method == .get)
        #expect(Endpoints.LoadComposedMessage(server: "1", id: .new).path == "/api/v2/guilds/1/messages/new")
        #expect(Endpoints.LoadComposedMessage(server: "1", id: .saved(12)).path == "/api/v2/guilds/1/messages/12")
        let save = Endpoints.SaveComposedMessage(
            server: "1", id: .saved(12), name: "N", channelId: "", action: .publish, spec: ComposedMessageSpec())
        #expect(save.path == "/api/v2/guilds/1/messages/12")
        #expect(save.method == .post)
        #expect(Endpoints.SaveComposedMessage(
            server: "1", id: .new, name: "", channelId: "", action: .save, spec: ComposedMessageSpec()).path
            == "/api/v2/guilds/1/messages/new")
        let unpublish = Endpoints.UnpublishComposedMessage(server: "1", id: 12)
        #expect(unpublish.path == "/api/v2/guilds/1/messages/12/unpublish")
        #expect(unpublish.method == .post)
        let delete = Endpoints.DeleteComposedMessage(server: "1", id: 12)
        #expect(delete.path == "/api/v2/guilds/1/messages/12/delete")
        #expect(delete.method == .post)
    }

    @Test("the save body is name, channel, action and spec, nothing else")
    func saveBody() throws {
        let save = Endpoints.SaveComposedMessage(
            server: "1", id: .new, name: "Rules", channelId: "111111111111111111", action: .publish,
            spec: ComposedMessageSpec(content: "Hi"))
        let body = try #require(save.body)
        let data = try JSONEncoder().encode(body)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(object.keys) == ["name", "channelId", "action", "spec"])
        #expect(object["action"] as? String == "publish")
        #expect(object["name"] as? String == "Rules")
        let spec = try #require(object["spec"] as? [String: Any])
        #expect(Set(spec.keys) == ["content", "embeds", "rows"])
    }
}
