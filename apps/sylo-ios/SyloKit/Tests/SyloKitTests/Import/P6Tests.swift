import Foundation
import Testing
@testable import SyloKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

private func value(_ json: String) throws -> JSONValue { try decode(JSONValue.self, json) }

@Suite("Message templates")
struct MessageTemplateTests {
    @Test("The six built-in templates")
    func gallery() {
        #expect(MessageTemplate.all.map(\.name) == ["Rules", "Welcome card", "Announcement", "Stream live", "Giveaway", "Event"])
        #expect(Set(MessageTemplate.all.map(\.id)).count == 6)
        #expect(MessageTemplate.all.allSatisfy { !$0.embeds.isEmpty })
    }

    @Test("A page without placeholders gets the words written out")
    func tokens() throws {
        let welcome = try #require(MessageTemplate.all.first { $0.id == "welcome-card" })
        let withTokens = welcome.message(tokens: true)
        #expect(withTokens.embeds[0].draft.title == "\u{1F44B} Welcome to {server}!")
        let without = welcome.message(tokens: false)
        #expect(without.embeds[0].draft.title == "\u{1F44B} Welcome to our server!")
        #expect(without.embeds[0].draft.footerText == "Enjoy your stay in our server")
        #expect(without.content == "")
        // A copy: changing it leaves the gallery alone.
        #expect(welcome.embeds[0].title == "\u{1F44B} Welcome to {server}!")
    }

    @Test("A text field only offers the templates that have a text for it")
    func texts() {
        #expect(MessageTemplate.templates(for: .welcome).map(\.id) == ["rules", "welcome-card"])
        #expect(MessageTemplate.templates(for: .stream).map(\.id) == ["stream-live"])
        #expect(MessageTemplate.templates(for: .youtubeLive).map(\.id) == ["stream-live"])
        #expect(MessageTemplate.templates(for: .rss).map(\.id) == ["announcement"])
        #expect(MessageTemplate.templates(for: .youtubeVideo).map(\.id) == ["announcement"])
        #expect(MessageTemplate.templates(for: .welcomeDm).count == 2)
    }

    @Test("Every placeholder a text uses belongs to the field it goes into")
    func placeholders() {
        let allowed: [TemplateTextField: Set<String>] = [
            .welcome: ["server", "user", "memberCount"], .welcomeDm: ["server", "user.name"],
            .stream: ["name", "title", "game", "viewers", "url"], .youtubeVideo: ["name", "title", "url"],
            .youtubeLive: ["name", "title", "url"], .rss: ["title", "link"],
        ]
        for template in MessageTemplate.all {
            for (field, text) in template.texts {
                var rest = Substring(text)
                while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
                    let name = String(rest[rest.index(after: open)..<close])
                    #expect(allowed[field]?.contains(name) == true, "\(template.id) \(field): {\(name)}")
                    rest = rest[rest.index(after: close)...]
                }
            }
        }
    }
}

@Suite("Message JSON")
struct MessageJSONTests {
    private func limits() -> MessageJSON.Limits { MessageJSON.Limits() }

    private func imported(_ json: String, allowsLinks: Bool = true) throws -> MessageJSON.Imported {
        guard case .imported(let result) = MessageJSON.parse(try value(json), limits: limits(), allowsLinks: allowsLinks) else {
            Issue.record("expected an import")
            throw NetworkError.cancelled
        }
        return result
    }

    private func errors(_ json: String) throws -> [String] {
        guard case .failed(let list) = MessageJSON.parse(try value(json), limits: limits()) else {
            Issue.record("expected errors")
            return []
        }
        return list
    }

    @Test("A Discord message: text, embeds with colour, fields and a link button")
    func discordMessage() throws {
        let result = try imported(#"""
            {"content":"Hi","embeds":[{"title":"T","description":"D","color":5814783,"author":{"name":"A","icon_url":"https://x.test/a.png"},
              "footer":{"text":"F"},"image":{"url":"https://x.test/i.png"},"fields":[{"name":"n","value":"v","inline":true}]}],
             "components":[{"type":1,"components":[{"type":2,"style":5,"label":"Go","url":"https://x.test","emoji":{"name":"x"}}]}]}
            """#)
        #expect(result.content == "Hi")
        let draft = result.embeds[0].draft
        #expect(draft.title == "T")
        #expect(draft.color == "#58b9ff")
        #expect(draft.authorIcon == "https://x.test/a.png")
        #expect(draft.fields == [EmbedDraft.Field(name: "n", value: "v", inline: true)])
        #expect(result.links.count == 1)
        #expect(result.links[0].label == "Go")
        #expect(result.links[0].emoji == "x")
        #expect(result.warnings.isEmpty)
    }

    @Test("A Discohook backup, a list of embeds and a single embed are all read")
    func wrappers() throws {
        let backup = try imported(#"{"backups":[{"messages":[{"data":{"content":"A"}},{"data":{"content":"B"}}]}]}"#)
        #expect(backup.content == "A")
        #expect(backup.warnings == ["The file holds 2 messages; only the first was imported."])
        #expect(try imported(#"[{"title":"One"}]"#).embeds.count == 1)
        #expect(try imported(#"{"title":"Solo","description":"x"}"#).embeds[0].draft.title == "Solo")
        #expect(try imported(#"{"data":{"content":"Inner"}}"#).content == "Inner")
    }

    @Test("What a message here cannot carry is named, not dropped silently")
    func warnings() throws {
        let result = try imported(#"""
            {"content":"x","username":"Bot","attachments":[{"id":1}],"thread_name":"t","flags":4,
             "embeds":[{"title":"T","timestamp":"2020-01-01T00:00:00Z","url":"https://x.test","image":{"url":"not a url"}}],
             "components":[{"type":1,"components":[{"type":2,"style":1,"label":"Press","custom_id":"x"}]}]}
            """#)
        #expect(result.warnings.contains("Timestamps are not imported."))
        #expect(result.warnings.contains("The custom name and avatar (a webhook feature) are not imported."))
        #expect(result.warnings.contains("Attached files are not imported."))
        #expect(result.warnings.contains("The thread name (a forum post feature) is not imported."))
        #expect(result.warnings.contains("The message flags are not imported."))
        #expect(result.warnings.contains("Links on embed titles are not imported."))
        #expect(result.warnings.contains { $0.contains("is not a web address") })
        #expect(result.warnings.contains { $0.contains("need a bot to answer") })
        #expect(result.embeds[0].draft.image == "")
    }

    @Test("A page without buttons lists the link buttons as not imported")
    func noButtons() throws {
        let result = try imported(#"""
            {"content":"x","components":[{"type":1,"components":[{"type":2,"style":5,"label":"Go","url":"https://x.test"}]}]}
            """#, allowsLinks: false)
        #expect(result.links.isEmpty)
        #expect(result.warnings == ["1 link button was not imported: this page has no buttons."])
    }

    @Test("Limits are the server's: too long, too many, and a total over Discord's")
    func limitsChecked() throws {
        var small = EmbedLimits.standard
        small.title = 5
        small.maxFields = 1
        let json = try value(#"{"embeds":[{"title":"Far too long","fields":[{"name":"a","value":"b"},{"name":"c","value":"d"}]}]}"#)
        guard case .failed(let list) = MessageJSON.parse(json, limits: MessageJSON.Limits(embed: small)) else {
            Issue.record("expected errors")
            return
        }
        #expect(list.contains("Embed 1: the title is 12 characters; the limit is 5."))
        #expect(list.contains("Embed 1 has 2 fields; the limit is 1."))
        let long = String(repeating: "a", count: 2001)
        #expect(try errors(#"{"content":"\#(long)"}"#) == ["The message text is 2001 characters; the limit is 2000."])
        let big = (1...5).map { _ in #"{"description":"\#(String(repeating: "x", count: 1500))"}"# }.joined(separator: ",")
        #expect(try errors(#"{"embeds":[\#(big)]}"#) == ["The embeds hold 7500 characters in all; Discord allows 6000 in one message."])
    }

    @Test("Bad shapes and empty messages are refused with a reason")
    func refused() throws {
        #expect(try errors(#"{"content":5}"#) == ["\"content\" must be text."])
        #expect(try errors(#"{"embeds":"x"}"#) == ["\"embeds\" must be a list."])
        #expect(try errors(#"{"embeds":[5]}"#) == ["Embed 1 must be an object."])
        #expect(try errors(#"{"embeds":[{"fields":[{"name":"a","value":""}]}]}"#) == ["Embed 1, field 1 needs both a name and a value."])
        #expect(try errors(#"{"content":""}"#) == ["This JSON has no message text, embeds or link buttons."])
        #expect(MessageJSON.parse(try value("5")) == .failed(["This is not a message. Expected an object with \"content\" and/or \"embeds\"."]))
        #expect(MessageJSON.parse(Data("nope".utf8)) == .failed(["This is not valid JSON."]))
    }

    @Test("An export is a Discord message and importing it again gives the same message")
    func roundTrip() throws {
        let embed = EmbedItem(EmbedDraft(
            color: "#ff8000", authorName: "A", title: "T", description: "D", image: "https://x.test/i.png",
            footerText: "F", fields: [EmbedDraft.Field(name: "n", value: "v", inline: true)]))
        let link = ComposedLinkButton(label: "Go", emoji: "<:cool:123>", url: "https://x.test")
        let json = MessageJSON.export(content: "Hello", embeds: [embed], links: [link])
        guard case .object(let object) = json else {
            Issue.record("expected an object")
            return
        }
        #expect(Set(object.keys) == ["content", "embeds", "components"])
        guard case .imported(let back) = MessageJSON.parse(json) else {
            Issue.record("expected an import")
            return
        }
        #expect(back.content == "Hello")
        #expect(back.embeds[0].draft.color == "#ff8000")
        #expect(back.embeds[0].draft.title == "T")
        #expect(back.embeds[0].draft.fields == embed.draft.fields)
        #expect(back.links[0].emoji == "<:cool:123>")
        #expect(back.links[0].url == "https://x.test")
        #expect(back.warnings.isEmpty)
    }

    @Test("An empty message and an unfinished button export nothing for them")
    func exportEmpty() throws {
        let data = try MessageJSON.exportData(content: "", embeds: [], links: [ComposedLinkButton(label: "No link")])
        #expect(try value(String(decoding: data, as: UTF8.self)) == .object([:]))
    }
}

@Suite("Import configuration")
struct ConfigImportDecodingTests {
    static let planJSON = #"""
        {"source":{"guildId":"9","exportedAt":"2026-11-01T10:00:00.000Z","sameServer":false},
         "notCarried":"In the file but not imported yet: reminders.","confirmWord":"IMPORT",
         "items":[
           {"key":"settings","kind":"settings","label":"Server settings","status":"change","notes":[],
            "change":{"before":{"modlogChannelId":""},"after":{"modlogChannelId":"5"},"names":{"5":"#mod-log"}}},
           {"key":"module:welcome","kind":"module","label":"Welcome","status":"change",
            "notes":["2 channels from the file are not on this server and were cleared."],
            "change":{"before":{"enabled":false},"after":{"enabled":true}}},
           {"key":"module:starboard","kind":"module","label":"Starboard","status":"same","notes":[],"change":null},
           {"key":"module:apple-connect","kind":"module","label":"Apple Connect","status":"skip","notes":["Only a Sylo operator can set this module up."]}]}
        """#

    @Test("The preview reads: source, items with their diffs and notes")
    func decodes() throws {
        let plan = try decode(ImportPlan.self, Self.planJSON)
        #expect(plan.source.sameServer == false)
        #expect(plan.source.guildID == "9")
        #expect(plan.confirmWord == "IMPORT")
        #expect(plan.items.map(\.status) == [.change, .change, .same, .skip])
        #expect(plan.changes.map(\.key) == ["settings", "module:welcome"])
        #expect(plan.items[0].change?.names["5"] == "#mod-log")
        #expect(plan.items[0].change?.diff.rows.count == 1)
        #expect(plan.items[1].notes.count == 1)
        #expect(plan.items[2].change == nil)
        #expect(ImportItemStatus.skip.label == "Not imported")
        #expect(ImportItemStatus.same.label == "No changes")
    }

    @Test("A bare answer still gives the word to type")
    func word() throws {
        #expect(try decode(ImportPlan.self, "{}").confirmWord == "IMPORT")
        #expect(try decode(ImportPlan.self, #"{"confirmWord":""}"#).confirmWord == "IMPORT")
    }

    @Test("The calls carry the file, the ticked keys and the typed word")
    func endpoints() throws {
        let file = try value(#"{"kind":"sylo-config","version":1}"#)
        let preview = Endpoints.PreviewConfigImport(server: "fluxer:9", file: file)
        #expect(preview.path == "/api/v2/guilds/fluxer%3A9/import/preview")
        #expect(preview.method == .post)
        let apply = Endpoints.ApplyConfigImport(server: "1", file: file, keys: ["settings"], confirm: "IMPORT")
        #expect(apply.path == "/api/v2/guilds/1/import/apply")
        let applyBody = try #require(apply.body)
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(applyBody)) as? [String: Any])
        #expect(Set(json.keys) == ["export", "items", "confirm"])
        #expect(json["items"] as? [String] == ["settings"])
        #expect(json["confirm"] as? String == "IMPORT")
        #expect((json["export"] as? [String: Any])?["version"] as? Int == 1)
    }

    @Test("Results say what was imported and why not")
    func results() throws {
        let answer = try decode(ImportAnswer.self, #"""
            {"results":[{"key":"settings","label":"Server settings","ok":true},
                        {"key":"module:welcome","label":"Welcome","ok":false,"error":"You can't hand out the Verified role."}]}
            """#)
        #expect(answer.results.map(\.ok) == [true, false])
        #expect(answer.results[1].error == "You can't hand out the Verified role.")
    }
}

@MainActor
@Suite("Import configuration model")
struct ConfigImportModelTests {
    nonisolated static let plan = try! decode(ImportPlan.self, ConfigImportDecodingTests.planJSON)
    nonisolated static let file = Data(#"{"kind":"sylo-config","version":1,"modules":[]}"#.utf8)

    @Test("The preview ticks what would change, and nothing is applied until the word is typed")
    func flow() async throws {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ApplyConfigImport {
                return ImportAnswer(results: [ImportResult(key: "settings", label: "Server settings", ok: true)])
            }
            return Self.plan
        }
        let model = ConfigImportModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.preview(fileData: Self.file)
        #expect(model.plan == Self.plan)
        #expect(model.picked == ["settings", "module:welcome"])
        #expect(!model.canApply)
        await model.apply()
        #expect(!clients.calls.contains { $0.endpoint is Endpoints.ApplyConfigImport })

        model.typedWord = "import"
        #expect(!model.canApply)
        model.typedWord = "IMPORT"
        #expect(model.canApply)
        model.toggle("module:welcome")
        await model.apply()
        let sent = try #require(clients.calls.compactMap { $0.endpoint as? Endpoints.ApplyConfigImport }.first)
        #expect(sent.keys == ["settings"])
        #expect(sent.confirm == "IMPORT")
        #expect(model.phase == .done([ImportResult(key: "settings", label: "Server settings", ok: true)]))
    }

    @Test("Nothing ticked cannot be applied")
    func nothingTicked() async {
        let clients = StubClients { _ in Self.plan }
        let model = ConfigImportModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.preview(fileData: Self.file)
        model.untickAll()
        model.typedWord = "IMPORT"
        #expect(!model.canApply)
        model.tickAll()
        #expect(model.canApply)
    }

    @Test("A file that is too big or not JSON is refused before it goes up")
    func badFiles() async {
        let clients = StubClients { _ in Self.plan }
        let model = ConfigImportModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.preview(fileData: Data(repeating: 0x20, count: ConfigImportModel.maxFileBytes + 1))
        #expect(model.errorMessage == "This file is larger than 256 KB, which is more than a Sylo export holds.")
        await model.preview(fileData: Data("nope".utf8))
        #expect(model.errorMessage == "This file is not valid JSON.")
        #expect(clients.calls.isEmpty)
        #expect(model.phase == .idle)
    }

    @Test("The server's own refusal of a file is shown")
    func serverRefuses() async {
        let clients = StubClients { _ in throw NetworkError.badRequest(message: "This is not a Sylo configuration export.") }
        let model = ConfigImportModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.preview(fileData: Self.file)
        #expect(model.errorMessage == "This is not a Sylo configuration export.")
        #expect(model.phase == .idle)
    }


    @Test("A person who may only view is refused by the server, and the review stays")
    func viewOnly() async {
        let clients = StubClients { endpoint in
            if endpoint is Endpoints.ApplyConfigImport {
                throw NetworkError.forbidden(message: "Your dashboard access in this server is View only, so you can't do this.")
            }
            return Self.plan
        }
        let model = ConfigImportModel(server: "1", session: makeSignedInSession(clients: clients))
        await model.preview(fileData: Self.file)
        model.typedWord = "IMPORT"
        await model.apply()
        #expect(model.plan != nil)
        #expect(model.errorMessage?.contains("View only") == true)
    }
}

@MainActor
@Suite("Duplicate and route probing")
struct DuplicateTests {
    @Test("Each kind goes to its own route")
    func paths() {
        func path(_ kind: DuplicateKind, _ id: String) -> String { Endpoints.DuplicateItem(server: "fluxer:9", kind: kind, id: id).path }
        #expect(path(.reminder, "4") == "/api/v2/guilds/fluxer%3A9/modules/reminders/4/duplicate")
        #expect(path(.composedMessage, "5") == "/api/v2/guilds/fluxer%3A9/messages/5/duplicate")
        #expect(path(.reactionRoleSet, "6") == "/api/v2/guilds/fluxer%3A9/modules/roles/rr/6/duplicate")
        #expect(path(.customCommand, "a b") == "/api/v2/guilds/fluxer%3A9/modules/custom-commands/cmd/a%20b/duplicate")
        #expect(path(.shopItem, "7") == "/api/v2/guilds/fluxer%3A9/modules/economy/shop/items/7/duplicate")
        #expect(Endpoints.DuplicateItem(server: "1", kind: .reminder, id: "1").method == .post)
    }

    @Test("The copy's id may be a number or text")
    func result() throws {
        #expect(try decode(DuplicateResult.self, #"{"ok":true,"id":12,"name":"Daily (copy)"}"#) == DuplicateResult(id: "12", name: "Daily (copy)"))
        #expect(try decode(DuplicateResult.self, #"{"ok":true,"id":"abc","name":"x"}"#).id == "abc")
    }

    @Test("A copy says what it is")
    func copy() async {
        let clients = StubClients { _ in DuplicateResult(id: "9", name: "Daily (copy)") }
        let model = DuplicateModel(server: "1", session: makeSignedInSession(clients: clients))
        let made = await model.duplicate(.reminder, id: "4")
        #expect(made?.id == "9")
        #expect(model.copyCount == 1)
        #expect(model.lastNote == "Copied as Daily (copy). The copy is paused.")
    }

    @Test("A limit's refusal is shown in the server's words")
    func limit() async {
        let clients = StubClients { _ in throw NetworkError.badRequest(message: "This server already has the maximum of 25 reminders.") }
        let model = DuplicateModel(server: "1", session: makeSignedInSession(clients: clients))
        #expect(await model.duplicate(.reminder, id: "4") == nil)
        #expect(model.errorMessage == "This server already has the maximum of 25 reminders.")
    }

    @Test("The features a Sylo 5.2 announces, as the server spells them")
    func featureStrings() {
        #expect(ServerFeature.configImport.rawValue == "config-import")
        #expect(ServerFeature.duplicate.rawValue == "duplicate")
        #expect(ServerFeature.messageTemplates.rawValue == "message-templates")
        #expect(ServerFeature.setupWizard.rawValue == "setup-wizard")
        #expect(ServerFeature.configHistory.rawValue == "config-history")
        #expect(ServerFeature.inboxSearch.rawValue == "inbox-search")
        #expect(ServerFeature.health.rawValue == "health")
        #expect(ServerFeature.accessLevels.rawValue == "access-levels")
    }

    @Test("A control for a feature shows only when the Sylo announces it, and a probe is never sent")
    func gating() async {
        let all = ServerInfo(features: [
            .appLogin, .accessLevels, .health, .setupWizard, .configHistory, .inboxSearch, .configImport, .duplicate,
            .messageTemplates,
        ])
        let clients = StubClients { _ in all }
        let session = makeSignedInSession(clients: clients)
        // Before the features are read, nothing is announced.
        #expect(!session.has(.configImport))
        _ = await session.serverFeatures()
        for feature in [ServerFeature.configImport, .duplicate, .messageTemplates, .setupWizard, .configHistory, .inboxSearch] {
            #expect(session.has(feature))
        }
        // Nothing but the info call went out: no preview of an empty file to see whether import exists.
        #expect(clients.calls.allSatisfy { $0.endpoint is Endpoints.ServerInfo })
    }

    @Test("A Sylo 5.2 that predates the strings, or a 5.1, has none of the controls")
    func olderServer() async {
        let clients = StubClients { _ in ServerInfo(features: [.appLogin, .liveAccess, .changelog, .accessLevels, .health]) }
        let session = makeSignedInSession(clients: clients)
        _ = await session.serverFeatures()
        for feature in [ServerFeature.configImport, .duplicate, .messageTemplates, .setupWizard, .configHistory, .inboxSearch] {
            #expect(!session.has(feature))
        }
        #expect(session.has(.accessLevels))
        #expect(session.has(.health))
    }
}
