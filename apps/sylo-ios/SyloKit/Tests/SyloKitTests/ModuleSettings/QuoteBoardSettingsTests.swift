import Foundation
import Testing
@testable import SyloKit

@Suite("Quote board settings")
struct QuoteBoardSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/quote-board/config`, shaped like src/web/routes/v2Quotes.js.
    static let pageJSON = #"""
    {
      "config": {"publicPage": true, "saveMode": "roles", "saveRoles": ["111111111111111111"],
                 "staffRoles": ["444444444444444444"]},
      "roles": [{"id": "111111111111111111", "name": "Regulars"}, {"id": "444444444444444444", "name": "Moderators"}],
      "publicPath": "/quotes/900000000000000201",
      "total": 41,
      "quotes": [
        {"number": 41, "authorId": "810000000000000001", "author": "Alex", "text": "I meant to do that.",
         "attachments": 2, "channelId": "222222222222222222", "channel": "general", "messageAt": 1794000000000,
         "savedBy": "820000000000000001", "savedAt": 1794000100000, "publicSource": true,
         "url": "https://discord.com/channels/900000000000000201/222222222222222222/333333333333333333"},
        {"number": 40, "authorId": "810000000000000002", "author": "", "text": "", "attachments": 0,
         "channelId": "555555555555555555", "channel": null, "messageAt": 1793000000000,
         "savedBy": "820000000000000001", "savedAt": 1793000100000, "publicSource": false, "url": ""}
      ]
    }
    """#

    @Test("the page decodes settings, roles, the public page and the quote list")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(QuoteBoardPage.self, from: Data(Self.pageJSON.utf8))
        #expect(QuoteBoardPage.moduleID == "quote-board")
        #expect(page.settings == QuoteBoardSettings(
            publicPage: true, saveMode: .roles, saveRoles: ["111111111111111111"],
            staffRoles: ["444444444444444444"]))
        #expect(page.roles.count == 2)
        #expect(page.publicPath == "/quotes/900000000000000201")
        #expect(page.total == 41)
        #expect(page.quotes.map(\.number) == [41, 40])
        let quote = try #require(page.quotes.first)
        #expect(quote.author == "Alex")
        #expect(quote.attachments == 2)
        #expect(quote.channel == "general")
        #expect(quote.publicSource)
        #expect(quote.messageDate == Date(timeIntervalSince1970: 1_794_000_000))
        #expect(quote.url?.host == "discord.com")
        let second = try #require(page.quotes.last)
        #expect(second.channel == nil)
        #expect(!second.publicSource)
        #expect(second.url == nil)
    }

    @Test("missing fields fall back to the server's defaults: page off, everyone may save")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(QuoteBoardPage.self, from: Data(#"{"config":{"saveMode":"admins"}}"#.utf8))
        #expect(page.settings == QuoteBoardSettings())
        #expect(page.settings.saveMode == .everyone)
        #expect(!page.settings.publicPage)
        #expect(page.quotes.isEmpty)
        #expect(page.total == 0)
    }

    @Test("saving sends exactly the fields the web form sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(QuoteBoardPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["publicPage", "saveMode", "saveRoles", "staffRoles"])
        #expect(body["saveMode"] as? String == "roles")
        #expect(body["publicPage"] as? Bool == true)
        #expect(try JSONDecoder().decode(QuoteBoardSettings.self, from: data) == page.settings)
    }

    @Test("both save modes are known to the app")
    func saveModes() {
        #expect(QuoteSaveMode.allCases.map(\.rawValue) == ["everyone", "roles"])
    }
}
