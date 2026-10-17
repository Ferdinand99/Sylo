import Foundation
import Testing
@testable import SyloKit

@Suite("Leveling settings")
struct LevelingSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/leveling/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "cooldownSeconds": 30,
        "xpRate": 1.5,
        "announce": "dm",
        "announceChannel": "222222222222222222",
        "announceMessage": "Level {level}, {player}!",
        "noXpChannels": ["333333333333333333"],
        "noXpChannelsMode": "deny",
        "noXpRoles": ["444444444444444444"],
        "noXpRolesMode": "allow",
        "stackRewards": false,
        "removeRewardsOnXpLoss": true,
        "publicLeaderboard": true,
        "voiceXpEnabled": true,
        "voiceXpPerMin": 12,
        "voiceAfkExcluded": false,
        "multipliers": [{"type": "channel", "id": "333333333333333333", "factor": 1.25}],
        "rewards": [{"level": 10, "roleId": "555555555555555555"}]
      },
      "channels": [{"id": "222222222222222222", "name": "levels"}],
      "roles": [{"id": "555555555555555555", "name": "Regular"}],
      "announceModes": ["channel", "reply", "dm", "off"],
      "xpRates": [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3],
      "board": {"total": 1, "rows": [{"rank": 1, "name": "ada", "level": 3, "xp": 400, "voiceXp": 0,
                                       "voiceMinutes": 0, "messages": 20}]}
    }
    """#

    @Test("the page decodes settings, channels, roles and XP rates")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(LevelingPage.self, from: Data(Self.pageJSON.utf8))
        #expect(LevelingPage.moduleID == "leveling")
        let s = page.settings
        #expect(s.cooldownSeconds == 30)
        #expect(s.xpRate == 1.5)
        #expect(s.announce == .dm)
        #expect(s.announceChannel == "222222222222222222")
        #expect(s.announceMessage == "Level {level}, {player}!")
        #expect(s.noXpChannels == ["333333333333333333"])
        #expect(s.noXpChannelsMode == .deny)
        #expect(s.noXpRoles == ["444444444444444444"])
        #expect(s.noXpRolesMode == .allow)
        #expect(!s.stackRewards)
        #expect(s.removeRewardsOnXpLoss)
        #expect(s.voiceXpEnabled)
        #expect(s.voiceXpPerMin == 12)
        #expect(!s.voiceAfkExcluded)
        let multiplier = try #require(s.multipliers.first)
        #expect(multiplier.type == .channel)
        #expect(multiplier.targetId == "333333333333333333")
        #expect(multiplier.factor == 1.25)
        let reward = try #require(s.rewards.first)
        #expect(reward.level == 10)
        #expect(reward.roleId == "555555555555555555")
        #expect(page.channels.map(\.name) == ["levels"])
        #expect(page.roles.map(\.name) == ["Regular"])
        #expect(page.xpRates == [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3])
    }

    @Test("missing fields and unknown choices fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"""
        {"config":{"announce":"shout","xpRate":7,"noXpRolesMode":"maybe",
                   "multipliers":[{"type":"emoji","id":"1"}],"rewards":[{"roleId":"2"}]}}
        """#.utf8)
        let page = try JSONDecoder().decode(LevelingPage.self, from: json)
        let s = page.settings
        #expect(s.cooldownSeconds == 60)
        #expect(s.xpRate == 1)
        #expect(s.announce == .channel)
        #expect(s.announceChannel.isEmpty)
        #expect(s.announceMessage == LevelingSettings.defaultAnnounceMessage)
        #expect(s.noXpRolesMode == .allow)
        #expect(s.noXpChannelsMode == .allow)
        #expect(s.stackRewards)
        #expect(!s.removeRewardsOnXpLoss)
        #expect(!s.voiceXpEnabled)
        #expect(s.voiceXpPerMin == 10)
        #expect(s.voiceAfkExcluded)
        #expect(s.multipliers.first?.type == .role)
        #expect(s.multipliers.first?.factor == 1)
        #expect(s.rewards.first?.level == 1)
        #expect(page.channels.isEmpty)
        #expect(page.xpRates == LevelingSettings.xpRates)
    }

    @Test("saving sends what the web dashboard sends, except the leaderboard toggle the server keeps")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(LevelingPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        // The web form also echoes `publicLeaderboard`, but the server ignores it on this route
        // (it lives on the Leaderboard page and is kept from the stored config).
        #expect(Set(body.keys) == [
            "cooldownSeconds", "xpRate", "announce", "announceChannel", "announceMessage",
            "noXpChannels", "noXpChannelsMode", "noXpRoles", "noXpRolesMode", "stackRewards",
            "removeRewardsOnXpLoss", "voiceXpEnabled", "voiceXpPerMin", "voiceAfkExcluded",
            "multipliers", "rewards",
        ])
        #expect(body["announce"] as? String == "dm")
        #expect(body["noXpChannelsMode"] as? String == "deny")
        #expect(body["xpRate"] as? Double == 1.5)
        let multiplier = try #require((body["multipliers"] as? [[String: Any]])?.first)
        #expect(Set(multiplier.keys) == ["type", "id", "factor"])
        #expect(multiplier["type"] as? String == "channel")
        let reward = try #require((body["rewards"] as? [[String: Any]])?.first)
        #expect(Set(reward.keys) == ["level", "roleId"])
    }

    @Test("new rewards and multipliers start like the web form's new rows")
    func newRows() {
        let reward = LevelingSettings.Reward()
        #expect(reward.level == 5)
        #expect(reward.roleId.isEmpty)
        let multiplier = LevelingSettings.Multiplier()
        #expect(multiplier.type == .role)
        #expect(multiplier.targetId.isEmpty)
        #expect(multiplier.factor == 2)
    }
}
