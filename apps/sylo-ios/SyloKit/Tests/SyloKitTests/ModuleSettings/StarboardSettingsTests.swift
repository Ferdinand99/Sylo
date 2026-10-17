import Foundation
import Testing
@testable import SyloKit

@Suite("Starboard settings")
struct StarboardSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/starboard/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "boards": [
          {"id": "0", "name": "Hall of fame", "channelId": "222222222222222222",
           "emojis": ["⭐", "444444444444444444"], "emojiText": "⭐ <:pog:444444444444444444>",
           "threshold": 5, "multiPerUser": true, "autoReact": false, "autoReactFirstOnly": true,
           "removeOnUnstar": false, "repostCooldown": true, "removeOnDelete": false, "ignoreSelfStars": false,
           "removeSelfStarReactions": true, "ignoreBotMessages": false, "removeBotReactions": true,
           "minAgeMinutes": 2, "maxAgeMinutes": 1440, "roleMode": "deny", "roleList": ["111111111111111111"],
           "channelMode": "deny", "channelList": ["333333333333333333"]}
        ]
      },
      "channels": [{"id": "222222222222222222", "name": "highlights"}],
      "roles": [{"id": "111111111111111111", "name": "Members"}]
    }
    """#

    static let bodyKeys: Set<String> = [
        "id", "name", "channelId", "emojis", "threshold", "multiPerUser", "autoReact", "autoReactFirstOnly",
        "removeOnUnstar", "repostCooldown", "removeOnDelete", "ignoreSelfStars", "removeSelfStarReactions",
        "ignoreBotMessages", "removeBotReactions", "minAgeMinutes", "maxAgeMinutes", "roleMode", "roleList",
        "channelMode", "channelList",
    ]

    @Test("the page decodes boards, channels and roles")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(StarboardPage.self, from: Data(Self.pageJSON.utf8))
        #expect(StarboardPage.moduleID == "starboard")
        let board = try #require(page.settings.boards.first)
        #expect(board.boardId == "0")
        #expect(board.name == "Hall of fame")
        #expect(board.channelId == "222222222222222222")
        #expect(board.emojiText == "⭐ <:pog:444444444444444444>")
        #expect(board.threshold == 5)
        #expect(board.multiPerUser)
        #expect(!board.autoReact)
        #expect(board.autoReactFirstOnly)
        #expect(!board.removeOnUnstar)
        #expect(board.repostCooldown)
        #expect(!board.removeOnDelete)
        #expect(!board.ignoreSelfStars)
        #expect(board.removeSelfStarReactions)
        #expect(!board.ignoreBotMessages)
        #expect(board.removeBotReactions)
        #expect(board.minAgeMinutes == 2)
        #expect(board.maxAgeMinutes == 1440)
        #expect(board.roleMode == .deny)
        #expect(board.roleList == ["111111111111111111"])
        #expect(board.channelMode == .deny)
        #expect(board.channelList == ["333333333333333333"])
        #expect(page.channels.map(\.name) == ["highlights"])
        #expect(page.roles.map(\.name) == ["Members"])
    }

    @Test("missing fields and unknown modes fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"boards":[{"roleMode":"maybe","emojis":["🔥"]}]}}"#.utf8)
        let page = try JSONDecoder().decode(StarboardPage.self, from: json)
        let board = try #require(page.settings.boards.first)
        #expect(board.boardId.isEmpty)
        #expect(board.name == "Starboard")
        #expect(board.emojiText == "🔥")
        #expect(board.threshold == 3)
        #expect(board.autoReact)
        #expect(board.removeOnUnstar)
        #expect(board.removeOnDelete)
        #expect(board.ignoreSelfStars)
        #expect(board.ignoreBotMessages)
        #expect(!board.multiPerUser)
        #expect(board.roleMode == .allow)
        #expect(board.channelMode == .allow)
        #expect(board.roleList.isEmpty)

        let empty = try JSONDecoder().decode(StarboardPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(empty.settings.boards.isEmpty)
        #expect(empty.channels.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends, emoji as typed text")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(StarboardPage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["boards"])
        let board = try #require((body["boards"] as? [[String: Any]])?.first)
        #expect(Set(board.keys) == Self.bodyKeys)
        #expect(board["id"] as? String == "0")
        #expect(board["emojis"] as? String == "⭐ <:pog:444444444444444444>")
        #expect(board["roleMode"] as? String == "deny")
    }

    @Test("new boards start like the web form's new boards")
    func newBoard() {
        let board = StarboardSettings.Board()
        #expect(board.boardId.isEmpty)
        #expect(board.name == "Starboard")
        #expect(board.channelId.isEmpty)
        #expect(board.emojiText == "⭐")
        #expect(board.threshold == 3)
        #expect(!board.multiPerUser)
        #expect(board.autoReact)
        #expect(!board.autoReactFirstOnly)
        #expect(board.removeOnUnstar)
        #expect(!board.repostCooldown)
        #expect(board.removeOnDelete)
        #expect(board.ignoreSelfStars)
        #expect(!board.removeSelfStarReactions)
        #expect(board.ignoreBotMessages)
        #expect(!board.removeBotReactions)
        #expect(board.minAgeMinutes == 0)
        #expect(board.maxAgeMinutes == 0)
        #expect(board.roleMode == .allow)
        #expect(board.channelMode == .allow)
    }
}
