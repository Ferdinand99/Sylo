import Foundation
import Testing
@testable import SyloKit

@Suite("Suggestions settings")
struct SuggestionsSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/suggestions/config`, shaped like src/web/routes/v2Suggestions.js.
    static let pageJSON = #"""
    {
      "config": {
        "channel": "222222222222222222",
        "logChannel": "333333333333333333",
        "logMode": "copy",
        "anonymous": true,
        "dmAuthor": false,
        "messagesToSuggestions": true,
        "cooldownSeconds": 120,
        "staffRoles": ["111111111111111111"]
      },
      "channels": [{"id": "222222222222222222", "name": "suggestions"}, {"id": "333333333333333333", "name": "decided"}],
      "roles": [{"id": "111111111111111111", "name": "Moderators"}],
      "suggestions": [
        {"id": 5, "number": 12, "title": "", "text": "Add a movie night", "status": "approved",
         "reason": "Starting next week", "up": 8, "down": 1, "anonymous": true, "authorId": "810000000000000001",
         "author": "Alex", "decidedBy": "820000000000000001", "decidedAt": 1794000100000,
         "createdAt": 1794000000000, "channelId": "222222222222222222"},
        {"id": 6, "number": 13, "title": "Emoji", "text": "More emoji", "status": "open", "reason": "",
         "up": 0, "down": 0, "anonymous": false, "authorId": null, "author": null, "decidedBy": null,
         "decidedAt": null, "createdAt": 1794000200000, "channelId": "222222222222222222"}
      ]
    }
    """#

    @Test("the page decodes settings, options and the suggestion list")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(SuggestionsPage.self, from: Data(Self.pageJSON.utf8))
        #expect(SuggestionsPage.moduleID == "suggestions")
        #expect(page.settings == SuggestionsSettings(
            channel: "222222222222222222", logChannel: "333333333333333333", logMode: .copy, anonymous: true, dmAuthor: false,
            messagesToSuggestions: true, cooldownSeconds: 120, staffRoles: ["111111111111111111"]))
        #expect(page.channels.count == 2)
        #expect(page.roles.map(\.name) == ["Moderators"])
        let first = try #require(page.suggestions.first)
        #expect(first.number == 12)
        #expect(first.status == .approved)
        #expect(first.reason == "Starting next week")
        #expect(first.up == 8)
        #expect(first.author == "Alex")
        #expect(first.isAnonymous)
        #expect(first.createdDate == Date(timeIntervalSince1970: 1_794_000_000))
        let second = try #require(page.suggestions.last)
        #expect(second.title == "Emoji")
        #expect(second.author == nil)
        #expect(second.status == .open)
    }

    @Test("missing fields fall back to the server's defaults: DM on, 60 second cooldown")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(SuggestionsPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings == SuggestionsSettings())
        #expect(page.settings.dmAuthor)
        #expect(page.settings.cooldownSeconds == 60)
        #expect(!page.settings.anonymous)
        #expect(page.suggestions.isEmpty)
    }

    @Test("an unknown status is kept, not an error")
    func unknownStatus() throws {
        let json = Data(#"{"number":1,"text":"x","status":"merged"}"#.utf8)
        let item = try JSONDecoder().decode(SuggestionSummary.self, from: json)
        #expect(item.status == .other("merged"))
        #expect(item.status.rawValue == "merged")
    }

    @Test("saving sends exactly the fields the web form sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(SuggestionsPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == [
            "channel", "logChannel", "logMode", "anonymous", "dmAuthor", "messagesToSuggestions", "cooldownSeconds",
            "staffRoles",
        ])
        #expect(body["logMode"] as? String == "copy")
        #expect(body["cooldownSeconds"] as? Int == 120)
        #expect(body["dmAuthor"] as? Bool == false)
        #expect(try JSONDecoder().decode(SuggestionsSettings.self, from: data) == page.settings)
    }

    @Test("the cooldown range is the server's")
    func ranges() {
        #expect(SuggestionsSettings.cooldownRange == 0...3600)
        #expect(SuggestionsSettings.maxStaffRoles == 25)
    }

    @Test("the log mode is read as stored, and move is the one the app sends for move")
    func logModeRoundTrip() throws {
        for (raw, mode) in [("copy", SuggestionsLogMode.copy), ("move", .move)] {
            let json = Data(#"{"logChannel":"333333333333333333","logMode":"\#(raw)"}"#.utf8)
            let settings = try JSONDecoder().decode(SuggestionsSettings.self, from: json)
            #expect(settings.logMode == mode)
            let body = try #require(
                try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any])
            #expect(body["logMode"] as? String == raw)
        }
    }

    @Test("a server without the setting reads like the server does: a log channel keeps moving, none copies")
    func logModeDefaults() throws {
        let withChannel = try JSONDecoder().decode(
            SuggestionsSettings.self, from: Data(#"{"logChannel":"333333333333333333"}"#.utf8))
        #expect(withChannel.logMode == .move)
        let without = try JSONDecoder().decode(SuggestionsSettings.self, from: Data(#"{}"#.utf8))
        #expect(without.logMode == .copy)
        // An unknown value is not an error either.
        let unknown = try JSONDecoder().decode(
            SuggestionsSettings.self, from: Data(#"{"logChannel":"","logMode":"archive"}"#.utf8))
        #expect(unknown.logMode == .copy)
        #expect(SuggestionsSettings().logMode == .copy)
        #expect(SuggestionsSettings(logChannel: "1").logMode == .move)
        #expect(SuggestionsSettings(logChannel: "1", logMode: .copy).logMode == .copy)
    }

    @Test("a save always carries the log mode, even one the person never touched")
    @MainActor
    func savesLogMode() async throws {
        let clients = StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<SuggestionsPage> {
                return SavedModuleSettings(settings: saving.settings)
            }
            return try JSONDecoder().decode(SuggestionsPage.self, from: Data(Self.pageJSON.utf8))
        }
        let model = ModuleSettingsModel<SuggestionsPage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        model.draft?.cooldownSeconds = 30
        #expect(await model.save())
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveModuleSettings<SuggestionsPage>)
        #expect(sent.settings.logMode == .copy)
        let body = try #require(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(sent.settings)) as? [String: Any])
        #expect(body["logMode"] as? String == "copy")
        // Changing the mode is a change of its own.
        model.draft?.logMode = .move
        #expect(model.hasChanges)
    }
}
