import Foundation
import Testing
@testable import SyloKit

// The two Sylo 5.2 settings the app knows: Welcome's "when to welcome" (`trigger`, `triggerRoleIds`)
// and Economy's collectible settings (`collectibleChannelId`, `collectionPublic`). The app also talks
// to servers on 5.1 and self-hosted ones, which send none of these keys: those pages must decode, hide
// the new controls and never get the new keys back. Each suite tests a 5.1 shaped and a 5.2 shaped page.

private func keys(of settings: some Encodable) throws -> Set<String> {
    let data = try JSONEncoder().encode(settings)
    let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    return Set(body.keys)
}

@Suite("Welcome settings: Sylo 5.2")
struct WelcomeTriggerTests {
    /// `GET .../modules/welcome/config` from a 5.2 server: the config starts with the two new fields.
    static let page52JSON = #"""
    {
      "config": {
        "trigger": "role",
        "triggerRoleIds": ["111111111111111111", "444444444444444444"],
        "joinEnabled": true,
        "joinChannel": "222222222222222222",
        "joinMessage": "Welcome {user}, you are now {role}!",
        "useEmbed": false,
        "card": false,
        "cardBackground": "",
        "dmEnabled": false,
        "dmMessage": "",
        "leaveEnabled": false,
        "leaveChannel": "",
        "leaveMessage": "",
        "autoroleEnabled": false,
        "autoroles": []
      },
      "channels": [{"id": "222222222222222222", "name": "welcome"}],
      "roles": [{"id": "111111111111111111", "name": "Member"}, {"id": "444444444444444444", "name": "Verified"}],
      "verificationEnabled": true,
      "verificationMode": "button",
      "placeholders": ["{user}", "{server}", "{intro}", "{role}"]
    }
    """#

    /// The keys a 5.1 server sends and takes (the existing `WelcomeSettingsTests.pageJSON`).
    static let keys51: Set<String> = [
        "joinEnabled", "joinChannel", "joinMessage", "useEmbed", "card", "cardBackground",
        "dmEnabled", "dmMessage", "leaveEnabled", "leaveChannel", "leaveMessage",
        "autoroleEnabled", "autoroles",
    ]

    static func decode52() throws -> WelcomePage {
        try JSONDecoder().decode(WelcomePage.self, from: Data(page52JSON.utf8))
    }

    static func decode51() throws -> WelcomePage {
        try JSONDecoder().decode(WelcomePage.self, from: Data(WelcomeSettingsTests.pageJSON.utf8))
    }

    @Test("a 5.2 page decodes the trigger and its roles, and ignores the fields it does not know")
    func decodes52() throws {
        let page = try Self.decode52()
        let s = page.settings
        #expect(s.trigger == .role)
        #expect(s.triggerRoleIds == ["111111111111111111", "444444444444444444"])
        #expect(s.supportsTrigger)
        #expect(!s.hasNoTriggerRole)
        #expect(s.joinMessage == "Welcome {user}, you are now {role}!")
        #expect(page.roles.map(\.name) == ["Member", "Verified"])
        #expect(page.placeholders.contains("{role}"))
    }

    @Test("a 5.1 page has no trigger: the controls are hidden and nothing is blamed on the setup")
    func decodes51() throws {
        let s = try Self.decode51().settings
        #expect(s.trigger == nil)
        #expect(s.triggerRoleIds == nil)
        #expect(!s.supportsTrigger)
        #expect(!s.hasNoTriggerRole)
    }

    @Test("saving a 5.2 page sends the trigger and its roles with the rest")
    func encodes52() throws {
        let s = try Self.decode52().settings
        #expect(try keys(of: s) == Self.keys51.union(["trigger", "triggerRoleIds"]))
        let data = try JSONEncoder().encode(s)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["trigger"] as? String == "role")
        #expect(body["triggerRoleIds"] as? [String] == ["111111111111111111", "444444444444444444"])
        #expect(try JSONDecoder().decode(WelcomeSettings.self, from: data) == s)
    }

    @Test("saving a 5.1 page never sends the 5.2 keys, even after the person edits it")
    func encodes51() throws {
        var s = try Self.decode51().settings
        #expect(try keys(of: s) == Self.keys51)
        s.joinMessage = "Hello {user}"
        s.autoroles = ["111111111111111111"]
        #expect(try keys(of: s) == Self.keys51)
    }

    @Test("role mode with no role picked is the dashboard's warning; join mode never is")
    func noRoleWarning() {
        #expect(WelcomeSettings(trigger: .role, triggerRoleIds: []).hasNoTriggerRole)
        #expect(!WelcomeSettings(trigger: .role, triggerRoleIds: ["1"]).hasNoTriggerRole)
        #expect(!WelcomeSettings(trigger: .join, triggerRoleIds: []).hasNoTriggerRole)
        // A server that sent `trigger` but no role list: nothing picked yet, so the warning shows.
        #expect(WelcomeSettings(trigger: .role, triggerRoleIds: nil).hasNoTriggerRole)
        #expect(!WelcomeSettings(trigger: .join, triggerRoleIds: nil).hasNoTriggerRole)
        // A server before 5.2 sent no trigger at all: never blamed.
        #expect(!WelcomeSettings().hasNoTriggerRole)
    }

    @Test("a received empty trigger role list is posted back as an empty list")
    func emptyRoleListRoundTrip() throws {
        let page = try JSONDecoder().decode(
            WelcomePage.self, from: Data(#"{"config":{"trigger":"role","triggerRoleIds":[]}}"#.utf8))
        #expect(page.settings.triggerRoleIds == [])
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["trigger"] as? String == "role")
        let ids = try #require(body["triggerRoleIds"] as? [Any])
        #expect(ids.isEmpty)
    }

    @Test("without a received role list the key is only sent once a role is picked")
    func absentRoleListStaysAbsent() throws {
        var s = try JSONDecoder().decode(
            WelcomePage.self, from: Data(#"{"config":{"trigger":"role"}}"#.utf8)).settings
        #expect(s.triggerRoleIds == nil)
        #expect(s.triggerRoleSelection == [])
        // Nothing picked: the picker writing an empty list adds no key.
        s.setTriggerRoleSelection([])
        #expect(s.triggerRoleIds == nil)
        #expect(try keys(of: s) == Self.keys51.union(["trigger"]))
        // A role picked: now it is sent.
        s.setTriggerRoleSelection(["1"])
        #expect(s.triggerRoleIds == ["1"])
        #expect(try keys(of: s) == Self.keys51.union(["trigger", "triggerRoleIds"]))
        // Unpicked again: it was edited, so the empty list is sent.
        s.setTriggerRoleSelection([])
        #expect(s.triggerRoleIds == [])
    }

    @Test("the server keeps at most ten trigger roles")
    func limit() {
        #expect(WelcomeSettings.maxTriggerRoles == 10)
    }

    @Test("the picker is full at ten roles that exist; ids the server dropped do not count")
    func pickerLimit() {
        let existing = (1...12).map { "r\($0)" }
        let ten = Array(existing.prefix(10))
        let max = WelcomeSettings.maxTriggerRoles
        #expect(SelectionLimit.isFull(selection: ten, existing: existing, limit: max))
        #expect(!SelectionLimit.isFull(selection: Array(ten.prefix(9)), existing: existing, limit: max))
        #expect(!SelectionLimit.isFull(selection: [], existing: existing, limit: max))
        // Nine real roles and one deleted: room for one more.
        let withStale = Array(ten.prefix(9)) + ["deleted"]
        #expect(!SelectionLimit.isFull(selection: withStale, existing: existing, limit: max))
        // Ten real roles and a deleted one: full.
        #expect(SelectionLimit.isFull(selection: ten + ["deleted"], existing: existing, limit: max))
        // Only deleted ids: nothing used.
        #expect(!SelectionLimit.isFull(selection: ["a", "b"], existing: existing, limit: 1))
        // No limit is never full.
        #expect(!SelectionLimit.isFull(selection: existing, existing: existing, limit: nil))
    }

    @Test("an unknown trigger reads as joining, as the server does; odd types and nulls do not fail the page")
    func lenient() throws {
        func settings(_ config: String) throws -> WelcomeSettings {
            try JSONDecoder().decode(WelcomePage.self, from: Data(#"{"config":\#(config)}"#.utf8)).settings
        }
        let future = try settings(#"{"trigger":"someday","triggerRoleIds":["1"],"somethingNew":{"a":1}}"#)
        #expect(future.trigger == .join)
        #expect(future.triggerRoleIds == ["1"])

        let wrongTypes = try settings(#"{"trigger":5,"triggerRoleIds":"nope","joinEnabled":true}"#)
        #expect(wrongTypes.trigger == nil)
        #expect(wrongTypes.triggerRoleIds == nil)
        #expect(wrongTypes.joinEnabled)

        let nulls = try settings(#"{"trigger":null,"triggerRoleIds":null}"#)
        #expect(nulls.trigger == nil)
        #expect(nulls.triggerRoleIds == nil)
        #expect(try keys(of: nulls) == Self.keys51)
    }

    @Test("the model saves a switch to role mode and keeps what the server answers")
    @MainActor
    func modelSavesTrigger() async throws {
        let clients = StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<WelcomePage> {
                return SavedModuleSettings(settings: saving.settings)
            }
            return try Self.decode52()
        }
        let model = ModuleSettingsModel<WelcomePage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.hasChanges)
        model.draft?.trigger = .join
        model.draft?.triggerRoleIds = []
        #expect(model.hasChanges)
        #expect(await model.save())
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveModuleSettings<WelcomePage>)
        #expect(sent.path == "/api/v2/guilds/9/modules/welcome/config")
        #expect(sent.settings.trigger == .join)
        #expect(sent.settings.triggerRoleIds == [])
        #expect(model.draft?.trigger == .join)
        #expect(!model.hasChanges)
    }

    @Test("the model saves a 5.1 page without ever adding the trigger")
    @MainActor
    func modelSaves51() async throws {
        let clients = StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<WelcomePage> {
                return SavedModuleSettings(settings: saving.settings)
            }
            return try Self.decode51()
        }
        let model = ModuleSettingsModel<WelcomePage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        model.draft?.joinMessage = "Hi"
        #expect(await model.save())
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveModuleSettings<WelcomePage>)
        #expect(sent.settings.trigger == nil)
        #expect(try keys(of: sent.settings) == Self.keys51)
    }
}

@Suite("Economy settings: Sylo 5.2")
struct EconomyCollectibleSettingsTests {
    /// A 5.2 economy config: the 5.1 page plus the two collectible keys.
    static let page52JSON = EconomySettingsTests.pageJSON.replacingOccurrences(
        of: #""shopChannelId": "444444444444444444""#,
        with: #""shopChannelId": "444444444444444444", "collectibleChannelId": "333333333333333333", "collectionPublic": true"#)

    static func decode52() throws -> EconomyPage {
        try JSONDecoder().decode(EconomyPage.self, from: Data(page52JSON.utf8))
    }

    @Test("the 5.2 fixture really has the new keys")
    func fixture() {
        #expect(Self.page52JSON.contains("collectionPublic"))
    }

    @Test("a 5.2 page decodes the announcement channel and the collection switch")
    func decodes52() throws {
        let s = try Self.decode52().settings
        #expect(s.collectibleChannelId == "333333333333333333")
        #expect(s.collectionPublic == true)
        #expect(s.supportsCollectibles)
        #expect(s.shopChannelId == "444444444444444444")
    }

    @Test("a 5.1 page has neither key: the controls are hidden")
    func decodes51() throws {
        let s = try EconomySettingsTests.decodePage().settings
        #expect(s.collectibleChannelId == nil)
        #expect(s.collectionPublic == nil)
        #expect(!s.supportsCollectibles)
    }

    @Test("a 5.2 server that stores nothing yet sends an empty channel and off: still shown")
    func defaults52() throws {
        let page = try JSONDecoder().decode(
            EconomyPage.self, from: Data(#"{"config":{"collectibleChannelId":"","collectionPublic":false}}"#.utf8))
        #expect(page.settings.collectibleChannelId == "")
        #expect(page.settings.collectionPublic == false)
        #expect(page.settings.supportsCollectibles)
    }

    @Test("saving a 5.2 page sends the two collectible keys with every other setting")
    func encodes52() throws {
        let s = try Self.decode52().settings
        #expect(try keys(of: s) == EconomySettingsTests.serverKeys.union(["collectibleChannelId", "collectionPublic"]))
        let data = try JSONEncoder().encode(s)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body["collectibleChannelId"] as? String == "333333333333333333")
        #expect(body["collectionPublic"] as? Bool == true)
        #expect(try JSONDecoder().decode(EconomySettings.self, from: data) == s)
    }

    @Test("saving a 5.1 page never sends the collectible keys, even after an edit")
    func encodes51() throws {
        var s = try EconomySettingsTests.decodePage().settings
        s.webShop = false
        #expect(try keys(of: s) == EconomySettingsTests.serverKeys)
    }

    @Test("odd types and nulls for the new keys do not fail the page")
    func lenient() throws {
        let page = try JSONDecoder().decode(
            EconomyPage.self,
            from: Data(#"{"config":{"collectibleChannelId":7,"collectionPublic":"yes","unknownKey":[1]}}"#.utf8))
        #expect(page.settings.collectibleChannelId == nil)
        #expect(page.settings.collectionPublic == nil)
        let nulls = try JSONDecoder().decode(
            EconomyPage.self, from: Data(#"{"config":{"collectibleChannelId":null,"collectionPublic":null}}"#.utf8))
        #expect(nulls.settings == EconomySettings())
    }

    @Test("the model saves an edit of the collectible settings")
    @MainActor
    func modelSaves() async throws {
        let clients = StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<EconomyPage> {
                return SavedModuleSettings(settings: saving.settings)
            }
            return try Self.decode52()
        }
        let model = ModuleSettingsModel<EconomyPage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        model.draft?.collectionPublic = false
        model.draft?.collectibleChannelId = ""
        #expect(await model.save())
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveModuleSettings<EconomyPage>)
        #expect(sent.settings.collectionPublic == false)
        #expect(sent.settings.collectibleChannelId == "")
        #expect(model.draft?.collectionPublic == false)
    }
}

@Suite("Economy ledger: collectibles")
struct CollectibleLedgerTests {
    /// A member's detail as a 5.2 server sends it. A collectible is bought, given and refunded with
    /// the shop's own ledger kinds; the row's `reason` names the item. The inventory (which now has
    /// `imagePath` and `rarity` per row) is not read by the app, and an item kind it does not know
    /// is just text there.
    static let detailJSON = #"""
    {
      "member": {"id": "810000000000000001", "name": "Alex", "inServer": true},
      "account": {"cash": 400, "bank": 0, "total": 400, "dailyStreak": 0, "hasAccount": true},
      "transactionCount": 3,
      "inventory": [
        {"id": 5, "itemId": 2, "itemName": "Founder badge", "itemType": "collectible", "itemRemoved": false,
         "imagePath": "/c/abc.webp", "rarity": "epic", "status": "active", "pricePaid": 500},
        {"id": 6, "itemId": 3, "itemName": "From the future", "itemType": "hologram", "rarity": "mythic",
         "status": "active"}
      ],
      "transactions": [
        {"id": 12, "kind": "refund", "amount": 500, "cashAfter": 900, "bankAfter": 0, "counterparty": null,
         "actor": {"id": "820000000000000001", "name": "Mod", "inServer": true},
         "reason": "Refunded: 🎖️ Founder badge", "createdAt": 1794000300000},
        {"id": 11, "kind": "purchase", "amount": -500, "cashAfter": 400, "bankAfter": 0, "counterparty": null,
         "actor": null, "reason": "🎖️ Founder badge", "createdAt": 1794000200000},
        {"id": 10, "kind": "grant", "amount": 0, "cashAfter": 900, "bankAfter": 0, "counterparty": null,
         "actor": {"id": "820000000000000001", "name": "Mod", "inServer": true},
         "reason": "🎖️ Founder badge", "createdAt": 1794000100000}
      ]
    }
    """#

    @Test("a collectible purchase, refund and gift decode and read as shop rows with the item's name")
    func decodes() throws {
        let detail = try JSONDecoder().decode(EconomyMemberDetail.self, from: Data(Self.detailJSON.utf8))
        #expect(detail.transactions.map(\.kindLabel) == ["Refund", "Shop purchase", "Item given"])
        #expect(detail.transactions.map(\.amount) == [500, -500, 0])
        #expect(detail.transactions[1].reason == "🎖️ Founder badge")
        #expect(detail.transactions[0].actor?.name == "Mod")
        #expect(detail.account.cash == 400)
    }

    @Test("every shop and giveaway ledger kind has a label")
    func labels() {
        for kind in ["purchase", "refund", "grant", "revoke", "giveaway_entry", "giveaway_prize"] {
            #expect(EconomyTransaction(id: 1, kind: kind, amount: 1).kindLabel != kind, "\(kind)")
        }
    }
}
