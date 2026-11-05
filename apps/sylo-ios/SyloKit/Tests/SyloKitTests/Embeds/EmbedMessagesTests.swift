import Foundation
import Testing
@testable import SyloKit

@Suite("Embed specs")
struct EmbedSpecTests {
    /// An embed as the server stores it, with a key the app does not edit.
    static let json = #"""
    {"kind": "embed", "color": "#ed4245", "title": "Rules", "description": "Be **kind**.", "image": "",
     "thumbnail": "https://example.com/t.png", "authorName": "Mods", "authorIcon": "", "footerText": "Thanks",
     "footerIcon": "", "timestamp": true, "url": "https://example.com/rules",
     "fields": [{"name": "One", "value": "No spam", "inline": true}, {"name": "", "value": "", "inline": false}]}
    """#

    @Test("an embed decodes every part")
    func decodes() throws {
        let embed = try JSONDecoder().decode(EmbedSpec.self, from: Data(Self.json.utf8))
        #expect(embed.title == "Rules")
        #expect(embed.description == "Be **kind**.")
        #expect(embed.color == "#ed4245")
        #expect(embed.thumbnail == "https://example.com/t.png")
        #expect(embed.authorName == "Mods")
        #expect(embed.footerText == "Thanks")
        #expect(embed.timestamp)
        #expect(embed.fields.count == 2)
        #expect(embed.fields[0].inline)
        #expect(embed.extra["url"] == .string("https://example.com/rules"))
        #expect(!embed.isEmpty)
    }

    @Test("saving keeps the keys the app does not edit and drops fields with nothing in them")
    func encodes() throws {
        let embed = try JSONDecoder().decode(EmbedSpec.self, from: Data(Self.json.utf8))
        let data = try JSONEncoder().encode(embed)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == [
            "kind", "color", "title", "image", "authorName", "authorIcon", "description", "thumbnail",
            "footerText", "footerIcon", "timestamp", "fields", "url",
        ])
        #expect(body["kind"] as? String == "embed")
        #expect(body["url"] as? String == "https://example.com/rules")
        #expect((body["fields"] as? [[String: Any]])?.count == 1)
        let again = try JSONDecoder().decode(EmbedSpec.self, from: data)
        #expect(again.title == embed.title)
        #expect(again.fields.first == embed.fields.first)
    }

    @Test("an embed with text above it carries the text beside the embed's own keys")
    func encodesWithContent() throws {
        var embed = EmbedSpec(title: "Hi")
        embed.fields = [EmbedSpec.Field(name: "a", value: "b")]
        let data = try JSONEncoder().encode(EmbedWithContent(embed: embed, content: "Heads up"))
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["content"] as? String == "Heads up")
        #expect(body["title"] as? String == "Hi")
        #expect(body["kind"] as? String == "embed")
    }

    @Test("missing keys read as empty, and an unset colour stays unset until the editor opens it")
    func lenient() throws {
        let embed = try JSONDecoder().decode(EmbedSpec.self, from: Data("{}".utf8))
        #expect(embed.title.isEmpty)
        #expect(embed.color.isEmpty)
        #expect(!embed.timestamp)
        #expect(embed.fields.isEmpty)
        #expect(embed.isEmpty)
        #expect(embed.withDefaultColor().color == EmbedSpec.defaultColor)
        #expect(EmbedSpec(color: "#00ff00").withDefaultColor().color == "#00ff00")
    }

    @Test("colours convert to and from picker components")
    func colour() {
        var embed = EmbedSpec(color: "#ff8000")
        let rgb = embed.rgb
        #expect(rgb.red == 1)
        #expect(abs(rgb.green - 128.0 / 255) < 0.0001)
        #expect(rgb.blue == 0)
        embed.setRGB(red: 0, green: 1.4, blue: -1)
        #expect(embed.color == "#00ff00")
        #expect(EmbedSpec.hexValue("ff8000") == nil)
        #expect(EmbedSpec.hexValue("#ff80") == nil)
    }

    @Test("only http and https links count as links")
    func links() {
        #expect(EmbedSpec.isWebLink("https://example.com/a.png"))
        #expect(EmbedSpec.isWebLink("HTTP://example.com"))
        #expect(!EmbedSpec.isWebLink("ftp://example.com"))
        #expect(!EmbedSpec.isWebLink("https://"))
        #expect(!EmbedSpec.isWebLink("https://exa mple.com"))
    }
}

@Suite("Embed messages")
struct ComposedMessageTests {
    /// `GET /api/v2/guilds/:id/messages`.
    static let listJSON = #"""
    {"items": [
      {"id": 7, "name": "Rules", "channel": "rules", "published": true, "when": "3h ago"},
      {"id": 9, "name": "Untitled embed", "channel": "123456789012345678", "published": false, "when": "2d ago"}
    ]}
    """#

    /// `GET /api/v2/guilds/:id/messages/7`: a message with a link button and a row from Reaction roles.
    static let recordJSON = #"""
    {"isNew": false,
     "rec": {"id": 7, "name": "Rules", "channelId": "222222222222222222", "messageId": "999999999999999999",
             "spec": {"content": "Please read.",
                      "embeds": [{"kind": "embed", "color": "#5865f2", "title": "Rules", "description": "Be kind.",
                                  "authorName": "", "authorIcon": "", "image": "", "thumbnail": "",
                                  "footerText": "Thanks", "footerIcon": "", "fields": []},
                                 {"kind": "embed", "color": "", "title": "Second"}],
                      "rows": [{"type": "roleselect", "placeholder": "Roles", "options": [{"label": "A", "roleId": "1"}]},
                               {"type": "buttons", "buttons": [{"style": "link", "label": "Site", "emoji": "", "url": "https://example.com"}]}]}},
     "channels": [{"id": "222222222222222222", "name": "rules"}, {"id": "333333333333333333", "name": "general"}],
     "roles": [{"id": "1", "name": "Member"}]}
    """#

    /// `GET /api/v2/guilds/:id/messages/new`.
    static let newJSON = #"""
    {"isNew": true, "rec": {"id": "", "name": "", "channelId": "", "messageId": null,
                            "spec": {"content": "", "embeds": [], "rows": []}},
     "channels": [{"id": "333333333333333333", "name": "general"}], "roles": []}
    """#

    @Test("the list decodes the summaries")
    func decodesList() throws {
        let list = try JSONDecoder().decode(ComposedMessageList.self, from: Data(Self.listJSON.utf8))
        #expect(list.items.count == 2)
        #expect(list.items[0].id == 7)
        #expect(list.items[0].isPublished)
        #expect(list.items[0].edited == "3h ago")
        #expect(!list.items[1].isPublished)
        #expect(list.items[1].channel == "123456789012345678")
    }

    @Test("a saved message decodes, and a new one has no id and no posted message")
    func decodesRecord() throws {
        let page = try JSONDecoder().decode(ComposedMessagePage.self, from: Data(Self.recordJSON.utf8))
        #expect(page.record.id == 7)
        #expect(page.record.messageId == "999999999999999999")
        #expect(page.record.spec.embeds.count == 2)
        #expect(page.record.spec.rows.count == 2)
        #expect(page.channels.map(\.name) == ["rules", "general"])
        let fresh = try JSONDecoder().decode(ComposedMessagePage.self, from: Data(Self.newJSON.utf8))
        #expect(fresh.record.id == nil)
        #expect(fresh.record.messageId == nil)
        #expect(fresh.record.spec.embeds.isEmpty)
    }

    @Test("the editor takes link buttons out of the rows and keeps the other rows")
    func draftFromSpec() throws {
        let page = try JSONDecoder().decode(ComposedMessagePage.self, from: Data(Self.recordJSON.utf8))
        let draft = ComposedMessageDraft(spec: page.record.spec)
        #expect(draft.content == "Please read.")
        #expect(draft.embeds.map(\.title) == ["Rules", "Second"])
        // The second embed had no colour: the editor opens it with the default.
        #expect(draft.embeds[1].color == EmbedSpec.defaultColor)
        #expect(draft.links.count == 1)
        #expect(draft.links[0].label == "Site")
        #expect(draft.links[0].url == "https://example.com")
        let spec = draft.spec
        #expect(spec.rows.count == 2)
        #expect(spec.rows[0].objectValue?["type"]?.stringValue == "roleselect")
        #expect(spec.rows[1].objectValue?["type"]?.stringValue == "buttons")
        // Nothing was edited, so the saved form equals the loaded one.
        #expect(ComposedMessageDraft(spec: spec) == draft)
    }

    @Test("link buttons need a link and a label or an emoji; blank ones are dropped")
    func linksToRows() {
        var draft = ComposedMessageDraft(content: "Hi")
        draft.links = [
            LinkButton(label: " Site ", emoji: "", url: " https://example.com "),
            LinkButton(label: "", emoji: "", url: "https://nolabel.example"),
            LinkButton(label: "No link", emoji: "", url: ""),
            LinkButton(label: "", emoji: "🔗", url: "https://emoji.example"),
        ]
        let rows = draft.spec.rows
        #expect(rows.count == 1)
        let buttons = rows[0].objectValue?["buttons"]?.arrayValue ?? []
        #expect(buttons.count == 2)
        #expect(buttons[0].objectValue?["label"]?.stringValue == "Site")
        #expect(buttons[0].objectValue?["url"]?.stringValue == "https://example.com")
        #expect(buttons[0].objectValue?["style"]?.stringValue == "link")
        #expect(buttons[1].objectValue?["emoji"]?.stringValue == "🔗")
        draft.links = []
        #expect(draft.spec.rows.isEmpty)
    }

    @Test("saving sends the name, channel, action and the message in the web form's shape")
    func encodesSave() throws {
        let draft = ComposedMessageDraft(content: "Hello", embeds: [EmbedSpec(title: "T")])
        let save = Endpoints.SaveComposedMessage(
            server: "fluxer:5", id: nil, name: "Greeting", channelId: "333", publish: true, spec: draft.spec)
        #expect(save.path == "/api/v2/guilds/fluxer%3A5/messages/new")
        #expect(save.method == .post)
        let body = try bodyObject(save)
        #expect(Set(body.keys) == ["name", "channelId", "action", "spec"])
        #expect(body["action"] as? String == "publish")
        let spec = try #require(body["spec"] as? [String: Any])
        #expect(Set(spec.keys) == ["content", "embeds", "rows"])
        #expect((spec["embeds"] as? [[String: Any]])?.first?["title"] as? String == "T")
        let draftSave = Endpoints.SaveComposedMessage(
            server: "1", id: 12, name: "x", channelId: "", publish: false, spec: draft.spec)
        #expect(draftSave.path == "/api/v2/guilds/1/messages/12")
        let draftBody = try bodyObject(draftSave)
        #expect(draftBody["action"] as? String == "save")
    }

    @Test("the endpoints use the dashboard's message paths")
    func paths() {
        #expect(Endpoints.ComposedMessages(server: "1").path == "/api/v2/guilds/1/messages")
        #expect(Endpoints.ComposedMessage(server: "1", id: nil).path == "/api/v2/guilds/1/messages/new")
        #expect(Endpoints.ComposedMessage(server: "1", id: 4).path == "/api/v2/guilds/1/messages/4")
        #expect(Endpoints.UnpublishComposedMessage(server: "1", id: 4).path == "/api/v2/guilds/1/messages/4/unpublish")
        #expect(Endpoints.DeleteComposedMessage(server: "1", id: 4).path == "/api/v2/guilds/1/messages/4/delete")
        #expect(Endpoints.DeleteComposedMessage(server: "1", id: 4).method == .post)
    }

    @Test("a saved answer reads its status")
    func decodesSaved() throws {
        let json = #"{"rec": {"id": 3, "name": "n", "channelId": "1", "messageId": "55", "spec": {}}, "status": "sent"}"#
        let saved = try JSONDecoder().decode(SavedComposedMessage.self, from: Data(json.utf8))
        #expect(saved.status == .sent)
        #expect(saved.record.messageId == "55")
        let draft = try JSONDecoder().decode(
            SavedComposedMessage.self,
            from: Data(#"{"rec": {"id": 3, "name": "n", "channelId": "", "messageId": null, "spec": {}}, "status": "saved"}"#.utf8))
        #expect(draft.status == .saved)
        #expect(draft.record.messageId == nil)
    }
}

@MainActor
@Suite("Embed message screens' models")
struct ComposedMessageModelTests {
    /// Answers the list, the editor page and saves like the server does.
    static func clients(
        listed: [ComposedMessageSummary] = [], publishError: String? = nil
    ) -> StubClients {
        StubClients { endpoint in
            switch endpoint {
            case is Endpoints.ComposedMessages:
                return ComposedMessageList(items: listed)
            case let load as Endpoints.ComposedMessage:
                let data = Data((load.id == nil ? ComposedMessageTests.newJSON : ComposedMessageTests.recordJSON).utf8)
                return try JSONDecoder().decode(ComposedMessagePage.self, from: data)
            case let save as Endpoints.SaveComposedMessage:
                if save.publish, let publishError { throw NetworkError.badRequest(message: publishError) }
                let id = save.id ?? 21
                return SavedComposedMessage(
                    record: ComposedMessageRecord(
                        id: id, name: save.name.isEmpty ? "Untitled embed" : save.name, channelId: save.channelId,
                        messageId: save.publish ? "777" : nil, spec: save.spec),
                    status: save.publish ? .sent : .saved)
            case is Endpoints.UnpublishComposedMessage, is Endpoints.DeleteComposedMessage:
                return OKResponse()
            default:
                throw NetworkError.notFound
            }
        }
    }

    @Test("the list loads, and unpublishing and deleting change it")
    func list() async throws {
        let clients = Self.clients(listed: [
            ComposedMessageSummary(id: 7, name: "Rules", channel: "rules", isPublished: true, edited: "1h ago"),
            ComposedMessageSummary(id: 9, name: "Other", channel: "general", isPublished: false, edited: "2h ago"),
        ])
        let model = ComposedMessagesModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(model.items?.count == 2)
        await model.unpublish(7)
        #expect(model.items?.first?.isPublished == false)
        await model.delete(9)
        #expect(model.items?.map(\.id) == [7])
        #expect(model.changeCount == 2)
        #expect(clients.calls.contains { $0.endpoint is Endpoints.DeleteComposedMessage })
    }

    @Test("a failed delete explains and keeps the message")
    func failedDelete() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.DeleteComposedMessage { throw NetworkError.badRequest(message: "Nope.") }
            return ComposedMessageList(items: [
                ComposedMessageSummary(id: 7, name: "Rules", channel: "rules", isPublished: false, edited: ""),
            ])
        }
        let model = ComposedMessagesModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.load()
        await model.delete(7)
        #expect(model.items?.count == 1)
        #expect(model.actionError == "Nope.")
        #expect(model.changeCount == 0)
    }

    @Test("an existing message loads with no changes, and editing makes some")
    func editorLoads() async {
        let model = ComposedMessageEditorModel(server: "1", session: makeSignedInSession(clients: Self.clients()), id: 7)
        await model.load()
        #expect(model.isLoaded)
        #expect(model.name == "Rules")
        #expect(model.isPublished)
        #expect(model.channels.count == 2)
        #expect(!model.hasChanges)
        model.draft.embeds[0].title = "New rules"
        #expect(model.hasChanges)
        model.discardChanges()
        #expect(model.draft.embeds[0].title == "Rules")
        #expect(!model.hasChanges)
    }

    @Test("a new message saves as a draft, and the next save updates it")
    func savesDraft() async throws {
        let clients = Self.clients()
        let model = ComposedMessageEditorModel(server: "1", session: makeSignedInSession(clients: clients), id: nil)
        await model.load()
        #expect(model.isNew)
        model.name = "Greeting"
        model.draft.content = "Hello"
        #expect(model.hasChanges)
        let ok = await model.saveDraft()
        #expect(ok)
        #expect(model.recordID == 21)
        #expect(!model.isPublished)
        #expect(!model.hasChanges)
        #expect(model.lastStatus == .saved)
        model.draft.content = "Hello again"
        _ = await model.saveDraft()
        let saves = clients.calls.compactMap { $0.endpoint as? Endpoints.SaveComposedMessage }
        #expect(saves.count == 2)
        #expect(saves[0].id == nil)
        #expect(saves[1].id == 21)
    }

    @Test("publishing a message that was never saved saves it first, then posts it")
    func publishesNew() async throws {
        let clients = Self.clients()
        let model = ComposedMessageEditorModel(server: "1", session: makeSignedInSession(clients: clients), id: nil)
        await model.load()
        model.channelId = "333333333333333333"
        model.draft.embeds = [EmbedSpec(title: "Hi")]
        let ok = await model.publish()
        #expect(ok)
        let saves = clients.calls.compactMap { $0.endpoint as? Endpoints.SaveComposedMessage }
        #expect(saves.map(\.publish) == [false, true])
        #expect(saves.map(\.id) == [nil, 21])
        #expect(model.isPublished)
        #expect(model.lastStatus == .sent)
        #expect(!model.hasChanges)
    }

    @Test("a refused post keeps the saved draft, the edits and the server's reason")
    func refusedPublish() async {
        let clients = Self.clients(publishError: "Missing Permissions")
        let model = ComposedMessageEditorModel(server: "1", session: makeSignedInSession(clients: clients), id: nil)
        await model.load()
        model.channelId = "333333333333333333"
        model.draft.content = "Hello"
        let ok = await model.publish()
        #expect(!ok)
        #expect(model.actionError == "Missing Permissions")
        // The draft was saved before the post was tried, so a retry updates it instead of making a second one.
        #expect(model.recordID == 21)
        #expect(!model.isPublished)
    }

    @Test("publishing needs a channel and something to post")
    func publishProblems() async {
        let model = ComposedMessageEditorModel(server: "1", session: makeSignedInSession(clients: Self.clients()), id: nil)
        await model.load()
        #expect(model.publishProblem == "Choose a channel before publishing.")
        model.channelId = "333333333333333333"
        #expect(model.publishProblem == "Add some text or an embed before publishing.")
        model.draft.content = "x"
        #expect(model.publishProblem == nil)
        model.draft.content = ""
        model.draft.embeds = [EmbedSpec()]
        #expect(model.publishProblem != nil)
        let ok = await model.publish()
        #expect(!ok)
        #expect(model.actionError != nil)
    }

    @Test("a save bumps the session's module revision, so summaries load again")
    func bumpsRevision() async {
        let session = makeSignedInSession(clients: Self.clients())
        let model = ComposedMessageEditorModel(server: "1", session: session, id: nil)
        await model.load()
        model.draft.content = "x"
        let before = session.modulesRevision
        _ = await model.saveDraft()
        #expect(session.modulesRevision == before + 1)
    }
}
