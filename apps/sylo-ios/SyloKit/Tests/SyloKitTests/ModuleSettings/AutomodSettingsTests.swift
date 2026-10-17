import Foundation
import Testing
@testable import SyloKit

@Suite("Automod settings")
struct AutomodSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/automod/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "deleteMessage": true,
        "timeoutMinutes": 30,
        "exemptChannels": ["222222222222222222"],
        "exemptRoles": ["111111111111111111"],
        "native": {"enabled": true, "words": true, "mentions": false, "spam": true, "presets": ["slurs"]},
        "rules": {
          "invites": {"enabled": true, "action": "warn"},
          "links": {"enabled": true, "action": "delete", "allowed": ["youtube.com", "twitch.tv"]},
          "spam": {"enabled": true, "action": "timeout", "max": 7, "seconds": 10},
          "mentions": {"enabled": false, "action": "delete", "max": 6},
          "caps": {"enabled": true, "action": "delete", "minLength": 12, "percent": 80},
          "words": {"enabled": true, "action": "warn", "list": ["badword", "another phrase"]},
          "emojis": {"enabled": false, "action": "delete", "max": 9},
          "spoilers": {"enabled": false, "action": "delete", "max": 3},
          "zalgo": {"enabled": true, "action": "delete"},
          "repeat": {"enabled": false, "action": "delete"}
        }
      },
      "channels": [{"id": "222222222222222222", "name": "memes"}],
      "roles": [{"id": "111111111111111111", "name": "Trusted"}],
      "automodRules": [["words", "Bad words", "Blocks messages containing any listed word or phrase."]],
      "automodActions": ["delete", "warn", "timeout"],
      "nativeMappable": [["words", "Bad words"], ["mentions", "Excessive mentions"], ["spam", "Anti-spam"]],
      "presetKeys": ["profanity", "sexual", "slurs"],
      "modlogChannelId": "333333333333333333"
    }
    """#

    @Test("the page decodes every check, native AutoMod and the options")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(AutomodPage.self, from: Data(Self.pageJSON.utf8))
        #expect(AutomodPage.moduleID == "automod")
        let settings = page.settings
        #expect(settings.timeoutMinutes == 30)
        #expect(settings.exemptChannels == ["222222222222222222"])
        #expect(settings.exemptRoles == ["111111111111111111"])
        #expect(settings.native.enabled)
        #expect(settings.native.words)
        #expect(!settings.native.mentions)
        #expect(settings.native.spam)
        #expect(settings.native.presets == ["slurs"])
        let rules = settings.rules
        #expect(rules.invites.mode == .warn)
        #expect(rules.links.mode == .delete)
        #expect(rules.links.allowedText == "youtube.com, twitch.tv")
        #expect(rules.spam.mode == .timeout)
        #expect(rules.spam.max == 7)
        #expect(rules.spam.seconds == 10)
        #expect(rules.mentions.mode == .off)
        #expect(rules.mentions.max == 6)
        #expect(rules.caps.minLength == 12)
        #expect(rules.caps.percent == 80)
        #expect(rules.words.mode == .warn)
        #expect(rules.words.listText == "badword, another phrase")
        #expect(rules.emojis.max == 9)
        #expect(rules.spoilers.max == 3)
        #expect(rules.zalgo.mode == .delete)
        #expect(rules.repeat.mode == .off)
        #expect(page.channels.map(\.name) == ["memes"])
        #expect(page.roles.map(\.name) == ["Trusted"])
        #expect(page.presetKeys == ["profanity", "sexual", "slurs"])
        #expect(page.modlogChannelId == "333333333333333333")
    }

    @Test("a near-empty config falls back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"rules":{"invites":{"enabled":true,"action":"explode"},"spam":{}}}}"#.utf8)
        let page = try JSONDecoder().decode(AutomodPage.self, from: json)
        let settings = page.settings
        #expect(settings.deleteMessage)
        #expect(settings.timeoutMinutes == 10)
        #expect(settings.exemptChannels.isEmpty)
        #expect(settings.exemptRoles.isEmpty)
        #expect(!settings.native.enabled)
        #expect(settings.native.presets.isEmpty)
        let rules = settings.rules
        #expect(rules.invites.mode == .delete)
        #expect(rules.links.mode == .off)
        #expect(rules.links.allowedText.isEmpty)
        #expect(rules.spam.max == 5)
        #expect(rules.spam.seconds == 5)
        #expect(rules.mentions.max == 5)
        #expect(rules.caps.minLength == 10)
        #expect(rules.caps.percent == 70)
        #expect(rules.words.listText.isEmpty)
        #expect(rules.emojis.max == 8)
        #expect(rules.spoilers.max == 4)
        #expect(rules.zalgo.mode == .off)
        #expect(page.presetKeys == ["profanity", "sexual", "slurs"])
        #expect(page.modlogChannelId.isEmpty)
        let empty = try JSONDecoder().decode(AutomodPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings == AutomodSettings())
    }

    @Test("saving sends exactly what the web dashboard sends, word lists as typed text")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(AutomodPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["deleteMessage", "timeoutMinutes", "exemptChannels", "exemptRoles", "native",
                                   "rules"])
        let native = try #require(body["native"] as? [String: Any])
        #expect(Set(native.keys) == ["enabled", "words", "mentions", "spam", "presets"])
        let rules = try #require(body["rules"] as? [String: [String: Any]])
        #expect(Set(rules.keys) == ["invites", "links", "spam", "mentions", "caps", "words", "emojis", "spoilers",
                                    "zalgo", "repeat"])
        func keys(_ rule: String) -> Set<String> { Set(rules[rule].map { Array($0.keys) } ?? []) }
        #expect(keys("invites") == ["enabled", "action"])
        #expect(keys("zalgo") == ["enabled", "action"])
        #expect(keys("repeat") == ["enabled", "action"])
        #expect(keys("links") == ["enabled", "action", "allowed"])
        #expect(keys("spam") == ["enabled", "action", "max", "seconds"])
        #expect(keys("mentions") == ["enabled", "action", "max"])
        #expect(keys("emojis") == ["enabled", "action", "max"])
        #expect(keys("spoilers") == ["enabled", "action", "max"])
        #expect(keys("caps") == ["enabled", "action", "minLength", "percent"])
        #expect(keys("words") == ["enabled", "action", "list"])
        #expect(rules["links"]?["allowed"] as? String == "youtube.com, twitch.tv")
        #expect(rules["words"]?["list"] as? String == "badword, another phrase")
        #expect(rules["invites"]?["action"] as? String == "warn")
    }

    @Test("choosing a mode sets enabled and action like the web form")
    func modes() {
        var rule = AutomodSettings.BasicRule()
        #expect(rule.mode == .off)
        rule.mode = .timeout
        #expect(rule.enabled)
        #expect(rule.action == .timeout)
        rule.mode = .off
        #expect(!rule.enabled)
        #expect(rule.action == .delete)
    }

    @Test("a keyword preset turns on and off without duplicates")
    func presets() {
        var native = AutomodSettings.Native(presets: ["slurs"])
        #expect(native[preset: "slurs"])
        #expect(!native[preset: "sexual"])
        native[preset: "sexual"] = true
        native[preset: "sexual"] = true
        #expect(native.presets == ["slurs", "sexual"])
        native[preset: "slurs"] = false
        #expect(native.presets == ["sexual"])
    }
}
