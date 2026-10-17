import Foundation
import Testing
@testable import SyloKit

@Suite("TempVoice settings")
struct TempVoiceSettingsTests {
    /// `GET /api/v2/guilds/:id/modules/temp-voice/config`, shaped like the server sends it.
    static let pageJSON = #"""
    {
      "config": {
        "hubs": [
          {"id": "0", "hubChannelId": "222222222222222222", "categoryId": "555555555555555555",
           "nameTemplate": "{username}'s room", "userLimit": 5, "bitrate": 96, "keepAliveMinutes": -1,
           "ownershipLock": true, "syncCategory": true, "syncChannel": false, "roleMode": "deny",
           "roleList": ["111111111111111111"], "useRolesForAccess": true, "ignoredRoles": ["111111111111111112"],
           "moderatorRoles": ["111111111111111113"],
           "ownerPerms": {"manageChannels": false, "managePermissions": true, "prioritySpeaker": true,
                          "moveMembers": true},
           "textChannel": {"enabled": true, "restrictCommands": true, "pinUsages": true, "restrict": true}}
        ]
      },
      "voiceChannels": [{"id": "222222222222222222", "name": "Join to create"}],
      "categories": [{"id": "555555555555555555", "name": "Voice"}],
      "roles": [{"id": "111111111111111111", "name": "Members"}]
    }
    """#

    @Test("the page decodes hubs, voice channels, categories and roles")
    func decodesPage() throws {
        let page = try JSONDecoder().decode(TempVoicePage.self, from: Data(Self.pageJSON.utf8))
        #expect(TempVoicePage.moduleID == "temp-voice")
        let hub = try #require(page.settings.hubs.first)
        #expect(hub.hubId == "0")
        #expect(hub.hubChannelId == "222222222222222222")
        #expect(hub.categoryId == "555555555555555555")
        #expect(hub.nameTemplate == "{username}'s room")
        #expect(hub.userLimit == 5)
        #expect(hub.bitrate == 96)
        #expect(hub.keepAliveMinutes == -1)
        #expect(hub.ownershipLock)
        #expect(hub.syncCategory)
        #expect(!hub.syncChannel)
        #expect(hub.roleMode == .deny)
        #expect(hub.roleList == ["111111111111111111"])
        #expect(hub.useRolesForAccess)
        #expect(hub.ignoredRoles == ["111111111111111112"])
        #expect(hub.moderatorRoles == ["111111111111111113"])
        #expect(!hub.ownerPerms.manageChannels)
        #expect(hub.ownerPerms.managePermissions)
        #expect(hub.ownerPerms.prioritySpeaker)
        #expect(hub.ownerPerms.moveMembers)
        #expect(hub.textChannel.enabled)
        #expect(hub.textChannel.restrictCommands)
        #expect(hub.textChannel.pinUsages)
        #expect(hub.textChannel.restrict)
        #expect(page.voiceChannels.map(\.name) == ["Join to create"])
        #expect(page.categories.map(\.name) == ["Voice"])
        #expect(page.roles.map(\.name) == ["Members"])
    }

    @Test("missing fields and an unknown mode fall back to the server's defaults")
    func lenientDecoding() throws {
        let json = Data(#"{"config":{"hubs":[{"hubChannelId":"1","roleMode":"maybe","ownerPerms":{}}]}}"#.utf8)
        let page = try JSONDecoder().decode(TempVoicePage.self, from: json)
        let hub = try #require(page.settings.hubs.first)
        #expect(hub.hubId.isEmpty)
        #expect(hub.nameTemplate == TempVoiceSettings.defaultNameTemplate)
        #expect(hub.userLimit == 0)
        #expect(hub.bitrate == 0)
        #expect(hub.keepAliveMinutes == 0)
        #expect(hub.roleMode == .allow)
        #expect(hub.ownerPerms.manageChannels)
        #expect(!hub.ownerPerms.moveMembers)
        #expect(!hub.textChannel.enabled)
        #expect(page.voiceChannels.isEmpty)
        #expect(page.categories.isEmpty)
    }

    @Test("saving sends exactly what the web dashboard sends")
    func encodesBody() throws {
        let page = try JSONDecoder().decode(TempVoicePage.self, from: Data(Self.pageJSON.utf8))
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == ["hubs"])
        let hub = try #require((body["hubs"] as? [[String: Any]])?.first)
        #expect(Set(hub.keys) == [
            "id", "hubChannelId", "categoryId", "nameTemplate", "userLimit", "bitrate", "keepAliveMinutes",
            "ownershipLock", "syncCategory", "syncChannel", "roleMode", "roleList", "useRolesForAccess",
            "ignoredRoles", "moderatorRoles", "ownerPerms", "textChannel",
        ])
        #expect(hub["id"] as? String == "0")
        #expect(hub["roleMode"] as? String == "deny")
        let perms = try #require(hub["ownerPerms"] as? [String: Any])
        #expect(Set(perms.keys) == ["manageChannels", "managePermissions", "prioritySpeaker", "moveMembers"])
        let text = try #require(hub["textChannel"] as? [String: Any])
        #expect(Set(text.keys) == ["enabled", "restrictCommands", "pinUsages", "restrict"])
    }

    @Test("new hubs start like the web form's new hubs")
    func newHub() {
        let hub = TempVoiceSettings.Hub()
        #expect(hub.hubId.isEmpty)
        #expect(hub.hubChannelId.isEmpty)
        #expect(hub.categoryId.isEmpty)
        #expect(hub.nameTemplate == "#{index} - {username}'s Channel")
        #expect(hub.userLimit == 0)
        #expect(hub.bitrate == 0)
        #expect(hub.keepAliveMinutes == 0)
        #expect(!hub.ownershipLock)
        #expect(!hub.syncCategory)
        #expect(!hub.syncChannel)
        #expect(hub.roleMode == .allow)
        #expect(hub.roleList.isEmpty)
        #expect(!hub.useRolesForAccess)
        #expect(hub.ownerPerms.manageChannels)
        #expect(!hub.ownerPerms.managePermissions)
        #expect(!hub.ownerPerms.prioritySpeaker)
        #expect(!hub.ownerPerms.moveMembers)
        #expect(!hub.textChannel.enabled)
        #expect(!hub.textChannel.restrict)
    }

    @Test("the name preview fills in the tokens like the web form")
    func namePreview() {
        #expect(TempVoiceSettings.previewName("#{index} - {username}'s Channel") == "#1 - player's Channel")
        #expect(TempVoiceSettings.previewName("{user} ({count})") == "Player (1)")
        #expect(TempVoiceSettings.previewName("") == "#1 - player's Channel")
    }
}
