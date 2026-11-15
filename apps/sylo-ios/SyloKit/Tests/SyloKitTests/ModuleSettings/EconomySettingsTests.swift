import Foundation
import Testing
@testable import SyloKit

@Suite("Economy settings")
struct EconomySettingsTests {
    /// `GET /api/v2/guilds/:id/modules/economy/config`, shaped like src/web/routes/v2Economy.js.
    static let pageJSON = #"""
    {
      "config": {
        "currencyName": "gold",
        "currencyEmoji": "<:gold:123456789012345678>",
        "messageEnabled": false,
        "messageMin": 2,
        "messageMax": 9,
        "messageCooldownSeconds": 30,
        "messageMinLength": 5,
        "ignoredChannels": ["222222222222222222"],
        "ignoredRoles": ["111111111111111111"],
        "voiceEnabled": true,
        "voiceAmount": 12,
        "dailyBase": 200,
        "dailyStreakBonus": 20,
        "workMin": 60,
        "workMax": 160,
        "workCooldownMinutes": 90,
        "bankEnabled": false,
        "payEnabled": false,
        "payTaxPercent": 5,
        "robEnabled": true,
        "robChancePercent": 45,
        "robMinPercent": 11,
        "robMaxPercent": 31,
        "robFinePercent": 12,
        "robFineMin": 30,
        "robCooldownHours": 5,
        "robVictimMinCash": 150,
        "robNewMemberHours": 48,
        "robProtectionMinutes": 120,
        "startingBalance": 500,
        "publicLeaderboard": false,
        "logChannelId": "333333333333333333",
        "webShop": true,
        "shopChannelId": "444444444444444444"
      },
      "channels": [{"id": "222222222222222222", "name": "spam"}, {"id": "333333333333333333", "name": "eco-log"}],
      "roles": [{"id": "111111111111111111", "name": "Bots"}],
      "maxBalance": 1000000000,
      "messageLengthChecked": false
    }
    """#

    static func decodePage() throws -> EconomyPage {
        try JSONDecoder().decode(EconomyPage.self, from: Data(pageJSON.utf8))
    }

    /// Every key the server's `normaliseEconomyConfig` returns.
    static let serverKeys: Set<String> = [
        "currencyName", "currencyEmoji", "messageEnabled", "messageMin", "messageMax", "messageCooldownSeconds",
        "messageMinLength", "ignoredChannels", "ignoredRoles", "voiceEnabled", "voiceAmount", "dailyBase",
        "dailyStreakBonus", "workMin", "workMax", "workCooldownMinutes", "bankEnabled", "payEnabled",
        "payTaxPercent", "robEnabled", "robChancePercent", "robMinPercent", "robMaxPercent", "robFinePercent",
        "robFineMin", "robCooldownHours", "robVictimMinCash", "robNewMemberHours", "robProtectionMinutes",
        "startingBalance", "publicLeaderboard", "logChannelId", "webShop", "shopChannelId",
    ]

    @Test("the page decodes every setting, the options and the notes")
    func decodesPage() throws {
        let page = try Self.decodePage()
        #expect(EconomyPage.moduleID == "economy")
        let s = page.settings
        #expect(s.currencyName == "gold")
        #expect(s.currencyEmoji == "<:gold:123456789012345678>")
        #expect(!s.messageEnabled)
        #expect(s.messageMin == 2)
        #expect(s.messageMax == 9)
        #expect(s.messageCooldownSeconds == 30)
        #expect(s.messageMinLength == 5)
        #expect(s.ignoredChannels == ["222222222222222222"])
        #expect(s.ignoredRoles == ["111111111111111111"])
        #expect(s.voiceEnabled)
        #expect(s.voiceAmount == 12)
        #expect(s.dailyBase == 200)
        #expect(s.dailyStreakBonus == 20)
        #expect(s.workMin == 60)
        #expect(s.workMax == 160)
        #expect(s.workCooldownMinutes == 90)
        #expect(!s.bankEnabled)
        #expect(!s.payEnabled)
        #expect(s.payTaxPercent == 5)
        #expect(s.robEnabled)
        #expect(s.robChancePercent == 45)
        #expect(s.robMinPercent == 11)
        #expect(s.robMaxPercent == 31)
        #expect(s.robFinePercent == 12)
        #expect(s.robFineMin == 30)
        #expect(s.robCooldownHours == 5)
        #expect(s.robVictimMinCash == 150)
        #expect(s.robNewMemberHours == 48)
        #expect(s.robProtectionMinutes == 120)
        #expect(s.startingBalance == 500)
        #expect(!s.publicLeaderboard)
        #expect(s.logChannelId == "333333333333333333")
        #expect(s.webShop)
        #expect(s.shopChannelId == "444444444444444444")
        #expect(page.channels.map(\.name) == ["spam", "eco-log"])
        #expect(page.roles.map(\.name) == ["Bots"])
        #expect(page.maxBalance == 1_000_000_000)
        #expect(!page.messageLengthChecked)
    }

    @Test("missing fields fall back to the server's defaults")
    func lenientDecoding() throws {
        let page = try JSONDecoder().decode(EconomyPage.self, from: Data(#"{"config":{}}"#.utf8))
        #expect(page.settings == EconomySettings())
        let s = page.settings
        #expect(s.currencyName == "coins")
        #expect(s.currencyEmoji == "🪙")
        #expect(s.messageEnabled)
        #expect(s.messageMin == 5)
        #expect(s.messageMax == 15)
        #expect(s.messageCooldownSeconds == 60)
        #expect(s.messageMinLength == 3)
        #expect(!s.voiceEnabled)
        #expect(s.voiceAmount == 10)
        #expect(s.dailyBase == 100)
        #expect(s.dailyStreakBonus == 10)
        #expect(s.workMin == 50)
        #expect(s.workMax == 150)
        #expect(s.workCooldownMinutes == 60)
        #expect(s.bankEnabled)
        #expect(s.payEnabled)
        #expect(s.payTaxPercent == 0)
        #expect(!s.robEnabled)
        #expect(s.robChancePercent == 40)
        #expect(s.robMinPercent == 10)
        #expect(s.robMaxPercent == 30)
        #expect(s.robFinePercent == 10)
        #expect(s.robFineMin == 25)
        #expect(s.robCooldownHours == 4)
        #expect(s.robVictimMinCash == 100)
        #expect(s.robNewMemberHours == 24)
        #expect(s.robProtectionMinutes == 60)
        #expect(s.startingBalance == 0)
        #expect(s.publicLeaderboard)
        #expect(!s.webShop)
        #expect(s.logChannelId.isEmpty)
        #expect(s.shopChannelId.isEmpty)
        #expect(page.channels.isEmpty)
        #expect(page.messageLengthChecked)
    }

    @Test("saving sends every setting: the server builds the config from what it gets")
    func encodesBody() throws {
        let page = try Self.decodePage()
        let data = try JSONEncoder().encode(page.settings)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(body.keys) == Self.serverKeys)
        #expect(body["currencyName"] as? String == "gold")
        #expect(body["robEnabled"] as? Bool == true)
        #expect(body["messageCooldownSeconds"] as? Int == 30)
        #expect(body["ignoredRoles"] as? [String] == ["111111111111111111"])
        #expect(try JSONDecoder().decode(EconomySettings.self, from: data) == page.settings)
    }

    @Test("the limits are the server's")
    func limits() {
        #expect(EconomySettings.maxCurrencyNameLength == 20)
        #expect(EconomySettings.maxCurrencyEmojiLength == 64)
        #expect(EconomySettings.startingBalanceRange == 0...1_000_000)
        #expect(EconomySettings.messageAmountRange == 1...1000)
        #expect(EconomySettings.messageCooldownRange == 0...3600)
        #expect(EconomySettings.messageMinLengthRange == 0...100)
        #expect(EconomySettings.voiceAmountRange == 1...1000)
        #expect(EconomySettings.dailyBaseRange == 1...100_000)
        #expect(EconomySettings.dailyStreakBonusRange == 0...10_000)
        #expect(EconomySettings.workAmountRange == 1...100_000)
        #expect(EconomySettings.workCooldownRange == 1...1440)
        #expect(EconomySettings.payTaxRange == 0...50)
        #expect(EconomySettings.robChanceRange == 1...99)
        #expect(EconomySettings.robPercentRange == 1...100)
        #expect(EconomySettings.robFinePercentRange == 0...100)
        #expect(EconomySettings.robFineMinRange == 0...100_000)
        #expect(EconomySettings.robCooldownRange == 1...168)
        #expect(EconomySettings.robVictimMinCashRange == 0...1_000_000)
        #expect(EconomySettings.robNewMemberRange == 0...720)
        #expect(EconomySettings.robProtectionRange == 0...1440)
        #expect(EconomySettings.maxIgnoredChannels == 100)
        #expect(EconomySettings.maxIgnoredRoles == 100)
    }

    @Test("an empty currency name or emoji is a problem, because the server would swap in its own")
    func currencyProblem() {
        var settings = EconomySettings()
        #expect(settings.currencyProblem == nil)
        settings.currencyName = "  "
        #expect(settings.currencyProblem != nil)
        settings.currencyName = "gold"
        settings.currencyEmoji = ""
        #expect(settings.currencyProblem != nil)
    }

    @Test("the model saves an edit and keeps what the server made of it")
    @MainActor
    func modelSaves() async throws {
        let clients = StubClients { endpoint in
            if let saving = endpoint as? Endpoints.SaveModuleSettings<EconomyPage> {
                // The server raises the highest amount to the lowest, as normaliseEconomyConfig does.
                var stored = saving.settings
                stored.messageMax = max(stored.messageMin, stored.messageMax)
                return SavedModuleSettings(settings: stored)
            }
            return try Self.decodePage()
        }
        let model = ModuleSettingsModel<EconomyPage>(server: "9", session: makeSignedInSession(clients: clients))
        await model.load()
        #expect(!model.hasChanges)
        model.draft?.messageMin = 20
        #expect(await model.save())
        #expect(model.draft?.messageMax == 20)
        let sent = try #require(clients.calls.last?.endpoint as? Endpoints.SaveModuleSettings<EconomyPage>)
        #expect(sent.path == "/api/v2/guilds/9/modules/economy/config")
        #expect(sent.method == .post)
        #expect(sent.settings.currencyName == "gold")
    }
}
