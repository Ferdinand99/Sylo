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

    static func page() throws -> WelcomeChannelPage {
        try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(pageJSON.utf8))
    }

    private static func body(_ settings: WelcomeChannelSettings) throws -> [String: Any] {
        let data = try JSONEncoder().encode(settings)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("the page decodes the channel, the message, its elements and the presets")
    func decodesPage() throws {
        let page = try Self.page()
        #expect(WelcomeChannelPage.moduleID == "welcome-channel")
        let s = page.settings
        #expect(s.channelId == "111111111111111111")
        #expect(s.messageId == "222222222222222222")
        #expect(s.isPublished)
        #expect(s.content == "Welcome to {server}!")
        #expect(s.embeds.count == 2)
        let embed = try #require(s.embeds.first).draft
        #expect(!s.embeds[0].isBanner)
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
        #expect(banner.isBanner)
        #expect(banner.draft.image == "https://example.com/b.png")
        // No colour stored: the editor shows (and saving sends) Discord's blurple.
        #expect(banner.draft.color.isEmpty)
        #expect(banner.draft.resolvedColor() == "#5865f2")
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
        // An unknown kind is kept as it came (sent back unchanged), and the broken colour reads as the default.
        #expect(embed.draft.kind == "poster")
        #expect(!embed.isBanner)
        #expect(embed.draft.resolvedColor() == "#5865f2")
        #expect(embed.draft.title.isEmpty)
        #expect(embed.draft.fields.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.presets.isEmpty)

        let empty = try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.embeds.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, never the published message id")
    func encodesBody() throws {
        var settings = try Self.page().settings
        // An empty field row is left out, as the web form does.
        settings.embeds[0].draft.fields.append(EmbedDraft.Field())
        let body = try Self.body(settings)
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

    @Test("a banner stays a banner and an unknown key survives a save")
    func bannerRoundTrip() throws {
        let json = #"""
        {"config":{"spec":{"embeds":[
          {"kind":"banner","image":"https://example.com/b.png","description":"Hi","color":"#ed4245","extraKey":[1,{"a":true}]}
        ]}}}
        """#
        var settings = try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(json.utf8)).settings
        settings.embeds[0].draft.description = "Hello"
        let body = try Self.body(settings)
        let spec = try #require(body["spec"] as? [String: Any])
        let sent = try #require((spec["embeds"] as? [[String: Any]])?.first)
        #expect(sent["kind"] as? String == "banner")
        #expect(sent["image"] as? String == "https://example.com/b.png")
        #expect(sent["description"] as? String == "Hello")
        #expect(sent["color"] as? String == "#ed4245")
        #expect(sent["extraKey"] != nil)

        // Read back, the banner is the same banner.
        let again = try JSONDecoder().decode(WelcomeChannelSettings.self, from: JSONEncoder().encode(settings))
        #expect(again.embeds.count == 1)
        #expect(again.embeds[0].isBanner)
        #expect(again.embeds[0] == settings.embeds[0])
    }

    @Test("the colour a banner shows is what is sent, and the embeds read back as the same elements")
    func sentColourAndReadBack() throws {
        let settings = try Self.page().settings
        let again = try JSONDecoder().decode(WelcomeChannelSettings.self, from: JSONEncoder().encode(settings))
        #expect(again.embeds.count == 2)
        #expect(again.embeds[0].draft.title == "Rules")
        #expect(again.embeds[0].draft.fields == settings.embeds[0].draft.fields)
        // The banner had no colour stored; what is sent is the colour the editor shows.
        #expect(again.embeds[1].draft.color == "#5865f2")
        #expect(again.embeds[1].isBanner)
        // Like the web form, the Welcome embed has no timestamp switch, so a stored one is not sent.
        #expect(settings.embeds[0].draft.timestamp)
        #expect(!again.embeds[0].draft.timestamp)
    }

    @Test("new elements and presets start like the web form's new ones")
    func newRows() throws {
        let page = try Self.page()
        let preset = try #require(page.presets.first)
        let embed = preset.makeEmbed()
        #expect(!embed.isBanner)
        #expect(embed.draft.title == "Welcome to {server}!")
        #expect(embed.draft.description == "Hello")
        #expect(embed.draft.color == "#5865f2")
        #expect(embed.draft.image.isEmpty)
        #expect(embed.draft.fields.isEmpty)
        #expect(preset.makeEmbed().id != embed.id)
        let banner = try #require(page.presets.last).makeEmbed()
        #expect(banner.isBanner)
        #expect(banner.draft.resolvedColor() == "#5865f2")
        let field = EmbedDraft.Field()
        #expect(field.name.isEmpty)
        #expect(field.value.isEmpty)
        #expect(!field.inline)
    }

    @Test("a preset's copy has its own field ids")
    func presetFieldIDs() throws {
        let draft = EmbedDraft(fields: [EmbedDraft.Field(name: "1", value: "a")])
        let preset = WelcomeChannelPreset(id: "p", label: "P", defaults: draft)
        let first = preset.makeEmbed()
        let second = preset.makeEmbed()
        #expect(first.draft.fields[0].id != second.draft.fields[0].id)
        #expect(first.draft.fields[0].id != draft.fields[0].id)
        #expect(first == second)
    }

    // MARK: Publishing

    @Test("the publishing calls are POSTs to the module's own paths")
    func endpoints() throws {
        let settings = try Self.page().settings
        let publish = Endpoints.PublishWelcomeChannel(server: "fluxer:1", settings: settings)
        #expect(publish.path == "/api/v2/guilds/fluxer%3A1/modules/welcome-channel/publish")
        #expect(publish.method == .post)
        #expect(publish.body != nil)
        let unpublish = Endpoints.UnpublishWelcomeChannel(server: "1")
        #expect(unpublish.path == "/api/v2/guilds/1/modules/welcome-channel/unpublish")
        #expect(unpublish.method == .post)
        let create = Endpoints.CreateWelcomeChannel(server: "1")
        #expect(create.path == "/api/v2/guilds/1/modules/welcome-channel/create-channel")
        #expect(create.method == .post)
    }

    @Test("the answer to creating the channel carries the config and the refreshed channel list")
    func decodesCreated() throws {
        let json = #"""
        {"config":{"channelId":"333333333333333333","messageId":"","spec":{"content":"","embeds":[]}},
         "channels":[{"id":"333333333333333333","name":"welcome"}]}
        """#
        let created = try JSONDecoder().decode(WelcomeChannelCreated.self, from: Data(json.utf8))
        #expect(created.settings.channelId == "333333333333333333")
        #expect(created.channels.map(\.name) == ["welcome"])
    }
}

/// The server's side of the Welcome Channel for the publisher tests.
final class FakeWelcomeServer: @unchecked Sendable {
    // @unchecked: every field is only touched while holding `lock`.
    private let lock = NSLock()
    private var _channelId: String
    private var _messageId: String
    private var _calls: [String] = []
    private var _publishError: NetworkError?
    private var _saveError: NetworkError?
    private var _content = "Welcome!"
    private var _embeds = "[]"

    init(channelId: String = "111111111111111111", messageId: String = "") {
        _channelId = channelId
        _messageId = messageId
    }

    var calls: [String] { lock.withLock { _calls } }
    var channelId: String { lock.withLock { _channelId } }
    var messageId: String { lock.withLock { _messageId } }
    var content: String { lock.withLock { _content } }

    func failPublish(with error: NetworkError?) { lock.withLock { _publishError = error } }
    func failSave(with error: NetworkError?) { lock.withLock { _saveError = error } }

    private func config(_ channelId: String, _ messageId: String, content: String) throws -> WelcomeChannelSettings {
        let json = #"{"channelId":"\#(channelId)","messageId":"\#(messageId)","spec":{"content":"\#(content)","embeds":\#(lock.withLock { _embeds })}}"#
        return try JSONDecoder().decode(WelcomeChannelSettings.self, from: Data(json.utf8))
    }

    func clients() -> StubClients {
        StubClients { [self] endpoint in
            if endpoint is Endpoints.LoadModuleSettings<WelcomeChannelPage> {
                lock.withLock { _calls.append("load") }
                let json = #"{"config":{"channelId":"\#(channelId)","messageId":"\#(messageId)","spec":{"content":"\#(content)","embeds":[{"kind":"banner","image":"https://example.com/b.png"}]}},"channels":[{"id":"111111111111111111","name":"welcome"}]}"#
                return try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(json.utf8))
            }
            if let saving = endpoint as? Endpoints.SaveModuleSettings<WelcomeChannelPage> {
                lock.withLock { _calls.append("save") }
                if let error = lock.withLock({ _saveError }) { throw error }
                lock.withLock {
                    _channelId = saving.settings.channelId
                    _content = saving.settings.content
                }
                return SavedModuleSettings(settings: try config(channelId, messageId, content: content))
            }
            if endpoint is Endpoints.PublishWelcomeChannel {
                lock.withLock { _calls.append("publish") }
                if let error = lock.withLock({ _publishError }) { throw error }
                lock.withLock { _messageId = "999999999999999999" }
                return SavedModuleSettings(settings: try config(channelId, messageId, content: content))
            }
            if endpoint is Endpoints.UnpublishWelcomeChannel {
                lock.withLock {
                    _calls.append("unpublish")
                    _messageId = ""
                }
                return SavedModuleSettings(settings: try config(channelId, messageId, content: content))
            }
            if endpoint is Endpoints.CreateWelcomeChannel {
                lock.withLock {
                    _calls.append("create")
                    _channelId = "333333333333333333"
                }
                let json = #"{"config":{"channelId":"333333333333333333","messageId":"","spec":{"content":"","embeds":[]}},"channels":[{"id":"333333333333333333","name":"welcome"}]}"#
                return try JSONDecoder().decode(WelcomeChannelCreated.self, from: Data(json.utf8))
            }
            throw NetworkError.notFound
        }
    }
}

@MainActor
@Suite("Welcome channel publishing")
struct WelcomeChannelPublisherTests {
    func make(_ server: FakeWelcomeServer) async -> (ModuleSettingsModel<WelcomeChannelPage>, WelcomeChannelPublisher) {
        let session = makeSignedInSession(clients: server.clients())
        let model = ModuleSettingsModel<WelcomeChannelPage>(server: "9", session: session)
        await model.load()
        return (model, WelcomeChannelPublisher(model: model, session: session))
    }

    @Test("publishing saves unsaved edits first, posts, and reloads so the message shows as published")
    func publishes() async throws {
        let server = FakeWelcomeServer()
        let (model, publisher) = await make(server)
        #expect(!publisher.isPublished)
        model.draft?.content = "Hello {server}"
        #expect(model.hasChanges)

        let published = await publisher.publish()

        #expect(published)
        #expect(server.calls == ["load", "save", "publish", "load"])
        #expect(server.content == "Hello {server}")
        #expect(publisher.isPublished)
        #expect(publisher.notice == .published)
        #expect(publisher.errorMessage == nil)
        #expect(!model.hasChanges)
        #expect(publisher.successCount == 1)
    }

    @Test("publishing without edits does not save again, and an already posted message is updated")
    func updates() async throws {
        let server = FakeWelcomeServer(messageId: "888888888888888888")
        let (_, publisher) = await make(server)
        #expect(publisher.isPublished)

        #expect(await publisher.publish())

        #expect(server.calls == ["load", "publish", "load"])
        #expect(publisher.notice == .updated)
    }

    @Test("publishing needs a channel and does not call the server without one")
    func needsChannel() async throws {
        let server = FakeWelcomeServer(channelId: "")
        let (_, publisher) = await make(server)

        #expect(await publisher.publish() == false)

        #expect(server.calls == ["load"])
        #expect(publisher.errorMessage == "Pick a channel first.")
        #expect(publisher.failedStep == .publish)
    }

    @Test("a post the server refuses shows its words and leaves the message unpublished")
    func publishFails() async throws {
        let server = FakeWelcomeServer()
        server.failPublish(with: .badRequest(message: "The bot lacks View Channel / Send Messages / Embed Links there."))
        let (_, publisher) = await make(server)

        #expect(await publisher.publish() == false)

        #expect(publisher.errorMessage == "The bot lacks View Channel / Send Messages / Embed Links there.")
        #expect(publisher.failedStep == .publish)
        #expect(!publisher.isPublished)
        #expect(publisher.notice == nil)
        #expect(publisher.successCount == 0)
        #expect(!publisher.isBusy)
    }

    @Test("a failed save stops before the post, and the settings model shows why")
    func saveFails() async throws {
        let server = FakeWelcomeServer()
        server.failSave(with: .badRequest(message: "Too much text."))
        let (model, publisher) = await make(server)
        model.draft?.content = "changed"

        #expect(await publisher.publish() == false)

        #expect(server.calls == ["load", "save"])
        #expect(model.saveError == "Too much text.")
        #expect(model.hasChanges)
    }

    @Test("removing the published message keeps the draft")
    func unpublishes() async throws {
        let server = FakeWelcomeServer(messageId: "888888888888888888")
        let (model, publisher) = await make(server)

        #expect(await publisher.unpublish())

        #expect(server.calls == ["load", "unpublish", "load"])
        #expect(!publisher.isPublished)
        #expect(publisher.notice == .removed)
        #expect(model.draft?.embeds.count == 1)
        #expect(model.draft?.embeds.first?.isBanner == true)
    }

    @Test("creating the channel picks it, and keeps edits that were not saved")
    func createsChannel() async throws {
        let server = FakeWelcomeServer(channelId: "")
        let (model, publisher) = await make(server)
        model.draft?.content = "Draft text"

        #expect(await publisher.createChannel())

        #expect(server.calls == ["load", "create", "load"])
        #expect(model.draft?.channelId == "333333333333333333")
        #expect(model.draft?.content == "Draft text")
        #expect(publisher.notice == .channelCreated)
    }

    @Test("a server that cannot create the channel says why")
    func createFails() async throws {
        let session = makeSignedInSession(clients: StubClients { endpoint in
            if endpoint is Endpoints.CreateWelcomeChannel {
                throw NetworkError.badRequest(message: "Sylo needs the Manage Channels permission.")
            }
            return try JSONDecoder().decode(WelcomeChannelPage.self, from: Data(#"{"config":{}}"#.utf8))
        })
        let model = ModuleSettingsModel<WelcomeChannelPage>(server: "9", session: session)
        await model.load()
        let publisher = WelcomeChannelPublisher(model: model, session: session)

        #expect(await publisher.createChannel() == false)

        #expect(publisher.errorMessage == "Sylo needs the Manage Channels permission.")
        #expect(publisher.failedStep == .createChannel)
    }
}
